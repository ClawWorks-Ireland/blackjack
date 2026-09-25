const test = require('node:test');
const assert = require('node:assert/strict');
const { maxBet, betError } = require('./betting.js');

test('B9: max bet is the bankroll rounded down to whole dollars', () => {
  assert.equal(maxBet(498.5), 498);
  assert.equal(maxBet(1000), 1000);
  assert.equal(maxBet(0.5), 0);
  assert.equal(maxBet(0), 0);
});

test('max bet is capped by the table maximum', () => {
  assert.equal(maxBet(2500, 500), 500);
  assert.equal(maxBet(123.5, 500), 123);
});

test('B9: betting everything you can afford with cents left is allowed', () => {
  assert.equal(betError(498, { bankroll: 498.5 }), null);
});

test('B9: over-bankroll message is formatted money, not a raw number', () => {
  assert.equal(betError(499, { bankroll: 498.5 }), 'You can bet up to $498.');
  assert.equal(betError(1500, { bankroll: 1234.5, max: 5000 }), 'You can bet up to $1,234.');
});

test('bet errors for empty, fractional and out-of-limit bets', () => {
  assert.equal(betError(NaN, { bankroll: 100 }), 'Enter a bet to deal.');
  assert.equal(betError(0, { bankroll: 100 }), 'Enter a bet to deal.');
  assert.equal(betError(2.5, { bankroll: 100 }), 'Bets are in whole dollars.');
  assert.equal(betError(4, { bankroll: 100, min: 5 }), 'The minimum bet is $5.');
  assert.equal(betError(600, { bankroll: 1000, max: 500 }), 'The table maximum is $500.');
  assert.equal(betError(5, { bankroll: 100, min: 5, max: 500 }), null);
});
