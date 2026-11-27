'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GRACE_MS, parseRun, ac2Gate, runVerdict, roundExit, runLines } = require('./b99-runs');

const N = {
  AC1: 'AC1 deal click in grace window deals one round',
  AC1b: 'AC1b backdrop point over deal in grace window deals one round',
  AC2: 'AC2 held report reopens for the same shoe between rounds',
  AC3: 'AC3 rebet click in grace window deals one round at the last bet',
  AC4: 'AC4 deal click after grace window only closes the report',
  AC5: 'AC5 backdrop click off the controls in grace window is ignored',
  AC5b: 'AC5b panel button in grace window does not act',
  AC6: 'AC6 session report has no grace window',
};
const ok = (detail = {}) => ({ pass: true, detail });
const bad = (detail = {}) => ({ pass: false, detail });
const ac1Ok = { pressMs: 120.5, handledMs: 130.2, attempts: 1, hit: 'panel', closed: true, dealt: 1, outcome: 'dealt-one', reason: null };
const late = { precondition: 'press outside grace window', attempts: 3, pressAt: 700 };

/** A report with every check passing; over replaces checks by key, extra adds to the report. */
function report(over = {}, extra = {}) {
  const checks = {
    AC1: ok(ac1Ok), AC1b: ok({}), AC2: ok({ reopened: true }), AC3: ok({}),
    AC4: ok({}), AC5: ok({}), AC5b: ok({}), AC6: ok({}), ...over,
  };
  const named = {};
  for (const k of Object.keys(N)) named[N[k]] = checks[k];
  const failed = Object.keys(N).filter((k) => !checks[k].pass).map((k) => N[k]);
  return { failed, checks: named, errors: [], ...extra };
}
const ac1With = (d) => ok({ ...ac1Ok, ...d });

test('b99-runs: ac2Gate passes AC1 dealt-one and closed', () => {
  assert.equal(ac2Gate({ outcome: 'dealt-one', closed: true, dealt: 1 }), null);
});

test('b99-runs: ac2Gate fails AC1 harness-late with AC1 did not deal', () => {
  const g = ac2Gate({ outcome: 'no-deal', reason: 'harness-late', closed: false, dealt: 0, extra: 1 });
  assert.deepEqual(g, { reason: 'AC1 did not deal', ac1: { outcome: 'no-deal', reason: 'harness-late', closed: false, dealt: 0 } });
  assert.equal(ac2Gate({ outcome: 'no-deal', closed: false, dealt: 0 }).reason, 'AC1 did not deal');
  assert.equal(ac2Gate({ outcome: 'two-deals', closed: true, dealt: 2 }).reason, 'AC1 did not deal');
  assert.equal(ac2Gate({ outcome: 'dealt-one', closed: false, dealt: 1 }).reason, 'AC1 did not deal');
  assert.deepEqual(ac2Gate(null), { reason: 'AC1 did not deal', ac1: { outcome: null, reason: null, closed: null, dealt: null } });
  assert.deepEqual(ac2Gate(undefined).ac1, { outcome: null, reason: null, closed: null, dealt: null });
});

test('b99-runs: runVerdict pass needs 8 passing checks and the AC-d fields', () => {
  assert.equal(runVerdict(report()), 'pass');
  for (const d of [{ hit: 'backdrop' }, { closed: false }, { dealt: 2 }, { handledMs: undefined }, { pressMs: '1' }, { attempts: undefined }, { outcome: 'two-deals' }]) {
    assert.equal(runVerdict(report({ AC1: ac1With(d) })), 'fail', JSON.stringify(d));
  }
  const seven = report();
  delete seven.checks[N.AC5b];
  assert.equal(runVerdict(seven), 'fail');
  assert.equal(runVerdict(report({}, { errors: ['HARNESS boom'] })), 'fail');
});

test('b99-runs: runVerdict tolerates AC1 harness-late', () => {
  const ac1 = bad({ ...ac1Ok, outcome: 'no-deal', reason: 'harness-late', pressMs: 900 });
  assert.equal(runVerdict(report({ AC1: ac1 })), 'tolerated');
  const ac2 = bad({ reason: 'AC1 did not deal', ac1: {} });
  assert.equal(runVerdict(report({ AC1: ac1, AC2: ac2 })), 'tolerated');
  assert.equal(runVerdict(report({ AC1: ac1, AC2: bad({ reason: 'other' }) })), 'fail');
  assert.equal(runVerdict(report({ AC1: ac1 }, { errors: ['HARNESS x'] })), 'fail');
});

