'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { NAMES, parseRun, runVerdict, roundExit, formatLines } = require('./b109-runs');

const [N1, N2, N3, N4, N5, N6, N7] = NAMES;

const ok = (detail = {}) => ({ pass: true, detail });
const bad = (detail = {}) => ({ pass: false, detail });
const timing = { pressMs: 100.4, handledMs: 120.6, outcome: 'dealt-one', attempts: 1, reason: null };
function good(over = {}) {
  return {
    failed: [],
    checks: {
      [N1]: ok(timing), [N2]: ok({ reopened: true }), [N3]: ok(timing),
      [N4]: ok({ rebet2Disabled: true, open: true, dealt: 0, tables: 3 }),
      [N5]: ok({ dealt: 0 }), [N6]: ok({}), [N7]: ok(timing),
      ...over,
    },
    errors: [],
  };
}
const pass = (strict = false) => ({ result: 'pass', reasons: [], strict, ac4Tables: 3, named: true });
const fail = () => ({ result: 'fail', reasons: ['AC5 failed'], strict: false, ac4Tables: 3, named: true });
const n = (k, v) => Array.from({ length: k }, () => v);

test('b109-runs: NAMES are the 7 check names the check writes', () => {
  assert.equal(NAMES.length, 7);
  const src = fs.readFileSync(path.join(__dirname, '..', 'b109_report_key_check.js'), 'utf8');
  for (const name of NAMES) assert.ok(src.includes(name), name);
});

test('b109-runs: parseRun reads the JSON after leading output, null when none or invalid', () => {
  assert.deepEqual(parseRun('noise\n{"a": 1}'), { a: 1 });
  assert.equal(parseRun('no json here'), null);
  assert.equal(parseRun('x { broken'), null);
  assert.equal(parseRun(''), null);
  assert.equal(parseRun(undefined), null);
});

test('b109-runs: runVerdict passes 7 checks with AC4, AC5, AC6 passing and numeric AC4 tables, even when AC1, AC2, AC3 and AC7 fail', () => {
  const v = runVerdict(good());
  assert.equal(v.result, 'pass');
  assert.equal(v.strict, true);
  assert.equal(v.ac4Tables, 3);
  assert.deepEqual(v.reasons, []);
  const j = good({ [N1]: bad(timing), [N2]: bad(), [N3]: bad(timing), [N7]: bad(timing) });
  j.failed = [N1, N2, N3, N7];
  const w = runVerdict(j);
  assert.equal(w.result, 'pass');
  assert.equal(w.strict, false);
});

test('b109-runs: runVerdict fails AC4, AC5 or AC6 failing, a missing check name, non-empty errors, AC4 tables missing, and a null report', () => {
  for (const name of [N4, N5, N6]) {
    const v = runVerdict(good({ [name]: bad({ tables: 3 }) }));
    assert.equal(v.result, 'fail', name);
    assert.ok(v.reasons.some((r) => r.includes(name.slice(0, 3))), name);
  }
  const missing = good();
  delete missing.checks[N2];
  const m = runVerdict(missing);
  assert.equal(m.result, 'fail');
  assert.equal(m.named, false);
  assert.ok(m.reasons.some((r) => r.includes(N2)));

  const withErrors = { ...good(), errors: ['HARNESS boom'] };
  const e = runVerdict(withErrors);
  assert.equal(e.result, 'fail');
  assert.ok(e.reasons.some((r) => /error/.test(r)));

  const noTables = runVerdict(good({ [N4]: ok({ rebet2Disabled: true, open: true, dealt: 0 }) }));
  assert.equal(noTables.result, 'fail');
  assert.ok(noTables.reasons.some((r) => /tables/.test(r)));
  assert.equal(runVerdict(good({ [N4]: ok({ tables: '3' }) })).result, 'fail');

  const nul = runVerdict(null);
  assert.equal(nul.result, 'fail');
  assert.equal(nul.named, false);
  assert.ok(nul.reasons.length > 0);
  assert.equal(runVerdict({}).result, 'fail');
  assert.equal(runVerdict({ checks: [] }).result, 'fail');
});

