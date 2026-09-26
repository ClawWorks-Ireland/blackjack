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

// --- History ---

const entry = (round, net = 10) => ({
  round, net, dealer: 18, dealerCards: '10♠ 8♥',
  hands: [{ cards: 'K♠ 9♦', total: 19, outcome: 'win' }],
});

test('addHistory puts the newest round first without mutating', () => {
  const h1 = S.addHistory([], entry(1));
  const h2 = S.addHistory(h1, entry(2));
  assert.equal(h1.length, 1);
  assert.deepEqual(h2.map((e) => e.round), [2, 1]);
});

test('addHistory keeps only the newest entries', () => {
  let h = [];
  for (let i = 1; i <= S.HISTORY_MAX + 5; i++) h = S.addHistory(h, entry(i));
  assert.equal(h.length, S.HISTORY_MAX);
  assert.equal(h[0].round, S.HISTORY_MAX + 5);
});

test('parseHistory drops malformed entries and bad storage', () => {
  assert.deepEqual(S.parseHistory(null), []);
  assert.deepEqual(S.parseHistory('{"not":"array"}'), []);
  const bad = { ...entry(2), hands: [{ cards: 'x', total: 5, outcome: 'hacked' }] };
  const noHands = { ...entry(3), hands: [] };
  const parsed = S.parseHistory(JSON.stringify([entry(1), bad, noHands, { round: 'x' }]));
  assert.deepEqual(parsed.map((e) => e.round), [1]);
});

// --- Hint tracking ---

test('recordHint counts shown and followed hints without mutating', () => {
  const start = S.emptyStats();
  let s = S.recordHint(start, true);
  s = S.recordHint(s, false);
  s = S.recordHint(s, true);
  assert.equal(start.hintsShown, 0);
  assert.equal(s.hintsShown, 3);
  assert.equal(s.hintsFollowed, 2);
  assert.equal(S.hintRate(s), 2 / 3);
});

test('hint rate is empty before any hint and survives recordRound and storage', () => {
  assert.equal(S.hintRate(S.emptyStats()), null);
  let s = S.recordHint(S.emptyStats(), true);
  s = S.recordRound(s, [{ outcome: 'win' }], 10);
  const restored = S.parseStats(JSON.stringify(s));
  assert.equal(restored.hintsFollowed, 1);
  // Stats saved before this feature load with zero hints.
  assert.equal(S.parseStats(JSON.stringify({ wins: 2 })).hintsShown, 0);
});

// --- Strategy accuracy ---

test('recordMove scores decisions and accuracy', () => {
  const start = S.emptyStats();
  assert.equal(S.accuracy(start), null);
  let s = S.recordMove(start, true);
  s = S.recordMove(s, true);
  s = S.recordMove(s, false);
  s = S.recordMove(s, true);
  assert.equal(start.movesScored, 0);
  assert.deepEqual([s.movesScored, s.movesCorrect], [4, 3]);
  assert.equal(S.accuracy(s), 0.75);
  assert.equal(S.parseStats(JSON.stringify(s)).movesCorrect, 3);
});

// --- Count checks ---

test('recordCountCheck scores running-count checks without mutating', () => {
  const start = S.emptyStats();
  assert.equal(S.countRate(start), null);
  let s = S.recordCountCheck(start, true);
  s = S.recordCountCheck(s, false);
  assert.equal(start.countChecks, 0);
  assert.deepEqual([s.countChecks, s.countCorrect], [2, 1]);
  assert.equal(S.countRate(s), 0.5);
  assert.equal(S.parseStats(JSON.stringify(s)).countCorrect, 1);
  assert.equal(S.parseStats(JSON.stringify({ wins: 1 })).countChecks, 0);
});

// --- Return (R1) ---

test('R1: return is money back per $1 wagered', () => {
  let s = S.emptyStats();
  assert.equal(S.returnRate(s), null);
  s = S.recordRound(s, [{ outcome: 'win' }], 10, 10);
  s = S.recordRound(s, [{ outcome: 'lose' }], -10, 10);
  assert.equal(S.returnRate(s), 1);
  const doubled = S.recordRound(S.emptyStats(), [{ outcome: 'win' }], 20, 20);
  assert.equal(S.returnRate(doubled), 2);
});

test('R1: stats saved before wagers were tracked load with nothing wagered', () => {
  const legacy = S.parseStats(JSON.stringify({ rounds: 5, net: 30 }));
  assert.equal(legacy.wagered, 0);
  assert.equal(S.returnRate(legacy), null);
  // The legacy $30 net has no wagers behind it, so it stays out of return.
  assert.equal(S.returnRate(S.recordRound(legacy, [{ outcome: 'win' }], 10, 10)), 2);
});

// --- F7: bankroll graph and CSV ---

const hist = (round, bankroll, extra = {}) => ({
  round, net: 10, dealer: 18, dealerCards: '10♠ 8♥', bankroll,
  hands: [{ cards: 'K♠ 9♦', total: 19, outcome: 'win' }], ...extra,
});

test('F7: history keeps enough rounds for the graph and export', () => {
  assert.ok(S.HISTORY_MAX >= 100);
  assert.equal(S.HISTORY_SHOWN, 20);
});

test('F7: bankroll series is oldest first and skips rounds without a bankroll', () => {
  const h = [hist(3, 1030), hist(2, 1020), hist(1, undefined)]; // newest first
  assert.deepEqual(S.bankrollSeries(h), [1020, 1030]);
  assert.deepEqual(S.bankrollSeries([hist(5, 5), hist(4, 4), hist(3, 3)], 2), [4, 5]);
});

test('F7: sparkline points span the box and put the high at the top', () => {
  const pts = S.sparkPoints([100, 50, 150], 104, 58, 2).split(' ').map((p) => p.split(',').map(Number));
  assert.deepEqual(pts.map(([x]) => x), [2, 52, 102]);
  assert.deepEqual(pts.map(([, y]) => y), [29, 56, 2]);
  assert.equal(S.sparkPoints([7], 100, 50), '');
  assert.ok(S.sparkPoints([5, 5], 100, 50).endsWith(',25.0'));
});

test('F7: CSV is oldest first, quotes commas and quotes, blanks missing fields', () => {
  const csv = S.historyCSV([
    hist(2, 1015, { net: -5, wagered: 15, sideNet: -5, insurance: null }),
    hist(1, 1020, { wagered: 10, dealerCards: 'A♠, "x"' }),
  ]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'round,hands,dealer,dealer_total,outcomes,wagered,net,insurance,side_bets,bankroll');
  assert.equal(lines[1], '1,K♠ 9♦ (19),"A♠, ""x""",18,win,10,10,,,1020');
  assert.equal(lines[2], '2,K♠ 9♦ (19),10♠ 8♥,18,win,15,-5,,-5,1015');
  assert.equal(S.historyCSV([]).trim(), lines[0]);
});
