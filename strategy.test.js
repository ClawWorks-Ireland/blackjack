const test = require('node:test');
const assert = require('node:assert/strict');
const { recommend, insuranceAdvice } = require('./strategy.js');

const c = (rank) => ({ rank, suit: '♠' });
const ALL = { canDouble: true, canSplit: true, canSurrender: true };
const move = (ranks, up, allowed = ALL) => recommend(ranks.map(c), c(up), allowed).action;

test('hard totals', () => {
  assert.equal(move(['5', '3'], '6'), 'hit');       // 8
  assert.equal(move(['5', '4'], '3'), 'double');    // 9 vs 3
  assert.equal(move(['5', '4'], '2'), 'hit');       // 9 vs 2
  assert.equal(move(['6', '4'], '9'), 'double');    // 10 vs 9
  assert.equal(move(['6', '4'], '10'), 'hit');      // 10 vs 10
  assert.equal(move(['7', '4'], 'K'), 'double');    // 11 vs 10
  assert.equal(move(['7', '4'], 'A'), 'hit');       // 11 vs A (S17)
  assert.equal(move(['10', '2'], '3'), 'hit');      // 12 vs 3
  assert.equal(move(['10', '2'], '4'), 'stand');    // 12 vs 4
  assert.equal(move(['10', '3'], '6'), 'stand');    // 13 vs 6
  assert.equal(move(['10', '3'], '7'), 'hit');      // 13 vs 7
  assert.equal(move(['10', '7'], 'A'), 'stand');    // 17 vs A
});

test('soft totals', () => {
  assert.equal(move(['A', '2'], '5'), 'double');    // soft 13 vs 5
  assert.equal(move(['A', '2'], '4'), 'hit');
  assert.equal(move(['A', '4'], '4'), 'double');    // soft 15 vs 4
  assert.equal(move(['A', '6'], '3'), 'double');    // soft 17 vs 3
  assert.equal(move(['A', '6'], '2'), 'hit');
  assert.equal(move(['A', '7'], '6'), 'double');    // soft 18 vs 6
  assert.equal(move(['A', '7'], '3'), 'double');    // soft 18 vs 3
  assert.equal(move(['A', '7'], '2'), 'stand');     // soft 18 vs 2 (S17; H17 doubles)
  assert.equal(move(['A', '7'], '7'), 'stand');
  assert.equal(move(['A', '7'], '8'), 'stand');
  assert.equal(move(['A', '7'], '9'), 'hit');
  assert.equal(move(['A', '8'], '6'), 'stand');     // soft 19 (S17)
});

test('pairs', () => {
  assert.equal(move(['A', 'A'], '10'), 'split');
  assert.equal(move(['8', '8'], 'A'), 'split');
  assert.equal(move(['K', 'K'], '6'), 'stand');
  assert.equal(move(['9', '9'], '7'), 'stand');
  assert.equal(move(['9', '9'], '8'), 'split');
  assert.equal(move(['9', '9'], 'A'), 'stand');
  assert.equal(move(['7', '7'], '7'), 'split');
  assert.equal(move(['7', '7'], '8'), 'hit');
  assert.equal(move(['6', '6'], '6'), 'split');
  assert.equal(move(['6', '6'], '7'), 'hit');
  assert.equal(move(['4', '4'], '5'), 'split');
  assert.equal(move(['4', '4'], '4'), 'hit');
  assert.equal(move(['5', '5'], '9'), 'double');    // plays as hard 10
  assert.equal(move(['2', '2'], '7'), 'split');
});

test('late surrender', () => {
  assert.equal(move(['10', '6'], '9'), 'surrender');
  assert.equal(move(['10', '6'], 'A'), 'surrender');
  assert.equal(move(['10', '6'], '8'), 'hit');
  assert.equal(move(['10', '5'], '10'), 'surrender');
  assert.equal(move(['10', '5'], '9'), 'hit');
  assert.equal(move(['A', '5'], '10'), 'hit');      // soft 16 never surrenders
});

test('falls back when a move is not allowed', () => {
  const none = { canDouble: false, canSplit: false, canSurrender: false };
  assert.equal(move(['7', '4'], '6', none), 'hit');         // double -> hit
  assert.equal(move(['A', '7'], '5', none), 'stand');       // soft 18 double -> stand
  assert.equal(move(['10', '6'], '10', none), 'hit');       // surrender -> hit
  assert.equal(move(['8', '8'], '10', none), 'hit');        // unsplittable 8,8 = hard 16
  assert.equal(move(['A', 'A'], '6', none), 'hit');         // unsplittable A,A = soft 12
  assert.equal(move(['5', '3', '3'], '6', ALL), 'double');  // caller gates doubling
});

test('reason names the hand and dealer card', () => {
  const r = recommend([c('10'), c('6')], c('A'), ALL);
  assert.equal(r.label, 'Surrender');
  assert.equal(r.reason, 'Hard 16 vs dealer ace');
});

test('basic strategy declines insurance', () => {
  assert.equal(insuranceAdvice().action, 'no-insurance');
});

test('basic strategy declines even money too', () => {
  const r = insuranceAdvice(true);
  assert.equal(r.action, 'no-insurance');
  assert.equal(r.label, 'No even money');
});
