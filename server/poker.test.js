const test = require('node:test');
const assert = require('node:assert/strict');
const { Hub } = require('./hub.js');
const { PokerHub } = require('./poker-hub.js');
const { Leaderboard } = require('./leaderboard.js');
const { createServer } = require('./server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(timing = { turnSeconds: 0.4, botDelayMs: 5, nextHandMs: 30, idleHands: 2 }, hubOpts = {}) {
  const board = new Leaderboard({ minRounds: 5 });
  const pokerHub = new PokerHub({ leaderboard: board, timing, ...hubOpts });
  const hub = new Hub(hubOpts.blackjack || {});
  const server = createServer({ hub, pokerHub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, hub, pokerHub, board, close: () => { pokerHub.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

async function api(url, method, p, body, token) {
  const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('poker table cap: the third POST /api/poker/tables gets 409 and builds no bot table (AC2)', async () => {
  const s = await start(undefined, { maxTables: 2 });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await api(s.url, 'POST', '/api/poker/tables', { name: `T${i}` })).status, 201);
    const r = await api(s.url, 'POST', '/api/poker/tables', { name: 'Third', bots: ['maniac'] });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /2/);
    assert.equal(s.pokerHub.tables.size, 2);
  } finally { await s.close(); }
});

test('poker table cap: seeded tables do not count (AC3, poker)', async () => {
  const s = await start(undefined, { maxTables: 2 });
  try {
    s.pokerHub.create({ name: 'Seed' }, { seeded: true });
    s.pokerHub.create({ name: 'Seed2' }, { seeded: true });
    for (let i = 0; i < 2; i++) assert.equal((await api(s.url, 'POST', '/api/poker/tables', { name: `T${i}` })).status, 201);
    assert.equal((await api(s.url, 'POST', '/api/poker/tables', { name: 'Third' })).status, 409);
  } finally { await s.close(); }
});

test('poker table cap: a refused create changes nothing; next id is p3 (AC5, poker)', async () => {
  const s = await start(undefined, { maxTables: 2 });
  try {
    for (let i = 0; i < 2; i++) await api(s.url, 'POST', '/api/poker/tables', { name: `T${i}` });
    const size = s.pokerHub.tables.size;
    const next = s.pokerHub.next;
    assert.equal((await api(s.url, 'POST', '/api/poker/tables', { name: 'No' })).status, 409);
    assert.equal(s.pokerHub.tables.size, size);
    assert.equal(s.pokerHub.next, next);
    s.pokerHub.maxTables = 3;
    const r = await api(s.url, 'POST', '/api/poker/tables', { name: 'Yes' });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, 'p3');
  } finally { await s.close(); }
});

test('table caps are per hub (AC4)', async () => {
  const s = await start(undefined, { maxTables: 1, blackjack: { maxTables: 1 } });
  try {
    assert.equal((await api(s.url, 'POST', '/api/tables', { name: 'B' })).status, 201);
    assert.equal((await api(s.url, 'POST', '/api/poker/tables', { name: 'P' })).status, 201);
  } finally { await s.close(); }
});

test('poker server: an agent plays hands among the bots, sees only its own cards, and is recorded in big blinds', async () => {
  const s = await start();
  try {
    const { body: t } = await api(s.url, 'POST', '/api/poker/tables', { name: 'Test', bots: ['calling-station', 'maniac'] });
    assert.equal(t.game, 'poker');
    const { body: j } = await api(s.url, 'POST', `/api/poker/tables/${t.id}/join`, { name: 'Robo', kind: 'ai' });
    let since;
    let hands = new Set();
    for (let i = 0; i < 400 && hands.size < 6; i++) {
      const { body: v } = await api(s.url, 'GET', `/api/poker/tables/${t.id}/wait?timeout=2${since !== undefined ? `&since=${since}` : ''}`, null, j.token);
      since = v.version;
      if (v.handNo) hands.add(v.handNo);
      if (v.phase !== 'done' && v.phase !== 'waiting') {
        for (const seat of v.seats) {
          if (seat && seat.seat !== v.you.seat && seat.inHand && !seat.folded) assert.deepEqual(seat.cards, ['??', '??'], 'other hands hidden');
        }
        assert.equal(v.you.cards.length, 2);
      }
      if (v.you.yourTurn) {
        const can = v.you.legal.map((l) => l.action);
        const r = await api(s.url, 'POST', `/api/poker/tables/${t.id}/act`, { action: can.includes('check') ? 'check' : 'call' }, j.token);
        assert.ok(r.status === 200 || r.status === 409, JSON.stringify(r.body));
      }
    }
    assert.ok(hands.size >= 6, `hands dealt: ${hands.size}`);
    const { body: lb } = await api(s.url, 'GET', '/api/poker/leaderboard');
    assert.equal(lb.unit, 'big blinds per 100 hands');
    assert.deepEqual(lb.players.map((p) => [p.name, p.kind]), [['Robo', 'ai']], 'bots are not on the leaderboard');
    assert.ok(lb.players[0].rounds >= 4);
    const { body: list } = await api(s.url, 'GET', '/api/poker/tables');
    assert.equal(list.tables[0].seats.filter(Boolean).length, 3);
  } finally { await s.close(); }
});

