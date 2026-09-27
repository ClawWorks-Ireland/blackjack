/**
 * Mistake cost: how much expected value an off-chart play gave away, from
 * the solver's precomputed EV table (ev-data.js). Pure and DOM-free
 * (window.BlackjackEV in the browser, module.exports under Node).
 *
 * cost = EV(best play you could make) - EV(the play you made), per unit
 * bet. EVs are for two-card hands after the dealer has peeked; for a hand
 * of three or more cards the same total's hit/stand values are used as an
 * estimate. Returns null when a cell isn't in the table (an unsplittable
 * pair played as its total, e.g. 2,2 as hard 4).
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const DATA = node ? require('./ev-data.js') : root.BlackjackEVData;

  const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const ruleKey = (r) => `${r.decks || 6}-${r.h17 ? 'h17' : 's17'}-${r.das === false ? 'nodas' : 'das'}`;

  /** EV of each play in a cell: {stand, hit, double, split?, surrender}. */
  function cellEV(rules, key) {
    const [row, up] = key.split('|');
    const table = DATA[ruleKey(rules)];
    const cell = table && table[row] && table[row][UPS.indexOf(Number(up))];
    if (!cell) return null;
    const ev = { stand: cell[0] / 1e4, hit: cell[1] / 1e4, double: cell[2] / 1e4, surrender: -0.5 };
    if (cell.length > 3) ev.split = cell[3] / 1e4;
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
    if (canDouble) open.push('double');
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
