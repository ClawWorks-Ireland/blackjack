const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./poker.js');

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const ev = (s) => P.evaluate(s.split(' '));
const player = (id) => ({ id, name: id, kind: 'ai' });

// An independent, slow evaluator: the best of every five-card subset, ranked the textbook way.
function rank5(cards) {
  const v = cards.map(P.value).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const uniq = [...new Set(v)];
  let straight = 0;
  if (uniq.length === 5 && v[0] - v[4] === 4) straight = v[0];
  if (uniq.length === 5 && v[0] === 14 && v[1] === 5) straight = 5;
  const counts = {};
  for (const x of v) counts[x] = (counts[x] || 0) + 1;
  const groups = Object.entries(counts).map(([r, c]) => [Number(r), c]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const byGroup = groups.map((g) => g[0]);
  let cat;
  let ks;
  if (straight && flush) { cat = 8; ks = [straight]; } else if (shape === '41') { cat = 7; ks = byGroup; } else if (shape === '32') { cat = 6; ks = byGroup; } else if (flush) { cat = 5; ks = v; } else if (straight) { cat = 4; ks = [straight]; } else if (shape === '311') { cat = 3; ks = byGroup; } else if (shape === '221') { cat = 2; ks = byGroup; } else if (shape === '2111') { cat = 1; ks = byGroup; } else { cat = 0; ks = v; }
  return [cat, ...ks];
}
function slow7(cards) {
  let best = null;
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    const r = rank5(cards.filter((_, i) => i !== a && i !== b));
    if (!best || cmp(r, best) > 0) best = r;
  }
  return best;
}
const cmp = (x, y) => { for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); } return 0; };

test('poker: hand categories rank in order, with kickers and the wheel', () => {
  const order = ['Ah Kh Qh Jh Th 2c 3d', '9h 9d 9s 9c 2d 3c 4h', 'Kh Kd Ks 2c 2d 3c 4h', '2h 7h 9h Jh Kh Ac Ad', 'Ah 2d 3s 4c 5h Kd Kc', 'Qh Qd Qs Jc 8h 4d 2c', 'Qh Qd Js Jc 9h 8d 2c', 'Ah Ad Ks Qc 9h 4d 2c', 'Ah Kd 8s 6c 4h 3d 2c'];
  for (let i = 1; i < order.length; i++) assert.ok(ev(order[i - 1]).score > ev(order[i]).score, `${order[i - 1]} beats ${order[i]}`);
  assert.ok(ev('6h 2d 3s 4c 5h Kd Qc').score > ev('Ah 2d 3s 4c 5h Kd Qc').score, 'six-high straight beats the wheel');
  assert.ok(ev('Ah Ad Ks 9c 8h 4d 2c').score > ev('Ah Ad Qs Jc 9h 4d 2c').score, 'kicker decides');
  assert.equal(ev('Qh Qd Js Jc 9h 9d Ac').name, 'two pair, queens and jacks');
  assert.ok(ev('Qh Qd Js Jc 9h 9d Ac').score > ev('Qh Qd Js Jc 9h 9d 2c').score, 'the ace plays as the kicker, not the nines');
  assert.equal(ev('Kh Kd Ks 2c 2d 2s 4h').name, 'full house, kings full of twos');
  assert.equal(ev('Ts Js Qs Ks As 9s 8s').name, 'royal flush');
  assert.equal(ev('Ah Ad Ac Ks Kd Kc 2h').score, ev('Ac Ad Ah Kd Kc Ks 3h').score, 'same best five, same score');
});

test('poker: the evaluator agrees with a brute-force best-of-21 on random hands', () => {
  const rand = lcg(7);
  const deck = P.fullDeck();
  for (let n = 0; n < 3000; n++) {
    const d = deck.slice();
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    const a = d.slice(0, 7);
    const b = d.slice(7, 14);
    assert.equal(Math.sign(P.evaluate(a).score - P.evaluate(b).score), cmp(slow7(a), slow7(b)), `${a} vs ${b}`);
  }
});

