const test = require('node:test');
const assert = require('node:assert/strict');
const { Hub } = require('./hub.js');
const { PokerHub } = require('./poker-hub.js');
const { Leaderboard } = require('./leaderboard.js');
const { createServer } = require('./server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(timing = { turnSeconds: 0.4, botDelayMs: 5, nextHandMs: 30, idleHands: 2 }) {
  const board = new Leaderboard({ minRounds: 5 });
  const pokerHub = new PokerHub({ leaderboard: board, timing });
  const server = createServer({ hub: new Hub(), pokerHub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, pokerHub, board, close: () => { pokerHub.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

async function api(url, method, p, body, token) {
  const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

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
