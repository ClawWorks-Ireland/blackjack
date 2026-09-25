const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./stats.js');

const r = (outcome) => ({ outcome });

test('empty stats have no win rate', () => {
  assert.equal(S.winRate(S.emptyStats()), null);
});

test('recordRound counts outcomes per hand and does not mutate', () => {
  const start = S.emptyStats();
  const s = S.recordRound(start, [r('win'), r('bust')], 0);
  assert.equal(start.hands, 0);
  assert.equal(s.rounds, 1);
  assert.equal(s.hands, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
});

test('blackjack is a win, surrender a loss, push neither', () => {
  let s = S.emptyStats();
  s = S.recordRound(s, [r('blackjack')], 15);
  s = S.recordRound(s, [r('surrender')], -5);
  s = S.recordRound(s, [r('push')], 0);
  assert.deepEqual([s.wins, s.losses, s.pushes, s.blackjacks], [1, 1, 1, 1]);
});

test('win rate excludes pushes', () => {
  let s = S.emptyStats();
  for (const o of ['win', 'win', 'win', 'lose', 'push', 'push']) {
    s = S.recordRound(s, [r(o)], 0);
  }
  assert.equal(S.winRate(s), 0.75);
});

test('net, best and worst round track chip movement', () => {
  let s = S.emptyStats();
  s = S.recordRound(s, [r('win')], 50);
  s = S.recordRound(s, [r('lose')], -200);
  s = S.recordRound(s, [r('blackjack')], 150);
  assert.equal(s.net, 0);
  assert.equal(s.bestRound, 150);
  assert.equal(s.worstRound, -200);
});

test('streaks follow round net and pushes leave them alone', () => {
  let s = S.emptyStats();
  s = S.recordRound(s, [r('win')], 10);
  s = S.recordRound(s, [r('win')], 10);
  s = S.recordRound(s, [r('push')], 0);
  assert.equal(s.streak, 2);
  s = S.recordRound(s, [r('win')], 10);
  assert.equal(s.bestStreak, 3);
  s = S.recordRound(s, [r('lose')], -10);
  s = S.recordRound(s, [r('bust')], -10);
  assert.equal(s.streak, -2);
  assert.equal(s.bestStreak, 3);
});

test('parseStats recovers from missing or corrupt storage', () => {
  assert.deepEqual(S.parseStats(null), S.emptyStats());
  assert.deepEqual(S.parseStats('not json'), S.emptyStats());
  const partial = S.parseStats(JSON.stringify({ wins: 4, losses: 'x' }));
  assert.equal(partial.wins, 4);
  assert.equal(partial.losses, 0);
});
