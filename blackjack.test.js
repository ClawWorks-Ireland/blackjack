const test = require('node:test');
const assert = require('node:assert/strict');
const BJ = require('./blackjack.js');

const c = (rank, suit = '♠') => ({ rank, suit });
const total = (cards) => BJ.handValue(cards).total;

/** Build a Game whose shoe pops the given cards in order. */
function riggedGame(cards, bankroll = 1000) {
  const g = new BJ.Game({ bankroll });
  // Pad with filler so the shoe stays above the reshuffle threshold.
  const filler = Array.from({ length: 100 }, () => c('2'));
  g.shoe = filler.concat(cards.slice().reverse());
  return g;
}
// Deal order: player, player, dealer, dealer, then draws in play order.

test('shoe has 52 cards per deck', () => {
  assert.equal(BJ.createShoe(1).length, 52);
  assert.equal(BJ.createShoe(6).length, 312);
});

test('shuffle keeps every card and does not mutate input', () => {
  const shoe = BJ.createShoe(1);
  const copy = shoe.slice();
  const out = BJ.shuffle(shoe);
  assert.deepEqual(shoe, copy);
  assert.equal(out.length, 52);
  const key = (x) => x.rank + x.suit;
  assert.deepEqual(out.map(key).sort(), shoe.map(key).sort());
});

test('handValue counts aces as 11 or 1', () => {
  assert.deepEqual(BJ.handValue([c('A'), c('6')]), { total: 17, soft: true });
  assert.deepEqual(BJ.handValue([c('A'), c('6'), c('10')]), { total: 17, soft: false });
  assert.deepEqual(BJ.handValue([c('A'), c('A'), c('9')]), { total: 21, soft: true });
  assert.deepEqual(BJ.handValue([c('K'), c('Q'), c('5')]), { total: 25, soft: false });
});

test('blackjack only on two-card 21', () => {
  assert.ok(BJ.isBlackjack([c('A'), c('K')]));
  assert.ok(!BJ.isBlackjack([c('7'), c('7'), c('7')]));
});

test('dealer hits below 17 and stands on soft 17', () => {
  assert.ok(BJ.dealerShouldHit([c('10'), c('6')]));
  assert.ok(!BJ.dealerShouldHit([c('10'), c('7')]));
  assert.ok(!BJ.dealerShouldHit([c('A'), c('6')]));
});

test('settle covers every outcome', () => {
  const bj = [c('A'), c('K')];
  assert.deepEqual(BJ.settle(bj, bj, 10), { outcome: 'push', net: 0 });
  assert.deepEqual(BJ.settle(bj, [c('10'), c('9')], 10), { outcome: 'blackjack', net: 15 });
  assert.deepEqual(BJ.settle([c('10'), c('9')], bj, 10), { outcome: 'lose', net: -10 });
  assert.deepEqual(BJ.settle([c('K'), c('Q'), c('5')], [c('K'), c('Q'), c('5')], 10), { outcome: 'bust', net: -10 });
  assert.deepEqual(BJ.settle([c('10'), c('8')], [c('K'), c('6'), c('9')], 10), { outcome: 'win', net: 10 });
  assert.deepEqual(BJ.settle([c('10'), c('9')], [c('10'), c('8')], 10), { outcome: 'win', net: 10 });
  assert.deepEqual(BJ.settle([c('10'), c('7')], [c('10'), c('8')], 10), { outcome: 'lose', net: -10 });
  assert.deepEqual(BJ.settle([c('10'), c('8')], [c('10'), c('8')], 10), { outcome: 'push', net: 0 });
});

test('two-card 21 on a split hand pays 1:1, not 3:2', () => {
  assert.deepEqual(BJ.settle([c('A'), c('K')], [c('10'), c('7')], 10, { fromSplit: true }),
    { outcome: 'win', net: 10 });
});

test('natural blackjack pays 3:2 immediately', () => {
  const g = riggedGame([c('A'), c('K'), c('10'), c('9')]);
  g.deal(100);
  assert.equal(g.phase, 'done');
  assert.equal(g.results[0].outcome, 'blackjack');
  assert.equal(g.bankroll, 1150);
});

test('player bust loses the bet', () => {
  const g = riggedGame([c('10'), c('6'), c('10'), c('7'), c('K')]);
  g.deal(50);
  g.hit();
  assert.equal(g.results[0].outcome, 'bust');
  assert.equal(g.bankroll, 950);
});

test('stand makes dealer draw to 17+', () => {
  // Player 10+8=18; dealer 10+4, draws 5 -> 19.
  const g = riggedGame([c('10'), c('8'), c('10'), c('4'), c('5')]);
  g.deal(10);
  g.stand();
  assert.equal(total(g.dealer), 19);
  assert.equal(g.results[0].outcome, 'lose');
  assert.equal(g.bankroll, 990);
});

