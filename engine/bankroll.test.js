const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('./bankroll.js');
const R = require('./rules.js');

const RULES = { decks: 6, h17: false, payout: 1.5, das: true, lateSurrender: true, penetration: 0.75 };

test('F16: the seeded generator repeats and stays in [0, 1)', () => {
  const a = B.seededRng(42);
  const b = B.seededRng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('F16: a fixed seed gives the same simulation', () => {
  const one = B.simulate({ rules: RULES, ramp: 'ramp', rounds: 5000, seed: 3 });
  const two = B.simulate({ rules: RULES, ramp: 'ramp', rounds: 5000, seed: 3 });
  assert.deepEqual(one, two);
  assert.notDeepEqual(one, B.simulate({ rules: RULES, ramp: 'ramp', rounds: 5000, seed: 4 }));
});

test('F16: flat betting loses about the house edge times the average bet', () => {
  const sim = B.simulate({ rules: RULES, ramp: 'flat', rounds: 400000, seed: 11 });
  assert.equal(sim.avgBet, 1);
  const expected = -(R.houseEdge(RULES) / 100) * sim.avgBet;
  const se = sim.sd / Math.sqrt(sim.rounds);
  assert.ok(Math.abs(sim.mean - expected) < 3 * se,
    `mean ${sim.mean.toFixed(5)} vs ${expected.toFixed(5)} (se ${se.toFixed(5)})`);
  assert.ok(sim.sd > 1.05 && sim.sd < 1.25, `flat SD per round ${sim.sd}`);
  const m = B.summarize(sim, { bankroll: 100000, unit: 10 });
  assert.equal(m.ror, 1, 'no edge: ruin is certain in the long run');
  assert.equal(m.n0, Infinity);
});

test('F16: the 1-12 count ramp wins, and bets more at good counts', () => {
  const sim = B.simulate({ rules: RULES, ramp: 'ramp', rounds: 200000, seed: 7 });
  const m = B.summarize(sim, { bankroll: 10000, unit: 10 });
  assert.ok(m.ev100 > 0, `EV per 100 ${m.ev100}`);
  assert.ok(sim.avgBet > 1.3 && sim.avgBet < 2.2, `average bet ${sim.avgBet}`);
  assert.ok(m.sd100 > 20 && m.sd100 < 40);
  assert.ok(m.ror > 0 && m.ror < 1);
  assert.ok(Math.abs(m.ev100Dollars - m.ev100 * 10) < 1e-9);
});

test('F16: risk of ruin never rises with a bigger bankroll', () => {
  const sim = { rounds: 1, mean: 0.0135, sd: 3.0, avgBet: 1.65 };
  let prev = 1;
  for (let units = 0; units <= 2000; units += 25) {
    const ror = B.summarize(sim, { bankroll: units * 10, unit: 10 }).ror;
    assert.ok(ror <= prev + 1e-12, `${units} units: ${ror} > ${prev}`);
    prev = ror;
  }
  assert.ok(prev < 0.01);
  assert.equal(B.riskOfRuin(0.01, 3, 0), 1);
  assert.equal(B.riskOfRuin(-0.004, 1.14, 1e6), 1);
  // Doubling the bankroll squares the risk.
  assert.ok(Math.abs(B.riskOfRuin(0.0135, 3, 800) - B.riskOfRuin(0.0135, 3, 400) ** 2) < 1e-12);
});
