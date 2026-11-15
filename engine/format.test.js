const test = require('node:test');
const assert = require('node:assert/strict');
const { money, signedMoney, percent } = require('./format.js');

test('whole dollars have no cents and a thousands separator', () => {
  assert.equal(money(0), '$0');
  assert.equal(money(5), '$5');
  assert.equal(money(1000), '$1,000');
  assert.equal(money(1234567), '$1,234,567');
});

test('amounts with cents always show two decimals', () => {
  assert.equal(money(1002.5), '$1,002.50');
  assert.equal(money(0.5), '$0.50');
  assert.equal(money(37.5), '$37.50');
  assert.equal(money(1.2), '$1.20'); // 6:5 on $1
  assert.equal(money(0.1 + 0.2), '$0.30'); // float noise is rounded away
});

test('losses carry a leading minus', () => {
  assert.equal(money(-999.5), '-$999.50');
  assert.equal(money(-50), '-$50');
  assert.equal(money(-0), '$0');
});

test('signedMoney marks gains and losses', () => {
  assert.equal(signedMoney(15), '+$15');
  assert.equal(signedMoney(-7.5), '-$7.50');
  assert.equal(signedMoney(2500), '+$2,500');
  assert.equal(signedMoney(0), '$0');
});

test('percent formats fractions as percentages', () => {
  assert.equal(percent(0.125), '12.5%');
  assert.equal(percent(0.5, 0), '50%');
  assert.equal(percent(0), '0%');
  assert.equal(percent(1 / 3), '33.3%');
});

test('percent handles null and NaN', () => {
  assert.equal(percent(null), '—');
  assert.equal(percent(NaN), '—');
});
