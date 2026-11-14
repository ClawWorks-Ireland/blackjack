const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const guard = path.join(__dirname, 'policy-guard.js');
const run = (ev) => spawnSync('node', [guard], { input: JSON.stringify({ cwd: '/w', ...ev }), env: { ...process.env, CLAUDE_PROJECT_DIR: '/w' } }).status;

test('policy-guard blocks implementer edits to policy files', () => {
  for (const p of ['/w/CLAUDE.md', '/w/REVIEW.md', '/w/RISK.md', '/w/.github/workflows/merge.yml', '/w/.claude/agents/x.md', '/w/scripts/gates/lib.js', '/w/evals/review/01/case.md']) {
    assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: p } }), 2, p);
  }
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/elsewhere/x.js' } }), 2);
});

test('policy-guard allows ordinary edits and test runs', () => {
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: '/w/engine/blackjack.js' } }), 0);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/w/engine/new.test.js' } }), 0);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), 0);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "feat: x (#3)"' } }), 0);
});

test('policy-guard blocks shell writes to policy paths, pushes and network', () => {
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: "echo x > REVIEW.md" } }), 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: "sed -i s/a/b/ .github/workflows/ci.yml" } }), 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }), 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } }), 2);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 3' } }), 2);
});
