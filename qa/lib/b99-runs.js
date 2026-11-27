'use strict';
// Pure parts of the B99 PR-head runner (qa/b99_pr_check.js) and of the AC2 gate in
// qa/b99_report_click_check.js: judge one run's JSON, turn a round's verdicts into
// an exit code, and build the PR-comment lines. No browser, fs or subprocess here.
// Not shared with qa/lib/grace.js (#227 is editing it); GRACE_MS is repeated on purpose.

const GRACE_MS = 500;

// Check names by prefix, as qa/b99_report_click_check.js writes them.
const PREFIX = {
  AC1: 'AC1 deal click',
  AC1b: 'AC1b ',
  AC2: 'AC2 held report',
  AC3: 'AC3 ',
  AC4: 'AC4 ',
  AC5: 'AC5 ',
  AC5b: 'AC5b ',
  AC6: 'AC6 ',
};
const KEYS = Object.keys(PREFIX);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const num = (x) => typeof x === 'number' && Number.isFinite(x);

/** The JSON from the first `{` of a run's output, or null when there is none or it doesn't parse. */
function parseRun(text) {
  text = String(text || '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const json = JSON.parse(text.slice(start));
    return isObj(json) ? json : null;
  } catch (_) {
    return null;
  }
}

/**
 * null when AC1 dealt one round and closed the report, so AC2 can run; else why AC2 can't.
 * ac1: AC1's detail ({ outcome, reason, closed, dealt, ... }) or null.
 */
function ac2Gate(ac1) {
  if (isObj(ac1) && ac1.outcome === 'dealt-one' && ac1.closed === true) return null;
  const a = isObj(ac1) ? ac1 : {};
  const pick = (k) => (a[k] === undefined ? null : a[k]);
  return {
    reason: 'AC1 did not deal',
    ac1: { outcome: pick('outcome'), reason: pick('reason'), closed: pick('closed'), dealt: pick('dealt') },
  };
}

/** The 8 checks of a run by key (a check or undefined), found by name prefix. */
function findChecks(report) {
  const checks = isObj(report) && isObj(report.checks) ? report.checks : {};
  const names = Object.keys(checks);
  const found = {};
  for (const key of KEYS) {
    const name = names.find((n) => n.startsWith(PREFIX[key]));
    if (name !== undefined && isObj(checks[name])) found[key] = checks[name];
  }
  return found;
}

const detailOf = (c) => (c && isObj(c.detail) ? c.detail : {});
const passed = (c) => !!c && c.pass === true;

/** Whether a failing check is one of the busy-VM cases that is neither a product nor a harness defect. */
function toleratedFailure(key, check) {
  const d = detailOf(check);
  if (key === 'AC1') return d.reason === 'harness-late';
  if (key === 'AC2') return d.reason === 'AC1 did not deal';
  if (['AC1b', 'AC3', 'AC5', 'AC5b'].includes(key)) {
    return d.precondition === 'press outside grace window' && d.attempts === 3;
  }
  return false;
}

/**
 * Judge one run (the check's parsed JSON, or null): 'pass', 'tolerated', 'defect' or 'fail'.
 * pass: all 8 checks pass with no errors, and AC1 carries the timing fields (#225 AC-d).
 * tolerated: no errors, AC4 and AC6 pass, and every failing check is a busy-VM case.
 * defect: AC1 no-deal or two-deals on the panel with both clocks inside the grace window (#225 Q2).
 */
function runVerdict(report) {
  if (!isObj(report)) return 'fail';
  const found = findChecks(report);
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const all = KEYS.every((k) => found[k]);
  const ac1 = detailOf(found.AC1);

  if (all && errors.length === 0 && KEYS.every((k) => passed(found[k]))) {
    const ok = num(ac1.pressMs) && num(ac1.handledMs) && num(ac1.attempts) &&
      ac1.hit === 'panel' && ac1.closed === true && ac1.dealt === 1 && ac1.outcome === 'dealt-one';
    return ok ? 'pass' : 'fail';
  }

  if (all && errors.length === 0 && passed(found.AC4) && passed(found.AC6)) {
    const failing = KEYS.filter((k) => !passed(found[k]));
    if (failing.length > 0 && failing.every((k) => toleratedFailure(k, found[k]))) return 'tolerated';
  }

  if (found.AC1 && !passed(found.AC1) && (ac1.outcome === 'no-deal' || ac1.outcome === 'two-deals') &&
      num(ac1.pressMs) && ac1.pressMs < GRACE_MS && num(ac1.handledMs) && ac1.handledMs < GRACE_MS &&
      ac1.hit === 'panel') return 'defect';

  return 'fail';
}

/** 0 when at least one run passed and every run passed or was tolerated, else 1. */
function roundExit(verdicts) {
  return verdicts.includes('pass') && verdicts.every((v) => v === 'pass' || v === 'tolerated') ? 0 : 1;
}

/** The checks of a run that failed, by key, with the tolerated ones marked. */
function failedKeys(report) {
  const found = findChecks(report);
  return KEYS.filter((k) => !passed(found[k]))
    .map((k) => (found[k] && toleratedFailure(k, found[k]) ? `${k} (tolerated)` : k));
}

/** One run's summary lines: the verdict with AC1's and AC2's detail, then any failing checks. */
function runLines(k, total, verdict, report) {
  const found = findChecks(report);
  const a1 = detailOf(found.AC1);
  const a2 = detailOf(found.AC2);
  const lines = [
    `run ${k}/${total}: ${verdict} | AC1 ${a1.outcome} ${a1.reason} ${a1.pressMs} ${a1.handledMs} ${a1.hit} ${a1.closed} ${a1.dealt} ${a1.attempts}` +
      ` | AC2 ${found.AC2 ? (found.AC2.pass === true ? 'pass' : 'fail') : 'missing'} ${a2.reason}`,
  ];
  const failed = failedKeys(report);
  const errors = isObj(report) && Array.isArray(report.errors) ? report.errors : [];
  if (failed.length || errors.length) {
    lines.push(`  run ${k}: failed ${failed.join(', ') || 'none'}${errors.length ? `; errors ${errors.length}: ${String(errors[0]).slice(0, 100)}` : ''}`);
  }
  return lines;
}

module.exports = { GRACE_MS, parseRun, ac2Gate, runVerdict, roundExit, runLines };
