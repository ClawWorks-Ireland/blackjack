'use strict';
/**
 * Pure helpers for qa/b109_grace_round.js (no Playwright, fs or subprocess):
 * read the B109 check's JSON, judge a round plus its repeats, format the PR comment.
 * Only B109 is judged. B99 and the other round steps are printed, not judged.
 */

const GRACE_CHECKS = [
  ['AC1', 'AC1 Enter in grace window deals one round'],
  ['AC3', 'AC3 x in grace window deals one round at twice the last bet'],
  ['AC7', 'AC7 held Enter deals exactly one round'],
];
const OTHER_CHECKS = [
  ['AC2', 'AC2 held report reopens for the same shoe between rounds'],
  ['AC4', 'AC4 x with Rebet x2 disabled keeps the report open and deals nothing'],
  ['AC5', 'AC5 Enter after grace window deals nothing'],
  ['AC6', 'AC6 session report has no grace window'],
];
const TOTAL_CHECKS = 7;
const MAX_LINES = 25;

/** JSON from the first `{` on (like judgeReport); null when there is none. */
function parseCheck(text) {
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

const checksOf = (json) => (json && json.checks && typeof json.checks === 'object' ? json.checks : {});
const errorsOf = (json) => (json && Array.isArray(json.errors) ? json.errors : []);

/** AC1, AC3, AC7 rows by exact check name; an absent check is { pass: false, reason: 'missing' }. */
function graceRows(json) {
  const checks = checksOf(json);
  return GRACE_CHECKS.map(([ac, name]) => {
    const c = checks[name];
    if (!c) return { ac, pass: false, outcome: null, reason: 'missing', pressMs: null, handledMs: null, attempts: null };
    const d = c.detail || {};
    return {
      ac,
      pass: c.pass === true,
      outcome: d.outcome ?? null,
      reason: d.reason ?? null,
      pressMs: d.pressMs ?? null,
      handledMs: d.handledMs ?? null,
      attempts: d.attempts ?? null,
    };
  });
}

const passedCount = (json) => Object.values(checksOf(json)).filter((c) => c && c.pass !== false).length;

/**
 * { roundCode, round, repeats } -> { result: 'pass' | 'fail' | 'error', reasons[] }.
 * round: parsed B109 JSON of the round (or null). repeats[k]: parsed JSON, null (no
 * output) or { skipped: true }.
 */
function verdict({ roundCode, round, repeats = [] }) {
  if (roundCode >= 2) return { result: 'error', reasons: [`round exit ${roundCode}`] };
  if (!round) return { result: 'error', reasons: ['no round B109 output'] };
  const reasons = [];
  const checks = checksOf(round);
  const failedChecks = Object.entries(checks).filter(([, c]) => c && c.pass === false).map(([k]) => k.split(' ')[0]);
  if (failedChecks.length) reasons.push(`round B109 failed: ${failedChecks.join(' ')}`);
  else if (Object.keys(checks).length !== TOTAL_CHECKS) reasons.push(`round B109 has ${Object.keys(checks).length}/${TOTAL_CHECKS} checks`);
  if (errorsOf(round).length) reasons.push(`round B109 errors: ${errorsOf(round).length}`);
  repeats.forEach((rep, i) => {
    const k = i + 1;
    if (rep && rep.skipped) return;
    if (!rep) { reasons.push(`repeat ${k}: no output`); return; }
    if (errorsOf(rep).length) reasons.push(`repeat ${k}: errors ${errorsOf(rep).length}`);
    for (const row of graceRows(rep)) {
      if (!row.pass && row.reason !== 'harness-late') reasons.push(`repeat ${k} ${row.ac}: ${row.reason || row.outcome || 'failed'}`);
    }
  });
  return { result: reasons.length ? 'fail' : 'pass', reasons };
}

const ms = (n) => (typeof n === 'number' ? String(Math.round(n)) : '-');
const rowLine = (label, r) => `${label} ${r.ac} ${r.pass ? 'pass' : 'FAIL'} ${r.outcome || '-'} ${r.reason || '-'} ${ms(r.pressMs)} ${ms(r.handledMs)} ${r.attempts ?? '-'}`;

function runLines(label, json) {
  if (json && json.skipped) return [`${label} skipped (time)`];
  if (!json) return [`${label} no output`];
  return graceRows(json).map((r) => rowLine(label, r));
}

/** At most MAX_LINES lines for the PR comment, the verdict last. */
function formatLines({ round, repeats = [], steps = [], verdict: v }) {
  const lines = [];
  const failedSteps = steps.filter((s) => s.ok === false).map((s) => s.name);
  lines.push(failedSteps.length ? `round failed: ${failedSteps.join(', ')}` : 'round passed');
  if (round) {
    const others = OTHER_CHECKS.map(([ac, name]) => {
      const c = checksOf(round)[name];
      return `${ac} ${c ? (c.pass === false ? 'FAIL' : 'pass') : 'missing'}`;
    });
    lines.push(`round B109: ${passedCount(round)}/${TOTAL_CHECKS} (${others.join(', ')})`);
  } else {
    lines.push('round B109: no output');
  }
  const b99 = steps.find((s) => /^B99/.test(s.name));
  lines.push(`round B99: ${b99 ? (b99.skipped ? `skipped (${b99.skipped})` : b99.detail) : 'not run'}`);
  lines.push(...runLines('round', round));
  repeats.forEach((rep, i) => lines.push(...runLines(`repeat ${i + 1}`, rep)));
  const final = `verdict: ${v.result} (${v.reasons.length ? v.reasons.join('; ') : 'ok'})`;
  const body = lines.slice(0, MAX_LINES - 1);
  return [...body, final];
}

module.exports = { parseCheck, graceRows, verdict, formatLines, GRACE_CHECKS, OTHER_CHECKS };
