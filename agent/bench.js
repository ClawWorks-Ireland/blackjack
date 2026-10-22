#!/usr/bin/env node
/**
 * Benchmark: play a policy over fixed seeds and score it, so an agent's
 * result can be read next to the baselines (agent/policies.js) on the
 * leaderboard (agent/LEADERBOARD.md). See agent/README.md.
 *
 *   node agent/bench.js                          # every baseline, standard config
 *   node agent/bench.js --policy hilo            # one baseline
 *   node agent/bench.js --policy ./my-policy.js  # a JS module {name, bet, act}
 *   node agent/bench.js --cmd "python3 agent.py" --name my-agent
 *   options: --rounds N --seeds a,b --json --record
 *
 * --cmd runs any program as the agent over JSON lines: the bench writes
 * {"type":"bet","obs":{...}} and expects {"bet":10} (or a list for several
 * spots); it writes {"type":"act","obs":{...},"hint":{...}} and expects
 * {"action":"hit"}. Observations are full (with rules and table). Strict: an
 * illegal or malformed reply stops the run with the reason.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const { BlackjackEnv } = require('./env.js');
const { BASELINES } = require('./policies.js');

const BENCH_VERSION = 1;
const STANDARD = Object.freeze({
  rules: {}, minBet: 10, maxBet: 500, bankroll: 1e7,
  seeds: ['bench-1', 'bench-2', 'bench-3', 'bench-4', 'bench-5'], rounds: 200000,
});
const BOARD = path.join(__dirname, 'leaderboard.json');

class BenchError extends Error {}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Play `policy` on every seed of `config` and return the scores. Per-round
 * results are kept as sums, so memory does not grow with the rounds.
 */
async function runBench(policy, config = STANDARD) {
  const { rules, minBet, maxBet, bankroll, seeds, rounds } = config;
  const t = { rounds: 0, initial: 0, wagered: 0, net: 0, net2: 0, init2: 0, netInit: 0, decisions: 0, agree: 0, offChart: 0 };
  const started = Date.now();
  for (const seed of seeds) {
    const env = new BlackjackEnv({ seed, rules, bankroll, minBet, maxBet });
    const first = env.observe();
    const ctx = { seed, rules: first.rules, table: first.table, observe: () => env.observe() };
    let obs = first;
    for (let r = 0; r < rounds; r++) {
      const where = `seed ${seed}, round ${r + 1}`;
      const bet = await ask(() => policy.bet(obs, ctx), where);
      let res = step(env, { action: 'deal', bet }, where);
      const initial = sum(res.obs.hands.map((h) => h.bet)); // nothing doubled or split yet
      while (!res.done) {
        const hint = env.hint();
        const action = await ask(() => policy.act(res.obs, hint, ctx), where);
        if (hint) {
          t.decisions++;
          if (action === hint.action) t.agree++;
          t.offChart += offChartCost(res.obs, hint, action);
        }
        res = step(env, action, where);
      }
      obs = res.obs;
      const o = res.obs;
      const net = res.reward;
      t.rounds++;
      t.initial += initial;
      t.wagered += sum(o.hands.map((h) => h.bet)) + o.insurance.stake + sum(o.sideBets.map((s) => s.stake));
      t.net += net;
      t.net2 += net * net;
      t.init2 += initial * initial;
      t.netInit += net * initial;
    }
  }
  return { policy: policy.name, description: policy.description || '', config, ms: Date.now() - started, ...score(t, config) };
}

/** EV given up against the best priced action, in chips. */
function offChartCost(obs, hint, action) {
  if (!hint.ev || hint.ev[action] === undefined) return 0;
  const best = Math.max(...Object.values(hint.ev));
  const stake = obs.phase === 'insurance' ? sum(obs.hands.map((h) => h.bet)) : obs.hands[obs.active].bet;
  return (best - hint.ev[action]) * stake;
}

/**
 * Scores from the sums. Return is net / initial bets, a ratio estimate whose
 * standard error comes from the residuals net - R x initial.
 */
