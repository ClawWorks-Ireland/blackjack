const test = require('node:test');
const assert = require('node:assert/strict');
const BJ = require('./blackjack.js');
const K = require('./counting.js');
const Rp = require('./replay.js');

// --- F19: seeded shoes ---

test('F19: two engines with the same seed deal identical cards for 10 shoes', () => {
  const a = new BJ.Game({ bankroll: 1e9, seed: 'lucky' });
  const b = new BJ.Game({ bankroll: 1e9, seed: 'lucky' });
  const dealt = [];
  for (let shoe = 0; shoe < 10; shoe++) {
    assert.deepEqual(a.shoe, b.shoe, `shoe ${shoe + 1}`);
    assert.equal(a.shoeSeed, `lucky-${shoe + 1}`);
    dealt.push(a.shoe.map(Rp.cardCode).join(' '));
    do {
      for (const g of [a, b]) {
        g.deal(10);
        if (g.phase === 'insurance') g.declineInsurance();
        while (g.phase === 'player') g.stand();
      }
      assert.deepEqual(a.hands, b.hands);
      assert.deepEqual(a.dealer, b.dealer);
    } while (!a.cutCardReached);
    for (const g of [a, b]) {
      g.deal(10); // the next deal shuffles shoe n+1
      assert.equal(g.newShoe, true);
      if (g.phase === 'insurance') g.declineInsurance();
      while (g.phase === 'player') g.stand();
    }
  }
  assert.equal(new Set(dealt).size, 10, 'each shoe is different');
  assert.notDeepEqual(new BJ.Game({ seed: 'other' }).shoe, new BJ.Game({ seed: 'lucky' }).shoe);
});

test('F19: a shoe seed reproduces that shoe on its own, card for card', () => {
  const a = new BJ.Game({ seed: 'abc', shoeNo: 1 });
  const cards = [];
  while (!a.cutCardReached) {
    a.deal(10);
    if (a.phase === 'insurance') a.declineInsurance();
    while (a.phase === 'player') a.stand();
  }
  a.deal(10); // shoe 2
  if (a.phase === 'insurance') a.declineInsurance();
  while (a.phase === 'player') a.stand();
  cards.push(...a.drawLog);
  const b = new BJ.Game({ seed: 'abc', shoeNo: 2 });
  assert.deepEqual(b.shoe.slice(-cards.length).reverse(), cards, '"abc-2" starts with the same cards');
  assert.deepEqual(BJ.parseSeed('abc-2'), { seed: 'abc', shoeNo: 2 });
  assert.deepEqual(BJ.parseSeed(' lucky '), { seed: 'lucky', shoeNo: 1 });
  assert.equal(BJ.parseSeed(''), null);
  assert.equal(BJ.parseSeed('has space'), null);
  assert.deepEqual(new BJ.Game({ seed: 'x', decks: 2 }).shoe, BJ.seededShoe(2, 'x', 1));
  assert.notDeepEqual(new BJ.Game({ seed: 'x', decks: 2 }).shoe.slice(-20), new BJ.Game({ seed: 'x', decks: 6 }).shoe.slice(-20));
});

test('F19: the seed survives a reload and the next shoe is still the seeded one', () => {
  const g = new BJ.Game({ seed: 'keep', shoeNo: 4 });
  g.deal(10);
  if (g.phase === 'insurance') g.declineInsurance();
  while (g.phase === 'player') g.stand();
  const back = BJ.Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.equal(back.shoeSeed, 'keep-4');
  assert.deepEqual(back.actionLog, g.actionLog);
  back.freshShoe();
  assert.equal(back.shoeSeed, 'keep-5');
  assert.deepEqual(back.shoe, BJ.seededShoe(6, 'keep', 5));
  assert.equal(BJ.Game.fromJSON({ ...JSON.parse(JSON.stringify(g)), shoeNo: 0 }), null);
  assert.equal(new BJ.Game().seed, null, 'unseeded games still use rng');
});

