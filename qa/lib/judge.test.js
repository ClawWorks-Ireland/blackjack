'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeUnitTests } = require('./judge');

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
