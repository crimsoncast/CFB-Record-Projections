#!/usr/bin/env node
/*
 * Replays completed seasons and checks the tiebreaker engine against reality.
 *
 *   node scripts/validate.mjs 2024 2025
 *
 * Every game in a finished season has a result, so the engine gets no help from
 * guesswork: it must produce the two teams who actually played in each
 * conference championship game. Those matchups come from the season file's
 * championships array, captured from CollegeFootballData.
 *
 * A conference is only counted wrong when the engine names a definite pair that
 * disagrees with what happened. Stopping at a step that needs outside
 * information is reported separately — that is the tool working as designed,
 * not a failure.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TB = require("../tiebreakers.js");
const SC = require("../context.js");

const argv = process.argv.slice(2);
const explainAt = argv.indexOf("--explain");
const explainConf = explainAt >= 0 ? argv[explainAt + 1] : null;
const years = (explainAt >= 0 ? argv.slice(0, explainAt) : argv).map(Number).filter(Boolean);
if (!years.length) {
  console.error("Name at least one completed season, e.g. node scripts/validate.mjs 2024 2025");
  process.exit(1);
}

function pair(a, b) { return [a, b].sort().join(" vs "); }

function rec(ctx, t) {
  const r = ctx.rec[t];
  return `${r.cw}-${r.cl}`.padEnd(5) + (r.division ? ` (${r.division})` : "");
}

/*
 * Dump everything behind one conference's decision: the standings, how the tie
 * groups were defined, and for each contested group the head-to-head grid, the
 * common opponents, and the value every step computed for every team.
 */
