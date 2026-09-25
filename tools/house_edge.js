/**
 * House edge for a rule set from the solver in solver.js: the expected
 * loss per initial bet playing total-dependent basic strategy, averaged
 * over every initial deal. Used to check the published table and to
 * derive the late-surrender and 6:5 adjustments in rules.js.
 *
 * Usage: node tools/house_edge.js   (prints every rule set)
 */
'use strict';

const { makeSolver, fullDeck } = require('./solver.js');

const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Total-dependent chart: best action per (row, up) averaged over compositions. */
function chartFrom(cells) {
  const rows = new Map();
  for (const c of cells) {
    const key = `${c.row}|${c.up}`;
    const r = rows.get(key) || { w: 0, ev: {} };
    r.w += c.w;
    for (const k in c.ev) r.ev[k] = (r.ev[k] || 0) + c.w * c.ev[k];
    rows.set(key, r);
  }
  const pick = new Map();
  for (const [key, r] of rows) {
    const ev = Object.fromEntries(Object.entries(r.ev).map(([k, v]) => [k, v / r.w]));
    pick.set(key, ev);
  }
  return pick;
}

function houseEdge(decks, { h17, das, surrender, payout }) {
  const solver = makeSolver({ decks, h17, das });
  const deck = fullDeck(decks);
  const cells = [];
  const deals = [];
  const n0 = 52 * decks;
  for (const up of VALUES) {
    const pUp = deck[up] / n0;
    for (let a = 1; a <= 10; a++) {
      for (let b = 1; b <= 10; b++) {
        const c = deck.slice();
        c[up]--;
        const pa = c[a] / (n0 - 1);
        c[a]--;
        const pb = c[b] / (n0 - 2);
        c[b]--;
        if (pa <= 0 || pb <= 0) continue;
        const p = pUp * pa * pb; // ordered player cards
        // Dealer blackjack chance given the three cards seen.
        const need = up === 1 ? 10 : up === 10 ? 1 : 0;
        const pDBJ = need ? c[need] / (n0 - 3) : 0;
        const pBJ = (a === 1 && b === 10) || (a === 10 && b === 1);
        if (pBJ) { deals.push({ p, pDBJ, bj: true }); continue; }
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const ev = solver.actions(lo, hi, up);
        const row = a === b ? `pair ${a}` : lo === 1 ? `soft ${hi + 11}` : `hard ${a + b}`;
        deals.push({ p, pDBJ, bj: false, ev, row, up, pair: a === b });
        cells.push({ row, up, w: p * (1 - pDBJ), ev });
        // Two different ten-value ranks are not a pair in this game; they play
        // as hard 20. The chart row for "pair 10" is only 1/4 of 10-10 deals.
      }
    }
  }
  const chart = chartFrom(cells);
  let ret = 0;
  for (const d of deals) {
    if (d.bj) { ret += d.p * (1 - d.pDBJ) * payout; continue; }
    const cell = chart.get(`${d.row}|${d.up}`);
    const allowed = ['stand', 'hit', 'double'];
    if (d.pair) allowed.push('split');
    if (surrender) allowed.push('surrender');
    // Choose by the chart (total-dependent), score with this hand's own EV.
    const act = allowed.reduce((x, y) => (cell[y] > cell[x] ? y : x));
    ret += d.p * (d.pDBJ * -1 + (1 - d.pDBJ) * d.ev[act]);
  }
  return -ret;
}

module.exports = { houseEdge };

if (require.main === module) {
  for (const decks of [1, 2, 6, 8]) {
    for (const h17 of [false, true]) {
      for (const das of [false, true]) {
        const base = houseEdge(decks, { h17, das, surrender: false, payout: 1.5 });
        const ls = houseEdge(decks, { h17, das, surrender: true, payout: 1.5 });
        const six5 = houseEdge(decks, { h17, das, surrender: false, payout: 1.2 });
        const f = (x) => `${(x * 100).toFixed(3)}%`;
        console.log(`${decks} ${h17 ? 'H17' : 'S17'} ${das ? 'DAS  ' : 'noDAS'} base ${f(base)}  LS ${f(ls - base)}  6:5 ${f(six5 - base)}`);
      }
    }
  }
}
