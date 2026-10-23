const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hub } = require('../server/hub.js');
const { Leaderboard } = require('../server/leaderboard.js');
const { createServer } = require('../server/server.js');
const { LocalPlayer, pickMove } = require('./local-player.js');
const { FeedbackQueue, fingerprint, pending, mark } = require('./feedback.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'local-player-'));

/** A stand-in for the local-models script: `status`, a move, or JSON notes; `busy` makes it exit 4. */
function fakeModel(dir, { busy = false } = {}) {
  const file = path.join(dir, 'fake-llm.js');
  fs.writeFileSync(file, `
    const args = process.argv.slice(2);
    if (${busy}) process.exit(4);
    if (args[0] === 'status') { console.log(JSON.stringify({ ready: true, model: 'fake:1b' })); process.exit(0); }
    let input = ''; process.stdin.on('data', (d) => input += d).on('end', () => {
      if (args.includes('--json')) console.log(JSON.stringify({ items: [{ title: 'Round header hard to read', detail: 'too long', evidence: input.split('\\n')[0].slice(0, 40) }] }));
      else console.log(/Legal moves: .*stand/.test(input) ? 'Stand.' : 'decline insurance');
    });`);
  return `${process.execPath} ${file}`;
}

async function server() {
  const hub = new Hub({ leaderboard: new Leaderboard({ minRounds: 5 }), timing: { betSeconds: 2, turnSeconds: 2, botDelayMs: 1, nextRoundMs: 10 } });
  const s = createServer({ hub });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, hub, close: () => { hub.close(); s.closeAllConnections(); return new Promise((r) => s.close(r)); } };
}

test('local player: picks the legal move the model names, or nothing', () => {
  assert.equal(pickMove('Stand.', ['hit', 'stand']), 'stand');
  assert.equal(pickMove('I would DOUBLE here', ['hit', 'stand', 'double']), 'double');
  assert.equal(pickMove('no insurance', ['insurance', 'decline_insurance']), 'decline_insurance');
  assert.equal(pickMove('decline_insurance', ['insurance', 'decline_insurance']), 'decline_insurance');
  assert.equal(pickMove('insurance', ['insurance', 'decline_insurance']), 'insurance');
  assert.equal(pickMove('split', ['hit', 'stand']), null, 'not legal now');
  assert.equal(pickMove('hmm', ['hit', 'stand']), null);
});

test('local player: plays rounds with the model, reflects, and queues findings once', async () => {
  const dir = tmp();
  const s = await server();
  try {
    const queue = new FeedbackQueue({ file: path.join(dir, 'q.jsonl') });
    const p = new LocalPlayer({ url: s.url, table: s.hub.create({ name: 'T', bots: 1 }).id, name: 'Fake model', llm: fakeModel(dir), rounds: 4, reflectEvery: 2, roundPauseMs: 0, queue, log: () => {} });
    const stats = await p.run();
    assert.equal(stats.rounds, 4);
    assert.ok(stats.modelMoves > 0);
    assert.equal(stats.reflections, 2);
    assert.equal(stats.findings, 1, 'the same note twice is queued once');
    const rows = fs.readFileSync(path.join(dir, 'q.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].source, 'model');
    assert.equal(rows[0].agent, 'Fake model');
    assert.equal(rows[0].model, 'fake:1b');
    assert.equal(rows[0].fingerprint, fingerprint('Round header hard to read'));
  } finally { await s.close(); }
});

test('local player: sits out while the model is busy', async () => {
  const dir = tmp();
  const s = await server();
  try {
    const t = s.hub.create({ name: 'Busy' });
    const p = new LocalPlayer({ url: s.url, table: t.id, name: 'Busy model', llm: fakeModel(dir, { busy: true }), rounds: 1, roundPauseMs: 0, busyPauseMs: 50, queue: new FeedbackQueue({ file: path.join(dir, 'q.jsonl') }), log: () => {} });
    const run = p.run();
    await new Promise((r) => setTimeout(r, 600));
    p.stopped = true;
    await Promise.race([run, new Promise((r) => setTimeout(r, 3000))]);
    assert.ok(p.stats.busy >= 1);
    assert.equal(p.stats.moves, 0);
    assert.equal(t.table.round, 0, 'no round was dealt for a busy model');
  } finally { await s.close(); }
});

test('feedback: pending groups unfiled findings; mark files or dismisses them', () => {
  const dir = tmp();
  const queue = path.join(dir, 'q.jsonl');
  const filed = path.join(dir, 'filed.json');
  const q = new FeedbackQueue({ file: queue, withinMs: 0 });
  q.add({ source: 'harness', kind: 'bug', title: 'Server refused bet: Server error', detail: 'x', agent: 'A' });
  q.add({ source: 'harness', kind: 'bug', title: 'Server refused bet: server error', detail: 'y', agent: 'B' });
  q.add({ source: 'model', kind: 'feedback', title: 'Totals unclear', detail: 'z', agent: 'A' });
  let groups = pending({ queue, filed });
  assert.deepEqual(groups.map((g) => [g.kind, g.count]), [['bug', 2], ['feedback', 1]]);
  mark([groups[0].fingerprint], 'CLA-999', { filed });
  groups = pending({ queue, filed });
  assert.deepEqual(groups.map((g) => g.title), ['Totals unclear']);
  const again = new FeedbackQueue({ file: queue });
  assert.equal(again.add({ source: 'model', kind: 'feedback', title: 'Totals unclear!', detail: 'same' }), false, 'deduplicated across restarts');
});
