const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { render, sources, OUT } = require('./scripts/embed-engine.js');

test('the macOS app embeds the current engine', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), render(), 'run: node macos/scripts/embed-engine.js');
});

test('the embedded engine includes the rules engine and the agent env', () => {
  const files = sources();
  for (const f of ['engine/sidebets.js', 'engine/blackjack.js', 'engine/strategy.js', 'engine/rules.js', 'agent/env.js']) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(files.indexOf('engine/sidebets.js') < files.indexOf('engine/blackjack.js'), 'dependencies load first');
  assert.equal(files.at(-1), 'agent/env.js');
});
