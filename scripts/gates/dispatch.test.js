'use strict';
// gate.js's dispatching commands against a local GitHub API stub (#404, #425): exactly one fix round per head, and
// no "done" marker that outlives a dispatch that failed. No network, no gh.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const BOT = { login: 'github-actions[bot]' };
// The sweep reads RISK.md for a PR's tier (prFacts); template-ci renders into an empty project, so the tests bring
// their own policy directory instead of the project's.
const fs = require('fs'); const os = require('os');
const POLICY = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-policy-'));
fs.writeFileSync(path.join(POLICY, 'RISK.md'), '# Risk\n\n```risk-rules\n0 **\n```\n');
const SHA = 'a'.repeat(40);

/** A small GitHub: one PR (#7, slice #3), its comments, and dispatches that fail `failDispatch` times. */
function stub({ pr, statuses = [], failDispatch = 0, slice = { number: 3, body: 'Slice\n\nQA: qa/run.js' }, delay = 0 } = {}) {
  const st = { reqs: [], comments: { [pr.number]: [], [slice.number]: [] }, nextId: 100, failDispatch, dispatches: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; }).on('end', async () => {
      const b = body ? JSON.parse(body) : null;
      const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/repos\/o\/r/, ''); const page = u.searchParams.get('page');
      st.reqs.push({ method: req.method, url: p, body: b });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const list = (a) => send(200, page && page !== '1' ? [] : a);
      let m;
      if (req.method === 'GET' && p === '/pulls') return list([pr]);
      if (req.method === 'GET' && p === `/pulls/${pr.number}`) return send(200, pr);
      if (req.method === 'GET' && p === `/pulls/${pr.number}/files`) return list([{ filename: 'src/a.js' }]);
      if (req.method === 'GET' && p === `/pulls/${pr.number}/reviews`) return list(pr.reviews || []);
      if (req.method === 'GET' && p === `/issues/${slice.number}`) return send(200, slice);
      if (req.method === 'GET' && p === `/commits/${SHA}/statuses`) return list(statuses);
      if (req.method === 'GET' && p === `/commits/${SHA}/check-runs`) return send(200, { check_runs: page && page !== '1' ? [] : [{ name: 'ci', app: { slug: 'github-actions' }, head_sha: SHA, status: 'completed', conclusion: 'success' }] });
      if ((m = /^\/issues\/(\d+)\/comments$/.exec(p))) {
        const n = m[1]; st.comments[n] = st.comments[n] || [];
        if (req.method === 'GET') return list(st.comments[n]);
        if (delay) await new Promise((r) => setTimeout(r, delay));   // widen a race
        const c = { id: st.nextId++, user: BOT, body: b.body }; st.comments[n].push(c); return send(201, c);
      }
      if ((m = /^\/issues\/comments\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
        for (const k of Object.keys(st.comments)) st.comments[k] = st.comments[k].filter((c) => c.id !== Number(m[1]));
        return send(204);
      }
      if (/^\/issues\/\d+\/labels$/.test(p)) return send(200, []);
      if ((m = /^\/actions\/workflows\/(.+)\/dispatches$/.exec(p))) {
        if (st.failDispatch > 0) { st.failDispatch--; return send(422, { message: 'dispatch refused' }); }
        st.dispatches.push({ workflow: m[1], inputs: b.inputs }); return send(204);
      }
      if (req.method === 'POST' && /^\/statuses\//.test(p)) return send(201, {});
      if (req.method === 'PATCH' && p === `/pulls/${pr.number}`) { pr.state = b.state; return send(200, pr); }
      return send(404, { message: `not stubbed: ${req.method} ${p}` });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { st.port = server.address().port; st.server = server; resolve(st); }));
}

function gate(st, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(__dirname, 'gate.js'), ...args], {
      cwd: path.join(__dirname, '..', '..'),
      env: { PATH: process.env.PATH, GITHUB_API_URL: `http://127.0.0.1:${st.port}`, GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r', GATE_POLICY_DIR: POLICY, ...env },
    });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}