test('poker: blinds, the button and who acts first', () => {
  const t = new P.PokerTable({ seed: 'order', smallBlind: 5, bigBlind: 10 });
  t.sit(player('a'), 1000, 0); t.sit(player('b'), 1000, 2); t.sit(player('c'), 1000, 4);
  t.startHand();
  assert.equal(t.button, 0);
  assert.deepEqual([t.seats[2].bet, t.seats[4].bet], [5, 10], 'small blind left of the button, then the big blind');
  assert.equal(t.toAct, 0, 'first to act preflop is left of the big blind');
  t.act(0, 'call'); t.act(2, 'call');
  assert.equal(t.toAct, 4, 'the big blind gets the option');
  assert.ok(t.legal(4).some((l) => l.action === 'check'));
  t.act(4, 'check');
  assert.equal(t.phase, 'flop');
  assert.equal(t.board.length, 3);
  assert.equal(t.toAct, 2, 'postflop, first seat left of the button');
  // Heads-up: the button posts the small blind and acts first preflop.
  const h = new P.PokerTable({ seed: 'hu' });
  h.sit(player('x'), 500, 1); h.sit(player('y'), 500, 3);
  h.startHand();
  assert.equal(h.seats[h.button].bet, 5);
  assert.equal(h.toAct, h.button);
});

test('poker: minimum raises, and a short all-in does not reopen the betting', () => {
  const t = new P.PokerTable({ seed: 'raise' });
  t.sit(player('a'), 1000, 0); t.sit(player('b'), 1000, 1); t.sit(player('c'), 45, 2);
  t.startHand(); // button 0, sb 1, bb 2 (c, 45 chips), a to act
  assert.deepEqual(t.legal(0).find((l) => l.action === 'raise'), { action: 'raise', min: 20, max: 1000 });
  t.act(0, 'raise', 30); // raise of 20
  assert.deepEqual(t.legal(1).find((l) => l.action === 'raise').min, 50, 'next raise is at least another 20');
  assert.throws(() => t.act(1, 'raise', 40), /between 50/);
  t.act(1, 'call');
  t.act(2, 'allin'); // c to 45: a raise of 15, short of 20
  assert.equal(t.currentBet, 45);
  assert.deepEqual(t.legal(0).map((l) => l.action), ['fold', 'call'], 'a already acted: call or fold only');
  t.act(0, 'call');
  assert.deepEqual(t.legal(1).map((l) => l.action), ['fold', 'call']);
  t.act(1, 'call');
  assert.equal(t.phase, 'flop');
  assert.throws(() => t.act(2, 'check'), /turn/);
});

test('poker: side pots go to the best hand among the players who reached them', () => {
  const t = new P.PokerTable({ seed: 'side', smallBlind: 5, bigBlind: 10 });
  t.sit(player('short'), 100, 0); t.sit(player('mid'), 300, 1); t.sit(player('big'), 1000, 2);
  // Dealt from the end: one card each to seats 1, 2, 0, then again; burn, flop, burn, turn, burn, river.
  // short: As Ah (best), mid: Ks Kh (second), big: Qs Qh (worst); board 2c 7d 9s 3h 4c.
  const order = ['Ks', 'Qs', 'As', 'Kh', 'Qh', 'Ah', 'Xx', '2c', '7d', '9s', 'Xx', '3h', 'Xx', '4c'];
  t.nextDeck = ['8c', '8d', ...order.slice().reverse()].map((c) => (c === 'Xx' ? '5d' : c));
  t.startHand(); // button 0 (short), sb 1 (mid), bb 2 (big)
  t.act(0, 'allin'); // to 100
  t.act(1, 'allin'); // to 300
  t.act(2, 'call'); // big calls 300
  assert.equal(t.phase, 'done');
  const net = t.lastHand.net.slice(0, 3);
  assert.deepEqual(t.lastHand.pots.map((p) => p.amount), [300, 400], 'main pot 3 x 100, side pot 2 x 200');
  assert.deepEqual(net, [200, 100, -300], 'short wins the main pot, mid the side pot');
  assert.equal(t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0), 1400, 'no chip created or lost');
  assert.equal(t.lastHand.shown.length, 3);
});

