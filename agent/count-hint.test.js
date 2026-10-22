const test = require('node:test');
const assert = require('node:assert/strict');
const { BlackjackEnv } = require('./env.js');
const { countHint, seenEV, unseenDeck } = require('./count-hint.js');
const Counting = require('../engine/counting.js');
const Solver = require('../engine/tools/solver.js');
const { handle } = require('./cli.js');
const { handleMessage } = require('./mcp.js');

/** Play `rounds` rounds following the counter's own advice; call `see` on every hint. */
function playCounting(env, rounds, see) {
  for (let r = 0; r < rounds; r++) {
    const between = countHint(env);
    see(between, env.observe());
    let res = env.step({ action: 'deal', bet: between.bet });
    while (!res.done) {
      const h = countHint(env);
      see(h, env.observe());
      res = env.step(h.count.play.action);
    }
  }
}

test('count hint: the unseen deck is the shoe minus the seen cards', () => {
  const seen = { A: 2, 2: 1, 3: 0, 4: 3, 5: 0, 6: 1, 7: 0, 8: 0, 9: 1, T: 2, J: 1, Q: 0, K: 4 };
  const d = unseenDeck(6, seen);
  const full = Solver.fullDeck(6);
  assert.equal(d[1], full[1] - 2);
  assert.equal(d[10], full[10] - 7);
  assert.equal(d.reduce((a, b) => a + b, 0), 312 - 15);
});

test('count hint: the count matches the engine, and every play is legal and priced', () => {
  const env = new BlackjackEnv({ seed: 'count-hint', bankroll: 1e6 });
  let decisions = 0;
  let indexPlays = 0;
  playCounting(env, 150, (h, obs) => {
    assert.equal(h.count.running, Counting.countState(env.game).running);
    if (obs.phase === 'player') {
      decisions++;
      assert.deepEqual(Object.keys(h.evSeen).sort(), [...obs.legal].sort());
      assert.deepEqual(h.evSeen, seenEV(obs, obs.rules)); // from the observation alone
      assert.equal(h.evSeen[h.bestSeen], Math.max(...Object.values(h.evSeen)));
      assert.ok(obs.legal.includes(h.count.play.action));
      if (h.count.play.index !== null) indexPlays++;
    } else if (obs.phase === 'insurance') {
      assert.equal(h.count.play.action, Math.floor(h.count.trueCount) >= 3 && obs.legal.includes('insurance') ? 'insurance' : 'decline_insurance');
    } else {
      const tc = obs.shoe.cutCardReached ? 0 : h.count.trueCount;
      assert.equal(h.action, 'deal');
      assert.equal(h.bet, Counting.suggestedBet(tc, { min: 1, max: 500, bankroll: obs.bankroll }));
    }
  });
  assert.ok(decisions > 150);
  assert.ok(indexPlays > 0);
});

test('count hint: off the top of the shoe, seen-card EVs agree with the full-shoe table', () => {
  for (let i = 0; i < 40; i++) {
    const env = new BlackjackEnv({ seed: `top-${i}` });
    let res = env.step({ action: 'deal', bet: 10 });
    if (res.done || res.obs.phase !== 'player') continue;
    const h = countHint(env);
    for (const a of ['stand', 'hit']) {
      if (h.ev && h.ev[a] !== undefined) assert.ok(Math.abs(h.evSeen[a] - h.ev[a]) < 0.06, `${a}: ${h.evSeen[a]} vs ${h.ev[a]}`);
    }
  }
});

test('count hint: the CLI and MCP hint take count, and plain hints are unchanged', () => {
  const env = new BlackjackEnv({ seed: 'count-cli' });
  assert.equal(handle(env, { cmd: 'hint' }).hint, null);
  const between = handle(env, { cmd: 'hint', count: true }).hint;
  assert.equal(between.action, 'deal');
  assert.equal(between.count.system, 'hilo');
  env.step({ action: 'deal', bet: 10 });
  const plain = handle(env, { cmd: 'hint' }).hint;
  assert.equal(plain.count, undefined);
  assert.equal(plain.evSeen, undefined);
  const res = handleMessage(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hint', arguments: { count: true } } }).result;
  const { hint } = JSON.parse(res.content[0].text);
  assert.equal(hint.count.system, 'hilo');
  if (env.observe().phase === 'player') assert.ok(hint.evSeen && hint.bestSeen);
});