test('double down doubles the stake and draws one card', () => {
  // Player 6+5=11, dealer 10+7=17, player doubles into 10 -> 21.
  const g = riggedGame([c('6'), c('5'), c('10'), c('7'), c('10')]);
  g.deal(100);
  assert.ok(g.canDouble());
  g.double();
  assert.equal(g.hands[0].cards.length, 3);
  assert.equal(g.hands[0].bet, 200);
  assert.equal(g.results[0].outcome, 'win');
  assert.equal(g.bankroll, 1200);
});

test('cannot double without enough bankroll', () => {
  const g = riggedGame([c('6'), c('5'), c('10'), c('7')], 100);
  g.deal(100);
  assert.ok(!g.canDouble());
  assert.throws(() => g.double());
});

test('deal rejects invalid bets and mid-round deals', () => {
  const g = riggedGame([c('10'), c('6'), c('10'), c('7')], 100);
  assert.throws(() => g.deal(0));
  assert.throws(() => g.deal(200));
  g.deal(10);
  assert.throws(() => g.deal(10));
});

test('shoe reshuffles when running low', () => {
  const g = new BJ.Game({ decks: 1 });
  g.shoe = g.shoe.slice(0, 10);
  g.draw();
  assert.ok(g.shoe.length >= 50);
});

// --- Splitting ---

test('canSplit requires a same-rank pair', () => {
  const pair = riggedGame([c('8'), c('8'), c('10'), c('7')]);
  pair.deal(10);
  assert.ok(pair.canSplit());

  const tens = riggedGame([c('K'), c('Q'), c('10'), c('7')]);
  tens.deal(10);
  assert.ok(!tens.canSplit());
  assert.throws(() => tens.split());
});

test('cannot split without enough bankroll for the second bet', () => {
  const g = riggedGame([c('8'), c('8'), c('10'), c('7')], 100);
  g.deal(100);
  assert.ok(!g.canSplit());
});

test('split plays each hand in turn and settles them separately', () => {
  // 8,8 vs dealer 10,7. Hand 1 gets 3 (11), hand 2 gets 10 (18).
  const g = riggedGame([c('8'), c('8'), c('10'), c('7'), c('3'), c('10')]);
  g.deal(100);
  g.split();
  assert.equal(g.bankroll, 800);
  assert.equal(g.hands.length, 2);
  assert.equal(g.active, 0);
  assert.equal(total(g.hands[0].cards), 11);
  assert.equal(g.hands[1].cards.length, 1, 'second hand waits for its card');

  g.stand();
  assert.equal(g.active, 1);
  assert.equal(total(g.hands[1].cards), 18);

  g.stand();
  assert.equal(g.phase, 'done');
  assert.deepEqual(g.results.map((r) => r.outcome), ['lose', 'win']);
  assert.equal(g.net, 0);
  assert.equal(g.bankroll, 1000);
});

test('split aces get one card each and a 21 is not blackjack', () => {
  // A,A vs 10,7. Hand 1 gets K (21), hand 2 gets 5 (16). Round auto-ends.
  const g = riggedGame([c('A'), c('A'), c('10'), c('7'), c('K'), c('5')]);
  g.deal(100);
  g.split();
  assert.equal(g.phase, 'done');
  assert.deepEqual(g.results, [{ outcome: 'win', net: 100 }, { outcome: 'lose', net: -100 }]);
  assert.equal(g.bankroll, 1000);
});

test('double after split', () => {
  // 5,5 vs 10,7. Hand 1 gets 6 (11), doubles into 10 (21); hand 2 gets 9 (14).
  const g = riggedGame([c('5'), c('5'), c('10'), c('7'), c('6'), c('10'), c('9')]);
  g.deal(100);
  g.split();
  assert.ok(g.canDouble());
  g.double();
  assert.equal(g.active, 1);
  g.stand();
  assert.deepEqual(g.results.map((r) => r.outcome), ['win', 'lose']);
  // 1000 - 100 deal - 100 split - 100 double + 400 (hand 1 win) = 1100
  assert.equal(g.bankroll, 1100);
});

test('resplitting is capped at four hands', () => {
  const g = riggedGame([c('8'), c('8'), c('10'), c('7'), c('8'), c('8'), c('8')]);
  g.deal(10);
  g.split();
  g.split();
  g.split();
  assert.equal(g.hands.length, BJ.MAX_HANDS);
  assert.ok(!g.canSplit());
});

