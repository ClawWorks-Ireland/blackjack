'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { POLICIES } = require('../engine/poker-bots.js');
const { match } = require('./poker-bench.js');
const { preflopVpip, vpipTable } = require('./poker-vpip.js');

test('preflop VPIP helper agrees with match()', async () => {
  const r = await match(POLICIES.default, { ...POLICIES.maniac, name: 'maniac' }, { hands: 25, seed: 'mild' });
  const v = preflopVpip(POLICIES.maniac, 'maniac', { pairs: 25, seed: 'mild' });
  assert.strictEqual(r.villainStats.vpip, Math.round((100 * v.vpipHands) / v.hands));
});

test('preflopVpip counts every hand', () => {
  const v = preflopVpip(POLICIES.maniac, 'maniac', { pairs: 25, seed: 'mild' });
  assert.strictEqual(v.hands, 50);
  assert.ok(v.vpipHands >= 0 && v.vpipHands <= v.hands);
});

test('preflopVpip replays', () => {
  const a = preflopVpip(POLICIES['calling-station'], 'calling-station', { pairs: 10, seed: 'mild' });
  const b = preflopVpip(POLICIES['calling-station'], 'calling-station', { pairs: 10, seed: 'mild' });
  assert.strictEqual(a.vpipHands, b.vpipHands);
});

test('vpipTable lists the nine styles', () => {
  assert.deepStrictEqual(vpipTable({ pairs: 5 }).map((r) => r.style), [
    'default', 'tight-passive', 'loose-aggressive', 'calling-station', 'maniac',
    'tight-passive-mild', 'loose-aggressive-mild', 'calling-station-mild', 'maniac-mild',
  ]);
});
