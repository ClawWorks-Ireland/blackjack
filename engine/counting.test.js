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

// --- Count-based advice ---

const { recommend } = require('./strategy.js');
const ALL = { canDouble: true, canSplit: true, canSurrender: true };
const NO_LS = { canDouble: true, canSplit: true, canSurrender: false };
const play = (ranks, up, tc, allowed = ALL) => {
  const cards = ranks.map((r) => c(r));
  const basic = recommend(cards, c(up), allowed);
  return K.countPlay(cards, c(up), allowed, basic, tc);
};

test('index plays switch at their true count', () => {
  assert.equal(play(['10', '6'], '10', 0, NO_LS).action, 'stand');   // 16 v 10 at 0
  assert.equal(play(['10', '6'], '10', -1, NO_LS).action, 'hit');
  assert.equal(play(['10', '2'], '3', 2).action, 'stand');           // 12 v 3 at +2
  assert.equal(play(['10', '2'], '3', 1.9).action, 'hit');            // rounds down
  assert.equal(play(['10', '2'], '4', -0.5).action, 'hit');           // 12 v 4 below 0
  assert.equal(play(['10', '2'], '4', 0).action, 'stand');
  assert.equal(play(['7', '4'], 'A', 1).action, 'double');            // 11 v A at +1
  assert.equal(play(['5', '4'], '2', 1).action, 'double');            // 9 v 2 at +1
  assert.equal(play(['K', 'K'], '6', 4).action, 'split');             // tens v 6 at +4
  assert.equal(play(['K', 'K'], '6', 3).action, 'stand');
});

test('Fab 4 surrenders, and 15 v 10 stops surrendering below 0', () => {
  assert.equal(play(['10', '4'], '10', 3).action, 'surrender');
  assert.equal(play(['10', '4'], '10', 2).action, 'hit');
  assert.equal(play(['10', '5'], '9', 2).action, 'surrender');
  assert.equal(play(['10', '5'], 'A', 1).action, 'surrender');
  assert.equal(play(['10', '5'], '10', 0).action, 'surrender');
  assert.equal(play(['10', '5'], '10', -1).action, 'hit');
  // 16 v 10 with surrender available: surrender, whatever the count.
  assert.equal(play(['10', '6'], '10', 2).action, 'surrender');
});

test('deviations only suggest moves you can make', () => {
  const noDouble = { canDouble: false, canSplit: false, canSurrender: false };
  assert.equal(play(['7', '4'], 'A', 5, noDouble).action, 'hit');
  assert.equal(play(['5', '3', '3'], 'A', 5, ALL).action, 'hit');   // three cards: no double
  assert.equal(play(['K', 'K'], '6', 5, noDouble).action, 'stand');
});

test('a deviation explains itself; basic plays pass through', () => {
  const d = play(['10', '2'], '3', 2.4);
  assert.ok(d.deviation);
  assert.equal(d.reason, 'Hard 12 vs dealer 3 at true count +2.4, index +2');
  assert.equal(d.basicLabel, 'Hit');
  assert.ok(!play(['10', '7'], '6', 5).deviation);
  assert.ok(!play(['A', '6'], '3', 5).deviation);                      // soft hands: basic only
});

test('insurance and even money at +3 or more', () => {
  assert.equal(K.countInsurance(2.9), null);
  assert.equal(K.countInsurance(3).action, 'insurance');
  assert.equal(K.countInsurance(3.4, true).label, 'Even money');
});

test('bet ramp: 1, 2, 4, 8, 12 units', () => {
  assert.deepEqual([-2, 0, 1.9, 2, 3.5, 4, 4.9, 5, 9].map(K.betUnits), [1, 1, 1, 2, 4, 8, 8, 12, 12]);
});

test('F4b: suggested bet uses the table minimum as a unit', () => {
  const t = { min: 5, max: 500 };
  assert.deepEqual([-1, 2.4, 3.0, 5.7].map((tc) => K.suggestedBet(tc, t)), [5, 10, 20, 60]);
});

