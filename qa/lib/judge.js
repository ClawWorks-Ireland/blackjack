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

module.exports = { judgeUnitTests };
