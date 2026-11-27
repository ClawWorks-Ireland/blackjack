'use strict';
/**
 * Grace-window key checks. No Playwright dependency: the page work is an
 * injected attempt(n) function (like reach.js), so npm test covers the logic.
 */

const GRACE_MS = 500; // matches REPORT_GRACE_MS in web/app.js
const MAX_ATTEMPTS = 3;

/**
 * One key press -> 'not-open' | 'late' | 'dealt-one' | 'no-deal' | 'two-deals'.
 * Checked in that order, so a late press is 'late' whatever was dealt.
 */
function classify({ open, pressMs, handledMs, dealt }, graceMs = GRACE_MS) {
  if (open === false || pressMs === null || pressMs === undefined) return 'not-open';
  if (pressMs >= graceMs) return 'late';
  if (typeof handledMs === 'number' && handledMs >= graceMs) return 'late';
  if (dealt === 1) return 'dealt-one';
  if (dealt === 0) return 'no-deal';
  if (dealt >= 2) return 'two-deals';
  return 'not-open';
}

/**
 * attempt(n) (async) -> { open, pressMs, dealt, extraOk = true, detail }, or
 *   { ok: false, detail } when no report could be reached.
 * Late presses are retried up to maxAttempts; anything else stops the loop.
 * Returns { pass, reached, outcome, reason, pressMs, attempts, history[, detail] }.
 * reached is false when no report was reached; reason is then detail.reason, else 'no-report'.
 */
async function runGraceCheck(attempt, opts = {}) {
  const { maxAttempts = MAX_ATTEMPTS, graceMs = GRACE_MS } = opts;
  const history = [];
  let last = null;
  let outcome = null;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    last = await attempt(attempts);
    if (last && last.ok === false) {
      const reason = last.detail && last.detail.reason ? last.detail.reason : 'no-report';
      return { pass: false, reached: false, outcome: null, reason, pressMs: null, attempts, history, detail: last.detail };
    }
    outcome = classify(last, graceMs);
    // handledMs is left out of an entry when the attempt had none (older callers).
    history.push(typeof last.handledMs === 'number'
      ? { pressMs: last.pressMs ?? null, handledMs: last.handledMs, outcome }
      : { pressMs: last.pressMs ?? null, outcome });
    if (outcome !== 'late') break;
  }
  const { extraOk = true, detail } = last;
  const pass = outcome === 'dealt-one' && extraOk !== false;
  let reason = null;
  if (!pass) {
    if (outcome === 'late') reason = 'harness-late';
    else if (outcome === 'dealt-one') reason = 'extra';
    else reason = outcome;
  }
  return { pass, reached: true, outcome, reason, pressMs: last.pressMs ?? null, handledMs: last.handledMs ?? null, attempts, history, detail };
}

module.exports = { runGraceCheck, classify, GRACE_MS, MAX_ATTEMPTS };
