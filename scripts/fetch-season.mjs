#!/usr/bin/env node
/**
 * Pulls season data from CollegeFootballData and writes static JSON files
 * that the board loads directly. Run locally or from GitHub Actions.
 *
 *   CFBD_KEY=your_key node scripts/fetch-season.mjs 2024 2025 2026
 *
 * Output:
 *   data/manifest.json      list of available seasons + timestamp
 *   data/season-YYYY.json   teams, FBS games, conference championship games
 *
 * The season files carry more fields than the board currently reads (points,
 * dates, notes, neutral-site flags). That is deliberate: the tiebreaker engine
 * will need some of them, and regenerating every file later is a chore worth
 * avoiding.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const API = "https://api.collegefootballdata.com";
const KEY = process.env.CFBD_KEY;
const OUT = "data";

if (!KEY) {
  console.error("CFBD_KEY is not set.\n" +
    "  Locally:  CFBD_KEY=your_key node scripts/fetch-season.mjs 2026\n" +
    "  Actions:  add it under Settings > Secrets and variables > Actions");
  process.exit(1);
}

const years = process.argv.slice(2).map(Number).filter(Boolean);
if (!years.length) {
  console.error("Name at least one season, e.g. node scripts/fetch-season.mjs 2026");
  process.exit(1);
}

/* CFBD has used both snake_case and camelCase across API versions. Read either. */
function field(obj, ...names) {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return null;
}

function normalizeGame(g) {
  return {
    id: field(g, "id", "gameId"),
    week: field(g, "week"),
    seasonType: field(g, "seasonType", "season_type") || "regular",
    startDate: field(g, "startDate", "start_date"),
    home: field(g, "homeTeam", "home_team"),
    away: field(g, "awayTeam", "away_team"),
    homeConf: field(g, "homeConference", "home_conference"),
    awayConf: field(g, "awayConference", "away_conference"),
    confGame: Boolean(field(g, "conferenceGame", "conference_game")),
    neutral: Boolean(field(g, "neutralSite", "neutral_site")),
    completed: Boolean(field(g, "completed")),
    homePts: field(g, "homePoints", "home_points"),
    awayPts: field(g, "awayPoints", "away_points"),
    notes: field(g, "notes"),
  };
}

function normalizeTeam(t) {
  return {
    school: field(t, "school", "name"),
    conference: field(t, "conference"),
    abbreviation: field(t, "abbreviation"),
  };
}

async function get(path) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (res.status === 401) throw new Error("CFBD rejected the key.");
  if (res.status === 429) throw new Error("CFBD rate limit reached. Wait, then rerun.");
  if (!res.ok) throw new Error(`CFBD returned ${res.status} for ${path}`);
  return res.json();
}

/* The games endpoint returns every division. Keep only games with at least one
   FBS team, which preserves FBS-vs-FCS matchups (they count toward overall
   records) while discarding games between teams the board never displays. */
function involvesFBS(g, fbs) {
  return fbs.has(g.home) || fbs.has(g.away);
}

/* A conference championship game is a same-conference matchup between two FBS
   teams in the final week of the regular season. Bowls and playoff games can
   also pair two teams from one conference, so those are excluded explicitly —
   that was the flaw in the previous version, which caught bowls and missed
   every actual title game. */
function isChampionship(g, fbs, finalWeek) {
  if (!g.homeConf || g.homeConf !== g.awayConf) return false;
  if (!fbs.has(g.home) || !fbs.has(g.away)) return false;

  const notes = (g.notes || "").toLowerCase();
  if (/bowl|playoff|semifinal|quarterfinal|first round|national champion/.test(notes)) return false;
  if (/champion/.test(notes)) return true;

  return g.seasonType === "regular" && g.week === finalWeek;
}

async function fetchSeason(year) {
  const [rawTeams, rawRegular, rawPost] = await Promise.all([
    get(`/teams/fbs?year=${year}`),
    get(`/games?year=${year}&seasonType=regular`),
    get(`/games?year=${year}&seasonType=postseason`).catch(() => []),
  ]);

  const teams = rawTeams.map(normalizeTeam).filter((t) => t.school);
  teams.sort((a, b) => a.school.localeCompare(b.school));
  const fbs = new Set(teams.map((t) => t.school));

  const allRegular = rawRegular.map(normalizeGame).filter((g) => g.id && g.home && g.away);
  const allPost = rawPost.map(normalizeGame).filter((g) => g.id && g.home && g.away);

  const games = allRegular.filter((g) => involvesFBS(g, fbs));
  games.sort((a, b) => (a.week - b.week) || String(a.startDate).localeCompare(String(b.startDate)));

  const finalWeek = games.length ? Math.max(...games.map((g) => g.week || 0)) : 0;
  const championships = [...allRegular, ...allPost]
    .filter((g) => isChampionship(g, fbs, finalWeek));

  const played = games.filter((g) => g.completed).length;
  const dropped = allRegular.length - games.length;

  console.log(
    `  ${year}  ${teams.length} teams, ${games.length} FBS games ` +
    `(${played} final), ${championships.length} title games  ` +
    `[dropped ${dropped} non-FBS]`
  );
  for (const c of championships) {
    console.log(`         ${c.homeConf}: ${c.away} vs ${c.home}`);
  }

  return {
    year,
    generated: new Date().toISOString(),
    source: "CollegeFootballData.com",
    teams,
    games,
    championships,
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log("Fetching from CollegeFootballData:");

  const done = [];
  for (const year of years) {
    const season = await fetchSeason(year);
    await writeFile(
      join(OUT, `season-${year}.json`),
      JSON.stringify(season) + "\n"
    );
    done.push({
      year,
      teams: season.teams.length,
      games: season.games.length,
      final: season.games.filter((g) => g.completed).length,
      championships: season.championships.length,
    });
  }

  const manifest = {
    generated: new Date().toISOString(),
    seasons: done.sort((a, b) => b.year - a.year),
  };
  await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\nWrote ${done.length} season file(s) plus manifest.json to ${OUT}/`);
}

main().catch((err) => {
  console.error("\nFailed: " + err.message);
  process.exit(1);
});
