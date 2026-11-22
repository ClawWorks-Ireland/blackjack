const test = require('node:test');
const assert = require('node:assert/strict');
const { vpipTable } = require('./poker-vpip.js');

const STYLES = [
  'default', 'tight-passive', 'loose-aggressive', 'calling-station', 'maniac',
  'tight-passive-mild', 'loose-aggressive-mild', 'calling-station-mild', 'maniac-mild',
];

// Computed once per file so later assertions (#112) share the same table.
let memo;
function table() {
  memo ||= (() => {
    const t0 = Date.now();
    const rows = vpipTable({ pairs: 1000, seed: 'mild' });
    return { rows, ms: Date.now() - t0 };
  })();
  return memo;
}

test('VPIP table, 1,000 pairs, seed mild (#10 AC3 record)', (t) => {
  const { rows, ms } = table();
  assert.deepEqual(rows.map((r) => r.style), STYLES);
  for (const r of rows) assert.equal(r.hands, 2000, `${r.style} hands`);
  for (const r of rows) {
    t.diagnostic(`${r.style.padEnd(24)} VPIP ${r.pct.toFixed(1).padStart(5)}%  (${r.vpipHands}/${r.hands})  ${r.ms} ms`);
  }
  // AC3 "mild is between default and full" is reported, not asserted: this slice
  // is measure-only (#151). The assertion belongs to #112 in this same file.
  const pct = Object.fromEntries(rows.map((r) => [r.style, r.pct]));
  for (const base of ['tight-passive', 'loose-aggressive', 'calling-station', 'maniac']) {
    const lo = Math.min(pct.default, pct[base]);
    const hi = Math.max(pct.default, pct[base]);
    const mild = pct[`${base}-mild`];
    t.diagnostic(`${base}-mild: default ${pct.default.toFixed(1)}%, full ${pct[base].toFixed(1)}%, mild ${mild.toFixed(1)}%, between: ${mild >= lo && mild <= hi ? 'yes' : 'no'}`);
  }
  t.diagnostic(`total wall time ${ms} ms (1000 pairs, seed mild)`);
});