test('b99-runs: runVerdict tolerates AC1b/AC3/AC5/AC5b pressed outside the grace window 3 times', () => {
  for (const k of ['AC1b', 'AC3', 'AC5', 'AC5b']) {
    assert.equal(runVerdict(report({ [k]: bad(late) })), 'tolerated', k);
    assert.equal(runVerdict(report({ [k]: bad({ attempts: 1 }) })), 'fail', k);
    assert.equal(runVerdict(report({ [k]: bad({ ...late, attempts: 2 }) })), 'fail', k);
    assert.equal(runVerdict(report({ [k]: bad({ ...late, precondition: 'other' }) })), 'fail', k);
  }
  assert.equal(runVerdict(report({ AC1b: bad(late), AC3: bad(late), AC5: bad(late), AC5b: bad(late) })), 'tolerated');
  assert.equal(runVerdict(report({ AC3: bad(late), AC5: bad({ stillOpen: false, dealt: 0 }) })), 'fail');
  assert.equal(runVerdict(report({ AC2: bad(late) })), 'fail');
});

test('b99-runs: runVerdict marks an in-window no-deal or two-deals on the panel as defect', () => {
  for (const outcome of ['no-deal', 'two-deals']) {
    const d = { outcome, pressMs: 120, handledMs: 140, hit: 'panel', closed: false, dealt: outcome === 'no-deal' ? 0 : 2 };
    assert.equal(runVerdict(report({ AC1: bad({ ...ac1Ok, ...d }) })), 'defect', outcome);
    assert.equal(runVerdict(report({ AC1: bad({ ...ac1Ok, ...d, handledMs: GRACE_MS }) })), 'fail', outcome);
    assert.equal(runVerdict(report({ AC1: bad({ ...ac1Ok, ...d, pressMs: 600 }) })), 'fail', outcome);
    assert.equal(runVerdict(report({ AC1: bad({ ...ac1Ok, ...d, hit: 'backdrop' }) })), 'fail', outcome);
    assert.equal(runVerdict(report({ AC1: bad({ ...ac1Ok, ...d, handledMs: undefined }) })), 'fail', outcome);
  }
});

test('b99-runs: runVerdict fails AC4 or AC6 failing, even beside a tolerated AC1, and a null report', () => {
  const ac1 = bad({ ...ac1Ok, outcome: 'no-deal', reason: 'harness-late', pressMs: 900 });
  assert.equal(runVerdict(report({ AC4: bad({}) })), 'fail');
  assert.equal(runVerdict(report({ AC6: bad({}) })), 'fail');
  assert.equal(runVerdict(report({ AC1: ac1, AC4: bad({}) })), 'fail');
  assert.equal(runVerdict(report({ AC1: ac1, AC6: bad({}) })), 'fail');
  assert.equal(runVerdict(null), 'fail');
  assert.equal(runVerdict(undefined), 'fail');
  assert.equal(runVerdict({}), 'fail');
});

test('b99-runs: roundExit', () => {
  assert.equal(roundExit(['pass', 'pass', 'pass']), 0);
  assert.equal(roundExit(['pass', 'tolerated', 'tolerated']), 0);
  assert.equal(roundExit(['tolerated', 'tolerated', 'tolerated']), 1);
  assert.equal(roundExit(['pass', 'defect', 'pass']), 1);
  assert.equal(roundExit(['pass', 'fail', 'pass']), 1);
  assert.equal(roundExit([]), 1);
});

test('b99-runs: runLines shows AC1 and AC2 detail and names the failing checks', () => {
  const lines = runLines(2, 3, 'pass', report());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^run 2\/3: pass \| AC1 dealt-one null 120\.5 130\.2 panel true 1 1 \| AC2 pass undefined$/);
  const tol = runLines(1, 3, 'tolerated', report({ AC3: bad(late) }));
  assert.equal(tol.length, 2);
  assert.match(tol[1], /failed AC3 \(tolerated\)/);
  const none = runLines(1, 1, 'fail', null);
  assert.match(none[0], /^run 1\/1: fail/);
  assert.match(none[1], /failed AC1, AC1b/);
});

test('b99-runs: parseRun reads the JSON after leading output, null when none or invalid', () => {
  assert.deepEqual(parseRun('noise\n{"a": 1}'), { a: 1 });
  assert.equal(parseRun('no json here'), null);
  assert.equal(parseRun('x { broken'), null);
  assert.equal(parseRun(''), null);
  assert.equal(parseRun(undefined), null);
});

test('b99-runs: the QA scripts compile', () => {
  for (const file of ['b99_pr_check.js', 'b99_report_click_check.js']) {
    const filename = path.join(__dirname, '..', file);
    // Node wraps a CommonJS file in a function, so top-level `return` is legal there.
    const source = `(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(filename, 'utf8')}\n})`;
    assert.doesNotThrow(() => new vm.Script(source, { filename }), file);
  }
});
