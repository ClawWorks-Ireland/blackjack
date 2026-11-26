'use strict';
// gate.js slice-check against a local GitHub API stub (REQ-FLOW-9, blackjack#158 AC5). No network, no gh.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function stub(issue, comments = []) {
  const reqs = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; }).on('end', () => {
      reqs.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (issue === 500) return send(500, { message: 'boom' });
      if (req.method === 'GET' && /\/issues\/\d+$/.test(req.url.split('?')[0])) return send(200, issue);
      if (req.method === 'GET' && /\/comments/.test(req.url)) return send(200, comments);
      if (req.method === 'POST' && /\/comments$/.test(req.url)) { comments.push({ user: { login: 'github-actions[bot]' }, body: JSON.parse(body).body }); return send(201, {}); }
      if (req.method === 'POST' && /\/labels$/.test(req.url)) { issue.labels.push(...JSON.parse(body).labels.map((name) => ({ name }))); return send(200, []); }
      if (req.method === 'DELETE') return send(200, []);
      return send(404, { message: 'not stubbed' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, reqs, port: server.address().port })));
}

function run(port, ...args) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(__dirname, 'gate.js'), 'slice-check', ...args], {
      env: { PATH: process.env.PATH, GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r' },
    });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

test('slice-check --apply on a policy slice labels and comments once', async () => {
  const s = await stub({ number: 9, body: 'Part of #48\nFiles: `RISK.md`', labels: [{ name: 'status:planned' }] });
  const r = await run(s.port, '--issue', '9', '--apply');
  assert.deepEqual([r.code, r.out], [0, 'ok=false reason=policy paths=RISK.md']);
  const posts = s.reqs.filter((q) => q.method === 'POST');
  assert.ok(posts.some((q) => /labels$/.test(q.url) && q.body.labels.includes('needs-human')));
  assert.equal(posts.filter((q) => /comments$/.test(q.url) && q.body.body.includes('<!-- slice-check: policy -->')).length, 1);
  assert.ok(s.reqs.some((q) => q.method === 'DELETE' && q.url.endsWith('/labels/status%3Aplanned')));
  const n = s.reqs.length;
  const r2 = await run(s.port, '--issue', '9', '--apply');
  assert.equal(r2.code, 0);
  assert.equal(s.reqs.slice(n).filter((q) => q.method === 'POST').length, 0, 'second run writes nothing');
  s.server.close();
});

test('slice-check ok changes nothing, even with --apply', async () => {
  const s = await stub({ number: 9, body: 'Files: `engine/blackjack.js`', labels: [] });
  const r = await run(s.port, '--issue', '9', '--apply');
  assert.deepEqual([r.code, r.out], [0, 'ok=true']);
  assert.ok(s.reqs.every((q) => q.method === 'GET'));
  s.server.close();
});

test('slice-check no-files asks for a replan, not a human', async () => {
  const s = await stub({ number: 9, body: 'Part of #1\nno files line', labels: [] });
  const r = await run(s.port, '--issue', '9', '--apply');
  assert.deepEqual([r.code, r.out], [0, 'ok=false reason=no-files']);
  const lab = s.reqs.find((q) => q.method === 'POST' && /labels$/.test(q.url));
  assert.deepEqual(lab.body.labels, ['needs-replan']);
  assert.equal(s.reqs.filter((q) => q.method === 'POST' && /comments$/.test(q.url) && q.body.body.includes('<!-- slice-check: no-files -->')).length, 1);
  s.server.close();
});

test('slice-check rejects a bad issue argument and fails on an API error', async () => {
  const s = await stub(500);
  assert.notEqual((await run(s.port, '--issue', 'abc')).code, 0);
  assert.equal(s.reqs.length, 0);
  assert.notEqual((await run(s.port, '--issue', '9')).code, 0);
  s.server.close();
});

test('slice-check --apply routes team-file and eval slices to team work for A10 (REQ-OPS-18), not the owner', async () => {
  const s = await stub({ number: 9, body: 'Files: `evals/review/README.md`', labels: [{ name: 'needs-human' }] });
  const r = await run(s.port, '--issue', '9', '--apply');
  assert.deepEqual([r.code, r.out], [0, 'ok=false reason=policy paths=evals/review/README.md']);
  const lab = s.reqs.find((q) => q.method === 'POST' && /labels$/.test(q.url));
  assert.deepEqual(lab.body.labels, ['team-improve']);
  assert.ok(s.reqs.some((q) => q.method === 'DELETE' && q.url.endsWith('/labels/needs-human')));
  assert.equal(s.reqs.filter((q) => q.method === 'POST' && /comments$/.test(q.url) && q.body.body.includes('<!-- slice-check: console -->')).length, 1);
  s.server.close();
});
