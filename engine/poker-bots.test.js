'use strict';
// Golden test (#10 slice 1): pins how the five poker bot policies behave today,
// so a later refactor of engine/poker-bots.js can show it changed nothing.
// Constants generated on main at c112a24.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { PokerTable } = require('./poker.js');
const { POLICIES, STYLES, MILD_POLICIES, MILD_STYLES, rngFor } = require('./poker-bots.js');

const BB = 10;
const STACK = 100 * BB;
const HANDS = 200;

// Every decision (action:amount) plus the running rng draw count, hashed.
function play(style) {
  const log = [];
  let draws = 0;
  for (let h = 0; h < HANDS; h++) {
    const deal = `golden-${style}-${h}`;
    const t = new PokerTable({ seed: deal, smallBlind: BB / 2, bigBlind: BB, seats: 2 });
    const players = h % 2 ? [['Regular', POLICIES.default], ['Opponent', POLICIES[style]]] : [['Opponent', POLICIES[style]], ['Regular', POLICIES.default]];
    players.forEach(([name], i) => t.sit({ id: name, name, kind: 'bot' }, STACK, i));
    const rngs = players.map(([name]) => {
      const r = rngFor(`${deal}:${name}`);
      return () => { draws++; return r(); };
    });
    t.startHand();
    while (t.inPlay) {
      const s = t.toAct;
      let d = players[s][1].decide(t.view(s), rngs[s]);
      if (!t.legal(s).some((l) => l.action === d.action) && d.action !== 'allin') d = { action: t.legal(s).some((l) => l.action === 'check') ? 'check' : 'fold' };
      log.push(`${d.action}:${d.amount === undefined ? '' : d.amount}@${draws}`);
      t.act(s, d.action, d.amount);
    }
  }
  return { hash: crypto.createHash('sha256').update(log.join('|')).digest('hex'), draws };
}

const GOLDEN = {
  default: { hash: '7fd07f76fb591a95f8f377c0ac15474cc6005e5f681b26778f739d4b6a28d89a', draws: 1243198 },
  'tight-passive': { hash: '60d57d5010573ab538f4f3023d3f9cbd2bb11a447232f93a230cfc005fa0c302', draws: 998984 },
  'loose-aggressive': { hash: '89a8715b6c636ca6fa59a6ee2a086363c7c9cf715671a3ff81050c2d9a96015f', draws: 1517833 },
  'calling-station': { hash: 'ec1d646d69230d1df748d899255ff469003c98af2114f437f845b4ae9ee66c66', draws: 1632345 },
  maniac: { hash: '3cb9f79cd02bb7a0ad4b1ac5f43b2a8256984e7c3db70fa5ba90623dbfdc7c0d', draws: 1357267 },
};

test('styles use numeric params only', () => {
  for (const [name, st] of Object.entries(STYLES)) {
    for (const [k, v] of Object.entries(st.params)) {
      assert.ok(typeof v === 'number' && Number.isFinite(v), `${name}.${k} is a finite number`);
    }
  }
  assert.strictEqual(STYLES.maniac.params.maniacRate, 0.75);
  assert.strictEqual(STYLES['calling-station'].params.stationCalls, 1);
});

for (const style of Object.keys(GOLDEN)) {
  test(`poker bots golden: ${style} v default, ${HANDS} hands`, () => {
    assert.deepStrictEqual(play(style), GOLDEN[style]);
  });
}

const FULL = ['tight-passive', 'loose-aggressive', 'calling-station', 'maniac'];

test('mild styles: every param lies exactly halfway between default and the full style', () => {
  for (const name of FULL) {
    const mild = MILD_STYLES[name + '-mild'];
    assert.ok(mild, name + '-mild exists');
    const base = STYLES.default.params;
    const full = STYLES[name].params;
    for (const k of new Set([...Object.keys(base), ...Object.keys(full)])) {
      const a = base[k] || 0;
      const b = full[k] || 0;
      const m = mild.params[k];
      if (a === b) assert.strictEqual(m, a, name + '-mild.' + k);
      else assert.ok(m > Math.min(a, b) && m < Math.max(a, b), name + '-mild.' + k + ' strictly between');
      assert.ok(Math.abs(m - (a + b) / 2) <= 1e-12, name + '-mild.' + k + ' is the midpoint');
    }
  }
  assert.ok(Math.abs(MILD_STYLES['maniac-mild'].params.maniacRate - 0.375) < 1e-12);
  assert.ok(Math.abs(MILD_STYLES['calling-station-mild'].params.stationCalls - 0.5) < 1e-12);
  assert.ok(Math.abs(MILD_STYLES['tight-passive-mild'].params.foldToRaise - 0.3) < 1e-12);
  assert.strictEqual(MILD_STYLES['maniac-mild'].description, 'A milder maniac: halfway between default and maniac.');
});

test('mild styles are not live-table styles', () => {
  assert.deepStrictEqual(Object.keys(POLICIES), ['default', 'tight-passive', 'loose-aggressive', 'calling-station', 'maniac']);
  assert.deepStrictEqual(Object.keys(MILD_POLICIES), FULL.map((n) => n + '-mild'));
});

test('mild policies decide legally', () => {
  for (const [style, policy] of Object.entries(MILD_POLICIES)) {
    for (let h = 0; h < 50; h++) {
      const deal = 'mild-' + style + '-' + h;
      const t = new PokerTable({ seed: deal, smallBlind: BB / 2, bigBlind: BB, seats: 2 });
      const players = h % 2 ? [['Regular', POLICIES.default], ['Opponent', policy]] : [['Opponent', policy], ['Regular', POLICIES.default]];
      players.forEach(([name], i) => t.sit({ id: name, name, kind: 'bot' }, STACK, i));
      const rngs = players.map(([name]) => rngFor(deal + ':' + name));
      t.startHand();
      while (t.inPlay) {
        const s = t.toAct;
        const d = players[s][1].decide(t.view(s), rngs[s]);
        assert.ok(d.action === 'allin' || t.legal(s).some((l) => l.action === d.action), style + ': ' + d.action + ' is legal');
        t.act(s, d.action, d.amount);
      }
    }
  }
});
