/*
 * Turns a season file plus a set of projected winners into the per-conference
 * contexts the tiebreaker engine consumes.
 *
 * Loads as a plain script in the browser (window.SeasonContext) or via
 * require() in Node for the validation script.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SeasonContext = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /*
   * The Sun Belt is the only FBS conference still using divisions, and CFBD
   * does not supply division membership, so it lives here. Keyed by year
   * because the rosters move: Texas State left for the Pac-12 after 2025 and
   * Louisiana Tech took its place in the West.
   */
  var DIVISIONS = {
    "Sun Belt": {
      east: ["Appalachian State", "Coastal Carolina", "Georgia Southern",
             "Georgia State", "James Madison", "Marshall", "Old Dominion"],
      west: {
        2024: ["Arkansas State", "Louisiana", "Louisiana Monroe", "South Alabama",
               "Southern Mississippi", "Texas State", "Troy"],
        2025: ["Arkansas State", "Louisiana", "Louisiana Monroe", "South Alabama",
               "Southern Mississippi", "Texas State", "Troy"],
        2026: ["Arkansas State", "Louisiana", "Louisiana Monroe", "Louisiana Tech",
               "South Alabama", "Southern Mississippi", "Troy"],
      },
    },
  };

  function divisionOf(conference, year, team) {
    var d = DIVISIONS[conference];
    if (!d) return null;
    if (d.east.indexOf(team) >= 0) return "East";
    var west = d.west[year] || d.west[Object.keys(d.west).sort().pop()];
    if (west && west.indexOf(team) >= 0) return "West";
    return null;
  }

  function isFinal(g) {
    return g.completed && g.homePts !== null && g.awayPts !== null && g.homePts !== g.awayPts;
  }

  /** Which side won: a real result if the game is played, otherwise the pick. */
  function winnerSide(g, picks) {
    if (isFinal(g)) return g.homePts > g.awayPts ? "home" : "away";
    return (picks && picks[g.id]) || null;
  }

  /**
   * Build one context per conference.
   *
   * Only games where both teams are FBS members of the same conference count
   * toward conference records. Overall records include everything, and wins
   * over non-FBS opponents are tracked separately because several conferences
   * cap how many of those count.
   */
  function buildSeasonContexts(season, picks, Tiebreakers) {
    var fbs = {}, conf = {}, rec = {};

    /* Conference championship games carry seasonType "regular" in CFBD, so they
       arrive in the games array looking like ordinary week 15 league games.
       Counting one inflates the winner's record and saddles the loser with a
       loss they did not have when the field was set — which is backwards, since
       the title game is the OUTPUT of the standings, not an input to them. */
    var isTitleGame = {};
    (season.championships || []).forEach(function (g) { isTitleGame[g.id] = true; });

    (season.teams || []).forEach(function (t) {
      fbs[t.school] = true;
      conf[t.school] = t.conference || null;
      rec[t.school] = {
        team: t.school,
        conference: t.conference || null,
        division: divisionOf(t.conference, season.year, t.school),
        cw: 0, cl: 0, cpct: 0,
        w: 0, l: 0, pct: 0,
        fcsWins: 0,
        opp: {},
      };
    });

    (season.games || []).forEach(function (g) {
      if (isTitleGame[g.id]) return;
      var side = winnerSide(g, picks);
      if (!side) return;

      var win = side === "home" ? g.home : g.away;
      var lose = side === "home" ? g.away : g.home;

      if (rec[win]) {
        rec[win].w++;
        if (!fbs[lose]) rec[win].fcsWins++;
      }
      if (rec[lose]) rec[lose].l++;

      var sameConf = g.confGame && fbs[g.home] && fbs[g.away] &&
                     conf[g.home] && conf[g.home] === conf[g.away];
      if (!sameConf) return;

      rec[win].cw++;
      rec[lose].cl++;
      rec[win].opp[lose] = { result: "W", pf: null, pa: null };
      rec[lose].opp[win] = { result: "L", pf: null, pa: null };
    });

    Object.keys(rec).forEach(function (t) {
      var r = rec[t];
      r.cpct = (r.cw + r.cl) ? r.cw / (r.cw + r.cl) : 0;
      r.pct = (r.w + r.l) ? r.w / (r.w + r.l) : 0;
    });

    var byConf = {};
    Object.keys(rec).forEach(function (t) {
      var c = rec[t].conference;
      if (!c || c === "Independent") return;
      (byConf[c] = byConf[c] || []).push(t);
    });

    var out = {};
    Object.keys(byConf).forEach(function (c) {
      out[c] = Tiebreakers.buildContext(c, byConf[c], rec);
    });
    return out;
  }

  /**
   * Resolve one conference, handling divisional leagues.
   *
   * A divisional conference is two independent one-slot races, so each division
   * gets its own context restricted to its own members — which also makes the
   * "next highest position in the standings" step walk divisional standings
   * rather than the whole league, as the Sun Belt's procedure requires.
   */
  function resolveWithDivisions(ctx, Tiebreakers) {
    var rules = Tiebreakers.RULES[ctx.conference];
    if (!rules || !rules.divisions) return Tiebreakers.resolveConference(ctx, 2);

    var divs = {};
    ctx.members.forEach(function (t) {
      var d = ctx.rec[t].division;
      if (!d) return;
      (divs[d] = divs[d] || []).push(t);
    });

    var names = Object.keys(divs).sort();
    if (names.length < 2) {
      return {
        order: [], participants: [], eliminated: [], tiers: [], trace: [],
        blocked: { needs: "division assignments missing for " + ctx.conference },
        seedingBlocked: null,
      };
    }

    var participants = [], eliminated = [], trace = [], blocked = null, tiers = [];
    names.forEach(function (d) {
      var sub = Tiebreakers.buildContext(ctx.conference, divs[d], ctx.rec);
      var res = Tiebreakers.resolveConference(sub, 1);
      participants = participants.concat(res.participants);
      eliminated = eliminated.concat(res.eliminated);
      tiers = tiers.concat(res.tiers);
      trace = trace.concat(res.trace.map(function (x) {
        return { step: d + ": " + x.step, teams: x.teams, outcome: x.outcome, needs: x.needs };
      }));
      if (res.blocked && !blocked) blocked = res.blocked;
    });

    return {
      order: participants.concat(eliminated),
      tiers: tiers,
      participants: participants,
      eliminated: eliminated,
      blocked: blocked,
      seedingBlocked: null,
      trace: trace,
      divisional: true,
    };
  }

  return {
    buildSeasonContexts: buildSeasonContexts,
    resolveWithDivisions: resolveWithDivisions,
    divisionOf: divisionOf,
    winnerSide: winnerSide,
    isFinal: isFinal,
    DIVISIONS: DIVISIONS,
  };
});
