/**
 * Mistake cost: how much expected value an off-chart play gave away, from
 * the solver's precomputed EV table (ev-data.js). Pure and DOM-free
 * (window.BlackjackEV in the browser, module.exports under Node).
 *
 * cost = EV(best play you could make) - EV(the play you made), per unit
 * bet. EVs are for two-card hands after the dealer has peeked (under ENHC,
 * including the dealer's blackjack; OBO prices as the peek game); for a hand
 * of three or more cards the same total's hit/stand values are used as an
 * estimate. Returns null when a cell isn't in the table (an unsplittable
 * pair played as its total, e.g. 2,2 as hard 4).
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const DATA = node ? require('./ev-data.js') : root.BlackjackEVData;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;

  const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  /** OBO plays and prices exactly like the peek game. */
  const plainENHC = (r) => !!r.enhc && !r.obo;
  const baseKey = (r) => `${r.decks || 6}-${r.h17 ? 'h17' : 's17'}-${r.das === false ? 'nodas' : 'das'}` +
    (plainENHC(r) ? '-enhc' : '');
  /** Key in ev-data.js: "6-s17-das", "6-s17-das-enhc-d911", ... */
  const ruleKey = (r) => baseKey(r) + (r.doubleOn && r.doubleOn !== 'any' ? `-d${r.doubleOn.replace('-', '')}` : '');

  /** A two-card hand for a row, to check the doubling rule. */
  function rowCards(row) {
    const [kind, n] = [row.split(' ')[0], Number(row.split(' ')[1])];
    const c = (v) => ({ rank: v === 11 ? 'A' : String(v), suit: '♠' });
    if (kind === 'pair') return [c(n), c(n)];
    if (kind === 'soft') return [c(11), c(n - 11)];
    return n > 11 ? [c(10), c(n - 10)] : [c(2), c(n - 2)];
  }

  /** EV of each play in a cell: {stand, hit, double?, split?, surrender}. */
  function cellEV(rules, key) {
    const [row, up] = key.split('|');
    const i = UPS.indexOf(Number(up));
    // Restricted-doubling keys hold only the pair rows.
    const variant = DATA[ruleKey(rules)];
    const table = variant && variant[row] ? variant : DATA[baseKey(rules)];
    const cell = table && table[row] && table[row][i];
    if (!cell) return null;
    const enhc = plainENHC(rules);
    const ev = { stand: cell[0] / 1e4, hit: cell[1] / 1e4, surrender: enhc ? cell[cell.length - 1] / 1e4 : -0.5 };
    if (cell[2] !== null && BJ.canDoubleOn(rowCards(row), rules.doubleOn || 'any')) ev.double = cell[2] / 1e4;
    if (cell.length > (enhc ? 4 : 3)) ev.split = cell[3] / 1e4;
    return ev;
  }

  /**
   * Cost of `move` in cell `key`, given which plays were open to you.
   * Returns {cost, best, bestEV, chosenEV} or null if the cell isn't known.
   */
  function moveCost(rules, key, move, { canDouble = true, canSplit = true, canSurrender = true } = {}) {
    const ev = cellEV(rules, key);
    if (!ev || !(move in ev)) return null;
    const open = ['stand', 'hit'];
    if (canDouble && ev.double !== undefined) open.push('double');
    if (canSplit && ev.split !== undefined) open.push('split');
    if (canSurrender && rules.lateSurrender !== false) open.push('surrender');
    if (!open.includes(move)) return null;
    const best = open.reduce((a, b) => (ev[b] > ev[a] ? b : a));
    const cost = Math.max(0, ev[best] - ev[move]);
    return { cost, best, bestEV: ev[best], chosenEV: ev[move] };
  }

  const PAST = { hit: 'Hit', stand: 'Stood on', double: 'Doubled', split: 'Split', surrender: 'Surrendered' };

  /** "Stood on 16 vs 10: -2.8% of your bet". */
  function describe(move, handLabel, upLabel, cost) {
    return `${PAST[move]} ${handLabel} vs ${upLabel}: -${(cost * 100).toFixed(1)}% of your bet`;
  }

  const api = { cellEV, moveCost, describe, ruleKey };
  if (node) module.exports = api;
  else root.BlackjackEV = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
