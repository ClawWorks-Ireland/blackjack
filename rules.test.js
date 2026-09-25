const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./rules.js');

const base = R.DEFAULT_RULES;

test('default rules are the classic table', () => {
  assert.deepEqual({ ...base }, { decks: 6, h17: false, payout: 1.5, das: true, lateSurrender: true });
});

test('house edge for the default rules is about a third of a percent', () => {
  assert.equal(R.houseEdge(base), 0.33);
  assert.equal(R.edgeText(base), 'House edge 0.33%');
});

test('house edge matches the published figures with no surrender', () => {
  const noLS = { ...base, lateSurrender: false };
  assert.equal(R.houseEdge({ ...noLS, decks: 8, h17: true }), 0.65);
  assert.equal(R.houseEdge({ ...noLS, decks: 2, das: false }), 0.34);
  assert.equal(R.houseEdge({ ...noLS, decks: 1, h17: true, das: false }), 0.19);
});

test('each worse rule raises the house edge', () => {
  const e = R.houseEdge(base);
  assert.ok(R.houseEdge({ ...base, h17: true }) > e);
  assert.ok(R.houseEdge({ ...base, das: false }) > e);
  assert.ok(R.houseEdge({ ...base, lateSurrender: false }) > e);
  assert.ok(R.houseEdge({ ...base, decks: 8 }) > e);
  assert.ok(R.houseEdge({ ...base, decks: 2 }) < e);
  assert.ok(R.houseEdge({ ...base, payout: 1.2 }) - e > 1.3);
});

test('single deck S17 with DAS favours the player', () => {
  assert.equal(R.edgeText({ ...base, decks: 1 }), 'Player edge 0.16%');
});

test('saved settings are validated field by field', () => {
  assert.deepEqual(R.normalizeRules(null), { ...base });
  assert.deepEqual(R.normalizeRules({ decks: 4, payout: 2, h17: 'yes' }), { ...base });
  assert.deepEqual(R.normalizeRules({ decks: 2, h17: true, payout: 1.2, das: false, lateSurrender: false }),
    { decks: 2, h17: true, payout: 1.2, das: false, lateSurrender: false });
});

test('sameRules compares every setting', () => {
  assert.ok(R.sameRules(base, { ...base }));
  assert.ok(!R.sameRules(base, { ...base, das: false }));
});

test('describe spells out the rules and the edge', () => {
  const [one, two] = R.describe({ decks: 1, h17: true, payout: 1.2, das: false, lateSurrender: false });
  assert.match(one, /Single deck · Dealer hits soft 17 · Blackjack pays 6:5 · .*not after a split/);
  assert.match(two, /No surrender · House edge 1\.58%/);
});