function explain(name, ctx, res) {
  const rules = TB.RULES[name];
  console.log(`\n${"=".repeat(72)}\nEXPLAIN  ${name}\n${"=".repeat(72)}`);

  console.log("\nStandings:");
  TB.standingsBuckets(ctx).forEach((b, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${b.map(t => `${t} (${rec(ctx, t).trim()})`).join(", ")}`);
  });

  const groups = TB.defineTiedTeams(ctx, rules);
  console.log("\nTie groups as defined:");
  groups.forEach((g, i) => console.log(`  ${i + 1}. ${g.join(", ")}`));

  // Only the groups that could affect the two championship slots matter.
  let slotsLeft = rules.divisions ? 1 : 2;
  for (const g of groups) {
    if (slotsLeft <= 0) break;
    if (g.length === 1) { slotsLeft--; continue; }

    console.log(`\n${"-".repeat(72)}\nContested group: ${g.join(", ")}   (${slotsLeft} slot(s) available)`);

    console.log("\n  Head-to-head among these teams:");
    g.forEach(a => {
      const cells = g.filter(b => b !== a).map(b => {
        const r = (ctx.rec[a].opp || {})[b];
        return `${b}:${r ? r.result : "-"}`;
      });
      console.log(`    ${a.padEnd(22)} ${cells.join("  ")}`);
    });

    const common = TB.commonOpponents(ctx, g);
    console.log(`\n  Common conference opponents (${common.length}): ${common.length ? common.join(", ") : "none"}`);
    if (common.length) {
      g.forEach(t => {
        const r = TB.recordAgainst(ctx, t, common);
        console.log(`    ${t.padEnd(22)} ${r.w}-${r.l}  (${r.pct.toFixed(3)})`);
      });
    }

    console.log("\n  Step by step:");
    let cur = g.slice();
    for (const st of rules.steps) {
      if (st.blocked) {
        console.log(`    BLOCKED  ${st.label}  (needs ${st.needs})`);
        break;
      }
      const buckets = st.fn(cur, ctx);
      const shape = buckets.map(b => b.join("+")).join("  >  ");
      if (buckets.length <= 1) {
        console.log(`    -        ${st.label}`);
      } else {
        console.log(`    SPLIT    ${st.label}`);
        console.log(`             ${shape}`);
        cur = buckets[0];
        if (cur.length === 1) { console.log(`             ${cur[0]} placed; remaining restart`); break; }
      }
    }
    slotsLeft -= Math.min(slotsLeft, g.length);
  }

  console.log(`\nEngine result: participants ${res.participants.join(" + ") || "none"}`);
  if (res.blocked) console.log(`               contested ${(res.blocked.contested || []).join("/")} needs ${res.blocked.needs}`);
  console.log(`               eliminated ${res.eliminated.join(", ") || "none"}`);
}

let totalMatch = 0, totalWrong = 0, totalBlocked = 0, totalNoGame = 0;

for (const year of years) {
  let season;
  try {
    season = JSON.parse(await readFile(`data/season-${year}.json`, "utf8"));
  } catch {
    console.error(`Could not read data/season-${year}.json — run the fetch script first.`);
    process.exit(1);
  }

  const actual = {};
  (season.championships || []).forEach((g) => { actual[g.homeConf] = pair(g.home, g.away); });

  const contexts = SC.buildSeasonContexts(season, {}, TB);
  const names = Object.keys(contexts).sort();

  console.log(`\n${year}  ${names.length} conferences, ${Object.keys(actual).length} title games on record`);
  console.log("-".repeat(72));

  for (const name of names) {
    const res = SC.resolveWithDivisions(contexts[name], TB);
    const truth = actual[name];

    if (!TB.RULES[name]) {
      console.log(`  SKIP   ${name.padEnd(20)} no rules loaded`);
      continue;
    }
    if (!truth) {
      console.log(`  ---    ${name.padEnd(20)} no championship game this season`);
      totalNoGame++;
      continue;
    }

    if (explainConf && name.toLowerCase() === explainConf.toLowerCase()) {
      explain(name, contexts[name], res);
    }

    if (res.participants.length === 2) {
      const got = pair(res.participants[0], res.participants[1]);
      if (got === truth) {
        totalMatch++;
        console.log(`  MATCH  ${name.padEnd(20)} ${got}`);
      } else {
        totalWrong++;
        console.log(`  WRONG  ${name.padEnd(20)} engine: ${got}`);
        console.log(`         ${"".padEnd(20)} actual: ${truth}`);
        res.trace.slice(-6).forEach((t) =>
          console.log(`         \u00b7 ${t.step} [${t.teams.join(",")}] -> ${t.outcome}`));
      }
    } else {
      totalBlocked++;
      const need = res.blocked ? res.blocked.needs : "unknown";
      const contested = res.blocked && res.blocked.contested
        ? res.blocked.contested.join("/") : "-";
      const named = res.participants.length ? res.participants.join("+") : "none";
      console.log(`  STOP   ${name.padEnd(20)} settled: ${named}; contested: ${contested}`);
      console.log(`         ${"".padEnd(20)} needs: ${need}`);
      console.log(`         ${"".padEnd(20)} actual: ${truth}`);
      // Did the actual participants at least survive to the contested group?
      if (res.blocked && res.blocked.contested) {
        const pool = res.participants.concat(res.blocked.contested);
        const missed = truth.split(" vs ").filter((t) => pool.indexOf(t) < 0);
        if (missed.length) {
          console.log(`         ${"".padEnd(20)} PROBLEM: ${missed.join(", ")} eliminated but actually played`);
        }
      }
    }
  }
}

console.log("\n" + "=".repeat(72));
console.log(`matched ${totalMatch}   wrong ${totalWrong}   stopped early ${totalBlocked}   no title game ${totalNoGame}`);
if (totalWrong) {
  console.log("\nWRONG results are real bugs. STOP results are expected wherever a");
  console.log("conference procedure needs rankings or a draw, but check the PROBLEM");
  console.log("lines: a team that actually played should never be eliminated.");
} else {
  console.log("\nNo incorrect pairings. Review any PROBLEM lines above.");
}
process.exit(totalWrong ? 1 : 0);
