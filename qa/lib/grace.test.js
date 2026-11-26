'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runGraceCheck, classify, GRACE_MS, MAX_ATTEMPTS } = require('./grace');

// A scripted attempt(n): returns the next scripted result and counts calls.
function scripted(results) {
  const calls = [];
  const attempt = async (n) => {
    calls.push(n);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  return { attempt, calls };
}

test('grace: constants match the web grace window', () => {
  assert.equal(GRACE_MS, 500);
  assert.equal(MAX_ATTEMPTS, 3);
});

test('grace: classify checks not-open, late, then the deal count', () => {
  assert.equal(classify({ open: false, pressMs: 10, dealt: 1 }), 'not-open');
  assert.equal(classify({ open: true, pressMs: null, dealt: 1 }), 'not-open');
  assert.equal(classify({ open: true, pressMs: undefined, dealt: 1 }), 'not-open');
  assert.equal(classify({ open: true, pressMs: 600, dealt: 1 }), 'late');
  assert.equal(classify({ open: true, pressMs: 600, dealt: 0 }), 'late');
  assert.equal(classify({ open: true, pressMs: 100, dealt: 1 }), 'dealt-one');
  assert.equal(classify({ open: true, pressMs: 100, dealt: 0 }), 'no-deal');
  assert.equal(classify({ open: true, pressMs: 100, dealt: 2 }), 'two-deals');
  assert.equal(classify({ open: true, pressMs: 100, dealt: 3 }), 'two-deals');
  assert.equal(classify({ open: false, pressMs: 900, dealt: 1 }), 'not-open');
  assert.equal(classify({ open: true, pressMs: 250, dealt: 1 }, 200), 'late');
});

test('grace: in-window dealt-one passes on the first attempt', async () => {
  const s = scripted([{ open: true, pressMs: 120, dealt: 1 }]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, true);
  assert.equal(r.outcome, 'dealt-one');
  assert.equal(r.reason, null);
  assert.equal(r.pressMs, 120);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.history, [{ pressMs: 120, outcome: 'dealt-one' }]);
  assert.deepEqual(s.calls, [1]);
});

test('grace: late, late, dealt-one passes after 3 attempts with all three in history', async () => {
  const s = scripted([
    { open: true, pressMs: 640, dealt: 0 },
    { open: true, pressMs: 510, dealt: 1 },
    { open: true, pressMs: 90, dealt: 1 },
  ]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, true);
  assert.equal(r.outcome, 'dealt-one');
  assert.equal(r.reason, null);
  assert.equal(r.pressMs, 90);
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.history, [
    { pressMs: 640, outcome: 'late' },
    { pressMs: 510, outcome: 'late' },
    { pressMs: 90, outcome: 'dealt-one' },
  ]);
  assert.deepEqual(s.calls, [1, 2, 3]);
});

test('grace: late x3 fails with harness-late and records every pressMs', async () => {
  const s = scripted([
    { open: true, pressMs: 600, dealt: 1 },
    { open: true, pressMs: 700, dealt: 1 },
    { open: true, pressMs: 800, dealt: 1 },
    { open: true, pressMs: 100, dealt: 1 },
  ]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'harness-late');
  assert.equal(r.outcome, 'late');
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.history.map((h) => h.pressMs), [600, 700, 800]);
  assert.deepEqual(r.history.map((h) => h.outcome), ['late', 'late', 'late']);
  assert.deepEqual(s.calls, [1, 2, 3]);
});

test('grace: in-window no-deal fails on the first attempt with no retry', async () => {
  const s = scripted([{ open: true, pressMs: 100, dealt: 0 }]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, false);
  assert.equal(r.outcome, 'no-deal');
  assert.equal(r.reason, 'no-deal');
  assert.equal(r.attempts, 1);
  assert.equal(s.calls.length, 1);
});

test('grace: in-window two-deals fails with no retry', async () => {
  const s = scripted([{ open: true, pressMs: 100, dealt: 2 }]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, false);
  assert.equal(r.outcome, 'two-deals');
  assert.equal(r.reason, 'two-deals');
  assert.equal(r.attempts, 1);
  assert.equal(s.calls.length, 1);
});

test('grace: not-open fails with no retry', async () => {
  const s = scripted([{ open: false, pressMs: null, dealt: 0 }]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, false);
  assert.equal(r.outcome, 'not-open');
  assert.equal(r.reason, 'not-open');
  assert.equal(r.attempts, 1);
  assert.equal(s.calls.length, 1);
});

