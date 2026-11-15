// local-implement.sh path handling (incident #16): relative prompt/log paths
// must resolve against the caller's directory, not the worktree it cd's into.
// `claude` and `curl` are stubbed on PATH, so no model or Ollama is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, 'local-implement.sh');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-impl-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'wt'));
  // Stub claude: print the -p prompt and the cwd it ran in.
  fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = -p ] && { printf "PROMPT=%s\\n" "$2"; shift; }; shift; done\nprintf "CWD=%s\\n" "$PWD"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const run = (args) => spawnSync('bash', [script, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir },
  });
  return { dir, run };
}

test('local-implement.sh reads a relative prompt and writes a relative log outside the worktree', () => {
  const { dir, run } = sandbox();
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'Slice #15: add percent()');
  const r = run(['wt', 'prompt.txt', 'impl.log']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'wt', 'impl.log')), 'log must not land in the worktree');
  const log = fs.readFileSync(path.join(dir, 'impl.log'), 'utf8');
  assert.match(log, /PROMPT=Slice #15: add percent\(\)/);
  assert.ok(log.includes(`CWD=${fs.realpathSync(path.join(dir, 'wt'))}\n`), 'claude runs inside the worktree');
});

test('local-implement.sh accepts absolute paths too', () => {
  const { dir, run } = sandbox();
  fs.writeFileSync(path.join(dir, 'prompt.txt'), 'abs prompt');
  const r = run([path.join(dir, 'wt'), path.join(dir, 'prompt.txt'), path.join(dir, 'impl.log')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'impl.log'), 'utf8'), /PROMPT=abs prompt/);
});

test('local-implement.sh fails loudly instead of running the model on a missing prompt', () => {
  const { dir, run } = sandbox();
  const r = run(['wt', 'nope.txt', 'impl.log']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Prompt file missing/);
  assert.ok(!fs.existsSync(path.join(dir, 'impl.log')), 'claude must not run');
});
