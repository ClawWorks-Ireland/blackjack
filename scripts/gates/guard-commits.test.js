// Incident #12: main-guard must judge only commits that landed on main itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('./lib.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-commits-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', env }).trim();
  let n = 0;
  const commit = (msg) => { fs.writeFileSync(path.join(dir, `f${n++}.txt`), msg); git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  return { dir, git, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('incident #12: a --no-ff merge push selects only the merge commit, not the branch commits', () => {
  const r = repo();
  try {
    const before = r.commit('base');
    r.git('checkout', '-q', '-b', 'setup');
    // the branch's commits already carry main-guard.yml, as in PR #11
    fs.mkdirSync(path.join(r.dir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, '.github/workflows/main-guard.yml'), 'name: main-guard\n');
    const branch = [r.commit('b1'), r.commit('b2'), r.commit('b3')];
    r.git('checkout', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #11', 'setup');
    const after = r.git('rev-parse', 'HEAD');
    const got = G.guardCommits(r.git, { before, after });
    assert.deepEqual(got, [after]);
    for (const b of branch) assert.ok(!got.includes(b));
    // sanity: plain rev-list (the old selection) would have flagged the branch commits too
    assert.equal(r.git('rev-list', `${before}..${after}`).split('\n').length, 4);
    // sweep mode, same history
    assert.deepEqual(G.guardCommits(r.git, { since: '1970-01-02T00:00:00Z', ref: 'main' }), [before, after]);
  } finally { r.done(); }
});

test('incident #12: plain direct pushes on main are still all selected, oldest first', () => {
  const r = repo();
  try {
    const before = r.commit('base');
    const pushed = [r.commit('d1'), r.commit('d2')];
    const after = pushed[1];
    assert.deepEqual(G.guardCommits(r.git, { before, after }), pushed);
    assert.deepEqual(G.guardCommits(r.git, { since: '1970-01-02T00:00:00Z', ref: 'main' }), [before, ...pushed]);
  } finally { r.done(); }
});

test('incident #12: a merge followed by a direct push selects the merge and the push', () => {
  const r = repo();
  try {
    const before = r.commit('base');
    r.git('checkout', '-q', '-b', 'f');
    r.commit('f1');
    r.git('checkout', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'merge f', 'f');
    const merge = r.git('rev-parse', 'HEAD');
    const direct = r.commit('direct');
    assert.deepEqual(G.guardCommits(r.git, { before, after: direct }), [merge, direct]);
  } finally { r.done(); }
});

test('main-guard is armed only after the commit that adds the marker (re-bootstrap)', () => {
  const r = repo();
  try {
    r.commit('base');
    fs.mkdirSync(path.join(r.dir, '.github'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, G.GUARD_MARKER), 'armed\n');
    const arming = r.commit('add marker');   // its parent lacks the marker → exempt
    const next = r.commit('later push');     // its parent has it → judged
    const has = (rev, p) => { try { r.git('cat-file', '-e', `${rev}:${p}`); return true; } catch { return false; } };
    assert.equal(G.guardActiveFor(has, arming), false);
    assert.equal(G.guardActiveFor(has, next), true);
    assert.equal(G.GUARD_MARKER, '.github/main-guard.armed');
  } finally { r.done(); }
});