test('grace: dealt-one with extraOk false fails with reason extra', async () => {
  const s = scripted([{ open: true, pressMs: 100, dealt: 1, extraOk: false }]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, false);
  assert.equal(r.outcome, 'dealt-one');
  assert.equal(r.reason, 'extra');
  assert.equal(r.attempts, 1);
  assert.equal(s.calls.length, 1);
});

test('grace: pressMs exactly 500 is late', async () => {
  assert.equal(classify({ open: true, pressMs: 500, dealt: 1 }), 'late');
  assert.equal(classify({ open: true, pressMs: 499, dealt: 1 }), 'dealt-one');
  const s = scripted([{ open: true, pressMs: 500, dealt: 1 }, { open: true, pressMs: 499, dealt: 1 }]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.history[0].outcome, 'late');
});

test('grace: no check passes on a late attempt alone', async () => {
  const s = scripted([{ open: true, pressMs: 900, dealt: 1 }]);
  const r = await runGraceCheck(s.attempt, { maxAttempts: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'harness-late');
  assert.equal(r.attempts, 1);
  assert.equal(s.calls.length, 1);
});

test('grace: unreachable report stops with no-report', async () => {
  const s = scripted([{ ok: false, detail: 'no report after 10 tables' }]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-report');
  assert.equal(r.detail, 'no report after 10 tables');
  assert.equal(r.attempts, 1);
  assert.equal(s.calls.length, 1);
});

test('grace: graceMs option moves the late boundary', async () => {
  const s = scripted([{ open: true, pressMs: 300, dealt: 1 }]);
  const r = await runGraceCheck(s.attempt, { maxAttempts: 1, graceMs: 200 });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'harness-late');
});

test('grace: pressMs under 500 but handledMs 500 or more is late', () => {
  assert.equal(classify({ open: true, pressMs: 100, handledMs: 500, dealt: 1 }), 'late');
  assert.equal(classify({ open: true, pressMs: 100, handledMs: 900, dealt: 0 }), 'late');
});

test('grace: handledMs missing keeps the pressMs-only rule', () => {
  assert.equal(classify({ open: true, pressMs: 499, handledMs: undefined, dealt: 1 }), 'dealt-one');
  assert.equal(classify({ open: true, pressMs: 499, handledMs: null, dealt: 1 }), 'dealt-one');
  assert.equal(classify({ open: true, pressMs: 499, dealt: 1 }), 'dealt-one');
});

test('grace: dealt-one only when pressMs and handledMs are both under 500', () => {
  assert.equal(classify({ open: true, pressMs: 499, handledMs: 499, dealt: 1 }), 'dealt-one');
  assert.equal(classify({ open: true, pressMs: 499, handledMs: 500, dealt: 1 }), 'late');
  assert.equal(classify({ open: true, pressMs: 500, handledMs: 400, dealt: 1 }), 'late');
  assert.equal(classify({ open: true, pressMs: 100, handledMs: 101, dealt: 0 }), 'no-deal');
  assert.equal(classify({ open: true, pressMs: 100, handledMs: 101, dealt: 2 }), 'two-deals');
});

test('grace: a press late only by handledMs is retried and passes on a later in-window attempt', async () => {
  const s = scripted([
    { open: true, pressMs: 100, handledMs: 650, dealt: 0 },
    { open: true, pressMs: 90, handledMs: 120, dealt: 1 },
  ]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.handledMs, 120);
  assert.deepEqual(r.history, [
    { pressMs: 100, handledMs: 650, outcome: 'late' },
    { pressMs: 90, handledMs: 120, outcome: 'dealt-one' },
  ]);
});

test('grace: three presses late by handledMs fail with harness-late and keep handledMs in history', async () => {
  const s = scripted([
    { open: true, pressMs: 100, handledMs: 600, dealt: 1 },
    { open: true, pressMs: 110, handledMs: 700, dealt: 1 },
    { open: true, pressMs: 120, handledMs: 800, dealt: 1 },
  ]);
  const r = await runGraceCheck(s.attempt);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'harness-late');
  assert.equal(r.attempts, 3);
  assert.equal(r.handledMs, 800);
  assert.deepEqual(r.history.map((h) => h.handledMs), [600, 700, 800]);
});

test('grace: forced late (graceMs 1) fails with harness-late after 3 attempts', async () => {
  const s = scripted([{ open: true, pressMs: 5, handledMs: 6, dealt: 1 }]);
  const r = await runGraceCheck(s.attempt, { graceMs: 1 });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'harness-late');
  assert.equal(r.attempts, 3);
  assert.equal(r.history.length, 3);
  for (const h of r.history) assert.deepEqual(h, { pressMs: 5, handledMs: 6, outcome: 'late' });
});