const openPr = (extra = {}) => ({ number: 7, state: 'open', draft: false, base: { ref: 'main' }, body: 'Change\n\nCloses #3', head: { sha: SHA, ref: 'agent/3-claude' }, labels: [{ name: 'impl:claude' }, { name: 'round:1' }], ...extra });
const blocked = [
  { context: 'ai-review', state: 'success', creator: BOT, updated_at: '2026-11-26T10:00:00Z' },
  { context: 'security', state: 'failure', creator: BOT, updated_at: '2026-11-26T10:01:00Z' },
];
const claims = (st) => st.comments[7].filter((c) => c.body.startsWith('<!-- fix-round:'));

test('fix-round-check --claim: review.yml and security.yml at once start exactly one round', async () => {
  const st = await stub({ pr: openPr(), statuses: blocked, delay: 40 });
  try {
    const [a, b] = await Promise.all([
      gate(st, ['fix-round-check', '--claim', '--from', 'review', '--pr', '7', '--sha', SHA, '--important', '0'], { GITHUB_RUN_ID: '11' }),
      gate(st, ['fix-round-check', '--claim', '--from', 'security', '--pr', '7'], { GITHUB_RUN_ID: '22' }),
    ]);
    const yes = [a, b].filter((r) => /dispatch=true/.test(r.out));
    assert.equal(yes.length, 1, `${a.out} | ${b.out}`);
    assert.equal(claims(st).length, 1, 'the losing claim is removed');
  } finally { st.server.close(); }
});

test('fix-round-check --claim: a re-run of the winning run takes its claim back; another run does not', async () => {
  const st = await stub({ pr: openPr(), statuses: blocked });
  try {
    assert.match((await gate(st, ['fix-round-check', '--claim', '--from', 'review', '--pr', '7', '--sha', SHA], { GITHUB_RUN_ID: '11' })).out, /dispatch=true/);
    // its dispatch failed and the job is re-run: same run id
    assert.match((await gate(st, ['fix-round-check', '--claim', '--from', 'review', '--pr', '7', '--sha', SHA], { GITHUB_RUN_ID: '11' })).out, /dispatch=true/);
    assert.match((await gate(st, ['fix-round-check', '--claim', '--from', 'security', '--pr', '7'], { GITHUB_RUN_ID: '22' })).out, /dispatch=false/);
    assert.equal(claims(st).length, 1);
    // after a failed dispatch, unclaim frees the head for the next event
    assert.equal((await gate(st, ['unclaim-fix-round', '--pr', '7'], { GITHUB_RUN_ID: '11' })).code, 0);
    assert.equal(claims(st).length, 0);
    assert.match((await gate(st, ['fix-round-check', '--claim', '--from', 'security', '--pr', '7'], { GITHUB_RUN_ID: '22' })).out, /dispatch=true/);
  } finally { st.server.close(); }
});

test('round-cap: a run that failed after its marker is finished by the retry, one comment each', async () => {
  const st = await stub({ pr: openPr({ labels: [{ name: 'round:3' }] }), failDispatch: 1 });
  try {
    const r1 = await gate(st, ['round-cap', '--pr', '7', '--from', 'security', '--round', '3']);
    assert.notEqual(r1.code, 0, 'the A2 dispatch failed');
    const r2 = await gate(st, ['round-cap', '--pr', '7', '--from', 'security', '--round', '3']);
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /finishing the escalation/);
    assert.equal(st.dispatches.filter((d) => d.workflow === 'spec-plan.yml').length, 1);
    assert.equal(st.comments[7].length, 1, 'one PR comment');
    assert.equal(st.comments[3].length, 1, 'one slice comment');
    assert.equal((await gate(st, ['round-cap', '--pr', '7', '--from', 'security', '--round', '3'])).out, 'round-cap: #7 is closed');
  } finally { st.server.close(); }
});

