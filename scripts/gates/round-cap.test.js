'use strict';
// gate.js round-cap against a local GitHub API stub (REQ-FLOW-1, SecurityClaw#44). No network, no gh.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function stub(pr) {
  const reqs = []; const comments = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; }).on('end', () => {
      const b = body ? JSON.parse(body) : null;
      reqs.push({ method: req.method, url: req.url.split('?')[0], body: b });
      const u = req.url.split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.method === 'GET' && u === `/repos/o/r/pulls/${pr.number}`) return send(200, pr);
      if (req.method === 'GET' && u === `/repos/o/r/issues/${pr.number}/comments`) return send(200, comments);
      if (req.method === 'POST' && u === `/repos/o/r/issues/${pr.number}/comments`) { comments.push({ body: b.body }); return send(201, {}); }
      if (req.method === 'POST' && /\/comments$|\/labels$/.test(u)) return send(201, {});
      if (req.method === 'POST' && u.endsWith('/actions/workflows/spec-plan.yml/dispatches')) return send(204);
      if (req.method === 'PATCH' && u === `/repos/o/r/pulls/${pr.number}`) { pr.state = b.state; return send(200, pr); }
      return send(404, { message: 'not stubbed' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, reqs, port: server.address().port })));
}

function run(port, ...args) {
  return new Promise((resolve) => {
    const p = spawn('node', [path.join(__dirname, 'gate.js'), 'round-cap', ...args], {
      env: { PATH: process.env.PATH, GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r' },
    });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

test('round-cap at round 3: closes the PR, sends the slice to A2 by dispatch, once', async () => {
  const s = await stub({ number: 44, state: 'open', body: 'Closes #12', labels: [{ name: 'round:1' }, { name: 'round:3' }] });
  try {
    const r = await run(s.port, '--pr', '44', '--from', 'review');
    assert.equal(r.code, 0, r.out);
    const w = s.reqs.filter((q) => q.method !== 'GET');
    assert.ok(w.some((q) => q.url === '/repos/o/r/issues/12/labels' && q.body.labels.includes('needs-replan')));
    const d = w.find((q) => q.url.endsWith('/spec-plan.yml/dispatches'));
    assert.deepEqual(d.body, { ref: 'main', inputs: { issue: '12', role: 'plan', replan: 'true' } });
    assert.ok(w.some((q) => q.method === 'PATCH' && q.body.state === 'closed'));
    assert.ok(w.every((q) => !JSON.stringify(q.body).includes('needs-human')), 'no ask of the owner');
    const n = s.reqs.length;
    s.reqs.length = 0;
    const r2 = await run(s.port, '--pr', '44', '--from', 'review');
    assert.equal(r2.code, 0);
    assert.ok(s.reqs.every((q) => q.method === 'GET'), `second run writes nothing (${n} before)`);
  } finally { s.server.close(); }
});

test('round-cap under the cap writes nothing', async () => {
  const s = await stub({ number: 7, state: 'open', body: 'Closes #3', labels: [{ name: 'round:2' }] });
  try {
    const r = await run(s.port, '--pr', '7', '--from', 'security');
    assert.equal(r.code, 0, r.out);
    assert.ok(s.reqs.every((q) => q.method === 'GET'));
  } finally { s.server.close(); }
});
