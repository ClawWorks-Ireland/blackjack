const test = require('node:test');
const assert = require('node:assert/strict');
const { equity, POLICIES } = require('../engine/poker-bots.js');
const { match } = require('./poker-bench.js');
const { Profiles } = require('./poker-profile.js');

test('poker bots: equity matches known preflop numbers', () => {
  const near = (x, want, tol) => assert.ok(Math.abs(x - want) < tol, `${x} vs ${want}`);
  near(equity(['As', 'Ah'], [], 1, { iterations: 3000 }), 0.852, 0.03);
  near(equity(['7c', '2d'], [], 1, { iterations: 3000 }), 0.346, 0.03);
  near(equity(['As', 'Ks'], ['Qs', 'Js', 'Ts'], 1, { iterations: 200 }), 1, 1e-9); // a made royal flush
  near(equity(['2c', '7d'], ['As', 'Ad', 'Ac', 'Ah', 'Ks'], 1, { iterations: 500 }), 0.5, 1e-9); // four aces and a king on board: everyone plays the board, always a tie
});

test('poker bots: each style plays like its label, and the default beats them', async () => {
  const rows = {};
  for (const s of ['tight-passive', 'calling-station', 'maniac']) {
    rows[s] = await match(POLICIES.default, { ...POLICIES[s], name: s }, { hands: 200, seed: 't' });
  }
  const tp = rows['tight-passive'].villainStats;
  const st = rows['calling-station'].villainStats;
  const mn = rows.maniac.villainStats;
  assert.ok(tp.vpip < 25 && tp.pfr < 8, `tight-passive ${JSON.stringify(tp)}`);
  assert.ok(st.vpip > 40 && st.foldToBet < 15 && st.aggression < 0.5, `calling-station ${JSON.stringify(st)}`);
  assert.ok(mn.pfr > 50 && mn.aggression > 3, `maniac ${JSON.stringify(mn)}`);
  assert.ok(rows['calling-station'].bbPer100 > 0 && rows.maniac.bbPer100 > 0, JSON.stringify(rows, null, 1));
  // Same seed, same result: the benchmark replays.
  const again = await match(POLICIES.default, { ...POLICIES['tight-passive'], name: 'tight-passive' }, { hands: 200, seed: 't' });
  assert.equal(again.bbPer100, rows['tight-passive'].bbPer100);
});

test('poker profiles: stats from a hand log', () => {
  const p = new Profiles();
  const names = ['A', 'B'];
  const log = [
    { seat: 0, action: 'small blind', amount: 5, street: 'preflop' }, { seat: 1, action: 'big blind', amount: 10, street: 'preflop' },
    { seat: 0, action: 'raise', to: 30, street: 'preflop' }, { seat: 1, action: 'call', amount: 20, street: 'preflop' },
    { seat: 1, action: 'check', street: 'flop' }, { seat: 0, action: 'bet', to: 40, street: 'flop' }, { seat: 1, action: 'fold', street: 'flop' },
  ];
  p.addHand(names, log, { net: [30, -30], board: ['2c', '7d', '9s'], showdown: false, shown: [] });
  assert.deepEqual([p.stats('A').vpip, p.stats('A').pfr, p.stats('B').vpip, p.stats('B').pfr], [100, 100, 100, 0]);
  assert.equal(p.stats('B').foldToBet, 100);
  assert.equal(p.stats('A').aggression, 1);
  assert.match(p.line('B'), /plays 100% of hands .* folds to a bet 100%/);
});

test('match: onHand reports every hand for the hero', async () => {
  const run = async (hook) => {
    const pairs = [];
    const hands = [];
    const r = await match(POLICIES.default, { ...POLICIES.maniac, name: 'maniac' }, { hands: 10, seed: 'onhand', onPair: (i, bb) => pairs.push(bb), onHand: hook ? (h) => hands.push(h) : null });
    return { r, pairs, hands };
  };
  const withHook = await run(true);
  const without = await run(false);
  assert.equal(withHook.r.bbPer100, without.r.bbPer100);
  assert.deepEqual(withHook.pairs, without.pairs);
  const h = withHook.hands;
  assert.equal(h.length, 20);
  h.forEach((x, k) => {
    assert.equal(x.handIndex, k);
    assert.equal(x.pair, Math.floor(k / 2));
    assert.equal(x.seat, k % 2);
    assert.equal(x.deal, `onhand-${x.pair}`);
    assert.ok(['preflop', 'flop', 'turn', 'river'].includes(x.streetReached));
    assert.equal(typeof x.showdown, 'boolean');
    assert.equal(typeof x.facedRiverBet, 'boolean');
    assert.equal(typeof x.riverCall, 'boolean');
    if (x.riverCall) assert.ok(x.facedRiverBet);
    if (x.facedRiverBet) assert.equal(x.streetReached, 'river');
  });
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(h[2 * i].bb + h[2 * i + 1].bb - withHook.pairs[i]) < 1e-9);
});
