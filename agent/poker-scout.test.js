'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PokerTable } = require('../engine/poker.js');
const { POLICIES, rngFor } = require('../engine/poker-bots.js');
const { Profiles, classify } = require('./poker-profile.js');
const { fromTable } = require('./poker-history.js');
const { Store, watch } = require('./poker-scout.js');
const { playLive } = require('./poker-player.js');
const { TableClient } = require('./table-client.js');
const { Hub } = require('../server/hub.js');
const { PokerHub } = require('../server/poker-hub.js');
const { createServer } = require('../server/server.js');

const tmpStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-')), 'scouting.json');

/** Bots at one table, hands played offline; every hand as the rail sees it. */
function playOffline(styles, names, hands, tag, onRecord) {
  for (let h = 0; h < hands; h++) {
    const t = new PokerTable({ seed: `${tag}-${h}`, smallBlind: 5, bigBlind: 10, seats: styles.length });
    styles.forEach((s, i) => t.sit({ id: names[i], name: names[i], kind: 'bot' }, 1000, i));
    t.startHand();
    const rng = rngFor(`${tag}-${h}`);
    while (t.inPlay) {
      const s = t.toAct;
      let d = POLICIES[styles[s]].decide(t.view(s), rng);
      if (!t.legal(s).some((l) => l.action === d.action) && d.action !== 'allin') d = { action: t.legal(s).some((l) => l.action === 'check') ? 'check' : 'fold' };
      t.act(s, d.action, d.amount);
    }
    onRecord(fromTable({ ...t.view(null), id: tag }));
  }
}

async function start(timing = { turnSeconds: 0.5, botDelayMs: 2, nextHandMs: 20, idleHands: 50 }) {
  const pokerHub = new PokerHub({ timing });
  const server = createServer({ hub: new Hub(), pokerHub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, pokerHub, close: () => { pokerHub.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test('scouting: the style read from the numbers names every bot style, heads-up and five-handed', () => {
  const want = { 'tight-passive': 'tight-passive', 'loose-aggressive': 'loose-aggressive', 'calling-station': 'calling station', maniac: 'maniac' };
  for (const [style, read] of Object.entries(want)) {
    const p = new Profiles();
    playOffline([style, 'default'], ['X', 'Regular'], 300, `hu-${style}`, (r) => p.addRecord(r));
    const c = p.style('X');
    assert.equal(c.style, read, `${style} heads-up: ${p.line('X')}`);
    assert.equal(c.confidence, 'high');
  }
  const styles = ['tight-passive', 'loose-aggressive', 'calling-station', 'maniac', 'default'];
  const p = new Profiles();
  playOffline(styles, styles.map((s) => `P-${s}`), 400, 'five', (r) => p.addRecord(r));
  for (const [style, read] of Object.entries({ ...want, default: 'regular' })) assert.equal(p.style(`P-${style}`).style, read, `${style} five-handed: ${p.line(`P-${style}`)}`);
  assert.equal(classify({ hands: 5, vpip: 50 }).style, 'unknown');
});

test('scouting: watching a live table from the rail sees no hole cards until a showdown, and learns every player', async () => {
  const s = await start();
  const file = tmpStore();
  try {
    const lt = s.pokerHub.create({ name: 'Watched', bots: ['calling-station', 'maniac'] });
    // Someone real has to sit for hands to run: a default-bot agent.
    const robo = new TableClient(s.url, { game: 'poker' });
    await robo.join(lt.id, 'Robo');
    let playing = true;
    const play = (async () => {
      const rng = rngFor('robo');
      while (playing) {
        const v = await robo.wait(1, { anyChange: true });
        if (v.you && v.you.yourTurn) { const d = POLICIES.default.decide(v, rng); await robo.act(d.action, d.amount).catch(() => {}); }
      }
    })();
    const rail = new TableClient(s.url, { game: 'poker' });
    const seen = [];
    const spy = { watch: async (...a) => { const v = await rail.watch(...a); seen.push(v); return v; } };
    const store = new Store(file);
    const n = await watch({ client: spy, table: lt.id, store, hands: 8 });
    playing = false;
    await play;
    assert.equal(n, 8);
    for (const v of seen) {
      assert.equal(v.you, undefined, 'a spectator has no seat');
      for (const seat of v.seats) {
        if (!seat || !seat.cards.length) continue;
        const shown = v.phase === 'done' && v.lastHand && v.lastHand.showdown && v.lastHand.shown.some((x) => x.seat === seat.seat);
        if (!shown) assert.deepEqual(seat.cards, ['??', '??']);
      }
    }
    const saved = new Store(file);
    for (const name of ['Bot 1', 'Bot 2', 'Robo']) assert.equal(saved.profiles.stats(name).hands, 8, name);
    assert.equal(fs.readFileSync(file.replace(/\.json$/, '.hands.jsonl'), 'utf8').trim().split('\n').length, 8);
    // Counted once: the same record again is ignored.
    const again = JSON.parse(fs.readFileSync(file.replace(/\.json$/, '.hands.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(saved.add(again), false);
    await robo.leave();
  } finally { await s.close(); }
});

test('scouting: joining with a report states each scouted player\'s style from the first hand', async () => {
  const file = tmpStore();
  const store = new Store(file);
  // Scouted elsewhere: 250 hands of "Bot 1", a calling station, against a regular.
  playOffline(['calling-station', 'default'], ['Bot 1', 'Regular'], 250, 'scouted', (r) => store.add(r));
  store.save();
  assert.equal(store.report('Bot 1').style, 'calling station');
  const s = await start();
  try {
    const lt = s.pokerHub.create({ name: 'Join', bots: ['calling-station'] });
    const prompts = [];
    const logs = [];
    const ask = async (llm, sys, instr, prompt) => { prompts.push(prompt); return { ok: true, text: 'A' }; };
    const stats = await playLive({ url: s.url, table: lt.id, name: 'Scout', hands: 3, scouting: new Store(file), ask, log: (m) => logs.push(m) });
    assert.equal(stats.hands, 3);
    assert.ok(logs.some((m) => /scouted Bot 1: calling station \(high confidence, 250 hands\)/.test(m)), logs.join('\n'));
    assert.ok(prompts.length > 0);
    assert.match(prompts[0], /Bot 1: .*Fact: plays like a calling station \(high confidence/);
    // It kept learning into the store from its seat.
    assert.ok(new Store(file).profiles.stats('Bot 1').hands >= 253);
  } finally { await s.close(); }
});
