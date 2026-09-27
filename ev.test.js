const test = require('node:test');
const assert = require('node:assert/strict');
const EV = require('./ev.js');
const Chart = require('./chart.js');
const { chart: solve } = require('./tools/solver.js');

const ACTION = { H: 'hit', S: 'stand', D: 'double', Ds: 'double', P: 'split', R: 'surrender', Rs: 'surrender', Rp: 'surrender' };

test('F14: a basic-strategy move always costs 0 (all 16 rule sets, every cell)', () => {
  const bad = [];
  for (const decks of [1, 2, 6, 8]) for (const h17 of [false, true]) for (const das of [false, true]) {
    for (const lateSurrender of [true, false]) {
      const rules = { decks, h17, das, lateSurrender };
      for (const g of Chart.buildChart(rules)) for (const r of g.rows) for (const { up, code } of r.cells) {
        const c = EV.moveCost(rules, `${r.row}|${up}`, ACTION[code], { canSurrender: lateSurrender });
        if (!c || c.cost > 1e-9) bad.push(`${decks}${h17 ? 'H' : 'S'}${das ? 'D' : ''}${lateSurrender ? 'L' : ''} ${r.row}|${up} ${code}: ${c && c.cost}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('F14: costs match the solver for a handful of cells (6 decks S17 DAS)', () => {
  const rows = solve(6, { h17: false, das: true });
  const rules = { decks: 6, h17: false, das: true, lateSurrender: true };
  const cases = [
    ['hard 16', 10, 'stand'], ['hard 12', 3, 'stand'], ['hard 11', 6, 'hit'],
    ['soft 18', 9, 'stand'], ['pair 8', 10, 'hit'], ['hard 15', 10, 'hit'],
  ];
  for (const [row, up, move] of cases) {
    const ev = rows[row][up === 11 ? 1 : up].ev;
    const open = { stand: ev.stand, hit: ev.hit, double: ev.double, surrender: -0.5 };
    if (ev.split !== undefined) open.split = ev.split;
    const best = Math.max(...Object.values(open));
    const c = EV.moveCost(rules, `${row}|${up}`, move);
    assert.ok(Math.abs(c.cost - (best - open[move])) < 2e-4, `${row} vs ${up} ${move}: ${c.cost} vs ${best - open[move]}`);
  }
});

test('F14: known costs are in the right range, and describe reads naturally', () => {
  const r = { decks: 6, h17: false, das: true, lateSurrender: false };
  const c = EV.moveCost(r, 'hard 16|10', 'stand');
  assert.equal(c.best, 'hit');
  assert.ok(c.cost > 0 && c.cost < 0.02, `stand 16 v 10 costs ${c.cost}`); // a close call
  const big = EV.moveCost(r, 'pair 11|6', 'stand');
  assert.ok(big.cost > 0.3, 'standing on A,A is expensive');
  assert.equal(EV.describe('stand', '16', '10', 0.0283), 'Stood on 16 vs 10: -2.8% of your bet');
});

test('F14: only open plays are compared; unknown cells return null', () => {
  const r = { decks: 6, h17: false, das: true, lateSurrender: true };
  assert.equal(EV.moveCost(r, 'hard 11|6', 'hit', { canDouble: false }).cost, 0); // can't double: hit is best
  assert.equal(EV.moveCost(r, 'hard 11|6', 'double', { canDouble: false }), null);
  assert.equal(EV.moveCost(r, 'hard 4|6', 'hit'), null);
  assert.equal(EV.moveCost({ ...r, lateSurrender: false }, 'hard 16|10', 'surrender'), null);
});
