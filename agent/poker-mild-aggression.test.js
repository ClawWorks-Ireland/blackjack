const test = require('node:test');
const assert = require('node:assert/strict');
const { POLICIES, MILD_POLICIES } = require('../engine/poker-bots.js');
const { match } = require('./poker-bench.js');

// 1,000 duplicate pairs = 2,000 hands per villain, five villains. Lives in its own file so
// node --test runs it in parallel with the other poker bench tests.
const VILLAINS = {
  default: POLICIES.default,
  'loose-aggressive': POLICIES['loose-aggressive'],
  maniac: POLICIES.maniac,
  'loose-aggressive-mild': MILD_POLICIES['loose-aggressive-mild'],
  'maniac-mild': MILD_POLICIES['maniac-mild'],
};

let memo;
function stats() {
  memo ||= (async () => {
    const out = {};
    for (const [key, policy] of Object.entries(VILLAINS)) {
      out[key] = (await match(POLICIES.default, { ...policy, name: key }, { hands: 1000, seed: 'mild' })).villainStats;
    }
    return out;
  })();
  return memo;
}

test('maniac-mild and loose-aggressive-mild: aggression between default and the full style (AC3)', async () => {
  const s = await stats();
  const table = Object.entries(s)
    .map(([k, v]) => `${k.padEnd(22)} aggression ${v.aggression}  vpip ${v.vpip}  pfr ${v.pfr}`)
    .join('\n');
  const msg = `\n${table}\n`;
  for (const k of Object.keys(s)) assert.notEqual(s[k].aggression, null, `${k} aggression is null (never called postflop)${msg}`);
  for (const [mild, full] of [['loose-aggressive-mild', 'loose-aggressive'], ['maniac-mild', 'maniac']]) {
    const lo = Math.min(s.default.aggression, s[full].aggression);
    const hi = Math.max(s.default.aggression, s[full].aggression);
    assert.ok(s[mild].aggression >= lo && s[mild].aggression <= hi,
      `${mild} aggression ${s[mild].aggression} not within [${lo}, ${hi}] of default and ${full}${msg}`);
  }
});
