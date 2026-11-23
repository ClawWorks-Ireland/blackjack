'use strict';
// Judge the `unit tests` step from the real node --test totals.
// Totals are read only from lines that are nothing but the total (TAP "# pass 12"
// or spec "ℹ pass 12"), so a test name like "ok 3 - pass 99 hands" can't match.

const TOTAL = /^(?:# |ℹ )(tests|pass|fail|cancelled) (\d+)\s*$/gm;

function judgeUnitTests({ code, text }) {
  text = String(text || '');
  const t = {};
  for (const m of text.matchAll(TOTAL)) t[m[1]] = Number(m[2]);
  if (t.pass === undefined) {
    const last = text.trim().split('\n').slice(-3).join(' | ');
    return { ok: false, detail: ('no test summary found: ' + last).slice(0, 300) };
  }
  const fail = t.fail || 0;
  const cancelled = t.cancelled || 0;
  let detail = `${t.pass} pass, ${fail} fail`;
  if (cancelled > 0) detail += `, ${cancelled} cancelled`;
  const ok = code === 0 && t.tests !== 0 && t.pass > 0 && fail === 0 && cancelled === 0;
  return { ok, detail };
}

const EXTRA_KEYS = ['invariantViolations', 'errors', 'problems', 'consoleErrors', 'findings'];

// Judge any other step from the JSON report most checks print
// ({checks: {name: {pass}}, errors: [...]}); non-JSON output is judged by exit code.
function judgeReport({ code, text }) {
  text = String(text || '');
  let json = null;
  const start = text.indexOf('{');
  if (start !== -1) { try { json = JSON.parse(text.slice(start)); } catch (_) { /* not JSON */ } }
  if (!json || typeof json !== 'object') {
    return { ok: code === 0, detail: code === 0 ? 'exit 0' : `exit ${code}: ${text.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` };
  }
  const failed = [];
  const checks = json.checks && typeof json.checks === 'object' ? json.checks : {};
  const entries = Object.entries(checks);
  let passed = 0;
  for (const [k, v] of entries) {
    if (v && v.pass === false) failed.push(k); else passed++;
  }
  const suffixes = [];
  for (const key of EXTRA_KEYS) {
    const v = json[key];
    let n = 0;
    if (Array.isArray(v)) n = v.length;
    else if (v && typeof v === 'object') n = Object.keys(v).length;
    if (!n) continue;
    failed.push(`${key}: ${JSON.stringify(v).slice(0, 200)}`);
    suffixes.push(`${key}: ${n}`);
  }
  let detail = entries.length ? `${passed}/${entries.length} checks` : `exit ${code}`;
  if (suffixes.length) detail += ', ' + suffixes.join(', ');
  return { ok: code === 0 && !failed.length, detail, failed };
}

module.exports = { judgeUnitTests, judgeReport };