// --- F19: replay ---

/** A seeded rng for the bot's choices. */
const botRng = BJ.seededRng(99);
const pick = (xs) => xs[Math.floor(botRng() * xs.length)];

function playRandomRound(g) {
  const before = { bankroll: g.bankroll, ...(g.cutCardReached ? { running: 0, unseen: g.decks * 52 } : K.countState(g)) };
  const spots = 1 + Math.floor(botRng() * 3);
  g.deal(Array(spots).fill(10), botRng() < 0.3 ? { pairs: 5, t213: 5 } : {});
  while (g.phase === 'insurance' || g.phase === 'player') {
    if (g.phase === 'insurance') { (botRng() < 0.5 && g.canInsure() ? g.takeInsurance() : g.declineInsurance()); continue; }
    const moves = ['stand'];
    if (g.canHit()) moves.push('hit', 'hit');
    if (g.canDouble()) moves.push('double');
    if (g.canSplit()) moves.push('split', 'split');
    if (g.canSurrender()) moves.push('surrender');
    g[pick(moves)]();
  }
  return Rp.recordOf(g, before);
}

test('F19: replaying a stored round rebuilds every hand, total and result exactly', () => {
  for (const rules of [{}, { enhc: true, obo: true, rsa: true }, { decks: 1, h17: true, doubleOn: '9-11' }]) {
    const g = new BJ.Game({ bankroll: 1e6, seed: 'replay', ...rules });
    for (let i = 0; i < 150; i++) {
      const rec = playRandomRound(g);
      const again = Rp.replayRound(JSON.parse(JSON.stringify(rec))); // as stored
      assert.equal(again.complete, true);
      assert.deepEqual(again.final.dealer, g.dealer);
      assert.deepEqual(again.final.hands.map((h) => h.cards), g.hands.map((h) => h.cards));
      assert.deepEqual(again.final.hands.map((h) => h.total), g.hands.map((h) => BJ.handValue(h.cards).total));
      assert.deepEqual(again.final.hands.map((h) => [h.outcome, h.net]), g.results.map((r) => [r.outcome, r.net]));
      assert.equal(again.final.net, g.net);
      const decisions = again.steps.filter((s) => s.decision);
      assert.equal(decisions.length, rec.actions.length, 'one step per decision');
      assert.ok(again.steps.length >= rec.actions.length + 2 * g.spotBets.length + 2);
    }
  }
});

test('F19: replay steps show the coach, the count at that moment and the cost of a mistake', () => {
  // You 10,6 vs dealer 10,7 (6 decks S17, no surrender): standing is a mistake, basic says hit.
  const g = new BJ.Game({ lateSurrender: false });
  g.shoe = [...BJ.createShoe(6), { rank: '5', suit: '♣' }, { rank: '7', suit: '♦' }, { rank: '10', suit: '♥' }, { rank: '6', suit: '♠' }, { rank: '10', suit: '♠' }];
  const before = { bankroll: g.bankroll, running: 3, unseen: 312 };
  g.deal(10);
  g.stand();
  const { steps } = Rp.replayRound(Rp.recordOf(g, before));
  const d = steps.find((s) => s.decision).decision;
  assert.equal(d.move, 'stand');
  assert.equal(d.basic, 'hit');
  // Visible: 10 (-1), 6 (+1), dealer 10 (-1): running 3 - 1 = 2 with 309 unseen.
  assert.equal(d.running, 2);
  assert.ok(Math.abs(d.tc - 2 / (309 / 52)) < 1e-12);
  assert.ok(d.cost && d.cost.dollars > 0, 'standing on 16 vs 10 is priced');
  assert.deepEqual(steps[0].hands[0].cards.map(Rp.cardCode), ['10♠']);
  assert.equal(steps[3].dealer[1], null, 'the hole card is face down during the deal');
  assert.equal(steps[steps.length - 1].final, true);
});
