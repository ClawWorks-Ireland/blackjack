'use strict';
/**
 * #233: money helpers of qa/b109_report_key_check.js. The page prints cents
 * (engine/format.js), so the check must read them and bet whole dollars.
 * Pure: no browser.
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseMoney, wholeBet } = require('./money.js');

test('parseMoney: $1,382.50 -> 1382.5', () => {
  assert.strictEqual(parseMoney('$1,382.50'), 1382.5);
});

test('parseMoney: $1,000 -> 1000', () => {
  assert.strictEqual(parseMoney('$1,000'), 1000);
});

test('parseMoney: $0 -> 0', () => {
  assert.strictEqual(parseMoney('$0'), 0);
});

test('parseMoney: $107.50 -> 107.5', () => {
  assert.strictEqual(parseMoney('$107.50'), 107.5);
});

test('parseMoney: text with no digit is NaN, not 0', () => {
  assert.ok(Number.isNaN(parseMoney('Out of chips')));
  assert.ok(Number.isNaN(parseMoney('')));
});

test('wholeBet: cap 255, bankroll 252.5 -> 252', () => {
  assert.strictEqual(wholeBet(255, 252.5), 252);
});

test('wholeBet: cap 255, bankroll 1382.5 -> 255', () => {
  assert.strictEqual(wholeBet(255, 1382.5), 255);
});

test('wholeBet: result never exceeds the bankroll for 0.5, 251.5 and 254.99', () => {
  for (const bank of [0.5, 251.5, 254.99]) {
    const bet = wholeBet(255, bank);
    assert.ok(bet <= bank, `bet ${bet} within bankroll ${bank}`);
    assert.ok(Number.isInteger(bet), `bet ${bet} is whole dollars`);
  }
});
