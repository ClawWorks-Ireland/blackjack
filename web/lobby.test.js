const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { createServer } = require('../server/server.js');
const { PokerHub } = require('../server/poker-hub.js');
const { Leaderboard } = require('../server/leaderboard.js');
const { Hub } = require('../server/hub.js');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const html = read('lobby.html');
const formOf = (id) => html.match(new RegExp(`<form id="${id}"[\\s\\S]*?</form>`))[0];

function loadLive() {
  const win = {};
  vm.runInNewContext(read('live.js'), { window: win });
  return win.Live;
}

test('AC1: lobby has a New poker table form with the right fields', () => {
  const f = formOf('new-poker');
  for (const n of ['name', 'bigBlind', 'bots', 'turnSeconds']) assert.match(f, new RegExp(`name="${n}"`));
  const sel = f.match(/<select name="bots">([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...sel.matchAll(/<option>(\d+)<\/option>/g)].map((m) => m[1]), ['0', '1', '2', '3', '4', '5']);
  assert.match(f, /name="bigBlind"[^>]*min="2"/);
  assert.match(f, /name="turnSeconds"[^>]*min="5" max="120"/);
  assert.match(html, /<p id="poker-msg" class="status" role="status">/);
});

test('AC1: blackjack #new form is unchanged', () => {
  const expected = `<form id="new" class="row">
      <label>Name <input name="name" type="text" maxlength="24" placeholder="Friday night"></label>
      <label>Minimum bet <input name="minBet" type="number" min="1" value="10" style="width:6em"></label>
      <label>Bots <select name="bots"><option>0</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select></label>
      <label>Seconds per move <input name="turnSeconds" type="number" min="5" max="120" value="30" style="width:5em"></label>
      <button type="submit">Create</button>
    </form>`;
  assert.equal(formOf('new'), expected);
  assert.match(html, /<p id="lobby-msg" class="status" role="status"><\/p>/);
});

test('AC2: pokerTableBody builds the POST body', () => {
  const raw = loadLive().util.pokerTableBody;
  const body = (x) => JSON.parse(JSON.stringify(raw(x))); // plain objects from this realm
  assert.deepEqual(body({ name: 'Friday heads-up', bigBlind: 10, bots: 1, turnSeconds: 30 }), { name: 'Friday heads-up', smallBlind: 5, bigBlind: 10, bots: 1, turnSeconds: 30 });
  assert.equal(body({ name: 'High stakes', bigBlind: 100, bots: 5, turnSeconds: 20 }).smallBlind, 50);
  assert.equal(body({ name: 'x', bigBlind: 15, bots: 0, turnSeconds: 30 }).smallBlind, 7);
  assert.deepEqual(body({ name: 'x', bigBlind: '10', bots: '2', turnSeconds: '30' }), { name: 'x', smallBlind: 5, bigBlind: 10, bots: 2, turnSeconds: 30 });
});

async function start() {
  const pokerHub = new PokerHub({ leaderboard: new Leaderboard({ minRounds: 5 }), timing: { botDelayMs: 5, nextHandMs: 30, idleHands: 2 } });
  const server = createServer({ hub: new Hub(), pokerHub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, pokerHub, server };
}

async function api(url, method, p, body, token) {
  const res = await fetch(url + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('AC3 and AC4: POST /api/poker/tables with the form bodies; a bots:1 table deals', async (t) => {
  const s = await start();
  t.after(() => { s.pokerHub.close(); s.server.closeAllConnections(); return new Promise((r) => s.server.close(r)); });
  const body = loadLive().util.pokerTableBody;
  const mk = (name, bots) => api(s.url, 'POST', '/api/poker/tables', body({ name, bigBlind: '10', bots, turnSeconds: '30' }));

  const one = await mk('Friday heads-up', '1');
  assert.equal(one.status, 201);
  assert.equal(one.body.seats.filter((x) => x && x.kind === 'bot').length, 1);
  assert.equal(one.body.free, 5);
  const five = await mk('Full', '5');
  assert.equal(five.status, 201);
  assert.equal(five.body.seats.filter((x) => x && x.kind === 'bot').length, 5);
  assert.equal(five.body.free, 1);
  const six = await mk('Too many', '6');
  assert.equal(six.status, 400);
  assert.match(six.body.error, /At most 5 bots/);
  const anon = await mk('', '0');
  assert.match(anon.body.name, /^Poker p\d+$/);

  const j = await api(s.url, 'POST', `/api/poker/tables/${one.body.id}/join`, { name: 'Solo', kind: 'human' });
  assert.ok(j.body.token, JSON.stringify(j.body));
  const deadline = Date.now() + 3000;
  let handNo = 0;
  while (Date.now() < deadline && handNo < 1) {
    const { body: v } = await api(s.url, 'GET', `/api/poker/tables/${one.body.id}/wait?timeout=1`, null, j.body.token);
    handNo = v.handNo || 0;
  }
  assert.ok(handNo >= 1, 'a hand was dealt');
});