test('F4b: suggested bet is capped by the table maximum and the bankroll', () => {
  assert.equal(K.suggestedBet(6, { min: 50, max: 500 }), 500);
  assert.equal(K.suggestedBet(6, { min: 5, max: 500, bankroll: 42.5 }), 42);
});

test('B11: the unit is fixed, not your last bet', () => {
  // Follow the ramp at +4 with a $25 unit, then the count drops to +1.
  const t = { min: 5, unit: 25, max: 500 };
  assert.equal(K.suggestedBet(4, t), 200);
  assert.equal(K.suggestedBet(1, t), 25); // back to 1 unit, not $200
});

test('B11: a unit below the table minimum, or blank, uses the minimum', () => {
  assert.equal(K.suggestedBet(3, { min: 5, unit: 2, max: 500 }), 20);
  assert.equal(K.suggestedBet(3, { min: 5, unit: NaN, max: 500 }), 20);
  assert.equal(K.suggestedBet(5, { min: 5, unit: 100, max: 500 }), 500);
});

test('B12: the shown true count and the one used agree about every index', () => {
  assert.equal(K.formatTrue(2.96), '+2.9');
  assert.equal(K.betUnits(2.96), 2); // both below +3
  assert.equal(K.wholeTrue(2.96), '+2');
  assert.equal(K.formatTrue(3), '+3.0');
  assert.equal(K.betUnits(3), 4);
  assert.equal(K.formatTrue(2.3), '+2.3'); // no float slip to +2.2
  assert.equal(K.formatTrue(-0.04), '-0.1');
  assert.equal(K.wholeTrue(-0.04), '-1');
  for (let tc = -6; tc <= 6; tc += 0.01) {
    const shown = Number(K.formatTrue(tc));
    assert.equal(Math.floor(shown), Math.floor(tc), `tc ${tc} shows ${shown}`);
  }
  for (const tc of [3 - 1e-12, 2 - 1e-12, -1e-12, 1e-12]) {
    assert.equal(Math.floor(Number(K.formatTrue(tc))), Math.floor(tc), `edge ${tc}`);
  }
});

test('N1: H17 index plays for 11 v A, 10 v A and 15 v A', () => {
  const H17 = { decks: 6, h17: true, das: true };
  const playH = (ranks, up, tc, allowed = ALL) => {
    const cards = ranks.map((r) => c(r));
    const basic = recommend(cards, c(up), allowed, H17);
    return K.countPlay(cards, c(up), allowed, basic, tc, { h17: true });
  };
  // 11 v A: H17 basic doubles; hit only below -1.
  assert.equal(playH(['7', '4'], 'A', -1).action, 'double');
  assert.equal(playH(['7', '4'], 'A', -2).action, 'hit');
  assert.equal(play(['7', '4'], 'A', 0).action, 'hit'); // S17: needs +1
  // 10 v A: +3 under H17, +4 under S17.
  assert.equal(playH(['6', '4'], 'A', 3).action, 'double');
  assert.equal(play(['6', '4'], 'A', 3).action, 'hit');
  // 15 v A: H17 surrenders down to -1; S17 needs +1.
  assert.equal(playH(['10', '5'], 'A', -1).action, 'surrender');
  assert.equal(playH(['10', '5'], 'A', -2).action, 'hit');
  assert.equal(play(['10', '5'], 'A', 0).action, 'hit');
  // Unchanged entries still apply under H17.
  assert.equal(playH(['10', '6'], '10', 0, NO_LS).action, 'stand');
});

// --- F20: other counting systems ---

test('F20: a full deck sums to 0 for the balanced systems and +4 for KO', () => {
  const deck = BJ.createShoe(1);
  const total = (sys) => deck.reduce((s, card) => s + K.tagOf(card, sys), 0);
  assert.deepEqual(['hilo', 'ho2', 'om2', 'ko'].map(total), [0, 0, 0, 4]);
  for (const d of [1, 2, 6, 8]) assert.equal(K.deckTotal('ko', d), 4 * d);
  assert.equal(K.deckTotal('om2', 6), 0);
  assert.deepEqual(Object.keys(K.SYSTEMS), ['hilo', 'ko', 'ho2', 'om2']);
});