test('b109-runs: strict is true only for 7 passing checks with empty failed and errors', () => {
  assert.equal(runVerdict(good()).strict, true);
  assert.equal(runVerdict({ ...good(), failed: [N1] }).strict, false);
  assert.equal(runVerdict({ ...good(), errors: ['x'] }).strict, false);
  assert.equal(runVerdict(good({ [N7]: bad() })).strict, false);
  assert.equal(runVerdict(good({ [N1]: bad() })).result, 'pass');
});

test('b109-runs: roundExit default needs half the runs completed and all of them pass', () => {
  const opts = { runs: 10 };
  assert.equal(roundExit(n(10, pass()), opts), 0);
  assert.equal(roundExit([...n(5, pass()), ...n(5, 'skipped')], opts), 0);
  assert.equal(roundExit([...n(4, pass()), ...n(6, 'skipped')], opts), 1);
  assert.equal(roundExit([...n(9, pass()), fail()], opts), 1);
  assert.equal(roundExit(n(10, 'skipped'), opts), 1);
});

test('b109-runs: roundExit strict needs every run completed and strict', () => {
  const opts = { runs: 10, mode: 'strict' };
  assert.equal(roundExit(n(10, pass(true)), opts), 0);
  assert.equal(roundExit([...n(9, pass(true)), 'skipped'], opts), 1);
  assert.equal(roundExit([...n(9, pass(true)), pass(false)], opts), 1);
  assert.equal(roundExit([...n(9, pass(true)), fail()], opts), 1);
  assert.equal(roundExit(n(9, pass(true)), opts), 1, 'fewer verdicts than requested runs');
});

test('b109-runs: roundExit plumbing passes a run with all 7 names whatever they report, fails no output or a missing name', () => {
  const opts = { runs: 1, mode: 'plumbing' };
  assert.equal(roundExit([pass()], opts), 0);
  assert.equal(roundExit([fail()], opts), 0, 'a run that parsed with all 7 names is enough');
  assert.equal(roundExit([runVerdict(good({ [N1]: bad(), [N4]: bad() }))], opts), 0);
  assert.equal(roundExit([runVerdict(null)], opts), 1);
  const missing = good();
  delete missing.checks[N6];
  assert.equal(roundExit([runVerdict(missing)], opts), 1);
  assert.equal(roundExit(['skipped'], opts), 1);
  assert.equal(roundExit([pass(), runVerdict(null)], { runs: 2, mode: 'plumbing' }), 1, 'every completed run must parse');
  assert.equal(roundExit([pass(), 'skipped'], { runs: 2, mode: 'plumbing' }), 0);
});

test('b109-runs: formatLines keeps 10 runs within 30 lines, verdict last', () => {
  const verdicts = [...n(7, runVerdict(good())), runVerdict(null), 'skipped', 'skipped'];
  const details = verdicts.map((v, i) => ({ json: v === 'skipped' || i === 7 ? null : good(), seconds: 100 + i }));
  const lines = formatLines({ sha7: 'abc1234', runs: 10, mode: 'default', verdicts, details });
  assert.ok(lines.length <= 30, String(lines.length));
  assert.equal(lines[0].startsWith('run 1/10: pass'), true);
  assert.ok(lines[0].includes('AC4 pass 3 true true 0'));
  assert.ok(lines[0].includes('AC1 pass dealt-one'));
  assert.ok(lines[0].includes('strict 7/7: yes'));
  assert.ok(lines[7].startsWith('run 8/10: no output'));
  assert.ok(lines[8].startsWith('run 9/10: skipped (time)'));
  assert.ok(lines.some((l) => l === 'strict 7/7: 7 of 8 runs'));
  const last = lines[lines.length - 1];
  assert.equal(last, `B109 PR check abc1234 (default): 7 pass, 1 fail, 2 skipped -> exit ${roundExit(verdicts, { runs: 10, mode: 'default' })}`);
  for (const l of lines) assert.equal(l.includes('\n'), false);
});

test('b109-runs: the QA scripts compile', () => {
  for (const f of ['b109_pr_check.js', 'b109_report_key_check.js']) {
    const filename = path.join(__dirname, '..', f);
    const source = fs.readFileSync(filename, 'utf8');
    // The scripts are CommonJS modules with top-level process.exit; wrap as Node does.
    assert.doesNotThrow(() => new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, { filename }), f);
  }
});
