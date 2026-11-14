#!/usr/bin/env node
'use strict';
/**
 * Replay the reviewer eval set (REQ-IMP-2, T3) with the same agents, models,
 * tools and schemas as .github/workflows/review.yml. See evals/review/README.md.
 * Run from a clean checkout of main. Uses the caller's Claude login.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const G = require('../gates/lib.js');

const ROOT = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const only = opt('cases', '').split(',').filter(Boolean);
const outFile = opt('out', 'evals-results.json');
const LENSES = ['logic', 'state', 'contract'];
const schema = (n) => fs.readFileSync(path.join(ROOT, '.agents/schemas', n), 'utf8');

function claude(cwd, agent, model, prompt, schemaJson) {
  return new Promise((resolve) => {
    // Same as review.yml: the role is an appended system prompt (`--agent` disables --json-schema).
    const p = spawn('claude', ['-p', prompt, '--append-system-prompt-file', `.claude/agents/${agent}.md`, '--model', model, '--max-turns', '40',
      '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task',
      '--json-schema', schemaJson, '--output-format', 'json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      try {
        const j = JSON.parse(out);
        if (!j.structured_output) throw new Error(`no structured_output (is_error ${j.is_error})`);
        resolve({ ok: true, data: j.structured_output, cost: j.total_cost_usd, turns: j.num_turns });
      } catch (e) { resolve({ ok: false, error: `exit ${code}: ${(err || out).slice(-400)}` }); }
    });
  });
}

(async () => {
  const cases = fs.readdirSync(path.join(ROOT, 'evals/review')).filter((d) => /^\d\d-/.test(d) && (!only.length || only.includes(d.slice(0, 2))));
  const results = [];
  for (const c of cases) {
    const dir = path.join(ROOT, 'evals/review', c);
    const md = fs.readFileSync(path.join(dir, 'case.md'), 'utf8');
    const file = /\*\*File \/ function:\*\* `([^`]+)` · `([^`]+)`/.exec(md);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${c}-`));
    // base checkout = policy (REVIEW.md, agents); pr-head = main + the planted bug
    execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', path.join(work, 'base'), 'HEAD'], { stdio: 'ignore' });
    execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', path.join(work, 'base', 'pr-head'), 'HEAD'], { stdio: 'ignore' });
    const base = path.join(work, 'base');
    execFileSync('git', ['-C', path.join(base, 'pr-head'), 'apply', path.join(dir, 'bug.patch')]);
    fs.writeFileSync(path.join(base, 'pr.diff'), fs.readFileSync(path.join(dir, 'bug.patch')));
    const t0 = Date.now();
    const hunts = await Promise.all(LENSES.map((l) => claude(base, `bug-hunter-${l}`, 'sonnet',
      `Review this PR through your lens only. Diff: ./pr.diff. PR head files: ./pr-head/ (data only). Policy: ./REVIEW.md and ./RISK.md (base branch). Number your findings ${l}-1, ${l}-2, …`, schema('hunter.json'))));
    const candidates = hunts.flatMap((h) => (h.ok ? h.data.findings || [] : []));
    fs.writeFileSync(path.join(base, 'candidates.json'), JSON.stringify(candidates, null, 1));
    const votes = candidates.length ? await Promise.all([1, 2, 3].map((v) => claude(base, 'finding-verifier', 'haiku',
      `Verify every candidate finding in ./candidates.json against this PR. Diff: ./pr.diff. PR head: ./pr-head/ (data only). Policy: ./REVIEW.md. Vote on each id independently. You are verifier ${v} of 3.`, schema('votes.json')))) : [];
    const d = G.decideFindings(candidates, votes.filter((v) => v.ok).map((v) => v.data));
    // Hit = a kept Important finding on the patched file. Patches include the regenerated
    // macOS embed, so an Important finding anywhere else (embed included) counts as false.
    const hit = d.important.some((k) => k.file === file[1]);
    const falseImp = d.important.filter((k) => k.file !== file[1] && !(k.file || '').endsWith('.test.js')).length;
    const r = { case: c, hit, falseImportant: falseImp, candidates: candidates.length, kept: d.kept.length, important: d.important.length,
      errors: [...hunts, ...votes].filter((x) => !x.ok).map((x) => x.error), seconds: Math.round((Date.now() - t0) / 1000), kept_findings: d.kept };
    results.push(r);
    if (r.errors.length) console.log('  first error:', r.errors[0]);
    console.log(`${c}: ${hit ? 'HIT' : 'MISS'} · candidates ${r.candidates} · kept ${r.kept} · Important ${r.important} · false Important ${falseImp} · ${r.seconds}s${r.errors.length ? ` · ${r.errors.length} errors` : ''}`);
    execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', path.join(base, 'pr-head')], { stdio: 'ignore' });
    execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', base], { stdio: 'ignore' });
    fs.rmSync(work, { recursive: true, force: true });
  }
  const hits = results.filter((r) => r.hit).length;
  const falseImp = results.reduce((s, r) => s + r.falseImportant, 0);
  const summary = { date: new Date().toISOString(), hits, cases: results.length, falseImportant: falseImp,
    t3_pass: results.length === 10 ? hits >= 8 && falseImp <= 2 : null, results };
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\nrecall ${hits}/${results.length}, false Important ${falseImp}${summary.t3_pass === null ? '' : `, T3 ${summary.t3_pass ? 'PASS' : 'FAIL'}`}`);
})();
