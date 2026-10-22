const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STANDARD, BenchError, runBench, loadPolicy, commandPolicy, recordEntry } = require('./bench.js');
const { BASELINES, toCard, hiLo } = require('./policies.js');

const small = (rounds = 1500) => ({ ...STANDARD, seeds: ['t-1', 't-2'], rounds });
const strip = ({ ms, ...r }) => r;

test('bench: same policy and config give the same scores', async () => {
  for (const name of Object.keys(BASELINES)) {
    const a = await runBench(BASELINES[name], small(500));
    const b = await runBench(BASELINES[name], small(500));
    assert.deepEqual(strip(a), strip(b), name);
    assert.equal(a.rounds, 1000);
  }
});

test('bench: baselines rank as expected and basic follows the chart', async () => {
  const r = {};
  for (const name of Object.keys(BASELINES)) r[name] = await runBench(BASELINES[name], small(3000));
  assert.equal(r.basic.chartAgreement, 1);
  assert.ok(r.random.return < r['never-bust'].return && r['never-bust'].return < r.basic.return);
  assert.ok(r.basic.offChartPct < 0.002, `basic off-chart ${r.basic.offChartPct}`);
  assert.equal(r.basic.avgBetUnits, 1);
  assert.ok(r.hilo.avgBetUnits > 1.2, 'the counter spreads its bets');
  assert.ok(r.hilo.chartAgreement < 1 && r.hilo.chartAgreement > 0.9, 'the counter deviates, but rarely');
  for (const x of Object.values(r)) assert.ok(x.per100CI > 0 && x.returnCI > 0);
});

test('policies: Hi-Lo count from the seen cards; cards convert for the engine', () => {
  const seen = { 2: 3, 3: 1, 4: 0, 5: 2, 6: 1, 7: 4, 8: 0, 9: 2, T: 1, J: 0, Q: 1, K: 0, A: 2 };
  assert.deepEqual(hiLo({ seen, cardsLeft: 104 }), { running: 3, trueCount: 1.5 });
  assert.deepEqual(toCard('Td'), { rank: '10', suit: '♦' });
  assert.deepEqual(toCard('As'), { rank: 'A', suit: '♠' });
});

test('bench: an external program plays over JSON lines like the same JS policy', async () => {
  const agent = path.join(__dirname, 'examples', 'bench-agent.js');
  const p = commandPolicy(`"${process.execPath}" "${agent}"`, 'example');
  const ext = await runBench(p, small(300));
  await p.close();
  const js = await runBench(BASELINES.basic, small(300));
  assert.deepEqual({ ...strip(ext), policy: 'basic', description: '' }, { ...strip(js), description: '' });
});

test('bench: an illegal move or a broken policy stops the run with the reason', async () => {
  const bad = { name: 'bad', bet: () => 10, act: () => 'split' };
  await assert.rejects(runBench(bad, small(50)), (e) => e instanceof BenchError && /round \d+: "split" refused/.test(e.message));
  const broken = { name: 'broken', bet: () => { throw new Error('boom'); }, act: () => 'stand' };
  await assert.rejects(runBench(broken, small(5)), /the policy failed: boom/);
  const tooBig = { name: 'big', bet: () => 501, act: () => 'stand' };
  await assert.rejects(runBench(tooBig, small(5)), BenchError);
  assert.throws(() => loadPolicy(path.join(__dirname, 'env.js')), /must export/);
  assert.equal(loadPolicy('hilo'), BASELINES.hilo);
});

test('leaderboard: records standard runs only, one entry per policy, ranked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  const file = path.join(dir, 'leaderboard.json');
  const fake = (policy, per100) => ({ policy, description: `${policy} test`, config: { ...STANDARD }, ms: 1, rounds: 10, initialBets: 100,
    wagered: 110, net: per100, per100, per100CI: 1, return: per100 / 100, returnCI: 0.01, avgBetUnits: 1, chartAgreement: 1, offChartPct: 0 });
  const opts = { file, commit: 'abc1234', date: '2026-10-22' };
  recordEntry(fake('a', -1), { ...opts, kind: 'baseline' });
  recordEntry(fake('b', 3), opts);
  const board = recordEntry(fake('a', 5), { ...opts, kind: 'baseline' });
  assert.deepEqual(board.entries.map((e) => [e.policy, e.per100]), [['a', 5], ['b', 3]]);
  assert.equal(board.entries[0].config, undefined);
  const md = fs.readFileSync(path.join(dir, 'LEADERBOARD.md'), 'utf8');
  assert.match(md, /\| 1 \| a \(baseline\) \| \+5\.00 ± 1\.00 \|/);
  assert.match(md, /\| 2 \| b \| \+3\.00/);
  assert.throws(() => recordEntry({ ...fake('c', 0), config: small() }, opts), /standard-config/);
});
