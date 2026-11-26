// B109 on a PR head, for qa.yml's script mode: snapshot the commit, serve it, run
// qa/b109_report_key_check.js back to back and judge the runs (qa/lib/b109-runs.js).
// qa.yml runs `node <script> <sha> <args>` from the PR head without installing
// qa/ deps, so this installs them (npm ci in qa/) when playwright-core is missing.
//
// Usage (from the repo root): node qa/b109_pr_check.js <sha> [runs=10] [plumbing|strict]
// Exit code: 0 = pass, 1 = failed, 2 = harness error (as run-round.js).
// The snapshot and server are copied from run-round.js (requiring it would start a round).
// The PR comment shows only the last 40 non-empty lines, so formatLines goes last.
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pagePath, hasFile } = require('./lib/layout');
const { parseRun, runVerdict, roundExit, formatLines } = require('./lib/b109-runs');

const QA = __dirname;
const REPO = path.resolve(QA, '..');
const PORT = 8765;
const RUN_LIMIT_MS = 8 * 60 * 1000;
const START_LIMIT_MS = 45 * 60 * 1000;
const started = Date.now();

const [commit, runsArg = '10', modeArg = 'default'] = process.argv.slice(2);
const runs = /^\d+$/.test(runsArg) ? Number(runsArg) : 0;
if (!commit || runs < 1 || runs > 10 || !['default', 'plumbing', 'strict'].includes(modeArg) || process.argv.length > 5) {
  console.error('usage: node qa/b109_pr_check.js <sha> [runs=10] [plumbing|strict]');
  process.exit(2);
}
const mode = modeArg;

let server = null;
const harnessError = (msg) => { console.error(`harness error: ${msg}`); if (server) server.kill(); process.exit(2); };

let sha;
try {
  sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
} catch (e) {
  harnessError(`no such commit ${commit}`);
}
const sha7 = sha.slice(0, 7);
const snap = path.join(QA, '.snapshots', sha7);
const out = path.join(QA, 'reports', sha7);

function run(cmd, argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, shell: false });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, RUN_LIMIT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text: killed ? '' : text }); });
  });
}

(async () => {
  // Deps: qa.yml doesn't install them.
  try {
    require.resolve('playwright-core', { paths: [QA] });
  } catch (e) {
    const r = spawnSync('npm', ['ci'], { cwd: QA, shell: false, stdio: 'inherit' });
    if (r.status !== 0) harnessError('npm ci in qa/ failed');
  }

  fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(path.join(snap, '.git-archive-done'))) {
    fs.mkdirSync(snap, { recursive: true });
    const tar = execFileSync('git', ['-C', REPO, 'archive', '--format=tar', sha], { maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', snap], { input: tar });
    fs.writeFileSync(path.join(snap, '.git-archive-done'), sha + '\n');
  }

  server = spawn(process.execPath, [path.join(QA, 'serve.js'), snap, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    // A server left on the port would answer for the wrong commit: refuse to run.
    const up = await new Promise((resolve) => {
      server.stdout.on('data', (d) => { if (/serving /.test(d)) resolve(true); });
      server.on('exit', () => resolve(false));
    });
    const served = !up ? '' : await fetch(`http://127.0.0.1:${PORT}/.git-archive-done`).then((r) => r.text()).catch(() => '');
    if (served.trim() !== sha) harnessError(`could not serve ${sha7} on port ${PORT} (in use?)`);
    if (!hasFile(snap, 'report.js')) harnessError(`no report.js in ${sha7}`);
    const url = `http://127.0.0.1:${PORT}${pagePath(snap)}`;

    const verdicts = [];
    const details = [];
    for (let k = 1; k <= runs; k++) {
      if (Date.now() - started > START_LIMIT_MS) { verdicts.push('skipped'); details.push({ json: null, seconds: 0 }); continue; }
      const t0 = Date.now();
      const res = await run(process.execPath, [path.join(QA, 'b109_report_key_check.js'), url], QA);
      const seconds = Math.round((Date.now() - t0) / 1000);
      fs.writeFileSync(path.join(out, `b109_pr_run${k}.out`), res.text);
      const json = parseRun(res.text);
      verdicts.push(runVerdict(json));
      details.push({ json, seconds });
      console.log(`run ${k}/${runs} took ${seconds}s`);
    }
    const lines = formatLines({ sha7, runs, mode, verdicts, details });
    console.log(lines.join('\n'));
    process.exitCode = roundExit(verdicts, { runs, mode });
  } finally {
    server.kill();
  }
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