test('poker: a fold to one player ends the hand; others see only their own cards', () => {
  const t = new P.PokerTable({ seed: 'fold' });
  t.sit(player('a'), 500, 0); t.sit(player('b'), 500, 1); t.sit(player('c'), 500, 2);
  t.startHand();
  const v = t.view(0);
  assert.equal(v.you.cards.length, 2);
  assert.deepEqual(v.seats[1].cards, ['??', '??']);
  t.act(0, 'raise', 40);
  t.act(1, 'fold');
  t.act(2, 'fold');
  assert.equal(t.phase, 'done');
  assert.equal(t.lastHand.showdown, false);
  assert.deepEqual(t.lastHand.net.slice(0, 3), [15, -5, -10], 'the raiser wins the blinds; the unmatched raise comes back');
  assert.deepEqual(t.view(1).seats[0].cards, ['??', '??'], 'no showdown: cards stay hidden');
});

test('poker: random play over thousands of hands never creates or loses a chip', () => {
  const rand = lcg(42);
  for (const n of [2, 3, 6]) {
    const t = new P.PokerTable({ seed: `fuzz-${n}`, smallBlind: 1, bigBlind: 2 });
    for (let i = 0; i < n; i++) t.sit(player(`p${i}`), 50 + Math.floor(rand() * 400), i);
    let total = t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0);
    for (let hand = 0; hand < 1500; hand++) {
      for (const s of t.seats) if (s && s.stack === 0) { s.stack = 100; total += 100; } // rebuy
      t.startHand();
      for (let steps = 0; t.inPlay; steps++) {
        assert.ok(steps < 200, 'the hand ends');
        const legal = t.legal(t.toAct);
        const l = legal[Math.floor(rand() * legal.length)];
        const amount = l.min !== undefined ? l.min + Math.floor(rand() * (l.max - l.min + 1)) : undefined;
        t.act(t.toAct, l.action, amount);
        const inPot = t.seats.reduce((a, s) => a + (s ? s.committed : 0), 0);
        if (t.inPlay) assert.equal(t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0) + inPot, total);
      }
      assert.equal(t.seats.reduce((a, s) => a + (s ? s.stack : 0), 0), total, `hand ${hand}`);
      assert.equal(t.lastHand.net.reduce((a, x) => a + (x || 0), 0), 0, 'what the winners win, the losers lose');
      assert.ok(t.lastHand.board.length === 5 || !t.lastHand.showdown);
    }
  }
});

test('poker: blinds must be positive whole numbers, small at most big', () => {
  // AC1: throw for non-positive-integer values and when small > big
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: 2.5, bigBlind: 5 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: 5, bigBlind: 7.5 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: '5', bigBlind: 10 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: 5, bigBlind: '10' }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: null, bigBlind: 10 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: 0, bigBlind: 10 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: -5, bigBlind: 10 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: NaN, bigBlind: 10 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: 5, bigBlind: Infinity }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: 1e-9, bigBlind: 10 }), P.PokerError);
  assert.throws(() => new P.PokerTable({ seed: 'b', smallBlind: 10, bigBlind: 5 }), P.PokerError, 'small > big');

  // AC1: builds without throwing for valid cases (defaults 5/10)
  const t = new P.PokerTable({ seed: 'valid' });
  assert.equal(t.sb, 5);
  assert.equal(t.bb, 10);
  const t2 = new P.PokerTable({ seed: 'valid', smallBlind: 1, bigBlind: 2 });
  assert.equal(t2.sb, 1);
  assert.equal(t2.bb, 2);
  const t3 = new P.PokerTable({ seed: 'valid', smallBlind: 10, bigBlind: 10 });
  assert.equal(t3.sb, 10);
  assert.equal(t3.bb, 10);
});