test('poker server: the clock checks or folds for a slow player, bots never play alone, bad moves are refused', async () => {
  const s = await start();
  try {
    const lt = s.pokerHub.create({ name: 'Clock', bots: ['default'] });
    await sleep(100);
    assert.equal(lt.table.handNo, 0, 'bots alone do not play');
    const { body: j } = await api(s.url, 'POST', `/api/poker/tables/${lt.id}/join`, { name: 'Sleepy', kind: 'human' });
    for (let i = 0; i < 60 && lt.players.has(j.token); i++) await sleep(100);
    assert.equal(lt.players.has(j.token), false, 'a player who never moves loses the seat');
    assert.ok(lt.table.handNo >= 2);
    const { body: k } = await api(s.url, 'POST', `/api/poker/tables/${lt.id}/join`, { name: 'Bad', kind: 'ai' });
    assert.equal((await api(s.url, 'POST', `/api/poker/tables/${lt.id}/act`, { action: 'raise', amount: 3 }, k.token)).status, 409);
    assert.equal((await api(s.url, 'POST', `/api/poker/tables/${lt.id}/join`, { name: 'X', kind: 'bot' })).status, 400);
    assert.equal((await api(s.url, 'POST', '/api/poker/tables', { bots: ['shark'] })).status, 400);
    assert.equal((await api(s.url, 'GET', '/api/poker/tables/p99')).status, 404);
  } finally { await s.close(); }
});

test('poker server: a bad bots count is a 400, not a 500', async () => {
  const s = await start();
  try {
    const MSG = 'bots must be a whole number from 0 to 5, or a list of styles';
    const post = (b) => api(s.url, 'POST', '/api/poker/tables', b);
    const created = [];
    const ok = async (b) => { const r = await post(b); assert.equal(r.status, 201, JSON.stringify(b)); created.push(r.body.id); return r.body; };
    for (const b of [-1, 1.5, '2', true, {}]) {
      const r = await post({ bots: b });
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.deepEqual(r.body, { error: MSG });
    }
    for (const b of [6, 1e9, 1e10]) {
      const t0 = Date.now();
      const r = await post({ bots: b });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'At most 5 bots' });
      assert.ok(Date.now() - t0 < 1000, 'fast refusal');
    }
    const seated = (t) => t.seats.filter(Boolean);
    assert.equal(seated(await ok({ bots: 0 })).length, 0);
    const five = await ok({ bots: 5 });
    assert.deepEqual(seated(five).map((x) => x.name), ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4', 'Bot 5']);
    assert.equal(five.free, 1);
    assert.equal(seated(await ok({})).length, 0);
    assert.equal(seated(await ok({ bots: null })).length, 0);
    await ok({ bots: ['calling-station', 'maniac'] });
    assert.equal((await post({ bots: ['shark'] })).status, 400);
    const six = await post({ bots: Array(6).fill('default') });
    assert.equal(six.status, 400);
    assert.deepEqual(six.body, { error: 'At most 5 bots' });
    const list = await api(s.url, 'GET', '/api/poker/tables');
    assert.deepEqual(list.body.tables.map((t) => t.id).sort(), [...created].sort());
  } finally { await s.close(); }
});
