// One QA round, one command: snapshot a commit, run the whole battery, write a
// compact summary. Runs anywhere Node 18+ and Chrome are installed (macOS or
// Windows) and needs no model: an agent or person only reads the summary.
//
// Usage (from the repo root):  node qa/run-round.js [commit=HEAD] [--rounds 80]
// Ports: nothing else may be on 8765 (the snapshot server) or 8766 (port + 1, the live server for 'poker lobby UI').
// Output: qa/reports/<sha7>/summary.json, plus one line per check on stdout.
// Exit code: 0 = everything passed, 1 = a check failed, 2 = harness error.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pagePath, hasFile } = require('./lib/layout');

const QA = __dirname;
const REPO = path.resolve(QA, '..');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const commit = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--rounds') || 'HEAD';
const rounds = flag('--rounds', '80');
const port = Number(flag('--port', '8765'));

const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
const sha = git('rev-parse', '--verify', `${commit}^{commit}`);
const sha7 = sha.slice(0, 7);
const snap = path.join(QA, '.snapshots', sha7);
const out = path.join(QA, 'reports', sha7);
fs.mkdirSync(out, { recursive: true });

// Test the commit, never the working tree.
if (!fs.existsSync(path.join(snap, '.git-archive-done'))) {
  fs.mkdirSync(snap, { recursive: true });
  const tar = execFileSync('git', ['-C', REPO, 'archive', '--format=tar', sha], { maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', snap], { input: tar });
  fs.writeFileSync(path.join(snap, '.git-archive-done'), sha + '\n');
}

const url = `http://127.0.0.1:${port}${pagePath(snap)}`;
const has = (f) => hasFile(snap, f);
// [name, script, args, needs] — a step runs only when the snapshot has its module.
const STEPS = [
  ['unit tests', null, [], null],
  ['engine fuzz', 'engine_fuzz.js', [snap], null],
  ['strategy diff', 'strategy_diff.js', [snap], 'strategy.js'],
  ['side bets', 'side_check.js', [snap], 'sidebets.js'],
  ['spots fuzz', 'spots_fuzz.js', [snap], null],
  ['F12-F14 engine', 'f12_f14_check.js', [snap], 'ev.js'],
  ['F15-F17 engine', 'f15_f17_check.js', [snap], 'bankroll.js'],
  ['F18-F20 engine', 'f18_f20_check.js', [snap], 'report.js'],
  ['UI playtest', 'ui_playtest.js', [snap, out, rounds], null],
  ['feature checks', 'feature_checks.js', [snap, out], null],
  ['F5/F8/F9 UI', 'f5_f8_f9_check.js', [snap, out], null],
  ['F7/F10 UI', 'f7_f10_check.js', [snap, out], 'stats.js'],
  ['F11 PWA', 'f11_check.js', [snap, out], 'sw.js'],
  ['F12-F14 UI', 'f12_f14_ui_check.js', [snap, out], 'ev.js'],
  ['focus', 'focus_check.js', [snap], 'a11y.js'],
  ['B14 drill timer', 'b14_ui_check.js', [url], 'drill.js'],
  ['count drill', 'count_drill_check.js', [url], 'drill.js'],
  ['bet ramp', 'ramp_check.js', [snap], 'counting.js'],
  ['F18-F20 UI', 'f18_f20_ui_check.js', [url, out], 'report.js'],
  ['B16 report timing', 'b16_ui_check.js', [url], 'report.js'],
  ['B99 report click', 'b99_report_click_check.js', [url], 'report.js'],
  ['poker lobby UI', 'poker_lobby_check.js', [snap, out, String(port + 1)], 'lobby.html'],
];

function run(cmd, argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, shell: false });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
}

// Pull pass/fail out of a step's output: node --test totals, or the JSON
// report most checks print ({checks: {name: {pass}}, errors: [...]}).
function judge(name, { code, text }) {
  if (name === 'unit tests') {
    return require('./lib/judge').judgeUnitTests({ code, text });
  }
  let json = null;
  const start = text.indexOf('{');
  if (start !== -1) { try { json = JSON.parse(text.slice(start)); } catch (_) { /* not JSON */ } }
  if (!json) return { ok: code === 0, detail: code === 0 ? 'exit 0' : `exit ${code}: ${text.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` };
  const failed = [];
  if (json.checks) for (const [k, v] of Object.entries(json.checks)) if (v && v.pass === false) failed.push(k);
  for (const key of ['failed', 'invariantViolations', 'errors', 'problems', 'consoleErrors', 'findings']) {
    const v = json[key];
    if (Array.isArray(v) && v.length && key !== 'failed') failed.push(`${key}: ${JSON.stringify(v).slice(0, 200)}`);
    if (v && !Array.isArray(v) && typeof v === 'object' && Object.keys(v).length) failed.push(`${key}: ${JSON.stringify(v).slice(0, 200)}`);
  }
  const total = json.checks ? Object.keys(json.checks).length : null;
  return { ok: code === 0 && !failed.length, detail: total ? `${total - failed.length}/${total} checks` : `exit ${code}`, failed };
}

(async () => {
  const server = spawn(process.execPath, [path.join(QA, 'serve.js'), snap, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  // A server left on the port (an earlier round) would answer for the wrong commit: refuse to run (T7).
  const up = await new Promise((resolve) => {
    server.stdout.on('data', (d) => { if (/serving /.test(d)) resolve(true); });
    server.on('exit', () => resolve(false));
  });
  const served = !up ? '' : await fetch(`http://127.0.0.1:${port}/.git-archive-done`).then((r) => r.text()).catch(() => '');
  if (served.trim() !== sha) {
    console.error(`harness error: could not serve ${sha7} on port ${port} (in use?); stop that server or pass --port`);
    server.kill();
    process.exit(2);
  }
  const results = [];
  try {
    for (const [name, script, argv, needs] of STEPS) {
      if (needs && !has(needs)) { results.push({ name, skipped: `no ${needs} in this commit` }); continue; }
      const started = Date.now();
      const res = script
        ? await run(process.execPath, [path.join(QA, script), ...argv], QA)
        : await run(process.execPath, ['--test', '--test-reporter=tap'], snap); // finds engine/, web/ and agent/ tests too
      fs.writeFileSync(path.join(out, `${script ? path.basename(script, '.js') : 'unit_tests'}.out`), res.text);
      const verdict = judge(name, res);
      results.push({ name, ...verdict, seconds: Math.round((Date.now() - started) / 1000) });
      console.log(`${verdict.ok ? 'PASS' : 'FAIL'}  ${name}  (${verdict.detail})`);
      for (const f of verdict.failed || []) console.log(`      - ${f}`);
    }
  } finally {
    server.kill();
  }
  const failed = results.filter((r) => r.ok === false);
  const summary = { commit: sha, ranAt: new Date().toISOString(), host: process.platform, passed: results.filter((r) => r.ok).length, failed: failed.length, results };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(`\n${sha7}: ${summary.passed} passed, ${summary.failed} failed -> ${path.relative(REPO, path.join(out, 'summary.json'))}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