test('dealer does not draw when every split hand busts', () => {
  // 8,8 vs 10,6. Each hand gets 6 (14) then busts on a 10.
  const g = riggedGame([c('8'), c('8'), c('10'), c('6'), c('6'), c('10'), c('6'), c('10')]);
  g.deal(10);
  g.split();
  g.hit();
  assert.equal(g.active, 1);
  g.hit();
  assert.equal(g.phase, 'done');
  assert.equal(g.dealer.length, 2);
  assert.deepEqual(g.results.map((r) => r.outcome), ['bust', 'bust']);
  assert.equal(g.bankroll, 980);
});

// --- Insurance ---

test('dealer ace up offers insurance before play', () => {
  const g = riggedGame([c('10'), c('9'), c('A'), c('7')]);
  g.deal(100);
  assert.equal(g.phase, 'insurance');
  assert.ok(g.canInsure());
  assert.throws(() => g.hit());
  assert.throws(() => g.deal(10));
});

test('ten up with dealer blackjack ends the round without insurance', () => {
  const g = riggedGame([c('10'), c('9'), c('K'), c('A')]);
  g.deal(100);
  assert.equal(g.phase, 'done');
  assert.equal(g.results[0].outcome, 'lose');
  assert.equal(g.insuranceNet, null);
});

test('insurance pays 2:1 when the dealer has blackjack', () => {
  const g = riggedGame([c('10'), c('9'), c('A'), c('K')]);
  g.deal(100);
  g.takeInsurance();
  assert.equal(g.phase, 'done');
  assert.equal(g.results[0].outcome, 'lose');
  assert.equal(g.insuranceNet, 100);
  assert.equal(g.net, 0);
  assert.equal(g.bankroll, 1000);
});

test('insurance is lost when the dealer has no blackjack, play continues', () => {
  const g = riggedGame([c('10'), c('9'), c('A'), c('7')]);
  g.deal(100);
  g.takeInsurance();
  assert.equal(g.phase, 'player');
  assert.equal(g.insuranceNet, -50);
  g.stand(); // 19 vs soft 18
  assert.equal(g.results[0].outcome, 'win');
  assert.equal(g.net, 50);
  assert.equal(g.bankroll, 1050);
});

test('declining insurance against dealer blackjack loses only the bet', () => {
  const g = riggedGame([c('10'), c('9'), c('A'), c('K')]);
  g.deal(100);
  g.declineInsurance();
  assert.equal(g.phase, 'done');
  assert.equal(g.insuranceNet, null);
  assert.equal(g.bankroll, 900);
});

test('player blackjack with insurance against dealer blackjack is even money', () => {
  const g = riggedGame([c('A'), c('K'), c('A'), c('Q')]);
  g.deal(100);
  assert.equal(g.phase, 'insurance');
  g.takeInsurance();
  assert.equal(g.results[0].outcome, 'push');
  assert.equal(g.net, 100);
  assert.equal(g.bankroll, 1100);
});

test('player blackjack still pays 3:2 once the dealer peeks clean', () => {
  const g = riggedGame([c('A'), c('K'), c('A'), c('7')]);
  g.deal(100);
  g.declineInsurance();
  assert.equal(g.phase, 'done');
  assert.equal(g.results[0].outcome, 'blackjack');
  assert.equal(g.bankroll, 1150);
});

test('cannot insure without chips for half the bet', () => {
  const g = riggedGame([c('10'), c('9'), c('A'), c('7')], 100);
  g.deal(100);
  assert.ok(!g.canInsure());
  assert.throws(() => g.takeInsurance());
  g.declineInsurance();
  assert.equal(g.phase, 'player');
});

// --- Surrender ---

test('surrender returns half the bet and the dealer does not draw', () => {
  const g = riggedGame([c('10'), c('6'), c('10'), c('6')]);
  g.deal(100);
  assert.ok(g.canSurrender());
  g.surrender();
  assert.equal(g.phase, 'done');
  assert.deepEqual(g.results[0], { outcome: 'surrender', net: -50 });
  assert.equal(g.dealer.length, 2);
  assert.equal(g.bankroll, 950);
});

test('surrender is only allowed on the first two cards of an unsplit hand', () => {
  const hit = riggedGame([c('5'), c('4'), c('10'), c('7'), c('2')]);
  hit.deal(10);
  hit.hit();
  assert.ok(!hit.canSurrender());
  assert.throws(() => hit.surrender());

  const split = riggedGame([c('8'), c('8'), c('10'), c('7'), c('3'), c('10')]);
  split.deal(10);
  split.split();
  assert.ok(!split.canSurrender());
});

test('surrender is not offered until insurance is resolved', () => {
  const g = riggedGame([c('10'), c('6'), c('A'), c('7')]);
  g.deal(100);
  assert.ok(!g.canSurrender());
  g.declineInsurance();
  assert.ok(g.canSurrender());
});