function score(t, config) {
  const n = t.rounds;
  const unit = config.minBet;
  const mean = t.net / n;
  const sd = Math.sqrt(Math.max(0, t.net2 / n - mean * mean));
  const R = t.net / t.initial;
  const resid2 = t.net2 - 2 * R * t.netInit + R * R * t.init2;
  const seR = Math.sqrt(Math.max(0, resid2 / n)) / Math.sqrt(n) / (t.initial / n);
  return {
    rounds: n,
    initialBets: round(t.initial, 2),
    wagered: round(t.wagered, 2),
    net: round(t.net, 2),
    per100: round((mean / unit) * 100, 2),
    per100CI: round((1.96 * sd / Math.sqrt(n) / unit) * 100, 2),
    return: round(R, 5),
    returnCI: round(1.96 * seR, 5),
    avgBetUnits: round(t.initial / n / unit, 3),
    chartAgreement: t.decisions ? round(t.agree / t.decisions, 4) : null,
    offChartPct: round(t.offChart / t.initial, 5),
  };
}

function step(env, action, where) {
  try {
    return env.step(action);
  } catch (e) {
    throw new BenchError(`${where}: ${JSON.stringify(action)} refused: ${e.message}`);
  }
}

async function ask(fn, where) {
  try {
    return await fn();
  } catch (e) {
    throw new BenchError(`${where}: the policy failed: ${e.message}`);
  }
}

/** A baseline by name, or a JS module exporting {name, bet, act}. */
function loadPolicy(spec) {
  if (BASELINES[spec]) return BASELINES[spec];
  const mod = require(path.resolve(spec));
  const p = mod.default || mod;
  if (typeof p.bet !== 'function' || typeof p.act !== 'function') throw new BenchError(`${spec} must export {name, bet, act}`);
  return { name: p.name || path.basename(spec, '.js'), description: p.description || '', bet: p.bet, act: p.act };
}

/** Any program as a policy, over JSON lines on its stdin and stdout. */
function commandPolicy(cmd, name) {
  const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  let closed = null;
  lines.on('line', (line) => {
    const w = waiting.shift();
    if (w) w.resolve(line);
  });
  child.on('exit', (code) => {
    closed = `the program exited (code ${code})`;
    for (const w of waiting.splice(0)) w.reject(new Error(closed));
  });
  child.stdin.on('error', () => {}); // reported through exit
  const send = (msg) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error(closed));
    waiting.push({ resolve, reject });
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
  const reply = async (msg, key) => {
    const line = await send(msg);
    let o;
    try { o = JSON.parse(line); } catch (_) { throw new Error(`reply is not JSON: ${line.slice(0, 120)}`); }
    if (!o || !(key in o)) throw new Error(`reply needs "${key}": ${line.slice(0, 120)}`);
    return o[key];
  };
  // Agents get full observations, rules and table included, on every message.
  return {
    name, description: `External program: ${cmd}`,
    bet: (obs, ctx) => reply({ type: 'bet', obs: ctx.observe() }, 'bet'),
    act: (obs, hint, ctx) => reply({ type: 'act', obs: ctx.observe(), hint }, 'action'),
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      child.once('exit', () => resolve());
      child.stdin.end();
    }),
  };
}

const sameConfig = (c) => JSON.stringify({ ...c }) === JSON.stringify({ ...STANDARD });

function gitCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.', '../engine'], { cwd: __dirname }).toString().trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch (_) {
    return null;
  }
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date());

/** Add or replace `result` on the leaderboard file; only standard-config runs compare. */
function recordEntry(result, { file = BOARD, kind = 'agent', commit = gitCommit(), date = today() } = {}) {
  if (!sameConfig(result.config)) throw new BenchError('only standard-config runs go on the leaderboard (no --rounds or --seeds)');
  const board = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { benchVersion: BENCH_VERSION, config: STANDARD, entries: [] };
  if (board.benchVersion !== BENCH_VERSION) throw new BenchError(`leaderboard is bench version ${board.benchVersion}, this is ${BENCH_VERSION}`);
  const { config, ms, ...metrics } = result;
  const entry = { ...metrics, kind, commit, date };
  board.entries = board.entries.filter((e) => e.policy !== entry.policy).concat(entry);
  board.entries.sort((a, b) => b.per100 - a.per100);
  fs.writeFileSync(file, JSON.stringify(board, null, 2) + '\n');
  fs.writeFileSync(file.replace(/\.json$/, '.md').replace(/leaderboard\.md$/, 'LEADERBOARD.md'), renderMarkdown(board));
  return board;
}

