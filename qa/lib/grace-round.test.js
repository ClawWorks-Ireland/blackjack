'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseCheck, graceRows, verdict, formatLines } = require('./grace-round');

const N1 = 'AC1 Enter in grace window deals one round';
const N3 = 'AC3 x in grace window deals one round at twice the last bet';
const N7 = 'AC7 held Enter deals exactly one round';
const OTHER = [
  'AC2 held report reopens for the same shoe between rounds',
  'AC4 x with Rebet x2 disabled keeps the report open and deals nothing',
  'AC5 Enter after grace window deals nothing',
  'AC6 session report has no grace window',
];

const chk = (over = {}) => ({ pass: true, detail: { pressMs: 100.4, handledMs: 120.6, outcome: 'dealt-one', attempts: 1, reason: null }, ...over });
function good(over = {}) {
  const checks = { [N1]: chk(), [N3]: chk(), [N7]: chk() };
  for (const n of OTHER) checks[n] = { pass: true, detail: {} };
  return { failed: [], checks: { ...checks, ...over }, errors: [] };
}
const fail = (reason, outcome) => chk({ pass: false, detail: { pressMs: 100, handledMs: 110, outcome, attempts: 1, reason } });

test('grace-round: parseCheck reads the JSON after leading output, null when none', () => {
  assert.deepEqual(parseCheck('noise\n{"a": 1}'), { a: 1 });
  assert.equal(parseCheck('no json here'), null);
  assert.equal(parseCheck('x { broken'), null);
  assert.equal(parseCheck(''), null);
  assert.equal(parseCheck(undefined), null);
});

test('grace-round: graceRows gives AC1, AC3, AC7 with handledMs, and missing for an absent check', () => {
  const j = good();
  delete j.checks[N3];
  const rows = graceRows(j);
  assert.deepEqual(rows.map((r) => r.ac), ['AC1', 'AC3', 'AC7']);
  assert.deepEqual(rows[0], { ac: 'AC1', pass: true, outcome: 'dealt-one', reason: null, pressMs: 100.4, handledMs: 120.6, attempts: 1 });
  assert.equal(rows[1].pass, false);
  assert.equal(rows[1].reason, 'missing');
  assert.equal(graceRows(null)[0].reason, 'missing');
});

test('grace-round: 7/7 round with repeats that pass or fail only harness-late is pass', () => {
  const late = good({ [N1]: fail('harness-late', 'late') });
  const v = verdict({ roundCode: 0, round: good(), repeats: [good(), late, { skipped: true }] });
  assert.equal(v.result, 'pass');
});

test('grace-round: round B109 6/7 or with errors is fail', () => {
  const six = good({ [OTHER[3]]: { pass: false, detail: {} } });
  assert.equal(verdict({ roundCode: 1, round: six, repeats: [] }).result, 'fail');
  const err = { ...good(), errors: ['HARNESS x'] };
  assert.equal(verdict({ roundCode: 1, round: err, repeats: [] }).result, 'fail');
  const six2 = good();
  delete six2.checks[OTHER[0]];
  assert.equal(verdict({ roundCode: 0, round: six2, repeats: [] }).result, 'fail');
});

test('grace-round: a repeat AC1/AC3/AC7 no-deal, two-deals, not-open or extra is fail', () => {
  for (const [reason, outcome] of [['no-deal', 'no-deal'], ['two-deals', 'two-deals'], ['not-open', 'not-open'], ['extra', 'dealt-one']]) {
    const rep = good({ [N7]: fail(reason, outcome) });
    const v = verdict({ roundCode: 0, round: good(), repeats: [rep] });
    assert.equal(v.result, 'fail', reason);
    assert.ok(v.reasons.length > 0);
  }
});

test('grace-round: a repeat with no JSON or errors is fail; a skipped repeat is not', () => {
  assert.equal(verdict({ roundCode: 0, round: good(), repeats: [null] }).result, 'fail');
  assert.equal(verdict({ roundCode: 0, round: good(), repeats: [{ ...good(), errors: ['e'] }] }).result, 'fail');
  assert.equal(verdict({ roundCode: 0, round: good(), repeats: [{ skipped: true }] }).result, 'pass');
});

test('grace-round: round exit 2 or no round JSON is error', () => {
  assert.equal(verdict({ roundCode: 2, round: good(), repeats: [] }).result, 'error');
  assert.equal(verdict({ roundCode: 0, round: null, repeats: [] }).result, 'error');
});

test('grace-round: B99 and other failed steps don\'t fail the verdict', () => {
  const steps = [{ name: 'B99 report click', ok: false, detail: '1/2 checks' }];
  const v = verdict({ roundCode: 1, round: good(), repeats: [], steps });
  assert.equal(v.result, 'pass');
});

test('grace-round: formatLines keeps a round and 5 repeats within 25 lines, verdict last', () => {
  const steps = [
    { name: 'B99 report click', ok: false, detail: '1/2 checks' },
    { name: 'B109 report keys', ok: true, detail: '7/7 checks' },
    { name: 'unit tests', ok: false, detail: '1 fail' },
  ];
  const repeats = [good(), good(), null, { skipped: true }, good()];
  const v = verdict({ roundCode: 1, round: good(), repeats, steps });
  const lines = formatLines({ roundCode: 1, round: good(), repeats, steps, verdict: v });
  assert.ok(lines.length <= 25, String(lines.length));
  assert.match(lines[lines.length - 1], /^verdict: /);
  const text = lines.join('\n');
  assert.match(text, /round B109: 7\/7/);
  assert.match(text, /round B99: /);
  assert.match(text, /skipped \(time\)/);
  assert.match(text, /no output/);
  assert.match(text, /unit tests/);
});

test('grace-round: b109_grace_round.js and b109_report_key_check.js compile', () => {
  for (const f of ['../b109_grace_round.js', '../b109_report_key_check.js']) {
    const filename = path.join(__dirname, f);
    const source = fs.readFileSync(filename, 'utf8');
    // Wrapped like a CommonJS module so top-level require/return are legal.
    assert.doesNotThrow(() => new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, { filename }));
  }
});
