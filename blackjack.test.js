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

// --- Cut card: the shoe is only replaced between rounds ---

test('cut card sits three quarters of the way into the shoe', () => {
  const g = new BJ.Game(); // 6 decks: 78 cards behind the cut card
  g.shoe = g.shoe.slice(0, 79);
  assert.ok(!g.cutCardReached);
  g.shoe.pop();
  assert.ok(g.cutCardReached);
});

test('a round that passes the cut card finishes from the same shoe', () => {
  // 80 cards left; the deal takes it past the cut card (78).
  const g = riggedGame([c('10'), c('2'), c('10'), c('6'), c('2'), c('2'), c('3'), c('K')]);
  g.shoe = g.shoe.slice(-80);
  const lengths = [g.shoe.length];
  g.deal(10);
  lengths.push(g.shoe.length);
  assert.ok(g.cutCardReached);
  while (g.phase === 'player') { g.hit(); lengths.push(g.shoe.length); }
  assert.equal(g.shuffles, 0);
  for (let i = 1; i < lengths.length; i++) assert.ok(lengths[i] < lengths[i - 1], 'no reshuffle mid-round');
  // The next deal starts a fresh shoe before any card is dealt.
  g.deal(10);
  assert.equal(g.shuffles, 1);
  assert.ok(g.newShoe);
  assert.equal(g.shoe.length, 312 - 4);
});

test('no mid-round reshuffles over many rounds', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = new BJ.Game({ bankroll: 1e9, rng });
  for (let i = 0; i < 3000; i++) {
    g.deal(10);
    let last = g.shoe.length;
    if (g.phase === 'insurance') g.declineInsurance();
    while (g.phase === 'player') {
      if (g.canSplit()) g.split(); else g.hit();
      assert.ok(g.shoe.length < last, `reshuffled mid-round in round ${i}`);
      last = g.shoe.length;
    }
  }
  assert.ok(g.shuffles > 30, 'the cut card does come out');
  assert.equal(g.emergencyShuffles, 0);
});

