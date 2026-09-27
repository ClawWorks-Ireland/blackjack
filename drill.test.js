const test = require('node:test');
const assert = require('node:assert/strict');
const BJ = require('./blackjack.js');
const Chart = require('./chart.js');
const K = require('./counting.js');
const D = require('./drill.js');

/** Seeded RNG so failures reproduce. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const ACTION = { H: 'hit', S: 'stand', D: 'double', Ds: 'double', P: 'split', R: 'surrender', Rs: 'surrender', Rp: 'surrender' };
const RULES = [
  { decks: 6, h17: false, das: true, lateSurrender: true },
  { decks: 1, h17: true, das: false, lateSurrender: false },
];

for (const rules of RULES) {
  test(`F13: flashcards are scored against the chart (${rules.decks}D ${rules.h17 ? 'H17' : 'S17'})`, () => {
    const r = rng(7);
    const chart = new Map();
    for (const g of Chart.buildChart(rules)) for (const row of g.rows) for (const c of row.cells) chart.set(`${row.row}|${c.up}`, c.code);
    for (let i = 0; i < 2000; i++) {
      const f = D.nextCard(rules, { rng: r });
      assert.equal(Chart.cellKey(f.cards, f.upcard), f.key, 'the hand is in the cell it was drawn for');
      assert.ok(!(f.cards[0].rank === f.cards[1].rank && f.cards[0].suit === f.cards[1].suit), 'no two identical cards');
      const want = ACTION[chart.get(f.key)];
      assert.ok(D.check(f, want, rules).correct, `${f.key}: ${want}`);
      for (const other of ['hit', 'stand', 'double', 'split', 'surrender'].filter((a) => a !== want)) {
        assert.ok(!D.check(f, other, rules).correct);
      }
    }
  });
}

test('F13: with the count, flashcards expect the count play', () => {
  const f = { cards: [{ rank: '10', suit: '♠' }, { rank: '2', suit: '♥' }], upcard: { rank: '3', suit: '♦' }, tc: 2.4 };
  assert.equal(D.expected(f, {}).action, 'stand');
  assert.equal(D.expected({ ...f, tc: 1.9 }, {}).action, 'hit');
  assert.equal(D.expected({ ...f, tc: null }, {}).action, 'hit');
});

test('F13: missed and tricky cells come up more often', () => {
  const w = D.cellWeights({}, { 'hard 13|2': 4 });
  const get = (k) => w.find((c) => c.key === k).w;
  assert.ok(get('hard 13|2') > get('hard 13|7'));
  assert.ok(get('hard 14|7') > get('hard 19|7')); // stiff hand beats a pat hand
  assert.ok(!w.some((c) => c.row === 'hard 7'));
  const r = rng(3);
  let hits = 0;
  for (let i = 0; i < 4000; i++) if (D.nextCard({}, { misses: { 'hard 13|2': 5 }, rng: r }).key === 'hard 13|2') hits++;
  const share = hits / 4000;
  const even = 1 / w.length;
  assert.ok(share > 5 * even, `missed cell drawn ${share}`);
});

test('F13: tally tracks accuracy, streak and pace', () => {
  let t = D.emptyTally(0);
  for (const ok of [true, true, false, true]) t = D.tally(t, ok);
  assert.deepEqual([t.answered, t.right, t.streak, t.best], [4, 3, 1, 2]);
  assert.equal(D.perMinute(t, 60000), 4);
});

test('F13: the count drill answer is the Hi-Lo sum of the cards shown', () => {
  const r = rng(11);
  const deck = D.countDeal(52, r);
  assert.equal(deck.cards.length, 52);
  assert.equal(deck.answer, 0); // a whole deck always sums to zero
  for (const n of [10, 20, 30]) {
    const d = D.countDeal(n, r);
    assert.equal(d.cards.length, n);
    assert.equal(d.answer, d.cards.reduce((s, c) => s + K.hiLo(c), 0));
  }
  assert.equal(D.COUNT_TARGET_SECONDS, 25);
  assert.ok(BJ.createShoe(1).length === 52);
});
