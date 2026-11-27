'use strict';
// Pure parts of the B109 PR-head runner (qa/b109_pr_check.js): read a run's JSON,
// judge it, turn a round's verdicts into an exit code and the PR-comment lines.
// No browser, fs or subprocess here. Not shared with qa/lib/grace-round.js or
// qa/lib/b99-runs.js (other slices own those).

// The check names exactly as qa/b109_report_key_check.js writes them.
const NAMES = [
  'AC1 Enter in grace window deals one round',
  'AC2 held report reopens for the same shoe between rounds',
  'AC3 x in grace window deals one round at twice the last bet',
  'AC4 x with Rebet x2 disabled keeps the report open and deals nothing',
  'AC5 Enter after grace window deals nothing',
  'AC6 session report has no grace window',
  'AC7 held Enter deals exactly one round',
];
const [N1, N2, N3, N4, N5, N6, N7] = NAMES;

/** The JSON from the first `{` of a run's output, or null when there is none or it doesn't parse. */
function parseRun(text) {
  text = String(text || '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const json = JSON.parse(text.slice(start));
    return json && typeof json === 'object' ? json : null;
  } catch (_) {
    return null;
  }
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const lenOf = (x) => (Array.isArray(x) ? x.length : 0);

/**
 * Judge one run. AC4, AC5 and AC6 are judged; AC1, AC2, AC3 and AC7 are reported
 * only (they depend on the grace-window timing #227 fixes).
 * named: the report had all 7 check names (plumbing mode judges only that).
 * strict: all 7 pass with failed and errors empty.
 */
function runVerdict(json) {
  if (!isObj(json)) return { result: 'fail', reasons: ['no report'], strict: false, ac4Tables: null, named: false };
  const checks = isObj(json.checks) ? json.checks : {};
  const reasons = [];
  const missing = NAMES.filter((name) => !isObj(checks[name]));
  const named = missing.length === 0;
  if (!named) reasons.push(`missing checks: ${missing.join(', ')}`);
  const errors = Array.isArray(json.errors) ? json.errors : [];
  if (errors.length) reasons.push(`errors: ${errors.length} (${String(errors[0]).slice(0, 80)})`);
  for (const name of [N4, N5, N6]) {
    if (isObj(checks[name]) && checks[name].pass !== true) reasons.push(`${name.slice(0, 3)} failed`);
  }
  const ac4 = isObj(checks[N4]) ? checks[N4] : {};
  const tables = isObj(ac4.detail) ? ac4.detail.tables : undefined;
  const ac4Tables = typeof tables === 'number' ? tables : null;
  if (isObj(checks[N4]) && ac4Tables === null) reasons.push('AC4 detail.tables is not a number');
  const allPass = named && NAMES.every((name) => checks[name].pass === true);
  const strict = allPass && Array.isArray(json.failed) && json.failed.length === 0 && errors.length === 0;
  return { result: reasons.length ? 'fail' : 'pass', reasons, strict, ac4Tables, named };
}

/**
 * Exit code for a round. verdicts has one entry per requested run: a runVerdict
 * result, or 'skipped' when the time limit stopped it from starting.
 */
function roundExit(verdicts, { runs, mode } = {}) {
  const requested = runs === undefined ? verdicts.length : runs;
  const completed = verdicts.filter((v) => v !== 'skipped');
  if (mode === 'plumbing') {
    return completed.length >= 1 && completed.every((v) => v.named === true) ? 0 : 1;
  }
  if (mode === 'strict') {
    return verdicts.length >= requested && completed.length === verdicts.length &&
      completed.every((v) => v.result === 'pass' && v.strict === true) ? 0 : 1;
  }
  return completed.length >= Math.ceil(requested / 2) && completed.every((v) => v.result === 'pass') ? 0 : 1;
}

const word = (c) => (isObj(c) && c.pass === true ? 'pass' : 'fail');
const num = (x) => (typeof x === 'number' ? Math.round(x) : x);
const timed = (c) => {
  const d = isObj(c) && isObj(c.detail) ? c.detail : {};
  return `${word(c)} ${d.outcome} ${d.reason} ${num(d.pressMs)}`;
};

function runLine(k, total, verdict, detail) {
  const head = `run ${k + 1}/${total}: `;
  const secs = detail && typeof detail.seconds === 'number' ? ` (${detail.seconds}s)` : '';
  if (verdict === 'skipped') return `${head}skipped (time)`;
  const json = detail ? detail.json : null;
  if (!isObj(json)) return `${head}no output${secs}`;
  const c = isObj(json.checks) ? json.checks : {};
  const a4 = isObj(c[N4]) && isObj(c[N4].detail) ? c[N4].detail : {};
  const parts = [
    `${head}${verdict.result}${secs}`,
    `AC4 ${word(c[N4])} ${a4.tables} ${a4.rebet2Disabled} ${a4.open} ${a4.dealt}`,
    `AC5 ${word(c[N5])}`,
    `AC6 ${word(c[N6])}`,
    `AC1 ${timed(c[N1])}`,
    `AC3 ${timed(c[N3])}`,
    `AC7 ${timed(c[N7])}`,
    `AC2 ${word(c[N2])}`,
    `strict 7/7: ${verdict.strict ? 'yes' : 'no'}`,
  ];
  if (verdict.result === 'fail') parts.push(`why: ${verdict.reasons.join('; ').slice(0, 160)}`);
  return parts.join(' | ');
}

/** The PR-comment lines: one per run, the strict count, then the verdict last. At most 30 lines. */
function formatLines({ sha7, runs, mode, verdicts, details = [] }) {
  const total = runs === undefined ? verdicts.length : runs;
  const lines = verdicts.slice(0, 28).map((v, k) => runLine(k, total, v, details[k]));
  const completed = verdicts.filter((v) => v !== 'skipped');
  const strictRuns = completed.filter((v) => v.strict === true).length;
  lines.push(`strict 7/7: ${strictRuns} of ${completed.length} runs`);
  const nPass = completed.filter((v) => v.result === 'pass').length;
  const nSkipped = verdicts.length - completed.length;
  const code = roundExit(verdicts, { runs: total, mode });
  lines.push(`B109 PR check ${sha7} (${mode || 'default'}): ${nPass} pass, ${completed.length - nPass} fail, ${nSkipped} skipped -> exit ${code}`);
  return lines;
}

module.exports = { NAMES, parseRun, runVerdict, roundExit, formatLines };
