// B99 on a PR head, for qa.yml's script mode: snapshot the commit, serve it, run
// qa/b99_report_click_check.js back to back and judge each run (qa/lib/b99-runs.js).
// qa.yml runs `node <script> <sha> <args>` from the PR head without installing
// qa/ deps, so this installs them (npm ci in qa/) when playwright-core is missing.
//
// Usage (from the repo root): node qa/b99_pr_check.js <sha> [runs=3]   (runs 1 to 5)
// Exit code: 0 = pass, 1 = failed, 2 = harness error (as run-round.js).
// The snapshot and server are copied from run-round.js (requiring it would start a round).
// The PR comment shows only the last 40 non-empty lines, so the summary goes last.
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pagePath, hasFile } = require('./lib/layout');
const { parseRun, runVerdict, roundExit, runLines } = require('./lib/b99-runs');

const QA = __dirname;
const REPO = path.resolve(QA, '..');
const PORT = 8765;

const [commit, runsArg = '3'] = process.argv.slice(2);
const runs = /^\d+$/.test(runsArg) ? Number(runsArg) : 0;
if (!commit || runs < 1 || runs > 5 || process.argv.length > 4) {
  console.error('usage: node qa/b99_pr_check.js <sha> [runs=3]   (runs 1 to 5)');
  process.exit(2);
}

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
    const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
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
    const lines = [];
    for (let k = 1; k <= runs; k++) {
      const res = await run(process.execPath, [path.join(QA, 'b99_report_click_check.js'), url], QA);
      fs.writeFileSync(path.join(out, `b99_run${k}.out`), res.text);
      const json = parseRun(res.text);
      const verdict = runVerdict(json);
      verdicts.push(verdict);
      lines.push(...runLines(k, runs, verdict, json));
      if (verdict === 'defect') lines.push(`GAME DEFECT: in-window on both clocks, see b99_run${k}.out; A0: post it on #225 for A1`);
    }
    const count = (v) => verdicts.filter((x) => x === v).length;
    const code = roundExit(verdicts);
    lines.push(`B99 PR check ${sha7}: ${count('pass')} pass, ${count('tolerated')} tolerated, ${count('defect')} defect, ${count('fail')} fail -> exit ${code}`);
    console.log(lines.join('\n'));
    process.exitCode = code;
  } finally {
    server.kill();
  }
})().catch((e) => { console.error('HARNESS ERROR', e); if (server) server.kill(); process.exit(2); });
