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

// Report fixtures: maniac has 3 sessions of 4 hands, calling-station 2 (see agent/fixtures).
const FIXDIR = path.join(__dirname, 'fixtures');
const FIX = path.join(FIXDIR, 'poker-scout-sessions.jsonl');
const { report, diagnose } = require('./poker-scout-sessions.js');

test('report: session-unit scouted minus cold with a 95% CI', () => {
  const res = report(FIX, FIXDIR, { bucket: 2, buckets: 2 });
  const m = res.maniac;
  // Per hand: cold 2 bb over 12 hands = 16.7 bb/100; scouted 10 over 12 = 83.3.
  assert.equal(m.heroes.cold.mean, 16.7);
  assert.equal(m.heroes.scouted.mean, 83.3);
  // Session means (bb/100): cold 0, 0, 50; scouted 50, 100, 100. d = 50, 100, 50.
  // mean 66.7; sample sd = sqrt(2500/3) = 28.87; 1.96 x sd / sqrt(3) = 32.7.
  assert.deepEqual([m.diff.n, m.diff.mean, m.diff.ci95], [3, 66.7, 32.7]);
  // Hands 1-2: d = 100, 0, 100: mean 66.7, sd 57.74, ci 65.3. Hands 3-4: d = 0, 200, 0: mean 66.7, sd 115.47, ci 130.7.
  assert.deepEqual(m.buckets.map((b) => [b.n, b.mean, b.ci95]), [[3, 66.7, 65.3], [3, 66.7, 130.7]]);
  assert.equal(m.buckets[0].label, 'hands 1-2');
  assert.deepEqual(m.read, { style: 'maniac', confidence: 'high', vpip: 80, pfr: 60, aggression: 3.5, foldToBet: 10 });
  // Two sessions: d = -50 and +100: mean 25, sd 106.07, ci 147.
  const s = res['calling-station'];
  assert.deepEqual([s.diff.n, s.diff.mean, s.diff.ci95], [2, 25, 147]);
});

test('report ignores incomplete sessions', () => {
  const partial = [0, 1].flatMap((i) => ['cold', 'scouted'].map((hero) => JSON.stringify({ seed: 'sessions', style: 'maniac', hero, session: 3, pair: 0, seat: i, handIndex: i, bb: 50, mainMove: 'call', showdown: false, facedRiverBet: false, riverCall: false })));
  const file = path.join(tmp(), 'rows.jsonl');
  fs.writeFileSync(file, fs.readFileSync(FIX, 'utf8') + partial.join('\n') + '\n');
  assert.deepEqual(report(file, FIXDIR), report(FIX, FIXDIR));
  assert.deepEqual(diagnose(file, 'maniac'), diagnose(FIX, 'maniac'));
});

test('diagnose: per-kind counts and bb, call-down and showdown rates', () => {
  const d = diagnose(FIX, 'maniac', { early: 2 });
  const k = (ks, kind) => [ks[kind].n, ks[kind].bb];
  assert.deepEqual(['call', 'fold', 'bluff', 'value', 'thin'].map((x) => k(d.cold.kinds, x)), [[3, 3], [3, 1], [3, -1], [3, -1], [0, 0]]);
  assert.deepEqual(['call', 'fold', 'bluff', 'value'].map((x) => k(d.cold.early, x)), [[3, 3], [3, 1], [0, 0], [0, 0]]);
  assert.equal(d.cold.kinds.call.perMove, 1);
  assert.deepEqual(['thin', 'call', 'value'].map((x) => k(d.scouted.kinds, x)), [[3, 4], [6, 5], [3, 1]]);
  assert.deepEqual(['thin', 'call', 'value'].map((x) => k(d.scouted.early, x)), [[3, 4], [3, 4], [0, 0]]);
  assert.equal(d.scouted.kinds.call.perMove, 0.8);
  // Cold faced 6 river bets and called 3; those 3 reached showdown and 2 won. Scouted called all 6; 4 won.
  assert.deepEqual([d.cold.callDown, d.cold.showdownWin], [0.5, 2 / 3]);
  assert.deepEqual([d.scouted.callDown, d.scouted.showdownWin], [1, 4 / 6]);
});
