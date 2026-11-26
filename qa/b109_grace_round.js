// Pre-merge B109 evidence for #206: one QA round on a commit, then the B109 check
// repeated on the round's snapshot, judged by qa/lib/grace-round.js.
// Usage (repo root): node qa/b109_grace_round.js <sha> [runs=3]   (runs 0-5)
// Prints the last lines for the PR comment, the verdict last.
// Exit code: 0 = pass, 1 = fail, 2 = error (qa.yml maps 0/1/other to pass/fail/error).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pagePath } = require('./lib/layout');
const { parseCheck, verdict, formatLines } = require('./lib/grace-round');

const QA = __dirname;
const REPO = path.resolve(QA, '..');
const PORT = 8765;
const BUDGET_MS = 45 * 60 * 1000;
const started = Date.now();

const [sha, runsArg] = process.argv.slice(2);
const runs = runsArg === undefined ? 3 : Number(runsArg);
if (!sha || !Number.isInteger(runs) || runs < 0 || runs > 5 || process.argv.length > 4) {
  console.error('usage: node qa/b109_grace_round.js <sha> [runs 0-5]');
  process.exit(2);
}

// Run a command, stream its output through, and resolve with { code, text }.
function run(cmd, argv, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, shell: false });
    let text = ''; // stdout and stderr, as printed
    let out = ''; // stdout alone (a check's JSON; stderr noise must not break its parse)
    child.stdout.on('data', (d) => { text += d; out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { text += d; process.stdout.write(d); });
    child.on('error', () => resolve({ code: 2, text, out }));
    child.on('close', (code) => resolve({ code: code === null ? 2 : code, text, out }));
  });
}

const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };

(async () => {
  const npm = await run('npm', ['--prefix', 'qa', 'ci'], REPO);
  if (npm.code !== 0) { console.log('verdict: error (npm ci failed)'); process.exit(2); }

  const round = await run(process.execPath, [path.join(QA, 'run-round.js'), sha], REPO);
  if (round.code >= 2) { console.log(`verdict: error (run-round exit ${round.code})`); process.exit(2); }

  // run-round.js resolves the commit-ish and names its directories by the first 7 characters of the hash.
  const resolved = await run('git', ['rev-parse', '--verify', `${sha}^{commit}`], REPO);
  if (resolved.code !== 0) { console.log('verdict: error (could not resolve the commit)'); process.exit(2); }
  const sha7 = resolved.out.trim().slice(0, 7);
  const out = path.join(QA, 'reports', sha7);
  const snap = path.join(QA, '.snapshots', sha7);
  const roundJson = parseCheck(readIf(path.join(out, 'b109_report_key_check.out')));
  let steps = [];
  try { steps = JSON.parse(readIf(path.join(out, 'summary.json'))).results || []; } catch (_) { /* no summary */ }

  const repeats = [];
  if (runs > 0) {
    const server = spawn(process.execPath, [path.join(QA, 'serve.js'), snap, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const up = await new Promise((resolve) => {
        server.stdout.on('data', (d) => { if (/serving /.test(d)) resolve(true); });
        server.on('exit', () => resolve(false));
      });
      const served = !up ? '' : await fetch(`http://127.0.0.1:${PORT}/.git-archive-done`).then((r) => r.text()).catch(() => '');
      const full = (readIf(path.join(snap, '.git-archive-done')) || '').trim();
      if (!full || served.trim() !== full) {
        console.log('verdict: error (could not serve the snapshot on 8765)');
        process.exitCode = 2;
        return;
      }
      const url = `http://127.0.0.1:${PORT}${pagePath(snap)}`;
      for (let k = 1; k <= runs; k++) {
        if (Date.now() - started > BUDGET_MS) { repeats.push({ skipped: true }); continue; }
        const r = await run(process.execPath, [path.join(QA, 'b109_report_key_check.js'), url], QA);
        fs.writeFileSync(path.join(out, `b109_repeat_${k}.out`), r.text);
        repeats.push(parseCheck(r.out));
      }
    } finally {
      // Wait for the server to exit so the port is free before anything else binds it.
      await new Promise((resolve) => {
        if (server.exitCode !== null || server.signalCode !== null) return resolve();
        server.once('exit', resolve);
        server.kill();
      });
    }
  }

  const v = verdict({ roundCode: round.code, round: roundJson, repeats, steps });
  console.log('');
  console.log(formatLines({ roundCode: round.code, round: roundJson, repeats, steps, verdict: v }).join('\n'));
  process.exitCode = v.result === 'pass' ? 0 : v.result === 'fail' ? 1 : 2;
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
