// Which jobs may run on which VM label (spec REQ-CFG-3; A7 sec-1 on blackjack#81). vm-sandbox runs PR or
// repo code as root, so only the listed jobs go there, and each holds a read-only token. Every other VM
// job (App keys, contents/statuses/issues/pull-requests/actions write) goes to vm-keyed, which never
// checks out the PR head. Reads the project's workflows (run from scripts/gates).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', '.github', 'workflows');
const SANDBOX_JOBS = ['actionlint.actionlint', 'ci.ci', 'qa.qa', 'release.rollback-test', 'release.verify', 'review.repro'];   // sorted

// A small line-based reader for our own workflow files: per job, its runs-on line, its permissions (the
// job's own, else the workflow's) and whether it checks out the PR head.
function jobs() {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml'))) {
    const wf = f.slice(0, -4);
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
    let inJobs = false, inTopPerms = false, topPerms = '', job = null;
    for (const l of lines) {
      if (/^permissions:/.test(l)) { inTopPerms = true; topPerms = l.replace(/^permissions:\s*/, ''); continue; }
      if (inTopPerms && /^  \S/.test(l)) { topPerms += ' ' + l.trim(); continue; }
      if (/^\S/.test(l)) inTopPerms = false;
      if (/^jobs:/.test(l)) { inJobs = true; continue; }
      const m = inJobs && /^  ([a-z0-9_-]+):/.exec(l);
      if (m) { job = { id: `${wf}.${m[1]}`, runsOn: '', perms: null, prHead: false, topPerms }; out.push(job); continue; }
      if (!job) continue;
      if (/^    runs-on:/.test(l)) job.runsOn = l;
      if (/^    permissions:/.test(l)) job.perms = l.replace(/^    permissions:\s*/, '');
      if (/path: pr-head|ref: "\$\{\{ env\.SHA \}\}"|pull_request\.head\.sha/.test(l)) job.prHead = true;
    }
  }
  return out;
}

test('vm-sandbox runs only the PR-code jobs, each with a read-only token (A7 sec-1 on blackjack#81)', () => {
  const all = jobs();
  const onSandbox = all.filter((j) => /vm-sandbox/.test(j.runsOn)).map((j) => j.id).sort();
  assert.deepEqual(onSandbox, SANDBOX_JOBS);
  for (const j of all.filter((x) => /vm-sandbox/.test(x.runsOn))) {
    const perms = j.perms !== null ? j.perms : j.topPerms;
    assert.ok(!/write/.test(perms), `${j.id} runs PR or repo code on vm-sandbox but has write permissions: ${perms}`);
  }
});

test('vm-keyed jobs never check out the PR head', () => {
  for (const j of jobs().filter((x) => /vm-keyed/.test(x.runsOn))) assert.equal(j.prHead, false, `${j.id} checks out the PR head on vm-keyed`);
});

test('no job runs on a GitHub-hosted runner', () => {
  for (const j of jobs()) assert.ok(!/ubuntu-|windows-|macos-/.test(j.runsOn), `${j.id}: ${j.runsOn.trim()}`);
});

// blackjack#108: GitHub keeps one pending run per concurrency group, so a label-triggered workflow must
// not put routing and non-routing label events for one issue in a shared group, and a label event that
// routes nowhere must not take a vm-keyed runner (every issue label used to queue one per workflow).
test('label-triggered key-VM route jobs skip labels that route nowhere; spec-plan groups by role (blackjack#108)', () => {
  const sp = fs.readFileSync(path.join(DIR, 'spec-plan.yml'), 'utf8');
  const group = /^  group: (.*)$/m.exec(sp)[1];
  for (const label of ['needs-spec', 'needs-replan', 'spec-approved']) assert.match(group, new RegExp(`'${label}'`));
  assert.match(group, /inputs\.role/);
  assert.match(group, /github\.run_id/, 'a label that routes nowhere gets a group of its own');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.yml'))) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (!/^  issues:\n    types: \[[^\]]*\blabeled\b/m.test(src)) continue;
    const route = /^  route:\n((?: {4}.*\n)+)/m.exec(src);
    if (!route || !/runs-on: \[self-hosted, vm-keyed\]/.test(route[1])) continue;
    assert.match(route[1], /^    if: /m, `${f}: route job needs an if: on the label`);
  }
});
