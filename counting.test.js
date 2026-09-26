const test = require('node:test');
const assert = require('node:assert/strict');
const BJ = require('./blackjack.js');
const K = require('./counting.js');

const c = (rank, suit = '♠') => ({ rank, suit });

/** Game whose shoe pops the given cards in order, after a balanced filler. */
function riggedGame(cards) {
  const g = new BJ.Game({ bankroll: 1000 });
  // A whole deck of filler keeps the unseen part balanced apart from `cards`.
  g.shoe = BJ.createShoe(2).concat(cards.slice().reverse());
  return g;
}

test('Hi-Lo tags', () => {
  for (const r of ['2', '3', '4', '5', '6']) assert.equal(K.hiLo(c(r)), 1);
  for (const r of ['7', '8', '9']) assert.equal(K.hiLo(c(r)), 0);
  for (const r of ['10', 'J', 'Q', 'K', 'A']) assert.equal(K.hiLo(c(r)), -1);
});

test('a full shoe sums to zero, so a fresh game counts 0', () => {
  for (const decks of [1, 2, 6, 8]) {
    const g = new BJ.Game({ decks });
    const s = K.countState(g);
    assert.equal(s.running, 0);
    assert.equal(s.unseen, decks * 52);
    assert.equal(s.decksLeft, decks);
  }
});

test('the dealer hole card is not counted until it is turned over', () => {
  // You 5,6 (+2); dealer up 4 (+1), hole K (-1, hidden).
  const g = riggedGame([c('5'), c('6'), c('4'), c('K')]);
  const before = K.countState(g).running;
  g.deal(10);
  assert.equal(g.phase, 'player');
  assert.equal(K.countState(g).running - before, 3);
  g.stand(); // hole card revealed; dealer 14 draws from the filler
  const after = K.countState(g);
  const drawn = g.dealer.slice(2).reduce((n, x) => n + K.hiLo(x), 0);
  assert.equal(after.running - before, 3 - 1 + drawn);
});

test('true count divides by decks left, never less than half a deck', () => {
  assert.equal(K.trueCount(6, 3), 2);
  assert.equal(K.trueCount(-4, 2), -2);
  assert.equal(K.trueCount(3, 0.25), 6);
  assert.equal(K.formatTrue(1.5), '+1.5');
  assert.equal(K.formatTrue(-2.26), '-2.3');
  assert.equal(K.formatTrue(0.04), '0.0');
});

test('the count resets with a new shoe', () => {
  const g = new BJ.Game({ decks: 1 });
  g.shoe = g.shoe.filter((x) => K.hiLo(x) !== 1).concat([c('2'), c('3')]);
  assert.notEqual(K.countState(g).running, 0);
  g.shoe = g.shoe.slice(0, 5); // past the cut card
  g.deal(10);
  assert.ok(g.newShoe);
  if (g.phase === 'insurance') g.declineInsurance();
  while (g.phase === 'player') g.stand();
  const onTable = [...g.dealer, ...g.hands.flatMap((h) => h.cards)].reduce((n, x) => n + K.hiLo(x), 0);
  assert.equal(K.countState(g).running, onTable);
});

test('count guesses accept signed whole numbers only', () => {
  assert.equal(K.parseGuess('+3'), 3);
  assert.equal(K.parseGuess(' -2 '), -2);
  assert.equal(K.parseGuess('0'), 0);
  assert.equal(K.parseGuess('1.5'), null);
  assert.equal(K.parseGuess(''), null);
  assert.equal(K.parseGuess('abc'), null);
  assert.equal(K.signed(3), '+3');
  assert.equal(K.signed(-1), '-1');
  assert.equal(K.signed(0), '0');
});
