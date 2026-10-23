const test = require('node:test');
const assert = require('node:assert/strict');
const { Hub } = require('../server/hub.js');
const { Leaderboard } = require('../server/leaderboard.js');
const { createServer } = require('../server/server.js');
const { TableClient, toObs } = require('./table-client.js');
const { playLive } = require('./live.js');
const { BASELINES } = require('./policies.js');
const { BlackjackEnv } = require('./env.js');
const { handleMessage } = require('./mcp.js');

async function start() {
  const board = new Leaderboard({ minRounds: 5 });
  const hub = new Hub({ leaderboard: board, timing: { betSeconds: 2, turnSeconds: 2, botDelayMs: 1, nextRoundMs: 10 } });
  const server = createServer({ hub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hub, board, close: () => { hub.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test('live: baseline policies sit at a live table as AI players, beside bots', async () => {
  const s = await start();
  try {
    const t = await new TableClient(s.url).create({ name: 'Policies', bots: 2 });
    const [a, b] = await Promise.all([
      playLive({ url: s.url, table: t.id, name: 'Basic', policy: BASELINES.basic, rounds: 12 }),
      playLive({ url: s.url, table: t.id, name: 'Counter', policy: BASELINES.hilo, rounds: 12 }),
    ]);
    assert.equal(a.rounds, 12);
    assert.equal(b.rounds, 12);
    const rows = s.board.rows();
    assert.deepEqual(rows.map((r) => [r.name, r.kind, r.rounds]).sort(), [['Basic', 'ai', 12], ['Counter', 'ai', 12]]);
    assert.equal(rows.find((r) => r.name === 'Basic').net, a.net);
    assert.equal(s.hub.get(t.id).table.seats.filter(Boolean).length, 2, 'both left; the bots stay');
  } finally { await s.close(); }
});

test('live: a table view becomes an env-style observation with a basic-strategy hint', async () => {
  const s = await start();
  try {
    const c = new TableClient(s.url);
    const t = await c.create({ name: 'Obs' });
    await c.join(t.id, 'Shape');
    let v = await c.bet(10);
    for (let i = 0; i < 20 && !(v.you.yourTurn && v.phase === 'player'); i++) {
      if (v.phase === 'done') { await c.wait(2, { anyChange: true }); v = await c.bet(10); continue; }
      if (v.phase === 'insurance' && v.you.yourTurn) v = await c.act('decline_insurance');
      else v = await c.wait(2);
    }
    if (v.phase !== 'player') return; // a run of dealer blackjacks: nothing to check this time
    const { obs, hint, move } = toObs(v);
    assert.equal(move, 'play');
    assert.deepEqual(obs.legal, v.you.legal);
    assert.equal(obs.hands[obs.active].cards.length, 2);
    assert.ok(obs.legal.includes(hint.action));
    assert.equal(obs.table.minBet, 10);
  } finally { await s.close(); }
});

test('live: MCP tools join, wait, bet, act and read the leaderboard as AI', async () => {
  const s = await start();
  try {
    const env = new BlackjackEnv();
    let id = 1;
    const call = async (name, args = {}) => (await handleMessage(env, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })).result;
    assert.equal((await call('live_wait')).isError, true, 'not seated yet');
    const list = await call('live_tables', { url: s.url });
    assert.match(list.content[0].text, /table 1: Main|No tables/);
    const t = await new TableClient(s.url).create({ name: 'MCP' });
    const joined = await call('live_join', { table: t.id, name: 'Claude', url: s.url });
    assert.match(joined.content[0].text, /Claude \[ai\] \(you\)/);
    assert.match(joined.content[0].text, /seat 0 Claude \[ai\] \(you\)/, 'seats count from 0, as in the JSON');
    let rounds = 0;
    for (let i = 0; i < 80 && rounds < 3; i++) {
      const r = await call('live_wait', { timeout: 3 });
      const line = r.content[0].text.split('\n')[0];
      const v = JSON.parse(r.content[0].text.split('\n').pop()).view;
      if (/your move: bet/.test(line) && v.phase === 'betting') { await call('live_bet', { amount: 10 }); rounds++; }
      else if (/your move: (insurance|even money)/.test(line)) await call('live_act', { action: 'decline_insurance' });
      else if (/your move: /.test(line) && v.phase === 'player') await call('live_act', { action: 'stand' });
      else if (v.phase === 'done') await new Promise((ok) => setTimeout(ok, 30));
    }
    assert.equal(rounds, 3);
    // Wait for betting to reopen right after a round this player was dealt into (under load the bet
    // clock can sit it out of one, and then there is rightly no "your round" line).
    let after;
    for (let i = 0; i < 60; i++) {
      after = await call('live_wait', { timeout: 3 });
      const v = JSON.parse(after.content[0].text.split('\n').pop()).view;
      if (v.phase === 'betting' && v.you.lastRound && v.you.lastRound.round === v.round) break;
      if (v.phase === 'betting' && v.seats[v.you.seat].bet === 0) await call('live_bet', { amount: 10 });
      else if (v.you.yourTurn) await call('live_act', { action: v.phase === 'insurance' ? 'decline_insurance' : 'stand' });
    }
    assert.match(after.content[0].text, /your round \d+: .* vs dealer .*, net [+-]?\d/, 'the last round is reported when betting reopens');
    assert.equal((await call('live_act', { action: 'fly' })).isError, true);
    let left;
    for (let i = 0; i < 40; i++) { left = await call('live_leave'); if (!left.isError) break; await call('live_act', { action: 'stand' }); await new Promise((ok) => setTimeout(ok, 30)); }
    assert.equal(left.content[0].text, 'Left the table.');
    const lb = await call('live_leaderboard', { url: s.url });
    assert.match(lb.content[0].text, /Claude \[ai\]/);
  } finally { await s.close(); }
});

test('live: MCP poker tools sit down, play hands among the bots and read the poker leaderboard', async () => {
  const { PokerHub } = require('../server/poker-hub.js');
  const { Hub: BJHub } = require('../server/hub.js');
  const pokerHub = new PokerHub({ leaderboard: new Leaderboard({ minRounds: 5 }), timing: { turnSeconds: 3, botDelayMs: 1, nextHandMs: 20 } });
  const server = createServer({ hub: new BJHub(), pokerHub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = new BlackjackEnv();
    let id = 1;
    const call = async (name, args = {}) => (await handleMessage(env, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })).result;
    const t = pokerHub.create({ name: 'MCP poker', bots: ['calling-station', 'tight-passive'] });
    assert.match((await call('poker_tables', { url })).content[0].text, /MCP poker, blinds 5\/10/);
    const j = await call('poker_join', { table: t.id, name: 'Claude', url });
    assert.match(j.content[0].text, /Claude \[ai\] \(you\)/);
    let acted = 0;
    for (let i = 0; i < 300 && t.table.handNo < 4; i++) {
      const r = await call('poker_wait', { timeout: 2 });
      const v = JSON.parse(r.content[0].text.split('\n').pop()).view;
      if (v.you && v.you.yourTurn) {
        assert.match(r.content[0].text, /your move: fold/);
        const can = v.you.legal.map((l) => l.action);
        const res = await call('poker_act', { action: can.includes('check') ? 'check' : 'call' });
        assert.ok(!res.isError || /turn/.test(res.content[0].text), res.content[0].text);
        acted++;
      }
    }
    assert.ok(t.table.handNo >= 4 && acted > 0, `hands ${t.table.handNo}, moves ${acted}`);
    assert.equal((await call('poker_act', { action: 'raise', amount: 1 })).isError, true);
    const lb = await call('poker_leaderboard', { url });
    assert.match(lb.content[0].text, /Claude \[ai\] .* bb\/100/);
    for (let i = 0; i < 40; i++) { const r = await call('poker_leave'); if (!r.isError) break; await new Promise((ok) => setTimeout(ok, 50)); }
  } finally { pokerHub.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