const pct = (x, d = 2) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const signed = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

function renderMarkdown(board) {
  const c = board.config;
  const rows = board.entries.map((e, i) => `| ${i + 1} | ${e.policy}${e.kind === 'baseline' ? ' (baseline)' : ''} | `
    + `${signed(e.per100)} ± ${e.per100CI.toFixed(2)} | ${pct(e.return)} ± ${(e.returnCI * 100).toFixed(2)}% | `
    + `${e.avgBetUnits.toFixed(2)} | ${e.chartAgreement === null ? '–' : (e.chartAgreement * 100).toFixed(1) + '%'} | `
    + `${(e.offChartPct * 100).toFixed(2)}% | ${e.commit || '–'} | ${e.date} |`);
  return [
    '# Leaderboard',
    '',
    'Generated by `node agent/bench.js --record`; do not edit. Ranked by units won per 100 rounds.',
    '',
    `Standard config (bench v${board.benchVersion}): default rules (6 decks, S17, 3:2, DAS, late surrender, 75% penetration), `
      + `table $${c.minBet}–$${c.maxBet}, seeds ${c.seeds.join(', ')} × ${c.rounds.toLocaleString('en')} rounds `
      + `(${(c.seeds.length * c.rounds).toLocaleString('en')} in all).`,
    '',
    '| # | Policy | Units / 100 rounds | Return | Avg bet (units) | Chart agreement | Off-chart cost | Commit | Date |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '- **Units / 100 rounds:** net won per 100 rounds in table-minimum units, ± a 95% confidence interval.',
    '- **Return:** net ÷ initial bets, ± 95%. Basic strategy should sit near the house edge.',
    '- **Chart agreement:** decisions that matched the hint (basic strategy). A counter disagrees on purpose.',
    '- **Off-chart cost:** EV given up against the hint\'s full-shoe prices, as a share of initial bets. It ignores the count, so index plays show up as a cost here even when they gain.',
    '',
    ...board.entries.map((e) => `- **${e.policy}:** ${e.description}`),
    '',
  ].join('\n');
}

function formatResult(r) {
  return `${r.policy.padEnd(12)} ${signed(r.per100).padStart(7)} ± ${r.per100CI.toFixed(2)} units/100   `
    + `return ${pct(r.return)} ± ${(r.returnCI * 100).toFixed(2)}%   avg bet ${r.avgBetUnits.toFixed(2)}u   `
    + `chart ${r.chartAgreement === null ? '–' : (r.chartAgreement * 100).toFixed(1) + '%'}   `
    + `off-chart ${(r.offChartPct * 100).toFixed(2)}%   ${r.rounds} rounds, ${(r.ms / 1000).toFixed(1)}s`;
}

async function main(argv) {
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const config = { ...STANDARD };
  if (flag('--rounds')) config.rounds = Number(flag('--rounds'));
  if (flag('--seeds')) config.seeds = flag('--seeds').split(',');
  if (!Number.isInteger(config.rounds) || config.rounds < 1) throw new BenchError('--rounds must be a positive whole number');
  const record = argv.includes('--record');
  let policies;
  if (flag('--cmd')) policies = [commandPolicy(flag('--cmd'), flag('--name') || 'agent')];
  else if (flag('--policy')) policies = [loadPolicy(flag('--policy'))];
  else policies = Object.values(BASELINES);
  const results = [];
  for (const p of policies) {
    let r;
    try {
      r = await runBench(p, config);
    } finally {
      if (p.close) await p.close();
    }
    results.push(r);
    if (record) recordEntry(r, { kind: BASELINES[r.policy] === p ? 'baseline' : 'agent' });
  }
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) console.log(formatResult(r));
  if (record) console.log(`recorded on ${path.relative(process.cwd(), BOARD)} and LEADERBOARD.md`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`bench: ${e.message}`);
    process.exit(e instanceof BenchError ? 2 : 1);
  });
}

module.exports = { STANDARD, BENCH_VERSION, BenchError, runBench, loadPolicy, commandPolicy, recordEntry, renderMarkdown, score };
