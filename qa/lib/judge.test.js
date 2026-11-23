'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeUnitTests, judgeReport } = require('./judge');

const tap = (tests, pass, fail, cancelled = 0) =>
  `TAP version 13\nok 1 - x\n1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped 0\n`;

test('AC1 TAP totals all passing -> ok, "12 pass, 0 fail"', () => {
  assert.deepEqual(judgeUnitTests({ code: 0, text: tap(12, 12, 0) }), { ok: true, detail: '12 pass, 0 fail' });
});

test('AC2 spec-reporter (ℹ) totals -> same result', () => {
  const text = 'ℹ tests 12\nℹ suites 0\nℹ pass 12\nℹ fail 0\nℹ cancelled 0\n';
  assert.deepEqual(judgeUnitTests({ code: 0, text }), { ok: true, detail: '12 pass, 0 fail' });
});

test('AC3 empty output, exit 0 -> not ok, detail starts "no test summary found"', () => {
  const r = judgeUnitTests({ code: 0, text: '' });
  assert.equal(r.ok, false);
  assert.ok(r.detail.startsWith('no test summary found'));
});

test('AC4 zero tests ran -> not ok', () => {
  assert.equal(judgeUnitTests({ code: 0, text: tap(0, 0, 0) }).ok, false);
});

test('AC5 one failure -> not ok, "11 pass, 1 fail"', () => {
  for (const code of [0, 1]) {
    const r = judgeUnitTests({ code, text: tap(12, 11, 1) });
    assert.equal(r.ok, false);
    assert.equal(r.detail, '11 pass, 1 fail');
  }
});

test('AC6 cancelled 1 -> not ok', () => {
  const r = judgeUnitTests({ code: 0, text: tap(12, 11, 0, 1) });
  assert.equal(r.ok, false);
  assert.equal(r.detail, '11 pass, 0 fail, 1 cancelled');
});

test('AC7 good totals but exit 1 -> not ok', () => {
  assert.equal(judgeUnitTests({ code: 1, text: tap(12, 12, 0) }).ok, false);
});

test('AC8 test name containing "pass 99" is ignored -> reads 3 pass', () => {
  const text = 'ok 1 - pass 99 hands\n' + tap(3, 3, 0);
  assert.equal(judgeUnitTests({ code: 0, text }).detail, '3 pass, 0 fail');
});

const rep = (o) => 'noise\n' + JSON.stringify(o);
const chk = (...pass) => Object.fromEntries(pass.map((p, i) => ['c' + i, { pass: p }]));

test('AC1 judgeReport: 3 passing checks + errors [HARNESS x], exit 1 -> not ok, "3/3 checks, errors: 1"', () => {
  const r = judgeReport({ code: 1, text: rep({ checks: chk(true, true, true), errors: ['HARNESS x'] }) });
  assert.equal(r.ok, false);
  assert.equal(r.detail, '3/3 checks, errors: 1');
  assert.equal(r.failed.length, 1);
  assert.ok(r.failed[0].startsWith('errors: '));
});

test('AC2 judgeReport: 2 of 3 checks pass, exit 1 -> "2/3 checks", failed = [check name]', () => {
  const r = judgeReport({ code: 1, text: rep({ checks: chk(true, false, true) }) });
  assert.equal(r.ok, false);
  assert.equal(r.detail, '2/3 checks');
  assert.deepEqual(r.failed, ['c1']);
});

test('AC3 judgeReport: 3 failing checks + 1 error -> "0/3 checks, errors: 1" (never negative)', () => {
  const r = judgeReport({ code: 1, text: rep({ checks: chk(false, false, false), errors: ['e'] }) });
  assert.equal(r.detail, '0/3 checks, errors: 1');
});

test('AC4 judgeReport: consoleErrors (2), findings object (1 key), problems [] -> "3/3 checks, consoleErrors: 2, findings: 1"', () => {
  const r = judgeReport({ code: 1, text: rep({ checks: chk(true, true, true), consoleErrors: ['a', 'b'], findings: { x: 1 }, problems: [] }) });
  assert.equal(r.detail, '3/3 checks, consoleErrors: 2, findings: 1');
});

test('AC5 judgeReport: all pass, non-check keys empty or missing, exit 0 -> ok, "N/N checks", failed []', () => {
  const r = judgeReport({ code: 0, text: rep({ checks: chk(true, true), errors: [], findings: {} }) });
  assert.deepEqual(r, { ok: true, detail: '2/2 checks', failed: [] });
});

test('AC6 judgeReport: no checks, errors [e], exit 1 -> not ok, "exit 1, errors: 1"', () => {
  const r = judgeReport({ code: 1, text: rep({ errors: ['e'] }) });
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'exit 1, errors: 1');
});

test('AC7 judgeReport: non-JSON output, exit 0 and exit 1 -> same { ok, detail } as before', () => {
  assert.deepEqual(judgeReport({ code: 0, text: 'all fine\n' }), { ok: true, detail: 'exit 0' });
  assert.deepEqual(judgeReport({ code: 1, text: 'z\ny\na\nb\nc\n' }), { ok: false, detail: 'exit 1: a | b | c' });
  assert.deepEqual(judgeReport({ code: 1, text: 'x { broken' }), { ok: false, detail: 'exit 1: x { broken' });
});

test('AC8 judgeReport: top-level failed [x] with all checks passing -> "N/N checks", failed []', () => {
  const r = judgeReport({ code: 0, text: rep({ checks: chk(true, true), failed: ['x'] }) });
  assert.deepEqual(r, { ok: true, detail: '2/2 checks', failed: [] });
});

test('judgeReport: suffixes follow the order invariantViolations, errors, problems, consoleErrors, findings', () => {
  const r = judgeReport({ code: 1, text: rep({ findings: ['f'], consoleErrors: ['c'], problems: ['p'], errors: ['e'], invariantViolations: ['i'], checks: chk(true) }) });
  assert.equal(r.detail, '1/1 checks, invariantViolations: 1, errors: 1, problems: 1, consoleErrors: 1, findings: 1');
});
