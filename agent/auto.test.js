const test = require('node:test');
const assert = require('node:assert/strict');
const { BlackjackEnv } = require('./env.js');
const { autoPlay, MAX_ROUNDS } = require('./auto.js');
const { handle } = require('./cli.js');
const { handleMessage } = require('./mcp.js');

test('auto: playing a batch is the same as playing each move by hand', () => {
  const a = new BlackjackEnv({ seed: 'auto-same' });
  const r = autoPlay(a, { rounds: 300, bet: 10 });
  const b = new BlackjackEnv({ seed: 'auto-same' });
  let net = 0;
  for (let i = 0; i < 300; i++) {
    let res = b.step({ action: 'deal', bet: 10 });
    while (!res.done) res = b.step(b.hint().action);
    net += res.reward;
  }
  assert.deepEqual(a.observe(), b.observe());
  assert.equal(r.played, 300);
  assert.equal(r.stopped, 'rounds');
  assert.equal(r.net, Math.round(net * 100) / 100);
  assert.deepEqual(r.obs, a.observe());
});

test('auto: tallies every hand and keeps going from where the table is', () => {
  const env = new BlackjackEnv({ seed: 'auto-tally', bankroll: 1e5 });
  const first = autoPlay(env, { rounds: 100, bet: [10, 10] });
  assert.equal(Object.values(first.hands).reduce((a, b) => a + b, 0) >= 200, true); // splits add hands
  assert.ok(first.wagered >= 2000);
  const second = autoPlay(env, { rounds: 50, policy: 'never-bust' });
  assert.equal(second.obs.round, 150);
  assert.equal(second.bankroll.start, first.bankroll.end);
});

test('auto: stops at the cut card or when the bankroll runs short', () => {
  const env = new BlackjackEnv({ seed: 'auto-shoe', bankroll: 1e5 });
  const r = autoPlay(env, { rounds: 5000, policy: 'hilo', untilShuffle: true });
  assert.equal(r.stopped, 'shuffle');
  assert.ok(r.played > 10 && r.played < 200);
  assert.equal(r.obs.shoe.cutCardReached, true);

  const poor = new BlackjackEnv({ seed: 'auto-poor', bankroll: 25 });
  const p = autoPlay(poor, { rounds: 1000, bet: 20, policy: 'random' });
  assert.equal(p.stopped, 'bankroll');
  assert.ok(p.bankroll.end < 20);
});

test('auto: a bad request is an error and changes nothing', () => {
  const env = new BlackjackEnv({ seed: 'auto-bad' });
  for (const [opts, re] of [
    [{ rounds: 0 }, /rounds must be/], [{ rounds: MAX_ROUNDS + 1 }, /rounds must be/], [{ rounds: 1.5 }, /rounds must be/],
    [{ rounds: 5, policy: 'martingale' }, /unknown policy/], [{ rounds: 5, bet: 0.5 }, /bet/i], [{ rounds: 5, bet: 501 }, /bet/i],
  ]) {
    const before = JSON.stringify(env.observe());
    assert.throws(() => autoPlay(env, opts), re);
    assert.equal(JSON.stringify(env.observe()), before);
  }
  env.step({ action: 'deal', bet: 10 });
  if (env.observe().phase !== 'done') assert.throws(() => autoPlay(env, { rounds: 1 }), /finish the round/);
});

test('auto: the CLI and the MCP server both offer it', () => {
  const cli = handle(new BlackjackEnv({ seed: 'auto-cli' }), { cmd: 'auto', rounds: 20, policy: 'basic', bet: 5 });
  assert.equal(cli.auto.played, 20);
  assert.equal(cli.obs.round, 20);
  assert.equal(cli.auto.obs, undefined);

  const env = new BlackjackEnv({ seed: 'auto-mcp' });
  const tools = handleMessage(env, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools;
  assert.ok(tools.some((t) => t.name === 'auto_play'));
  const res = handleMessage(env, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'auto_play', arguments: { rounds: 30 } } }).result;
  const [line, table, json] = res.content[0].text.split('\n');
  assert.match(line, /^Played 30 rounds by basic: net [+-]?\d/);
  assert.match(table, /^Round 30, done/);
  assert.equal(JSON.parse(json).auto.played, 30);
  const bad = handleMessage(env, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'auto_play', arguments: { rounds: 0 } } }).result;
  assert.equal(bad.isError, true);
});
