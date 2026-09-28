/**
 * Counter's report card (F18): grade a shoe, or a whole session, against a
 * perfect Hi-Lo counter playing the same rounds. Pure and DOM-free
 * (window.BlackjackReport in the browser, module.exports under Node).
 *
 * A tracker collects, per shoe:
 *   rounds: [{bet, suggested, unit, spots, tc, net, evLost}]  bet/suggested per spot
 *   spots:  [{hand, up, tc, index, play, move}]              deviation spots
 *   checks: [true/false]                                      Q count checks
 *   endRunning / endGuess                                     count at the reshuffle
 *
 * Money compares expectations, not a replay: each round's expected result
 * is bet x spots x edge(TC), where edge(TC) = -houseEdge + 0.5% per point of
 * true count (the usual Hi-Lo rule of thumb), minus the EV given away on
 * basic-strategy mistakes (F14). The perfect counter bets the ramp and
 * gives nothing away. So:
 *   luck      = your result - what your bets and play were expected to make
 *   skill gap = what the perfect counter expected - what you expected
 * Following the ramp and every index exactly gives a skill gap of 0.
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;
  const Strategy = node ? require('./strategy.js') : root.BlackjackStrategy;
  const Counting = node ? require('./counting.js') : root.BlackjackCounting;

  const EDGE_PER_TRUE_COUNT = 0.005;

  const cardText = (cards) => cards.map((c) => c.rank).join(',');
  const upText = (card) => (card.rank === 'A' ? 'A' : String(BJ.cardValue(card)));

  /**
   * The deviation spot at the game's current decision, whether or not the
   * count is on screen: {hand, up, tc, index, play} when the Hi-Lo count
   * play differs from basic strategy, else null.
   */
  function countSpot(game) {
    const tc = Math.floor(Counting.countState(game).trueCount);
    if (game.phase === 'insurance') {
      const ins = Counting.countInsurance(tc, game.evenMoneyOffered);
      return ins ? { hand: game.evenMoneyOffered ? 'Even money' : 'Insurance', up: 'A', tc, index: ins.index, play: 'insurance' } : null;
    }
    const h = game.currentHand;
    if (game.phase !== 'player' || !h) return null;
    const allowed = {
      canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender(), canHit: game.canHit(),
    };
    const basic = Strategy.recommend(h.cards, game.dealer[0], allowed, game.rules);
    const play = Counting.countPlay(h.cards, game.dealer[0], allowed, basic, tc, game.rules);
    if (!play.deviation) return null;
    return { hand: cardText(h.cards), up: upText(game.dealer[0]), tc, index: play.index, play: play.action };
  }
  const REPORTS_MAX = 20;

  function newShoe(meta = {}) {
    return { ...meta, rounds: [], spots: [], checks: [], endRunning: null, endGuess: null };
  }

  /** Call at the deal. `bet` and `suggested` are per spot, in dollars. */
  function recordBet(shoe, { bet, suggested, unit, spots = 1, tc }) {
    shoe.rounds.push({ bet, suggested, unit, spots, tc, net: 0, evLost: 0 });
  }

  /** Call when the round is settled. */
  function recordResult(shoe, { net, evLost = 0 }) {
    const r = shoe.rounds[shoe.rounds.length - 1];
    if (!r) return;
    r.net = net;
    r.evLost = evLost;
  }

  /** A decision where the count play differs from basic strategy. */
  function recordSpot(shoe, { hand, up, tc, index, play, move }) {
    shoe.spots.push({ hand, up, tc, index, play, move });
  }

  function recordCheck(shoe, right) {
    shoe.checks.push(!!right);
  }

  /** Pearson correlation, or null when either series never changes. */
  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    if (sxx < 1e-12 || syy < 1e-12) return null;
    return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  }

  const edgeAt = (tc, houseEdge) => -houseEdge / 100 + EDGE_PER_TRUE_COUNT * tc;

  /**
   * Grade one or more shoes. `houseEdge` in percent (rules.houseEdge).
   * Returns every number the report shows plus a plain-English `betNote`.
   */
  function grade(shoes, { houseEdge = 0 } = {}) {
    const list = Array.isArray(shoes) ? shoes : [shoes];
    const rounds = list.flatMap((s) => s.rounds);
    const spots = list.flatMap((s) => s.spots);
    const checks = list.flatMap((s) => s.checks);
    const bets = rounds.map((r) => r.bet);
    const ramp = rounds.map((r) => r.suggested);
    const r = pearson(bets, ramp);
    const within = rounds.length
      ? rounds.filter((x) => Math.abs(x.bet - x.suggested) <= x.unit + 1e-9).length / rounds.length : null;
    let betNote = null;
    if (rounds.length < 2) betNote = 'Play at least two rounds to measure bet correlation.';
    else if (r === null && new Set(bets).size === 1) {
      betNote = 'Flat betting: your bet never changed, so there is no correlation with the count to measure.';
    } else if (r === null) betNote = 'The count never called for a different bet, so there is nothing to correlate.';

    let expected = 0;
    let perfect = 0;
    let net = 0;
    let evLost = 0;
    for (const x of rounds) {
      const e = edgeAt(x.tc, houseEdge);
      expected += x.bet * x.spots * e - x.evLost;
      perfect += x.suggested * x.spots * e;
      net += x.net;
      evLost += x.evLost;
    }
    const taken = spots.filter((s) => s.move === s.play).length;
    const last = list[list.length - 1];
    const endError = last && last.endRunning !== null && last.endGuess !== null ? last.endGuess - last.endRunning : null;
    return {
      shoes: list.length,
      rounds: rounds.length,
      r, within, betNote,
      spots: spots.length, taken,
      missed: spots.filter((s) => s.move !== s.play),
      checks: checks.length, checksRight: checks.filter(Boolean).length,
      endRunning: last ? last.endRunning : null, endError,
      net, expected, perfect, evLost,
      luck: net - expected,
      skillGap: perfect - expected,
    };
  }

  /** Compact saved form of a finished shoe (kept to the last 20). */
  function summary(shoe, opts, when = Date.now()) {
    const g = grade(shoe, opts);
    return {
      when, shoeSeed: shoe.shoeSeed || null, rounds: g.rounds, r: g.r, within: g.within, spots: g.spots, taken: g.taken,
      missed: g.missed.map((m) => `${m.hand} vs ${m.up} at ${m.tc >= 0 ? '+' : ''}${m.tc} (index ${m.index >= 0 ? '+' : ''}${m.index}: ${m.play})`),
      checks: g.checks, checksRight: g.checksRight, endError: g.endError,
      net: round2(g.net), expected: round2(g.expected), perfect: round2(g.perfect), luck: round2(g.luck),
      skillGap: round2(g.skillGap), evLost: round2(g.evLost),
    };
  }
  const round2 = (x) => Math.round(x * 100) / 100;

  function addReport(reports, s, max = REPORTS_MAX) {
    return [s, ...(reports || [])].slice(0, max);
  }

  function parseReports(json) {
    try {
      const a = JSON.parse(json);
      return Array.isArray(a) ? a.filter((x) => x && typeof x === 'object' && Number.isFinite(x.rounds)).slice(0, REPORTS_MAX) : [];
    } catch {
      return [];
    }
  }

  const REPORT_COLUMNS = ['shoe_ended', 'shoe_seed', 'rounds', 'bet_correlation', 'within_one_unit', 'index_spots', 'index_taken',
    'index_missed', 'count_checks', 'count_checks_right', 'end_count_error', 'net', 'expected', 'perfect_counter',
    'luck', 'skill_gap', 'ev_given_away'];

  /** Shoe reports as CSV rows (newest last), for the history export. */
  function reportsCSV(reports, field) {
    const rows = reports.slice().reverse().map((s) => [
      new Date(s.when).toISOString(), s.shoeSeed || '', s.rounds, s.r === null ? '' : s.r.toFixed(3),
      s.within === null ? '' : `${Math.round(s.within * 100)}%`, s.spots, s.taken, s.missed.join('; '),
      s.checks, s.checksRight, s.endError === null ? '' : s.endError, s.net, s.expected, s.perfect, s.luck,
      s.skillGap, s.evLost,
    ].map(field).join(','));
    return [REPORT_COLUMNS.join(','), ...rows].join('\n') + '\n';
  }

  const api = {
    EDGE_PER_TRUE_COUNT, REPORTS_MAX, countSpot, newShoe, recordBet, recordResult, recordSpot, recordCheck,
    pearson, edgeAt, grade, summary, addReport, parseReports, reportsCSV, REPORT_COLUMNS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
