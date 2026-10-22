const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

/** Shortcut keys bound in app.js: the SHORTCUT_GROUPS table (V is routed directly but listed there too). */
function boundKeys() {
  const app = read('app.js');
  const start = app.indexOf('const SHORTCUT_GROUPS = [');
  const end = app.indexOf('];', app.indexOf("['Settings'", start));
  const block = app.slice(start, end);
  const keys = [...block.matchAll(/\['(.{1,2})', '/g)].map((m) => m[1]);
  assert.match(app, /e\.key\.toLowerCase\(\) === 'v'/);
  return keys.includes('v') ? keys : [...keys, 'v'];
}

test('F15: no two actions share a shortcut key', () => {
  const keys = boundKeys();
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, [], `duplicated keys: ${dupes.join(', ')}`);
  assert.ok(keys.includes('j') && keys.includes('w'), 'J sits out, W opens drills');
});

test('F15: every key shown on a table button is bound, and no two buttons show the same key', () => {
  const html = read('index.html').replace(/<dialog[\s\S]*?<\/dialog>/g, ''); // dialogs have their own keys
  const shown = [...html.matchAll(/<button[^>]*>[^<]*<kbd>([^<]+)<\/kbd>/g)].map((m) => m[1].toLowerCase());
  // Enter is shared on purpose: Deal and Rebet both deal the bet in the box again.
  const letters = shown.filter((k) => k !== 'enter');
  const dupes = letters.filter((k, i) => letters.indexOf(k) !== i);
  assert.deepEqual(dupes, []);
  const bound = boundKeys();
  for (const k of letters) assert.ok(bound.includes(k), `${k} shown but not bound`);
});