test('F20: running counts start at 0 (KO at 4 - 4 x decks) and follow each system\'s tags', () => {
  for (const decks of [1, 6]) {
    const g = new BJ.Game({ decks });
    assert.equal(K.systemState(g, 'ko').running, 4 - 4 * decks);
    for (const s of ['hilo', 'ho2', 'om2']) assert.equal(K.systemState(g, s).running, 0);
  }
  const g = new BJ.Game({ decks: 6 });
  const seen = g.shoe.splice(-30); // 30 cards come out
  for (const s of ['hilo', 'ko', 'ho2', 'om2']) {
    const start = s === 'ko' ? -20 : 0;
    assert.equal(K.systemState(g, s).running, start + seen.reduce((n, card) => n + K.tagOf(card, s), 0), s);
  }
  assert.equal(K.systemState(g, 'hilo').running, K.countState(g).running);
  assert.equal(K.systemState(g, 'ko').trueCount, null);
  // A whole shoe seen: KO ends at 4 - 4d + 4d = +4.
  g.shoe = [];
  assert.equal(K.systemState(g, 'ko').running, 4);
});

test('F20: the Hi-Opt II ace side count changes betting only, not the running count', () => {
  const g = new BJ.Game({ decks: 1 });
  const deck = BJ.createShoe(1);
  const aces = deck.filter((card) => card.rank === 'A');
  const eights = deck.filter((card) => card.rank === '8');
  const others = deck.filter((card) => !['A', '8'].includes(card.rank)).slice(0, 20);
  // Same unseen tags (aces and 8s are both 0 in Hi-Opt II), but one remainder is ace-rich.
  const rich = new BJ.Game({ decks: 1 });
  rich.shoe = [...aces, ...others];
  const plain = new BJ.Game({ decks: 1 });
  plain.shoe = [...eights, ...others];
  const a = K.systemState(rich, 'ho2');
  const b = K.systemState(plain, 'ho2');
  assert.equal(a.running, b.running, 'aces are tagged 0 in Hi-Opt II');
  assert.equal(a.trueCount, b.trueCount);
  assert.ok(a.aceSurplus > b.aceSurplus);
  assert.ok(a.betCount > b.betCount, 'more aces left means a bigger bet');
});

test('F20: bet ramp and insurance follow the chosen system', () => {
  const g = new BJ.Game({ decks: 6 });
  // Take out 60 low cards (2-6): every system goes positive.
  const low = g.shoe.filter((card) => ['2', '3', '4', '5', '6'].includes(card.rank)).slice(0, 60);
  g.shoe = g.shoe.filter((card) => !low.includes(card));
  const s = { hilo: K.systemState(g, 'hilo'), ko: K.systemState(g, 'ko'), ho2: K.systemState(g, 'ho2'), om2: K.systemState(g, 'om2') };
  assert.ok(s.hilo.betCount >= 5 && K.betUnits(s.hilo.betCount) === 12);
  for (const k of ['ko', 'ho2', 'om2']) assert.ok(K.betUnits(s[k].betCount) >= 8, `${k} ramps up (${s[k].betCount})`);
  for (const k of Object.keys(s)) assert.equal(s[k].insurance, true, `${k} takes insurance this rich in tens`);
  assert.equal(K.systemInsurance(s.ko).action, 'insurance');
  assert.match(K.systemInsurance(s.om2).reason, /Omega II true count/);
  // KO: below the key is 1 unit, at the key 2, at the pivot 8.
  const units = (rc) => K.betUnits(K.koBetCount(rc, K.KO_KEY[6]));
  assert.deepEqual([units(-5), units(-4), units(0), units(4), units(8)], [1, 2, 4, 8, 12]);
  assert.equal(K.systemState(new BJ.Game({ decks: 6 }), 'ko').betCount < 2, true, 'a fresh KO shoe bets 1 unit');
  assert.equal(K.systemState(new BJ.Game({ decks: 6 }), 'ko').insurance, false);
});
