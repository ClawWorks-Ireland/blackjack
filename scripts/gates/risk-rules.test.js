// Project-owned (not rendered from the template): this project's RISK.md tier rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('./lib.js');
const rules = G.parseRiskRules(fs.readFileSync(path.join(__dirname, '../../RISK.md'), 'utf8'));
const t = (p) => G.tierForPath(p, rules);

test('BlackJack RISK.md: docs and tests are Tier 0, engine Tier 1, policy and server Tier 2', () => {
  assert.equal(t('README.md'), 0);
  assert.equal(t('engine/blackjack.test.js'), 0);
  assert.equal(t('qa/reports/abc1234.md'), 0);
  assert.equal(t('engine/blackjack.js'), 1);
  assert.equal(t('web/app.js'), 1);
  assert.equal(t('some/new/file.txt'), 1);
  for (const p of ['CLAUDE.md', 'REVIEW.md', 'RISK.md', '.agents/SPEC.md', '.claude/agents/release-manager.md',
    '.github/workflows/merge.yml', 'scripts/rollback', 'scripts/gates/lib.js', 'server/server.js', 'server/README.md',
    'package.json', 'evals/review/01-ace/case.md', '.mcp.json', 'macos/scripts/ci.sh']) assert.equal(t(p), 2, p);
});

test('BlackJack RISK.md: a PR touching REVIEW.md is floored at Tier 2 (T5)', () => {
  assert.equal(G.riskFloor(['REVIEW.md', 'docs/notes.md'], rules).floor, 2);
});

test('BlackJack runs at autonomy Level 4 with unprotected autonomy accepted (Delmar 2026-11-19; changing it needs a deliberate, visible test change)', () => {
  const md = fs.readFileSync(path.join(__dirname, '../../.agents/PROJECT.md'), 'utf8');
  assert.equal(G.parseAutonomyLevel(md), 4);
  assert.match(md, /^accept_unprotected_autonomy:\s*true/m);
});
