const test = require('node:test');
const assert = require('node:assert/strict');
const BJ = require('./blackjack.js');
const Strategy = require('./strategy.js');
const { Table, TableError, SEATS } = require('./table.js');

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const player = (id, kind = 'ai') => ({ id, name: id, kind });
const gameLegal = (g) => {
  if (g.phase === 'insurance') return g.canInsure() ? ['insurance', 'decline_insurance'] : ['decline_insurance'];
  const out = [];
  if (g.canHit()) out.push('hit');
  out.push('stand');
  if (g.canDouble()) out.push('double');
  if (g.canSplit()) out.push('split');
  if (g.canSurrender()) out.push('surrender');
  return out;
};
const gameAct = (g, a) => {
  if (a === 'insurance') g.takeInsurance();
  else if (a === 'decline_insurance') g.declineInsurance();
  else g[a]();
};
const RULESETS = [{}, { h17: true, payout: 1.2, das: false }, { rsa: true, decks: 2 }, { enhc: true }, { enhc: true, obo: true, doubleOn: '9-11' }, { lateSurrender: false, decks: 1, penetration: 0.5 }];

test('table: one seat plays exactly like Game, move for move (oracle)', () => {
  for (const [r, rules] of RULESETS.entries()) {
    const seed = `oracle-${r}`;
    const g = new BJ.Game({ seed, bankroll: 1e6, minBet: 1, maxBet: 500, ...rules });
    const t = new Table({ seed, minBet: 1, maxBet: 500, ...rules });
    t.sit(player('p'), 1e6, 3);
    const rand = lcg(r + 1);
    for (let round = 0; round < 1500; round++) {
      const bet = 1 + Math.floor(rand() * 50);
      g.deal(bet);
      t.bet(3, bet);
      t.deal();
      let guard = 0;
      while (g.phase !== 'done') {
        const legal = gameLegal(g);
        assert.deepEqual(t.legal(3), legal, `${seed} round ${round}`);
        const a = legal[Math.floor(rand() * legal.length)];
        gameAct(g, a);
        t.act(3, a);
        assert.ok(guard++ < 50);
      }
      const s = t.seats[3];
      assert.equal(t.phase, 'done');
      assert.deepEqual(s.hands.map((h) => h.cards), g.hands.map((h) => h.cards));
      assert.deepEqual(t.dealer, g.dealer);
      assert.deepEqual(s.results, g.results, `${seed} round ${round}`);
      assert.equal(s.bankroll, Math.round(g.bankroll * 100) / 100);
      assert.equal(t.shoeNo, g.shoeNo);
    }
  }
});

test('table: several basic-strategy seats match Game with bots (oracle)', () => {
  for (const [bots, seat] of [[1, 0], [3, 2], [6, 3], [6, 6]]) {
    const seed = `oracle-bots-${bots}-${seat}`;
    const g = new BJ.Game({ seed, bankroll: 1e7, bots, seat, botDecide: () => 'stand' });
    const decide = (cards, up, allowed) => Strategy.recommend(cards, up, allowed, g.rules).action;
    g.botDecide = decide;
    const t = new Table({ seed });
    for (let i = 0; i <= bots; i++) t.sit(player(`s${i}`), 1e7, i);
    for (let round = 0; round < 800; round++) {
      g.deal(10);
      for (let i = 0; i <= bots; i++) t.bet(i, 10);
      t.deal();
      while (g.phase === 'insurance') g.declineInsurance();
      while (t.phase === 'insurance') t.act(t.turn, 'decline_insurance');
      while (t.phase === 'player') {
        const i = t.turn;
        const s = t.seats[i];
        const legal = t.legal(i);
        const allowed = { canHit: legal.includes('hit'), canDouble: legal.includes('double'), canSplit: legal.includes('split'), canSurrender: legal.includes('surrender') };
        const a = decide(s.hands[s.active].cards, t.dealer[0], allowed);
        if (i === seat) {
          assert.deepEqual(legal, gameLegal(g));
          gameAct(g, a);
        }
        t.act(i, a);
      }
      assert.deepEqual(t.dealer, g.dealer, `${seed} round ${round}`);
      assert.deepEqual(t.seats[seat].results, g.results);
      for (const o of g.others) assert.deepEqual(t.seats[o.seat].hands.map((h) => h.cards), o.hands.map((h) => h.cards));
    }
  }
});

test('table: turns are enforced and every seat sees the same public table', () => {
  const t = new Table({ seed: 'turns' });
  t.sit(player('a'), 1000, 0);
  t.sit(player('b', 'human'), 1000, 4);
  assert.throws(() => t.sit(player('a'), 1000, 2), /Already seated/);
  assert.throws(() => t.sit(player('c'), 1000, 4), /taken/);
  assert.throws(() => t.deal(), /Nobody has bet/);
  t.bet(0, 10);
  assert.equal(t.ready, false, 'b has not bet');
  t.sitOut(4);
  assert.equal(t.ready, true);
  assert.throws(() => t.bet(0, 0.5), /Minimum/);
  assert.throws(() => t.bet(0, 5000), /exceeds bankroll|Maximum/);
  t.deal();
  if (t.phase === 'done') return;
  assert.deepEqual(t.legal(4), [], 'sitting out: no moves');
  const other = t.turn === 0 ? 4 : 0;
  assert.throws(() => t.act(other, 'stand'), TableError);
  const a = t.view(0);
  const b = t.view(4);
  assert.deepEqual({ ...a, you: undefined }, { ...b, you: undefined });
  assert.equal(a.dealer.cards.length, 1, 'hole card hidden');
  assert.equal(JSON.stringify(a).includes('turns-'), false, 'the seed of the shoe in play never shows');
  assert.equal(b.seats[0].player.kind, 'ai');
  assert.equal(b.seats[4].player.kind, 'human');
  assert.ok(a.you.yourTurn !== b.you.yourTurn || t.phase === 'insurance');
  assert.throws(() => t.leave(0), /Finish the round/);
  t.leave(4);
});

test('table: seen cards plus cards left always make the shoe, and finished shoes are published', () => {
  const t = new Table({ seed: 'seen', decks: 2 });
  for (let i = 0; i < SEATS; i++) t.sit(player(`p${i}`), 1e6, i);
  const rand = lcg(9);
  let shoes = 0;
  for (let round = 0; round < 300; round++) {
    for (let i = 0; i < SEATS; i++) (rand() < 0.15 ? t.sitOut(i) : t.bet(i, 5));
    if (!t.ready) t.bet(0, 5);
    t.deal();
    const check = () => {
      const v = t.view(null);
      assert.equal(Object.values(v.shoe.seen).reduce((a, b) => a + b, 0) + v.shoe.cardsLeft, 104, `round ${round} ${v.phase}`);
    };
    check();
    while (t.phase !== 'done') {
      const legal = t.legal(t.turn);
      t.act(t.turn, legal[Math.floor(rand() * legal.length)]);
      check();
    }
    shoes = t.finishedShoes.length;
  }
  assert.ok(shoes >= 5);
  assert.equal(t.finishedShoes[0], 'seen-1');
  assert.equal(t.view(null).shoe.finished[0], 'seen-1');
});
