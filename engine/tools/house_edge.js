/**
 * House edge for a rule set from the solver in solver.js: the expected
 * loss per initial bet playing total-dependent basic strategy, averaged
 * over every initial deal. Used to check the published table and to
 * derive the rule adjustments in rules.js: late surrender, 6:5, European
 * no hole card (ENHC), doubling on 9-11 or 10-11 only, and resplitting
 * aces (RSA).
 *
 * Usage: node --max-old-space-size=6144 tools/house_edge.js   (about 7 minutes)
 */
'use strict';

const { makeSolver, fullDeck, mayDouble, toENHC } = require('./solver.js');

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

/**
 * Every initial deal with its probability and per-action EVs, from one
 * solver run. `ev` is conditioned on no dealer blackjack (the peek game);
 * `evE` is the ENHC value (dealer blackjack included).
 */
function deals(decks, { h17, das, doubleOn = 'any' }) {
  const solver = makeSolver({ decks, h17, das, doubleOn });
  const deck = fullDeck(decks);
  const out = [];
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
        if ((a === 1 && b === 10) || (a === 10 && b === 1)) { out.push({ p, pDBJ, bj: true }); continue; }
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const ev = solver.actions(lo, hi, up);
        if (!mayDouble([a, b], doubleOn)) delete ev.double;
        // Two different ten-value ranks are not a pair in this game; they play
        // as hard 20. The chart row for "pair 10" is only 1/4 of 10-10 deals.
        const row = a === b ? `pair ${a}` : lo === 1 ? `soft ${hi + 11}` : `hard ${a + b}`;
        out.push({ p, pDBJ, bj: false, ev, evE: toENHC(ev, pDBJ), row, up, pair: a === b });
      }
    }
  }
  return { list: out, solver };
}

function edgeFrom(list, { surrender, payout, enhc }) {
  const cells = list.filter((d) => !d.bj).map((d) => ({
    row: d.row, up: d.up, w: enhc ? d.p : d.p * (1 - d.pDBJ), ev: enhc ? d.evE : d.ev,
  }));
  const chart = chartFrom(cells);
  let ret = 0;
  for (const d of list) {
    if (d.bj) { ret += d.p * (1 - d.pDBJ) * payout; continue; }
    const cell = chart.get(`${d.row}|${d.up}`);
    const allowed = ['stand', 'hit'];
    if ('double' in d.ev) allowed.push('double');
    if (d.pair) allowed.push('split');
    if (surrender) allowed.push('surrender');
    // Choose by the chart (total-dependent), score with this hand's own EV.
    const act = allowed.reduce((x, y) => (cell[y] > cell[x] ? y : x));
    ret += enhc ? d.p * d.evE[act] : d.p * (d.pDBJ * -1 + (1 - d.pDBJ) * d.ev[act]);
  }
  return -ret;
}

function houseEdge(decks, { h17, das, surrender = false, payout = 1.5, enhc = false, doubleOn = 'any' }) {
  return edgeFrom(deals(decks, { h17, das, doubleOn }).list, { surrender, payout, enhc });
}

/**
 * What resplitting aces is worth, per initial bet: over every A,A deal
 * without a dealer blackjack, the gain in the split's EV.
 */
function rsaGain(decks, { h17, das }, solver) {
  const deck = fullDeck(decks);
  const n0 = 52 * decks;
  let gain = 0;
  for (const up of VALUES) {
    const c = deck.slice();
    const p = (c[up] / n0) * ((c[1] - (up === 1 ? 1 : 0)) / (n0 - 1)) * ((c[1] - (up === 1 ? 2 : 1)) / (n0 - 2));
    const need = up === 1 ? 10 : up === 10 ? 1 : 0;
    const left = c.slice();
    left[up]--;
    left[1] -= 2;
    const pDBJ = need ? left[need] / (n0 - 3) : 0;
    gain += p * (1 - pDBJ) * (solver.splitAcesEV(up, true) - solver.splitAcesEV(up, false));
  }
  return gain;
}

module.exports = { houseEdge, rsaGain };

if (require.main === module) {
  const f = (x) => `${(x * 100).toFixed(3)}%`;
  for (const decks of [1, 2, 6, 8]) {
    for (const h17 of [false, true]) {
      for (const das of [false, true]) {
        const any = deals(decks, { h17, das });
        const base = edgeFrom(any.list, { payout: 1.5 });
        const ls = edgeFrom(any.list, { surrender: true, payout: 1.5 });
        const six5 = edgeFrom(any.list, { payout: 1.2 });
        const enhc = edgeFrom(any.list, { payout: 1.5, enhc: true });
        const d911 = edgeFrom(deals(decks, { h17, das, doubleOn: '9-11' }).list, { payout: 1.5 });
        const d1011 = edgeFrom(deals(decks, { h17, das, doubleOn: '10-11' }).list, { payout: 1.5 });
        const rsa = -rsaGain(decks, { h17, das }, any.solver);
        console.log(`${decks} ${h17 ? 'H17' : 'S17'} ${das ? 'DAS  ' : 'noDAS'} base ${f(base)}  LS ${f(ls - base)}  6:5 ${f(six5 - base)}` +
          `  ENHC ${f(enhc - base)}  9-11 ${f(d911 - base)}  10-11 ${f(d1011 - base)}  RSA ${f(rsa)}`);
      }
    }
  }
}
