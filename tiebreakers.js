/*
 * Conference tiebreaker engine.
 *
 * Loads as a plain script in the browser (window.Tiebreakers) or via require()
 * in Node for the test suite.
 *
 * Two ideas drive the design:
 *
 * 1. Every step returns BUCKETS, not a winner — an array of arrays ordered best
 *    to worst. One bucket means the step separated nobody. This matches how the
 *    documents actually read: a step can split three tied teams into 1-and-2 or
 *    2-and-1, not just pick a winner.
 *
 * 2. Any separation RESTARTS the procedure for each resulting bucket. Every
 *    conference says some version of this ("the remaining teams revert to the
 *    beginning of the applicable tiebreaker procedures"), and it is the single
 *    most-missed rule in amateur implementations.
 *
 * Steps that cannot be computed from wins and losses — proprietary analytics
 * ratings, CFP rankings, coin tosses — are marked blocked. The engine stops
 * there and reports what it needs rather than inventing an answer.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Tiebreakers = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Context
   * ------------------------------------------------------------------ */

  /**
   * Build the per-conference view the engine works from.
   * rec[team] = {
   *   cw, cl, cpct,        conference record
   *   w, l, pct,           overall record
   *   fcsWins,             wins over non-FBS opponents
   *   opp: { name: { result, pf, pa } }   conference results only
   *   division             optional
   * }
   */
  function buildContext(conference, members, rec) {
    return { conference: conference, members: members.slice(), rec: rec };
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function pct(w, l) { return (w + l) > 0 ? w / (w + l) : 0; }

  /** Group team names into buckets by a numeric score, highest first. */
  function bucketByScore(group, scoreOf) {
    var scored = group.map(function (t) { return { team: t, s: scoreOf(t) }; });
    var valid = scored.filter(function (x) { return x.s !== null; });
    if (valid.length !== scored.length) return [group.slice()]; // incomparable
    valid.sort(function (a, b) { return b.s - a.s; });
    var out = [], cur = [], last = null;
    valid.forEach(function (x) {
      if (last === null || Math.abs(x.s - last) < 1e-9) cur.push(x.team);
      else { out.push(cur); cur = [x.team]; }
      last = x.s;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  /** Conference opponents a team faced. */
  function oppsOf(ctx, team) { return Object.keys(ctx.rec[team].opp || {}); }

  /** Opponents every team in the group played, excluding group members. */
  function commonOpponents(ctx, group) {
    var inGroup = {};
    group.forEach(function (t) { inGroup[t] = true; });
    var counts = {};
    group.forEach(function (t) {
      oppsOf(ctx, t).forEach(function (o) {
        if (!inGroup[o]) counts[o] = (counts[o] || 0) + 1;
      });
    });
    return Object.keys(counts).filter(function (o) { return counts[o] === group.length; });
  }

  /** A team's W-L against a set of opponents. */
  function recordAgainst(ctx, team, opponents) {
    var w = 0, l = 0, opp = ctx.rec[team].opp || {};
    opponents.forEach(function (o) {
      if (!opp[o]) return;
      if (opp[o].result === "W") w++; else if (opp[o].result === "L") l++;
    });
    return { w: w, l: l, pct: pct(w, l), played: w + l };
  }

  /** Conference standings as ordered buckets of teams level on win percentage. */
  function standingsBuckets(ctx) {
    return bucketByScore(ctx.members, function (t) { return ctx.rec[t].cpct; });
  }

  /* ------------------------------------------------------------------ *
   * Step primitives — each returns buckets, best to worst
   * ------------------------------------------------------------------ */

  /**
   * Head-to-head among the tied teams (the "mini round robin").
   *
   * When every tied pair has met, all conferences compare win percentage within
   * the group. When they have not, the documents diverge sharply and the
   * difference decides real seasons:
   *
   *   "sweep"            a team that beat all the others advances; nothing else
   *                      separates anyone. Big Ten, Big 12, MAC, American,
   *                      Mountain West.
   *   "sweepOrEliminate" as above, and additionally a team that LOST to all the
   *                      others is eliminated. Only the SEC and ACC say this.
   *   "pct"              always compare win percentage among the tied teams.
   *
   * Applying the elimination clause everywhere was wrong: in the 2025 MAC,
   * Miami (OH) lost to both Ohio and Toledo, who never played each other. Under
   * "sweep" nobody separates and all three advance to common opponents, where
   * Miami goes 3-0 and takes the slot — which is what happened.
   */
  function headToHead(mode) {
    return function (group, ctx) {
      if (group.length === 2) {
        var a = group[0], b = group[1];
        var r = (ctx.rec[a].opp || {})[b];
        if (!r) return [group.slice()];
        return r.result === "W" ? [[a], [b]] : [[b], [a]];
      }

      var complete = group.every(function (t) {
        return group.every(function (o) {
          return o === t || (ctx.rec[t].opp || {})[o];
        });
      });

      if (complete || mode === "pct") {
        var buckets = bucketByScore(group, function (t) {
          var r = recordAgainst(ctx, t, group.filter(function (o) { return o !== t; }));
          return r.played ? r.pct : null;
        });
        return buckets;
      }

      // Incomplete round robin: only a sweep or a total loss separates anyone.
      var beatAll = group.filter(function (t) {
        return group.every(function (o) {
          return o === t || ((ctx.rec[t].opp || {})[o] || {}).result === "W";
        });
      });
      if (beatAll.length === 1) {
        return [beatAll, group.filter(function (t) { return t !== beatAll[0]; })];
      }

      if (mode === "sweepOrEliminate") {
        var lostAll = group.filter(function (t) {
          return group.every(function (o) {
            return o === t || ((ctx.rec[t].opp || {})[o] || {}).result === "L";
          });
        });
        if (lostAll.length === 1) {
          return [group.filter(function (t) { return t !== lostAll[0]; }), lostAll];
        }
      }
      return [group.slice()];
    };
  }

  /** Common conference opponents from outside the tied teams' own division. */
  function vsCommonNonDivisional(group, ctx) {
    var div = ctx.rec[group[0]].division;
    var common = commonOpponents(ctx, group).filter(function (o) {
      return ctx.rec[o] && ctx.rec[o].division !== div;
    });
    if (!common.length) return [group.slice()];
    return bucketByScore(group, function (t) {
      return recordAgainst(ctx, t, common).pct;
    });
  }

  /** Record versus all common conference opponents. */
  function vsAllCommon(group, ctx) {
    var common = commonOpponents(ctx, group);
    if (!common.length) return [group.slice()];
    return bucketByScore(group, function (t) {
      return recordAgainst(ctx, t, common).pct;
    });
  }

  /**
   * Record against the best-placed common opponent, walking down the standings.
   *
   * Two subtleties both taken straight from the documents:
   *  - a standings position occupied by several tied teams is treated as ONE
   *    position, and records against the whole group are combined
   *  - but if head-to-head can break that lower tie, the resulting order is used
   *    instead (this is the SEC's Example #1 versus Example #3 distinction)
   */
  function vsOrderOfFinish(group, ctx) {
    var inGroup = {};
    group.forEach(function (t) { inGroup[t] = true; });

    var positions = [];
    standingsBuckets(ctx).forEach(function (bucket) {
      var outside = bucket.filter(function (t) { return !inGroup[t]; });
      if (!outside.length) return;
      if (outside.length > 1) {
        var split = headToHead("sweep")(outside, ctx);
        split.forEach(function (p) { positions.push(p); });
      } else {
        positions.push(outside);
      }
    });

    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i];
      // Every tied team must have played someone at this position.
      var allPlayed = group.every(function (t) {
        return pos.some(function (o) { return (ctx.rec[t].opp || {})[o]; });
      });
      if (!allPlayed) continue;

      // Restrict to opponents in this position that ALL tied teams faced.
      var shared = pos.filter(function (o) {
        return group.every(function (t) { return (ctx.rec[t].opp || {})[o]; });
      });
      if (!shared.length) continue;

      var buckets = bucketByScore(group, function (t) {
        return recordAgainst(ctx, t, shared).pct;
      });
      if (buckets.length > 1) return buckets;
    }
    return [group.slice()];
  }

  /** Cumulative conference win percentage of each team's conference opponents. */
  function opponentsSOS(group, ctx) {
    return bucketByScore(group, function (t) {
      var opps = oppsOf(ctx, t);
      if (!opps.length) return null;
      var sum = opps.reduce(function (acc, o) {
        return acc + (ctx.rec[o] ? ctx.rec[o].cpct : 0);
      }, 0);
      return sum / opps.length;
    });
  }

  /** Overall winning percentage, optionally capping wins over non-FBS teams. */
  function overallWinPct(capFcsWins) {
    return function (group, ctx) {
      return bucketByScore(group, function (t) {
        var r = ctx.rec[t];
        var w = r.w, l = r.l;
        if (capFcsWins && r.fcsWins > 1) w -= (r.fcsWins - 1);
        return pct(w, l);
      });
    };
  }

  /** Total wins, counting at most one win over a non-FBS opponent (Big 12). */
  function totalWins(group, ctx) {
    return bucketByScore(group, function (t) {
      var r = ctx.rec[t];
      var w = r.w;
      if (r.fcsWins > 1) w -= (r.fcsWins - 1);
      return w;
    });
  }

  /** Winning percentage within the team's own division (Sun Belt). */
  function divisionalWinPct(group, ctx) {
    return bucketByScore(group, function (t) {
      var div = ctx.rec[t].division;
      if (!div) return null;
      var mates = oppsOf(ctx, t).filter(function (o) {
        return ctx.rec[o] && ctx.rec[o].division === div;
      });
      if (!mates.length) return null;
      return recordAgainst(ctx, t, mates).pct;
    });
  }

  /**
   * Capped relative total scoring margin, per the SEC's Appendix A.
   *
   * For each conference game: relative scoring offense is the team's points as
   * a percentage of what the opponent typically allows, capped at 200%.
   * Relative scoring defense is points allowed as a percentage of what the
   * opponent typically scores, floored at 0%. Margin is offense minus defense,
   * averaged across the team's conference games.
   *
   * The document says opponent averages are taken "for the season" while the
   * margin itself is computed "versus all Conference opponents". Season-wide
   * averages are used here; SEASON_AVERAGES flips it if that reading is wrong.
   */
  var SEASON_AVERAGES = true;

  function cappedScoringMargin(group, ctx) {
    return bucketByScore(group, function (t) {
      var opp = ctx.rec[t].opp || {};
      var names = Object.keys(opp);
      if (!names.length) return null;
      var total = 0, counted = 0;
      for (var i = 0; i < names.length; i++) {
        var o = names[i], g = opp[o], or = ctx.rec[o];
        if (!or || g.pf == null || g.pa == null) return null;
        var avgAllowed = SEASON_AVERAGES ? or.avgAllowed : or.avgAllowedConf;
        var avgScored = SEASON_AVERAGES ? or.avgScored : or.avgScoredConf;
        if (!avgAllowed || !avgScored) return null;
        var off = Math.min((g.pf / avgAllowed) * 100, 200);
        var def = Math.max((g.pa / avgScored) * 100, 0);
        total += (off - def);
        counted++;
      }
      return counted ? total / counted : null;
    });
  }

  /* ------------------------------------------------------------------ *
   * Steps that cannot be derived from projected results
   * ------------------------------------------------------------------ */

  function blocked(label, needs) {
    return { label: label, needs: needs, blocked: true };
  }

  var SPORTSOURCE = function (l) { return blocked(l, "SportSource Analytics rating"); };
  var CFP = function (l) { return blocked(l, "CFP Selection Committee rankings"); };
  var COMPOSITE = function (l) { return blocked(l, "composite computer rankings"); };
  var DRAW = function (l) { return blocked(l, "random draw"); };
  var SCORES = function (l) { return blocked(l, "final scores"); };

  function step(label, fn) { return { label: label, fn: fn, blocked: false }; }

  /* ------------------------------------------------------------------ *
   * Conference rules
   * ------------------------------------------------------------------ */

  var RULES = {};

  RULES["SEC"] = {
    steps: [
      step("Head-to-head competition among the tied teams", headToHead("sweepOrEliminate")),
      step("Record versus all common conference opponents", vsAllCommon),
      step("Record against highest-placed common conference opponent", vsOrderOfFinish),
      step("Cumulative conference winning percentage of all opponents", opponentsSOS),
      SCORES("Capped relative total scoring margin"),
      DRAW("Random draw of the tied teams"),
    ],
  };

  RULES["Big Ten"] = {
    steps: [
      step("Head-to-head competition among the tied teams", headToHead("sweep")),
      step("Record against all common conference opponents", vsAllCommon),
      step("Record against common opponents by order of finish", vsOrderOfFinish),
      step("Cumulative conference winning percentage of all opponents", opponentsSOS),
      SPORTSOURCE("Highest SportSource Analytics Team Rating Score"),
      DRAW("Random draw among the tied teams"),
    ],
  };

  RULES["Big 12"] = {
    steps: [
      step("Head-to-head competition among the tied teams", headToHead("sweep")),
      step("Win percentage against all common conference opponents", vsAllCommon),
      step("Win percentage against next highest placed common opponent", vsOrderOfFinish),
      step("Combined win percentage of conference opponents", opponentsSOS),
      step("Total wins, counting at most one non-FBS win", totalWins),
      SPORTSOURCE("Highest SportSource Analytics Team Rating Score"),
      DRAW("Coin toss"),
    ],
  };

  RULES["ACC"] = {
    steps: [
      step("Head-to-head competition among the tied teams", headToHead("sweepOrEliminate")),
      SPORTSOURCE("Best SportSource Analytics Team Success Ranking"),
      DRAW("Draw administered by the Commissioner"),
    ],
    // The ACC also counts teams on an alternate number of conference games with
    // either the same wins or the same losses as tied. See defineTied below.
    defineTied: "acc",
  };

  RULES["Mid-American"] = {
    steps: [
      step("Head-to-head competition among the tied teams", headToHead("sweep")),
      step("Win percentage versus all common opponents", vsAllCommon),
      SPORTSOURCE("Higher SportSource Analytics Team Rating Score"),
      step("Win percentage versus common opponents by order of finish", vsOrderOfFinish),
      step("Combined conference win percentage of conference opponents", opponentsSOS),
      DRAW("Draw administered by the Commissioner"),
    ],
  };

  RULES["Conference USA"] = {
    steps: [
      step("Head-to-head competition", headToHead("sweep")),
      step("Winning percentage against common conference opponents", vsAllCommon),
      step("Record against the teams with the best conference record", vsOrderOfFinish),
      COMPOSITE("Average of Connelly SP+, SportSource, ESPN SOR and KPI"),
      step("Cumulative conference winning percentage of all opponents", opponentsSOS),
      DRAW("Coin toss"),
    ],
    defineTied: "cusa",
  };

  RULES["American Athletic"] = {
    steps: [
      step("Head-to-head competition among the tied teams", headToHead("sweep")),
      CFP("CFP Selection Committee rankings, then computer composite"),
      step("Win percentage against all common conference opponents", vsAllCommon),
      step("Highest overall winning percentage", overallWinPct(false)),
      DRAW("Coin toss"),
    ],
    defineTied: "aac",
  };

  RULES["Mountain West"] = {
    steps: [
      step("Head-to-head result between the tied teams", headToHead("sweep")),
      CFP("Highest CFP Selection Committee ranking, or computer composite"),
      step("Overall winning percentage, capping non-FBS wins at one", overallWinPct(true)),
      step("Record against the next highest-placed team in the standings", vsOrderOfFinish),
      step("Winning percentage against common conference opponents", vsAllCommon),
      DRAW("Coin toss conducted by the Commissioner"),
    ],
  };

  RULES["Sun Belt"] = {
    // The only FBS conference still using divisions: the title game is East
    // champion versus West champion, so each division is its own one-slot race.
    divisions: true,
    steps: [
      step("Head-to-head result between tied teams", headToHead("sweep")),
      step("Highest divisional winning percentage", divisionalWinPct),
      step("Record against the next highest position in the division", vsOrderOfFinish),
      step("Winning percentage against common non-divisional opponents", vsCommonNonDivisional),
      CFP("CFP Selection Committee rankings, then computer composite"),
      step("Highest overall winning percentage against FBS teams", overallWinPct(true)),
      DRAW("Coin toss conducted by the Commissioner"),
    ],
  };

  /* ------------------------------------------------------------------ *
   * Tie-group definition (conference-specific)
   * ------------------------------------------------------------------ */

  /**
   * Most conferences define tied teams as those level on conference win
   * percentage. The ACC, C-USA and the American extend that to teams on an
   * alternate number of games, because unbalanced schedules make raw percentage
   * a poor proxy for who is genuinely in contention.
   */
  function defineTiedTeams(ctx, rules) {
    var buckets = standingsBuckets(ctx);
    var mode = rules.defineTied;
    if (!mode || !buckets.length) return buckets;

    var lead = buckets[0];
    var leadRec = ctx.rec[lead[0]];
    var extra = [];

    ctx.members.forEach(function (t) {
      if (lead.indexOf(t) >= 0) return;
      var r = ctx.rec[t];
      var played = r.cw + r.cl, leadPlayed = leadRec.cw + leadRec.cl;
      if (played === leadPlayed) return; // only alternate game counts qualify

      if (mode === "acc") {
        // Same number of wins OR same number of losses as the leader.
        if (r.cw === leadRec.cw || r.cl === leadRec.cl) extra.push(t);
      } else if (mode === "cusa") {
        // Within one win of the leader AND an equal number of losses.
        if (r.cl === leadRec.cl && Math.abs(r.cw - leadRec.cw) <= 1) extra.push(t);
      } else if (mode === "aac") {
        // Tied in the loss column.
        if (r.cl === leadRec.cl) extra.push(t);
      }
    });

    if (!extra.length) return buckets;
    var merged = lead.concat(extra);
    var rest = buckets.slice(1).map(function (b) {
      return b.filter(function (t) { return extra.indexOf(t) < 0; });
    }).filter(function (b) { return b.length; });
    return [merged].concat(rest);
  }

  /* ------------------------------------------------------------------ *
   * Driver
   * ------------------------------------------------------------------ */

  /**
   * Rank a tied group into TIERS. A tier is a set of teams the procedure could
   * not separate from one another. [[A],[B,C]] means A is clear of B and C,
   * who remain level with each other.
   *
   * Note this deliberately keeps going after a blocked sub-group: if the top
   * three cannot be separated but the fourth team lost to all of them, that
   * fourth team is genuinely eliminated and saying so is useful.
   */
  function rankGroup(group, ctx, rules, trace, depth) {
    if (group.length === 0) return { tiers: [], needs: null };
    if (group.length === 1) return { tiers: [group.slice()], needs: null };
    if (depth > 12) return { tiers: [group.slice()], needs: "recursion limit" };

    for (var i = 0; i < rules.steps.length; i++) {
      var s = rules.steps[i];

      if (s.blocked) {
        trace.push({ step: s.label, teams: group.slice(), outcome: "blocked", needs: s.needs });
        var stalled = group.slice();
        stalled.needs = s.needs;
        return { tiers: [stalled], needs: s.needs };
      }

      var buckets = s.fn(group, ctx);
      if (buckets.length <= 1) {
        trace.push({ step: s.label, teams: group.slice(), outcome: "no separation" });
        continue;
      }

      trace.push({
        step: s.label,
        teams: group.slice(),
        outcome: "separated",
        result: buckets.map(function (b) { return b.slice(); }),
      });

      // Separation achieved: every resulting bucket restarts the procedure.
      var tiers = [], needs = null;
      for (var j = 0; j < buckets.length; j++) {
        var sub = rankGroup(buckets[j], ctx, rules, trace, depth + 1);
        tiers = tiers.concat(sub.tiers);
        if (sub.needs && !needs) needs = sub.needs;
      }
      return { tiers: tiers, needs: needs };
    }

    var exhausted = group.slice();
    exhausted.needs = "all steps exhausted";
    return { tiers: [exhausted], needs: exhausted.needs };
  }

  /**
   * Order a conference and name its championship game participants.
   *
   * Determining PARTICIPANTS and determining SEEDING are separate questions.
   * Two teams left level for the last two slots are both in the title game
   * even if nothing can rank them — the unresolved comparison decides only
   * who hosts. Reporting that as "blocked" would be wrong.
   */
  function resolveConference(ctx, slots) {
    slots = slots || 2;
    var rules = RULES[ctx.conference];
    if (!rules) {
      return {
        order: [], participants: [], eliminated: [], tiers: [],
        blocked: { needs: "no tiebreaker rules loaded for " + ctx.conference },
        seedingBlocked: null, trace: [],
      };
    }

    var trace = [];
    var tiers = [], needs = null;
    defineTiedTeams(ctx, rules).forEach(function (g) {
      var r = rankGroup(g, ctx, rules, trace, 0);
      tiers = tiers.concat(r.tiers);
      if (r.needs && !needs) needs = r.needs;
    });

    var participants = [], blocked = null, seedingBlocked = null, idx = 0;
    for (; idx < tiers.length && participants.length < slots; idx++) {
      var tier = tiers[idx];
      var room = slots - participants.length;
      if (tier.length <= room) {
        participants = participants.concat(tier);
        // A tier of two filling the last two slots settles who plays but not
        // who hosts.
        if (tier.length > 1) seedingBlocked = { needs: tier.needs || needs, teams: tier.slice() };
      } else {
        blocked = { needs: tier.needs || needs, contested: tier.slice(), slots: room };
        break;
      }
    }

    var placed = {};
    participants.forEach(function (t) { placed[t] = true; });
    if (blocked) blocked.contested.forEach(function (t) { placed[t] = true; });

    var eliminated = [];
    tiers.forEach(function (tier) {
      tier.forEach(function (t) { if (!placed[t]) eliminated.push(t); });
    });

    return {
      order: tiers.reduce(function (a, b) { return a.concat(b); }, []),
      tiers: tiers,
      participants: participants,
      eliminated: eliminated,
      blocked: blocked,
      seedingBlocked: seedingBlocked,
      trace: trace,
    };
  }

  return {
    buildContext: buildContext,
    resolveConference: resolveConference,
    rankGroup: rankGroup,
    defineTiedTeams: defineTiedTeams,
    standingsBuckets: standingsBuckets,
    commonOpponents: commonOpponents,
    recordAgainst: recordAgainst,
    RULES: RULES,
    _steps: {
      headToHead: headToHead,
      vsAllCommon: vsAllCommon,
      vsCommonNonDivisional: vsCommonNonDivisional,
      vsOrderOfFinish: vsOrderOfFinish,
      opponentsSOS: opponentsSOS,
      overallWinPct: overallWinPct,
      totalWins: totalWins,
      divisionalWinPct: divisionalWinPct,
      cappedScoringMargin: cappedScoringMargin,
    },
  };
});
