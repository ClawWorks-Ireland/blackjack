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

const { CHIPS, parseBet, addChip, rebetAmount } = require('./betting.js');

test('chip denominations', () => {
  assert.deepEqual(CHIPS, [1, 5, 25, 100, 500]);
});

test('parseBet treats empty or bad input as zero', () => {
  assert.equal(parseBet(''), 0);
  assert.equal(parseBet('abc'), 0);
  assert.equal(parseBet('-5'), 0);
  assert.equal(parseBet('25'), 25);
});

test('chips add to the bet up to the bankroll and table maximum', () => {
  assert.equal(addChip('', 25, { bankroll: 1000, max: 500 }), 25);
  assert.equal(addChip('25', 100, { bankroll: 1000, max: 500 }), 125);
  assert.equal(addChip('450', 100, { bankroll: 1000, max: 500 }), null);
  assert.equal(addChip('400', 100, { bankroll: 1000, max: 500 }), 500);
  assert.equal(addChip('', 5, { bankroll: 4.5, max: 500 }), null);
});

test('rebet and rebet x2 respect the bankroll and limits', () => {
  const limits = { bankroll: 300, min: 1, max: 500 };
  assert.equal(rebetAmount(100, 1, limits), 100);
  assert.equal(rebetAmount(100, 2, limits), 200);
  assert.equal(rebetAmount(200, 2, limits), null); // 400 > bankroll
  assert.equal(rebetAmount(300, 2, { ...limits, bankroll: 1000 }), null); // 600 > table max
  assert.equal(rebetAmount(0, 1, limits), null);
});

const { sideError } = require('./betting.js');

test('side bets: optional, whole dollars, capped, and fit with the main bet', () => {
  assert.equal(sideError(10, { 'Perfect Pairs': '', '21+3': '' }, { bankroll: 100 }), null);
  assert.equal(sideError(10, { 'Perfect Pairs': '5', '21+3': '5' }, { bankroll: 100 }), null);
  assert.equal(sideError(10, { 'Perfect Pairs': '2.5' }, { bankroll: 100 }), 'Perfect Pairs must be a whole-dollar amount.');
  assert.equal(sideError(10, { '21+3': '150' }, { bankroll: 1000 }), '21+3 is at most $100.');
  assert.equal(sideError(95, { 'Perfect Pairs': '10' }, { bankroll: 100.5 }),
    'Your bet and side bets come to $105; you can bet up to $100.');
});
