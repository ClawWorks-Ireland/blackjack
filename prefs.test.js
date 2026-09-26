const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('./prefs.js');
const A = require('./a11y.js');

test('F8: defaults, and saved prefs are checked field by field', () => {
  assert.deepEqual(P.normalizePrefs(null), { speed: 'auto', volume: 0.8, table: 'green', back: 'blue' });
  assert.deepEqual(P.normalizePrefs({ speed: 'warp', volume: 7, table: 'pink', back: 'red' }),
    { speed: 'auto', volume: 1, table: 'green', back: 'red' });
  assert.equal(P.normalizePrefs({ volume: -1 }).volume, 0);
});

test('F8: auto follows prefers-reduced-motion; an explicit choice wins', () => {
  assert.equal(P.effectiveSpeed({ speed: 'auto' }, true), 'off');
  assert.equal(P.effectiveSpeed({ speed: 'auto' }, false), 'normal');
  assert.equal(P.effectiveSpeed({ speed: 'fast' }, true), 'fast');
  assert.equal(P.effectiveSpeed({ speed: 'off' }, false), 'off');
});

test('F8: animation timing per speed', () => {
  assert.deepEqual(P.timing('off'), { step: 0, land: 0 });
  assert.ok(P.timing('fast').step < P.timing('normal').step);
  assert.ok(P.timing('fast').land < P.timing('normal').land);
});

test('F8: every table colour keeps disabled buttons at 3:1 or better', () => {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const border = css.match(/--disabled-border:\s*(#[0-9a-f]{6})/i)[1];
  const felts = [...css.matchAll(/--felt(?:-dark)?:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
  assert.ok(felts.length >= 2 * P.TABLES.length, 'each table colour defines --felt and --felt-dark');
  for (const f of felts) assert.ok(A.contrastRatio(border, f) >= 3, `disabled edge on ${f}`);
  for (const t of P.TABLES.slice(1)) assert.match(css, new RegExp(`\\[data-table="${t}"\\]`));
  for (const b of P.BACKS.slice(1)) assert.match(css, new RegExp(`\\[data-back="${b}"\\]`));
});