test('round-cap: a look-alike marker from anyone else does not suppress the explanation', async () => {
  const st = await stub({ pr: openPr({ labels: [{ name: 'round:3' }] }) });
  st.comments[7].push({ id: 1, user: { login: 'mallory' }, body: '<!-- round-cap -->' });
  try {
    assert.equal((await gate(st, ['round-cap', '--pr', '7', '--from', 'review', '--round', '3'])).code, 0);
    assert.equal(st.comments[7].filter((c) => c.user.login === BOT.login).length, 1, 'the gate posted its own comment');
  } finally { st.server.close(); }
});

const qaFailed = [
  { context: 'ai-review', state: 'success', creator: BOT, updated_at: '2026-11-26T10:00:00Z' },
  { context: 'security', state: 'success', creator: BOT, updated_at: '2026-11-26T10:01:00Z' },
  { context: 'qa', state: 'failure', creator: BOT, updated_at: '2026-11-26T10:02:00Z' },
];

test('qa-sweep: a failed round whose fix dispatch fails leaves no marker, and the next sweep starts it', async () => {
  const st = await stub({ pr: openPr(), statuses: qaFailed, failDispatch: 1 });
  try {
    const r1 = await gate(st, ['qa-sweep']);
    assert.notEqual(r1.code, 0, r1.out);
    assert.equal(st.comments[7].length, 0, 'the marker was removed with the failed dispatch');
    const r2 = await gate(st, ['qa-sweep']);
    assert.equal(r2.code, 0, r2.out);
    assert.deepEqual(st.dispatches.map((d) => d.workflow), ['implement.yml']);
    assert.equal((await gate(st, ['qa-sweep'])).code, 0);
    assert.equal(st.dispatches.length, 1, 'once per head');
  } finally { st.server.close(); }
});

test('qa-sweep: a round that never reported back is recorded as an error before its re-run', async () => {
  const old = new Date(Date.now() - 4 * 3600e3).toISOString();
  const statuses = [qaFailed[0], qaFailed[1], { context: 'qa', state: 'pending', creator: BOT, updated_at: old }];
  const st = await stub({ pr: openPr(), statuses });
  try {
    assert.equal((await gate(st, ['qa-sweep'])).code, 0);
    const qa = st.reqs.filter((q) => q.method === 'POST' && /^\/statuses\//.test(q.url)).map((q) => q.body.state);
    assert.deepEqual(qa, ['error', 'pending'], 'the lost round is recorded, then the re-run is queued');
    assert.deepEqual(st.dispatches.map((d) => d.workflow), ['qa.yml']);
  } finally { st.server.close(); }
});

test('qa-sweep: an invalid QA: line goes back to A2 once per line text', async () => {
  const st = await stub({ pr: openPr(), statuses: qaFailed, slice: { number: 3, body: 'Slice\n\nQA: check the dashboard by hand' } });
  try {
    assert.equal((await gate(st, ['qa-sweep'])).code, 0);
    assert.deepEqual(st.dispatches, [{ workflow: 'spec-plan.yml', inputs: { issue: '3', role: 'plan', replan: 'true' } }]);
    assert.equal((await gate(st, ['qa-sweep'])).code, 0);
    assert.equal(st.dispatches.length, 1, 'not sent twice for the same line');
  } finally { st.server.close(); }
});

test('owner-changes: a failed dispatch removes the marker, so the next review event retries', async () => {
  const pr = openPr({ reviews: [{ id: 5, user: { login: 'delmarolivier' }, state: 'CHANGES_REQUESTED', commit_id: SHA }] });
  const st = await stub({ pr, failDispatch: 1 });
  try {
    const owner = require('./lib.js').OWNER;
    pr.reviews[0].user.login = owner;
    assert.notEqual((await gate(st, ['owner-changes', '--pr', '7'])).code, 0);
    assert.equal(st.comments[7].length, 0);
    assert.equal((await gate(st, ['owner-changes', '--pr', '7'])).code, 0);
    assert.equal(st.dispatches.length, 1);
    assert.equal(st.comments[7].length, 1);
  } finally { st.server.close(); }
});
