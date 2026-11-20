'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./poker-scout-sessions.js');
const { makeBrain } = require('./poker-player.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
const FIELDS = ['seed', 'style', 'hero', 'session', 'pair', 'seat', 'handIndex', 'deal', 'bb', 'mainMove', 'equityAtMainMove', 'streetReached', 'showdown', 'guardrailFired', 'facedRiverBet', 'riverCall'];
const rowsOf = (dir) => fs.readFileSync(path.join(dir, 'poker-scout-sessions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sorted = (rows) => rows.map((r) => JSON.stringify(r)).sort();

/** A stub model: the note prompt gets a note, every move prompt fails so the brain takes its default. */
function stub() {
  const s = { notes: 0 };
  s.ask = async (llm, system, user) => {
    if (user === 'Write the note.') { s.notes++; return { ok: true, text: 'Plays loose.' }; }
    return { ok: false };
  };
  return s;
}
const base = (dir, ask, extra = {}) => ({ styles: ['maniac'], sessions: 2, hands: 4, watch: 20, dataDir: dir, ask, pause: false, ...extra });

test('run writes one row per hand with the fields; cold and scouted share the deal', async () => {
  const dir = tmp();
  await run(base(dir, stub().ask));
  const rows = rowsOf(dir);
  assert.equal(rows.length, 16);
  for (const r of rows) for (const f of FIELDS) assert.ok(f in r, `${f} missing`);
  const at = (hero, session, pair, seat) => rows.find((r) => r.hero === hero && r.session === session && r.pair === pair && r.seat === seat);
  for (const session of [0, 1]) for (const pair of [0, 1]) for (const seat of [0, 1]) assert.equal(at('cold', session, pair, seat).deal, at('scouted', session, pair, seat).deal);
});

test('every session starts from the frozen report', async () => {
  const dir = tmp();
  const made = [];
  const spy = (o) => { const b = makeBrain(o); made.push(b); return b; };
  const s = stub();
  await run(base(dir, s.ask, { makeBrain: spy }));
  const file = path.join(dir, 'poker-scout-sessions-maniac.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(made.length, 4);
  assert.ok(made.every((b) => b.stats.hands > 0)); // each played
  assert.deepEqual(saved.notes, { Opponent: 'Plays loose.' });
  assert.ok(saved.profiles.Opponent.hands >= 20 || saved.read.stats.hands >= 20);
  const before = fs.readFileSync(file);
  await run(base(dir, s.ask, { sessions: 3 }));
  assert.ok(before.equals(fs.readFileSync(file)));
});

test('a scouted brain starts with the saved profiles and notes and an empty ledger; a cold one with nothing', async () => {
  const dir = tmp();
  const starts = [];
  const spy = (o) => {
    const b = makeBrain(o);
    starts.push({ hero: o.profiles ? 'scouted' : 'cold', profiles: JSON.parse(JSON.stringify(b.profiles.toJSON())), notes: JSON.parse(JSON.stringify(b.notes)), ledger: JSON.parse(JSON.stringify(b.ledger)) });
    return b;
  };
  await run(base(dir, stub().ask, { makeBrain: spy }));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'poker-scout-sessions-maniac.json'), 'utf8'));
  assert.equal(starts.length, 4);
  for (const st of starts) assert.deepEqual(st.ledger, {});
  for (const st of starts.filter((x) => x.hero === 'scouted')) {
    assert.deepEqual(st.profiles, saved.profiles);
    assert.deepEqual(st.notes, saved.notes);
  }
  for (const st of starts.filter((x) => x.hero === 'cold')) {
    assert.deepEqual(st.profiles, {});
    assert.deepEqual(st.notes, {});
  }
});

test('interrupted then resumed equals uninterrupted', async () => {
  const a = tmp();
  const b = tmp();
  const s = stub();
  const cut = await run(base(a, s.ask, { stopAfterHands: 6 }));
  assert.equal(cut.stopped, true);
  assert.equal(rowsOf(a).length, 6);
  await run(base(a, s.ask));
  await run(base(b, stub().ask));
  const resumed = rowsOf(a);
  assert.deepEqual(sorted(resumed), sorted(rowsOf(b)));
  const keys = resumed.map((r) => [r.style, r.hero, r.session, r.pair, r.seat].join('|'));
  assert.equal(new Set(keys).size, keys.length);
});

test('resume reuses the saved report', async () => {
  const dir = tmp();
  const s = stub();
  await run(base(dir, s.ask, { stopAfterHands: 3 }));
  assert.equal(s.notes, 1);
  await run(base(dir, s.ask));
  assert.equal(s.notes, 1);
});

test('usage errors: unknown style, odd hands', async () => {
  await assert.rejects(run(base(tmp(), stub().ask, { styles: ['nope'] })), /unknown style/);
  await assert.rejects(run(base(tmp(), stub().ask, { hands: 5 })), /even/);
});
