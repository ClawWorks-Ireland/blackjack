const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('./hub.js');
const { Leaderboard } = require('./leaderboard.js');
const { createServer, maxTablesFlag } = require('./server.js');
const { spawnSync } = require('child_process');

const FAST = { betSeconds: 0.3, turnSeconds: 0.3, botDelayMs: 5, nextRoundMs: 20, idleRounds: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a server on a free port; returns {url, hub, board, close}. */
async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tables-'));
  const board = new Leaderboard({ file: path.join(dir, 'players.json'), minRounds: 5 });
  const hub = new Hub({ leaderboard: board, timing: FAST, ...opts });
  const server = createServer({ hub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, hub, board, dir, close: () => { hub.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

async function api(url, method, p, body, token) {
  const res = await fetch(url + p, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** A basic agent over HTTP: bets 10 for `rounds` rounds, standing on 17+ and hitting below; returns once the last round is settled. */
async function agent(url, table, name, kind, rounds) {
  const { body: j } = await api(url, 'POST', `/api/tables/${table}/join`, { name, kind });
  let bets = 0;
  let since;
  for (let guard = 0; guard < 2000; guard++) {
    const { body: v } = await api(url, 'GET', `/api/tables/${table}/wait?timeout=5${since !== undefined ? `&since=${since}` : ''}`, null, j.token);
    since = v.version;
    if (!v.you) throw new Error(`${name} lost its seat`);
    const me = v.seats[v.you.seat];
    const betting = v.phase === 'betting' || v.phase === 'done';
    if (bets >= rounds && betting && (v.phase === 'betting' || me.net !== null)) return j; // the last round is settled
    if (v.you.legal.includes('bet') && v.phase === 'betting' && me.bet === 0 && !me.out && bets < rounds) {
      const r = await api(url, 'POST', `/api/tables/${table}/bet`, { amount: 10 }, j.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      bets++;
    } else if (v.you.yourTurn) {
      const a = v.phase === 'insurance' ? 'decline_insurance' : (me.hands[me.active].total < 17 ? 'hit' : 'stand');
      const r = await api(url, 'POST', `/api/tables/${table}/act`, { action: a }, j.token);
      assert.ok(r.status === 200 || r.status === 409, JSON.stringify(r.body)); // 409: the clock beat us
    }
  }
  throw new Error(`${name} did not finish`);
}

test('server: an AI and a human play the same table over HTTP, and both reach the leaderboard', async () => {
  const s = await start();
  try {
    const { body: t } = await api(s.url, 'POST', '/api/tables', { name: 'Test', minBet: 10, maxBet: 100 });
    const [a, h] = await Promise.all([agent(s.url, t.id, 'Robo', 'ai', 8), agent(s.url, t.id, 'Ada', 'human', 8)]);
    assert.notEqual(a.seat, h.seat);
    const { body: list } = await api(s.url, 'GET', '/api/tables');
    const seats = list.tables.find((x) => x.id === t.id).seats.filter(Boolean);
    assert.deepEqual(seats.map((x) => x.kind).sort(), ['ai', 'human']);
    const { body: lb } = await api(s.url, 'GET', '/api/leaderboard');
    const kinds = Object.fromEntries(lb.players.map((p) => [p.name, p.kind]));
    assert.deepEqual(kinds, { Robo: 'ai', Ada: 'human' });
    assert.ok(lb.players.every((p) => p.rounds >= 7));
    assert.equal((await api(s.url, 'GET', '/api/leaderboard?kind=human')).body.players.length, 1);
    assert.ok(fs.existsSync(path.join(s.dir, 'players.json')), 'saved to disk');
  } finally { await s.close(); }
});

test('server: each viewer gets its own view, and the hole card and seed stay hidden', async () => {
  const s = await start();
  try {
    const { body: t } = await api(s.url, 'POST', '/api/tables', { name: 'Views', bots: 2 });
    const { body: j } = await api(s.url, 'POST', `/api/tables/${t.id}/join`, { name: 'Viewer', kind: 'human' });
    assert.equal(j.view.you.seat, j.seat);
    await api(s.url, 'POST', `/api/tables/${t.id}/bet`, { amount: 10 }, j.token);
    // Events: subscribe and collect a few states.
    const res = await fetch(`${s.url}/api/tables/${t.id}/events?token=${j.token}`);
    const reader = res.body.getReader();
    let buf = '';
    const states = [];
    while (states.length < 2) {
      const { value } = await reader.read();
      buf += Buffer.from(value).toString('utf8');
      for (const m of buf.split('\n\n').slice(0, -1)) if (m.includes('event: state')) states.push(JSON.parse(m.split('data: ')[1]));
      buf = buf.split('\n\n').pop();
    }
    reader.cancel();
    const live = states.find((v) => v.phase === 'player' || v.phase === 'insurance') || states[0];
    if (live.phase === 'player' || live.phase === 'insurance') assert.equal(live.dealer.cards.length, 1);
    assert.equal(JSON.stringify(states).includes(s.hub.get(t.id).table.seed), false, 'the seed never leaves the server');
    const spectator = (await api(s.url, 'GET', `/api/tables/${t.id}`)).body;
    assert.equal(spectator.you, undefined);
    assert.equal(spectator.seats.filter(Boolean).filter((x) => x.player.kind === 'bot').length, 2);
  } finally { await s.close(); }
});

test('server: the clock stands for a slow player, sits out a non-bettor, and frees idle seats', async () => {
  const s = await start();
  try {
    const { body: t } = await api(s.url, 'POST', '/api/tables', { name: 'Clock' });
    const { body: fast } = await api(s.url, 'POST', `/api/tables/${t.id}/join`, { name: 'Fast', kind: 'ai' });
    const { body: slow } = await api(s.url, 'POST', `/api/tables/${t.id}/join`, { name: 'Slow', kind: 'human' });
    const lt = s.hub.get(t.id);
    // Fast bets every round and lets the clock play its hand; Slow never does anything.
    for (let i = 0; i < 40 && lt.players.has(slow.token); i++) {
      if (lt.table.phase === 'betting' || lt.table.phase === 'done') {
        const me = lt.table.seats[fast.seat];
        if (me && me.bet === 0) await api(s.url, 'POST', `/api/tables/${t.id}/bet`, { amount: 10 }, fast.token);
      }
      await sleep(150);
    }
    assert.equal(lt.players.has(slow.token), false, 'Slow lost the seat after missing rounds');
    assert.ok(lt.table.round >= 3, `rounds played: ${lt.table.round}`);
    assert.equal(s.board.rows().find((p) => p.name === 'Slow'), undefined, 'sitting out is not playing');
  } finally { await s.close(); }
});

test('server: bad requests are refused with a reason', async () => {
  const s = await start();
  try {
    const { body: t } = await api(s.url, 'POST', '/api/tables', { name: 'Bad' });
    assert.equal((await api(s.url, 'POST', '/api/tables', { rules: { decks: 3 } })).status, 400);
    assert.equal((await api(s.url, 'POST', `/api/tables/${t.id}/join`, { name: '', kind: 'ai' })).status, 400);
    assert.equal((await api(s.url, 'POST', `/api/tables/${t.id}/join`, { name: 'X', kind: 'robot' })).status, 400);
    assert.equal((await api(s.url, 'POST', `/api/tables/${t.id}/bet`, { amount: 10 }, 'nope')).status, 403);
    const { body: j } = await api(s.url, 'POST', `/api/tables/${t.id}/join`, { name: 'Y', kind: 'ai' });
    assert.equal((await api(s.url, 'POST', `/api/tables/${t.id}/act`, { action: 'hit' }, j.token)).status, 409);
    assert.equal((await api(s.url, 'POST', `/api/tables/${t.id}/bet`, { amount: 5 }, j.token)).status, 409);
    assert.equal((await api(s.url, 'GET', '/api/tables/99')).status, 404);
    assert.equal((await fetch(`${s.url}/server/data/players.json`)).status, 404, 'data is never served');
    assert.equal((await fetch(`${s.url}/web/../server/hub.js`)).status, 404);
  } finally { await s.close(); }
});

test('table cap: the third POST /api/tables gets 409 naming the limit (AC1)', async () => {
  const s = await start({ maxTables: 2 });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await api(s.url, 'POST', '/api/tables', { name: `T${i}` })).status, 201);
    const r = await api(s.url, 'POST', '/api/tables', { name: 'Third' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /2/);
    assert.equal((await api(s.url, 'GET', '/api/tables')).body.tables.length, 2);
  } finally { await s.close(); }
});

test('table cap: seeded tables do not count (AC3, blackjack)', async () => {
  const s = await start({ maxTables: 2 });
  try {
    s.hub.create({ name: 'Seed' }, { seeded: true });
    s.hub.create({ name: 'Seed2' }, { seeded: true });
    for (let i = 0; i < 2; i++) assert.equal((await api(s.url, 'POST', '/api/tables', { name: `T${i}` })).status, 201);
    assert.equal((await api(s.url, 'POST', '/api/tables', { name: 'Third' })).status, 409);
  } finally { await s.close(); }
});

test('table cap: a refused create changes nothing and ids stay in order (AC5, blackjack)', async () => {
  const s = await start({ maxTables: 2 });
  try {
    for (let i = 0; i < 2; i++) await api(s.url, 'POST', '/api/tables', { name: `T${i}` });
    const size = s.hub.tables.size;
    const next = s.hub.next;
    assert.equal((await api(s.url, 'POST', '/api/tables', { name: 'No' })).status, 409);
    assert.equal(s.hub.tables.size, size);
    assert.equal(s.hub.next, next);
    s.hub.maxTables = 3;
    const r = await api(s.url, 'POST', '/api/tables', { name: 'Yes' });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, '3');
  } finally { await s.close(); }
});

test('table cap: default is 20 (Behaviour 1)', () => {
  assert.equal(new Hub().maxTables, 20);
});

test('hub: a join or leave between rounds does not freeze the table (CLA-117)', async () => {
  const hub = new Hub({ timing: { ...FAST, nextRoundMs: 100, botDelayMs: 1 } });
  try {
    const lt = hub.create({ name: 'Freeze', bots: 1 });
    const a = lt.join({ name: 'A', kind: 'ai' });
    lt.bet(a.token, 10);
    for (let i = 0; i < 400 && lt.table.phase !== 'done'; i++) {
      if (lt.table.turn === a.seat) lt.act(a.token, lt.table.phase === 'insurance' ? 'decline_insurance' : 'stand'); // an ace up asks about insurance first
      await sleep(10);
    }
    assert.equal(lt.table.phase, 'done');
    // Between rounds: A leaves and B sits down, as a restarted agent does.
    lt.leave(a.token);
    const b = lt.join({ name: 'B', kind: 'ai' });
    // Poll rather than sleep a fixed time: the full suite runs many files at once.
    const until = async (cond, ms = 4000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(20); return cond(); };
    assert.ok(await until(() => lt.table.phase === 'betting'), 'betting reopened after the round');
    lt.bet(b.token, 10);
    assert.ok(await until(() => lt.table.round >= 2), `round ${lt.table.round}: the next round was dealt`);
  } finally { hub.close(); }
});

test('max-tables flag: default 20, --max-tables 5 gives 5 (AC6)', () => {
  assert.equal(maxTablesFlag([]), 20);
  assert.equal(maxTablesFlag(['--max-tables', '5']), 5);
});

test('max-tables flag: 0, -1, abc and a missing value are refused (AC6)', () => {
  for (const v of ['0', '-1', 'abc', '1.5']) assert.throws(() => maxTablesFlag(['--max-tables', v]), /--max-tables/);
  assert.throws(() => maxTablesFlag(['--max-tables']), /--max-tables/);
});

test('max-tables flag: a bad value stops the server at startup (AC6)', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'server.js'), '--max-tables', 'abc', '--port', '0'], { timeout: 5000 });
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr), /--max-tables/);
});