test('a shoe that runs dry mid-round reuses only the discards', () => {
  const g = riggedGame([c('8'), c('8'), c('10'), c('7')]);
  g.deal(10);
  g.shoe = [];
  g.split(); // second 8 needs a card: shoe is empty
  assert.equal(g.emergencyShuffles, 1);
  const onTable = [...g.dealer, ...g.hands.flatMap((h) => h.cards)].length;
  assert.equal(g.shoe.length + onTable, 312);
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

// --- Saving and restoring (bankroll survives a reload) ---

const roundTrip = (g) => BJ.Game.fromJSON(JSON.parse(JSON.stringify(g)));

test('saved game keeps the bankroll between rounds', () => {
  const g = riggedGame([c('10'), c('9'), c('10'), c('7')]);
  g.deal(100);
  g.stand(); // 19 beats 17
  assert.equal(g.bankroll, 1100);
  const back = roundTrip(g);
  assert.equal(back.bankroll, 1100);
  assert.equal(back.phase, 'done');
  assert.deepEqual(back.results, g.results);
  assert.equal(back.shoe.length, g.shoe.length);
});

test('saved game resumes a round in progress with the stake still on the table', () => {
  // Player 10,6 vs dealer 10,7; hit draws a 4 (20).
  const g = riggedGame([c('10'), c('6'), c('10'), c('7'), c('4')]);
  g.deal(100);
  assert.equal(g.bankroll, 900);
  const back = roundTrip(g);
  assert.equal(back.phase, 'player');
  assert.equal(back.bankroll, 900, 'reload neither refunds nor forfeits the bet');
  back.hit();
  back.stand();
  assert.equal(back.results[0].outcome, 'win');
  assert.equal(back.bankroll, 1100);
});

test('saved game resumes an insurance offer', () => {
  const g = riggedGame([c('10'), c('9'), c('A'), c('K')]);
  g.deal(100);
  const back = roundTrip(g);
  assert.equal(back.phase, 'insurance');
  back.takeInsurance();
  assert.equal(back.bankroll, 1000);
});

test('corrupt or inconsistent saves are rejected', () => {
  const good = JSON.parse(JSON.stringify(new BJ.Game({ bankroll: 500 })));
  assert.ok(BJ.Game.fromJSON(good));
  const bad = [
    null, 'text', 42, {},
    { ...good, bankroll: -1 },
    { ...good, bankroll: 'lots' },
    { ...good, phase: 'dancing' },
    { ...good, decks: 0 },
    { ...good, shoe: [{ rank: 'Z', suit: '♠' }] },
    { ...good, phase: 'player', hands: [] },
    { ...good, phase: 'done', hands: [{ cards: [c('A'), c('K')], bet: 10, fromSplit: false, splitAces: false, surrendered: false, done: true }], results: [] },
  ];
  for (const d of bad) assert.equal(BJ.Game.fromJSON(d), null, JSON.stringify(d).slice(0, 60));
});

// --- Running out of chips ---

test('a bankroll below the minimum bet counts as broke', () => {
  const g = new BJ.Game({ bankroll: 0.5 });
  assert.equal(g.minBet, 1);
  assert.ok(g.isBroke);
  assert.throws(() => g.deal(1), /exceeds bankroll/);
  assert.throws(() => g.deal(0.5), /Minimum bet is \$1/);
  assert.ok(!new BJ.Game({ bankroll: 1 }).isBroke);
  assert.ok(new BJ.Game({ bankroll: 0 }).isBroke);
});

test('surrendering the last $1 leaves you broke', () => {
  const g = riggedGame([c('10'), c('6'), c('10'), c('7')], 1);
  g.deal(1);
  assert.equal(g.bankroll, 0);
  assert.ok(!g.isBroke, 'not broke while the round is still live');
  g.surrender();
  assert.equal(g.bankroll, 0.5);
  assert.ok(g.isBroke);
});

// --- Even money ---

test('even money is offered only when you hold blackjack against an ace', () => {
  const bj = riggedGame([c('A'), c('K'), c('A'), c('7')]);
  bj.deal(100);
  assert.ok(bj.evenMoneyOffered);
  const plain = riggedGame([c('10'), c('9'), c('A'), c('7')]);
  plain.deal(100);
  assert.equal(plain.phase, 'insurance');
  assert.ok(!plain.evenMoneyOffered);
});

test('even money pays 1:1 when the dealer has no blackjack', () => {
  const g = riggedGame([c('A'), c('K'), c('A'), c('7')]);
  g.deal(100);
  g.takeInsurance();
  assert.ok(g.tookEvenMoney);
  assert.equal(g.phase, 'done');
  assert.equal(g.net, 100);
  assert.equal(g.bankroll, 1100);
});

test('even money needs no spare chips', () => {
  const g = riggedGame([c('A'), c('K'), c('A'), c('Q')], 100);
  g.deal(100);
  assert.equal(g.bankroll, 0);
  assert.ok(g.canInsure());
  g.takeInsurance();
  assert.equal(g.bankroll, 200);
  assert.equal(g.net, 100);
});

// --- Table limits ---

test('deal enforces the table maximum', () => {
  const g = riggedGame([c('10'), c('9'), c('10'), c('7')]);
  g.maxBet = 500;
  assert.throws(() => g.deal(501), /Maximum bet is \$500/);
  g.deal(500);
  assert.equal(g.hands[0].bet, 500);
});

test('saved games keep table limits; older saves load with defaults', () => {
  const g = new BJ.Game({ bankroll: 900, minBet: 5, maxBet: 500 });
  const back = BJ.Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.equal(back.minBet, 5);
  assert.equal(back.maxBet, 500);
  const old = JSON.parse(JSON.stringify(g));
  delete old.minBet;
  delete old.maxBet;
  const legacy = BJ.Game.fromJSON(old);
  assert.equal(legacy.minBet, 1);
  assert.equal(legacy.maxBet, Infinity);
  assert.equal(BJ.Game.fromJSON({ ...old, maxBet: -3 }), null);
});

// --- Rule settings ---

test('H17: the dealer hits soft 17; S17 stands', () => {
  assert.ok(!BJ.dealerShouldHit([c('A'), c('6')]));
  assert.ok(BJ.dealerShouldHit([c('A'), c('6')], true));
  assert.ok(!BJ.dealerShouldHit([c('10'), c('7')], true)); // hard 17 always stands
  // Player 18 vs dealer A,6: under H17 the dealer draws a 3 and makes 20.
  const g = riggedGame([c('10'), c('8'), c('A'), c('6'), c('3')]);
  g.h17 = true;
  g.deal(10);
  g.declineInsurance();
  g.stand();
  assert.equal(BJ.handValue(g.dealer).total, 20);
  assert.equal(g.results[0].outcome, 'lose');
});

test('6:5 blackjack pays 1.2x the bet', () => {
  assert.deepEqual(BJ.settle([c('A'), c('K')], [c('10'), c('9')], 10, { payout: 1.2 }), { outcome: 'blackjack', net: 12 });
  const g = riggedGame([c('A'), c('K'), c('10'), c('9')]);
  g.payout = 1.2;
  g.deal(100);
  assert.equal(g.bankroll, 1120);
});

test('6:5: insuring a blackjack is plain insurance, not even money', () => {
  const g = riggedGame([c('A'), c('K'), c('A'), c('7')]);
  g.payout = 1.2;
  g.deal(100);
  assert.equal(g.phase, 'insurance');
  assert.ok(!g.evenMoneyOffered);
  g.takeInsurance(); // dealer has no blackjack: lose 50 insurance, win 120
  assert.equal(g.net, 70);
});

test('no double after split when DAS is off', () => {
  const g = riggedGame([c('5'), c('5'), c('10'), c('7'), c('6'), c('10'), c('9')]);
  g.das = false;
  g.deal(100);
  assert.ok(g.canDouble(), 'can still double the original two cards');
  g.split();
  assert.ok(!g.canDouble());
  assert.throws(() => g.double());
});

test('surrender can be turned off', () => {
  const g = riggedGame([c('10'), c('6'), c('10'), c('6')]);
  g.lateSurrender = false;
  g.deal(100);
  assert.ok(!g.canSurrender());
  assert.throws(() => g.surrender());
});

test('rules are saved with the game; older saves load with the defaults', () => {
  const g = new BJ.Game({ decks: 2, h17: true, payout: 1.2, das: false, lateSurrender: false });
  const back = BJ.Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(back.rules, { decks: 2, h17: true, payout: 1.2, das: false, lateSurrender: false });
  const old = JSON.parse(JSON.stringify(new BJ.Game()));
  for (const k of ['h17', 'payout', 'das', 'lateSurrender']) delete old[k];
  assert.deepEqual(BJ.Game.fromJSON(old).rules, { decks: 6, h17: false, payout: 1.5, das: true, lateSurrender: true });
  assert.equal(BJ.Game.fromJSON({ ...old, payout: 2 }), null);
  assert.equal(BJ.Game.fromJSON({ ...old, h17: 'yes' }), null);
});

// --- Side bets ---

test('side bets settle at the deal and add to the round net', () => {
  // You 8h 8d (colored pair) vs dealer 9h up: 21+3 loses. Stand 16 v 9... dealer 9,7 draws 2 -> 18.
  const g = riggedGame([c('8', '♥'), c('8', '♦'), c('9', '♣'), c('7', '♣'), c('2', '♣')]);
  g.deal(10, { pairs: 5, t213: 5 });
  assert.deepEqual(g.sideBets.map((s) => [s.bet, s.win, s.net]), [['pairs', 'colored pair', 60], ['t213', null, -5]]);
  assert.equal(g.bankroll, 1000 - 10 + 55);
  g.stand();
  assert.equal(g.results[0].outcome, 'lose');
  assert.equal(g.net, -10 + 55);
  assert.equal(g.bankroll, 1045);
});

test('side bets count against the bankroll and table limits', () => {
  const g = riggedGame([c('10'), c('9'), c('10'), c('7')], 20);
  assert.throws(() => g.deal(15, { pairs: 10 }), /exceeds bankroll/);
  assert.throws(() => g.deal(5, { pairs: 101 }), /at most \$100/);
  assert.throws(() => g.deal(5, { pairs: 2.5 }), /whole dollars/);
  assert.throws(() => g.deal(5, { craps: 1 }), /Unknown side bet/);
  g.deal(10, { pairs: 0, t213: 10 });
  assert.equal(g.sideBets.length, 1);
});

test('side bets survive save and restore; old saves have none', () => {
  const g = riggedGame([c('8', '♥'), c('8', '♦'), c('9', '♣'), c('7', '♣'), c('2', '♣')]);
  g.deal(10, { pairs: 5 });
  const back = BJ.Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.equal(back.sideNet, 60);
  const old = JSON.parse(JSON.stringify(g));
  delete old.sideBets;
  assert.equal(BJ.Game.fromJSON(old).sideNet, 0);
  assert.equal(BJ.Game.fromJSON({ ...old, sideBets: [{ bet: 'pairs', stake: -1, win: null, odds: 0, net: 1 }] }), null);
});

test('R1: wagered counts doubles, splits, insurance and side bets', () => {
  const g = riggedGame([c('5'), c('5'), c('10'), c('7'), c('6'), c('10'), c('9')]);
  g.deal(10, { pairs: 5 });
  g.split();
  g.double();
  g.stand();
  assert.equal(g.wagered, 20 + 10 + 5);
  const ins = riggedGame([c('10'), c('9'), c('A'), c('7')]);
  ins.deal(100);
  ins.takeInsurance();
  assert.equal(ins.wagered, 150);
});

// --- F5: 1-3 betting spots ---

test('F5: two spots get two cards each before the dealer, and settle separately', () => {
  // Spot 1: 10,9 (19). Spot 2: 10,6 (16). Dealer 10,8.
  const g = riggedGame([c('10'), c('9'), c('10'), c('6'), c('10'), c('8')]);
  g.deal([10, 20]);
  assert.equal(g.hands.length, 2);
  assert.deepEqual(g.hands.map((h) => [h.spot, h.bet, BJ.handValue(h.cards).total]), [[0, 10, 19], [1, 20, 16]]);
  assert.equal(g.bankroll, 970);
  g.stand();
  assert.equal(g.active, 1);
  g.stand();
  assert.deepEqual(g.results.map((r) => r.outcome), ['win', 'lose']);
  assert.equal(g.net, -10);
  assert.equal(g.bankroll, 990);
  assert.equal(g.wagered, 30);
});

test('F5: a natural on one spot is paid, the others still play', () => {
  // Spot 1: A,K. Spot 2: 10,7. Dealer 10,8.
  const g = riggedGame([c('A'), c('K'), c('10'), c('7'), c('10'), c('8')]);
  g.deal([10, 10]);
  assert.equal(g.phase, 'player');
  assert.equal(g.active, 1, 'play starts on spot 2');
  g.stand();
  assert.deepEqual(g.results.map((r) => r.outcome), ['blackjack', 'lose']);
  assert.equal(g.net, 15 - 10);
});

test('F5: when every spot is a natural the dealer does not draw', () => {
  const g = riggedGame([c('A'), c('K'), c('A'), c('Q'), c('10'), c('6'), c('5')]);
  g.deal([10, 10]);
  assert.equal(g.phase, 'done');
  assert.equal(g.dealer.length, 2);
  assert.equal(g.net, 30);
});

test('F5: insurance covers every spot; even money only with one spot', () => {
  // Spot 1: A,K (blackjack). Spot 2: 10,9. Dealer A up, K hole.
  const g = riggedGame([c('A'), c('K'), c('10'), c('9'), c('A'), c('K')]);
  g.deal([10, 20]);
  assert.equal(g.phase, 'insurance');
  assert.ok(!g.evenMoneyOffered);
  assert.equal(g.insuranceCost, 15);
  g.takeInsurance(); // dealer blackjack: insurance pays 30; spot 1 pushes, spot 2 loses 20
  assert.deepEqual(g.results.map((r) => r.outcome), ['push', 'lose']);
  assert.equal(g.net, 30 - 20);
});

test('F5: the split limit is per spot', () => {
  // Spot 1: 8,8. Spot 2: 8,8. Dealer 10,7. Then 8s for resplits and small cards.
  const g = riggedGame([c('8'), c('8'), c('8'), c('8'), c('10'), c('7'), c('8'), c('8'), c('8'),
    c('2'), c('2'), c('2'), c('2'), c('2'), c('2'), c('2'), c('2')]);
  g.deal([5, 5]);
  g.split(); g.split(); g.split();
  assert.equal(g.hands.filter((h) => h.spot === 0).length, 4);
  assert.ok(!g.canSplit());
  while (g.hands[g.active].spot === 0) g.stand();
  assert.ok(g.canSplit(), 'spot 2 can still split');
});

test('F5: 1-3 spots only, each within the limits, total within the bankroll', () => {
  const g = riggedGame([c('10'), c('9'), c('10'), c('7')], 25);
  assert.throws(() => g.deal([]), /1 to 3 spots/);
  assert.throws(() => g.deal([5, 5, 5, 5]), /1 to 3 spots/);
  assert.throws(() => g.deal([10, 10, 10]), /exceeds bankroll/);
  g.maxBet = 8;
  assert.throws(() => g.deal([5, 9]), /Maximum bet/);
});

test('F5: spots survive save and restore; older saves are one spot', () => {
  const g = riggedGame([c('10'), c('9'), c('10'), c('6'), c('10'), c('8')]);
  g.deal([10, 20]);
  const back = BJ.Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.deepEqual(back.spotBets, [10, 20]);
  assert.deepEqual(back.hands.map((h) => h.spot), [0, 1]);
  const old = JSON.parse(JSON.stringify(riggedGame([c('10'), c('9'), c('10'), c('7')])));
  delete old.spotBets;
  assert.ok(BJ.Game.fromJSON(old));
  assert.equal(BJ.Game.fromJSON({ ...JSON.parse(JSON.stringify(g)), spotBets: [1, 2, 3, 4] }), null);
});

test('F5: two spots, one split: every hand settles and return counts every bet', () => {
  // Spot 1: 8,8 -> split. Spot 2: 10,9. Dealer 10,7.
  // Spot 1a draws 3 (11) then doubles into 10 (21); spot 1b draws 10 (18); spot 2 stands on 19.
  const g = riggedGame([c('8'), c('8'), c('10'), c('9'), c('10'), c('7'), c('3'), c('10'), c('10')]);
  g.deal([10, 20]);
  g.split();
  assert.deepEqual(g.hands.map((h) => h.spot), [0, 0, 1]);
  g.double();                 // 1a: 8+3 -> doubles into 10 = 21
  g.stand();                  // 1b: 8+10 = 18
  g.stand();                  // spot 2: 19
  assert.equal(g.phase, 'done');
  assert.deepEqual(g.hands.map((h) => [h.spot, h.bet, BJ.handValue(h.cards).total]), [[0, 20, 21], [0, 10, 18], [1, 20, 19]]);
  assert.deepEqual(g.results.map((r) => r.outcome), ['win', 'win', 'win']);
  assert.equal(g.net, 20 + 10 + 20);
  assert.equal(g.wagered, 50);
  assert.equal(g.bankroll, 1050);
  const S = require('./stats.js');
  const st = S.recordRound(S.emptyStats(), g.results, g.net, g.wagered);
  assert.deepEqual([st.hands, st.wins, st.wagered], [3, 3, 50]);
  assert.equal(S.returnRate(st), 2);
});
