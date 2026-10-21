/**
 * Basic-strategy chart for the active rules, built from the coach itself
 * (strategy.recommend) so the chart and the coach can never disagree.
 * Pure and DOM-free (window.BlackjackChart in the browser, module.exports
 * under Node).
 *
 * Codes: H hit, S stand, D double (else hit), Ds double (else stand),
 * P split, R surrender (else hit), Rs surrender (else stand), Rp surrender
 * (else split).
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;
  const Strategy = node ? require('./strategy.js') : root.BlackjackStrategy;

  const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; // 11 = ace
  const upRank = (u) => (u === 11 ? 'A' : String(u));
  const upLabel = (u) => (u === 11 ? 'A' : String(u));
  const rank = (v) => (v === 11 || v === 1 ? 'A' : v === 10 ? '10' : String(v));

  /** Row keys in display order, grouped. Pair values use 11 for aces. */
  const GROUPS = [
    { title: 'Hard totals', rows: Array.from({ length: 16 }, (_, i) => `hard ${i + 5}`) },
    { title: 'Soft totals', rows: Array.from({ length: 8 }, (_, i) => `soft ${i + 13}`) },
    { title: 'Pairs', rows: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((v) => `pair ${v}`) },
  ];

  /** Row label as players read it: "12", "A,6", "8,8". */
  function rowLabel(row) {
    const [kind, n] = [row.split(' ')[0], Number(row.split(' ')[1])];
    if (kind === 'hard') return String(n);
    if (kind === 'soft') return `A,${n - 11}`;
    return `${rank(n)},${rank(n)}`;
  }

  /** A two-card hand that belongs to a row (hard 20 = K,Q: not a pair). */
  function handFor(row) {
    const [kind, n] = [row.split(' ')[0], Number(row.split(' ')[1])];
    const c = (r) => ({ rank: r, suit: '♠' });
    if (kind === 'pair') return [c(rank(n)), c(rank(n))];
    if (kind === 'soft') return [c('A'), c(rank(n - 11))];
    if (n === 20) return [c('K'), c('Q')];
    if (n <= 11) return [c('2'), c(rank(n - 2))]; // 2,3 ... 2,9
    return [c('10'), c(rank(n - 10))];             // 10,2 ... 10,9
  }

  /** Which chart cell a hand is in. A pair you can't split counts as its total. */
  function cellKey(cards, upcard, canSplit = true) {
    const up = BJ.cardValue(upcard);
    const { total, soft } = BJ.handValue(cards);
    if (canSplit && cards.length === 2 && cards[0].rank === cards[1].rank) {
      return `pair ${BJ.cardValue(cards[0])}|${up}`;
    }
    return `${soft && total < 21 ? 'soft' : 'hard'} ${total}|${up}`;
  }

  /** Chart code for one cell under the given rules. */
  function code(row, up, rules) {
    const cards = handFor(row);
    const upcard = { rank: upRank(up), suit: '♥' };
    const all = { canDouble: true, canSplit: true, canSurrender: !!rules.lateSurrender };
    const a = Strategy.recommend(cards, upcard, all, rules).action;
    if (a === 'double') {
      const b = Strategy.recommend(cards, upcard, { ...all, canDouble: false }, rules).action;
      return b === 'stand' ? 'Ds' : 'D';
    }
    if (a === 'surrender') {
      const b = Strategy.recommend(cards, upcard, { ...all, canSurrender: false }, rules).action;
      return b === 'stand' ? 'Rs' : b === 'split' ? 'Rp' : 'R';
    }
    return { hit: 'H', stand: 'S', split: 'P' }[a];
  }

  const LEGEND = [
    ['H', 'Hit'], ['S', 'Stand'], ['D', 'Double, else hit'], ['Ds', 'Double, else stand'],
    ['P', 'Split'], ['R', 'Surrender, else hit'], ['Rs', 'Surrender, else stand'],
    ['Rp', 'Surrender, else split'],
  ];

  /** The whole chart: [{title, rows: [{row, label, cells: [{up, code}]}]}]. */
  function buildChart(rules) {
    const r = { ...Strategy.DEFAULT_RULES, lateSurrender: true, ...rules };
    return GROUPS.map((g) => ({
      title: g.title,
      rows: g.rows.map((row) => ({
        row, label: rowLabel(row), cells: UPS.map((up) => ({ up, code: code(row, up, r) })),
      })),
    }));
  }

  /**
   * Index plays by cell for the count overlay: Map "row|up" -> text like
   * "Stand at +2 or more". Built from counting.indexPlays so it matches the coach.
   */
  function indexMarks(indexPlays) {
    const m = new Map();
    const say = (play, index, sense) => {
      const n = index > 0 ? `+${index}` : String(index);
      const p = play.charAt(0).toUpperCase() + play.slice(1);
      return sense === 'at' ? `${p} at ${n} or more` : `${p} below ${n}`;
    };
    for (const e of indexPlays) m.set(`${e.row}|${e.up}`, say(e.play, e.index, e.sense));
    return m;
  }

  /** Top off-chart cells, most missed first: [{key, label, count}]. */
  function topMisses(misses, n = 5) {
    return Object.entries(misses || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => {
        const [row, up] = key.split('|');
        return { key, count, label: `${rowLabel(row)} vs ${upLabel(Number(up))}` };
      });
  }

  const api = { UPS, GROUPS, LEGEND, upLabel, rowLabel, handFor, cellKey, code, buildChart, indexMarks, topMisses };
  if (node) module.exports = api;
  else root.BlackjackChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
