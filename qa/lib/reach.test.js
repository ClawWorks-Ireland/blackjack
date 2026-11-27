'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reachReport, reachFailure, reachOrFail, classify, MAX_TABLES, NO_REPORT_ROUNDS } = require('./reach');

// Fake tables: each table is a script of per-round outcomes { bankroll, report }.
// start is the opening bankroll. A table with bankroll <= 0 is broke.
function fake(tables) {
  const log = { opened: 0, closed: [], bets: [] };
  const ops = {
    freshTable: async () => {
      const spec = tables[Math.min(log.opened, tables.length - 1)];
      log.opened++;
      return { id: log.opened, script: spec.script || [], bank: spec.start ?? 1000, report: false, round: 0 };
    },
    closeTable: async (t) => { log.closed.push(t.id); },
    reportOpen: async (t) => t.report,
    canDeal: async (t) => !t.report,
    isBroke: async (t) => !t.report && t.bank <= 0,
    bankroll: async (t) => t.bank,
    deal: async (t, bet) => { log.bets.push(bet); t.pending = t.script[t.round++] || {}; },
    playOut: async (t) => { if (t.pending.bankroll !== undefined) t.bank = t.pending.bankroll; },
    waitReport: async (t) => { t.report = Boolean(t.pending.report); return t.report; },
  };
  return { ops, log };
}

test('reach: report opens on the first table -> ok, tables 1, reason null', async () => {
  const f = fake([{ script: [{ bankroll: 990 }, { bankroll: 1000, report: true }] }]);
  const r = await reachReport(f.ops);
  assert.equal(r.ok, true);
  assert.equal(r.tables, 1);
  assert.equal(r.rounds, 2);
  assert.equal(r.reason, null);
  assert.equal(r.table.report, true);
  assert.deepEqual(f.log.closed, []);
});

test('reach: first table goes broke, second reaches the report -> ok, tables 2, first table closed', async () => {
  const f = fake([
    { start: 20, script: [{ bankroll: 10 }, { bankroll: 0 }] },
    { script: [{ bankroll: 1000, report: true }] },
  ]);
  const r = await reachReport(f.ops);
  assert.equal(r.ok, true);
  assert.equal(r.tables, 2);
  assert.equal(r.rounds, 1);
  assert.deepEqual(f.log.closed, [1]);
});

test('reach: every table goes broke -> ok false, reason broke, tables 10, broke true', async () => {
  const f = fake([{ start: 10, script: [{ bankroll: 0 }] }]);
  const r = await reachReport(f.ops);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'broke');
  assert.equal(r.tables, MAX_TABLES);
  assert.equal(r.tables, 10);
  assert.equal(r.broke, true);
});

test('reach: minBankroll 251 and bankroll falls to 200 -> fresh table, no deal below 251', async () => {
  const f = fake([
    { start: 1000, script: [{ bankroll: 200 }] },
    { start: 1000, script: [{ bankroll: 1000, report: true }] },
  ]);
  const seen = [];
  const ops = { ...f.ops, deal: async (t, bet) => { seen.push(t.bank); return f.ops.deal(t, bet); } };
  const r = await reachReport(ops, { minBankroll: 251 });
  assert.equal(r.ok, true);
  assert.equal(r.tables, 2);
  assert.ok(seen.every((b) => b >= 251), `dealt at ${seen}`);
  assert.deepEqual(f.log.closed, [1]);
});

test('reach: every deal on the successful path bet more than 250 when betFor = min(255, bankroll) and minBankroll = 251', async () => {
  const f = fake([
    { start: 1000, script: [{ bankroll: 600 }, { bankroll: 240 }] },
    { start: 1000, script: [{ bankroll: 800 }, { bankroll: 900, report: true }] },
  ]);
  const r = await reachReport(f.ops, { betFor: (b) => Math.min(255, b), minBankroll: 251 });
  assert.equal(r.ok, true);
  assert.ok(f.log.bets.length > 0);
  assert.ok(f.log.bets.every((b) => b > 250), `bets ${f.log.bets}`);
});

test('reach: table keeps chips, 40 rounds, no report -> ok false, reason no-report', async () => {
  const f = fake([{ start: 1000, script: [] }]);
  const r = await reachReport(f.ops);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-report');
  assert.equal(r.rounds, 40);
  assert.equal(r.tables, 1);
  assert.equal(r.broke, false);
});

test('classify: not broke, 11 rounds -> no-report', () => {
  assert.equal(NO_REPORT_ROUNDS, 10);
  assert.equal(classify({ broke: false, rounds: 11 }), 'no-report');
});
test('classify: not broke, 10 rounds -> broke', () => {
  assert.equal(classify({ broke: false, rounds: 10 }), 'broke');
});
test('classify: broke, 30 rounds -> broke', () => {
  assert.equal(classify({ broke: true, rounds: 30 }), 'broke');
});

const NAMES = ['AC4 check', 'AC5 check'];
const brokeResult = { ok: false, table: null, tables: 10, rounds: 7, bankroll: 0, broke: true, reason: 'broke' };

test('reachOrFail: every table broke -> put called once per name with pass false and detail keys reason, tables, rounds, bankroll, broke; returns null; does not throw', async () => {
  const f = fake([{ start: 10, script: [{ bankroll: 0 }] }]);
  const puts = [];
  const r = await reachOrFail(f.ops, {}, NAMES, (n, pass, detail) => puts.push({ n, pass, detail }));
  assert.equal(r, null);
  assert.deepEqual(puts.map((p) => p.n), NAMES);
  for (const p of puts) {
    assert.equal(p.pass, false);
    assert.deepEqual(Object.keys(p.detail), ['reason', 'tables', 'rounds', 'bankroll', 'broke']);
    assert.equal(p.detail.reason, 'broke');
    assert.equal(p.detail.tables, 10);
    assert.equal(p.detail.broke, true);
  }
  assert.deepEqual(reachFailure(brokeResult), { reason: 'broke', tables: 10, rounds: 7, bankroll: 0, broke: true });
});

test('reachOrFail: no-report -> detail.note names a game defect', async () => {
  const script = Array.from({ length: 40 }, () => ({ bankroll: 1000 }));
  const f = fake([{ start: 1000, script }]);
  const puts = [];
  const r = await reachOrFail(f.ops, {}, ['AC5 check'], (n, pass, detail) => puts.push({ n, pass, detail }));
  assert.equal(r, null);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].detail.reason, 'no-report');
  assert.match(puts[0].detail.note, /game defect/);
});

test('reachOrFail: report reached -> returns the result and put is never called', async () => {
  const f = fake([{ script: [{ bankroll: 990 }, { bankroll: 1000, report: true }] }]);
  let calls = 0;
  const r = await reachOrFail(f.ops, {}, NAMES, () => { calls++; });
  assert.equal(r.ok, true);
  assert.equal(r.tables, 1);
  assert.equal(calls, 0);
});

test('reach: maxTables 1 and broke -> ok false, tables 1', async () => {
  const f = fake([{ start: 10, script: [{ bankroll: 0 }] }]);
  const r = await reachReport(f.ops, { maxTables: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.tables, 1);
  assert.equal(r.reason, 'broke');
});
