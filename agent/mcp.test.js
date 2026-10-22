const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { BlackjackEnv } = require('./env.js');
const { TOOLS, handleMessage } = require('./mcp.js');

let nextId = 1;
const call = (env, method, params) => handleMessage(env, { jsonrpc: '2.0', id: nextId++, method, params });
const tool = (env, name, args = {}) => call(env, 'tools/call', { name, arguments: args }).result;
/** The JSON line under a tool result's summary. */
const payload = (result) => JSON.parse(result.content[0].text.split('\n').pop());

test('MCP: initialize agrees a protocol version and offers tools', () => {
  const env = new BlackjackEnv({ seed: 'mcp' });
  const init = call(env, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'blackjack');
  assert.equal(call(env, 'initialize', { protocolVersion: '1999-01-01' }).result.protocolVersion, '2025-11-25');
  assert.equal(handleMessage(env, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(call(env, 'ping').result, {});
  const names = call(env, 'tools/list').result.tools.map((t) => t.name);
  assert.deepEqual(names, ['new_table', 'deal', 'act', 'auto_play', 'observe', 'hint']);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object', t.name);
});

test('MCP: a seeded session through the tools matches the environment step for step', () => {
  const env = new BlackjackEnv();
  const direct = new BlackjackEnv({ seed: 'mcp-replay' });
  payload(tool(env, 'new_table', { seed: 'mcp-replay' }));
  for (let r = 0; r < 50; r++) {
    let res = payload(tool(env, 'deal', { bet: 10 }));
    assert.deepEqual(res, direct.step({ action: 'deal', bet: 10 }));
    while (!res.done) {
      const { hint } = payload(tool(env, 'hint'));
      assert.deepEqual(hint, direct.hint());
      res = payload(tool(env, 'act', { action: hint.action }));
      assert.deepEqual(res, direct.step(hint.action));
    }
  }
  assert.deepEqual(payload(tool(env, 'observe')).obs, direct.observe());
});

test('MCP: the summary hides the hole card until the round ends', () => {
  const env = new BlackjackEnv();
  tool(env, 'new_table', { seed: 'mcp-hole' });
  for (let r = 0; r < 30; r++) {
    let result = tool(env, 'deal', { bet: 10 });
    while (!payload(result).done) {
      const [line] = result.content[0].text.split('\n');
      const obs = payload(result).obs;
      assert.equal(obs.dealer.cards.length, 1);
      assert.match(line, /\+ hole card \(showing \d+\)/);
      assert.match(line, /legal: /);
      result = tool(env, 'act', { action: env.hint().action });
    }
    assert.doesNotMatch(result.content[0].text.split('\n')[0], /hole card/);
    const end = payload(result).obs.hands[0].result;
    assert.match(result.content[0].text.split('\n')[0], new RegExp(`hand 1: .*, ${end.outcome} [+-]?\\d`));
    assert.doesNotMatch(result.content[0].text, /\[object Object\]/);
  }
});

test('MCP: bad requests are tool errors and leave the table unchanged', () => {
  const env = new BlackjackEnv({ seed: 'mcp-err' });
  const before = JSON.stringify(env.observe());
  const illegal = tool(env, 'act', { action: 'hit' });
  assert.equal(illegal.isError, true);
  assert.match(payload(illegal).error, /not legal now/);
  assert.deepEqual(payload(illegal).legal, ['deal']);
  assert.equal(tool(env, 'deal', { bet: 1e6 }).isError, true);
  assert.equal(tool(env, 'new_table', { rules: { decks: 3 } }).isError, true);
  assert.equal(JSON.stringify(env.observe()), before);
  assert.equal(call(env, 'tools/call', { name: 'cheat' }).error.code, -32602);
  assert.equal(call(env, 'resources/list').error.code, -32601);
  assert.equal(handleMessage(env, { id: 1, method: 'ping' }).error.code, -32600);
});

test('MCP: the server answers over stdio, one message per line', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp.js'), '--seed', 'mcp-stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  child.stdin.write('not json\n');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deal', arguments: { bet: 25 } } });
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  assert.deepEqual(lines.map((l) => l.id), [1, null, 2]);
  assert.equal(lines[1].error.code, -32700);
  const dealt = payload(lines[2].result);
  assert.equal(dealt.obs.shoe.seed, 'mcp-stdio-1'); // shoe 1 of that seed
  assert.equal(dealt.obs.round, 1);
});

test('MCP: the summary and obs settle side bets and name the insurance offer', () => {
  const env = new BlackjackEnv();
  tool(env, 'new_table', { seed: 'mcp-side', bankroll: 100000 });
  let won = 0;
  let offers = 0;
  for (let r = 0; r < 300; r++) {
    let result = tool(env, 'deal', { bet: 10, side: { pairs: 5, t213: 5 } });
    const sides = payload(result).obs.sideBets;
    assert.equal(sides.length, 2);
    for (const s of sides) {
      const name = s.bet === 'pairs' ? 'Perfect Pairs' : '21\\+3';
      if (s.outcome === 'win') {
        won++;
        assert.ok(s.win && s.odds > 0);
        assert.equal(s.net, s.stake * s.odds);
        assert.match(result.content[0].text, new RegExp(`${name} 5: ${s.win} ${s.odds}:1, \\+${s.net}`));
      } else {
        assert.deepEqual([s.outcome, s.win, s.odds, s.net], ['lose', null, 0, -5]);
        assert.match(result.content[0].text, new RegExp(`${name} 5: lose -5`));
      }
    }
    while (!payload(result).done) {
      const { insurance } = payload(result).obs;
      if (insurance.offered) {
        offers++;
        const label = insurance.evenMoney ? 'even money' : 'insurance';
        assert.match(result.content[0].text.split('\n')[0], new RegExp(`${label} offered \\(cost ${insurance.cost}\\)`));
      }
      result = tool(env, 'act', { action: env.hint().action });
    }
  }
  assert.ok(won > 0 && offers > 0);
});
