#!/usr/bin/env node
'use strict';
/**
 * PreToolUse hook for implementer sessions (spec §8.1 .claude/settings.json,
 * "block policy-file edits from implementer sessions"). Exit 2 blocks the tool
 * call and shows the reason to the model. A deterministic diff check in
 * implement.yml backs this up: a slice whose diff touches a policy path is
 * rejected even if a tool slipped past this hook.
 */
const POLICY = [/^CLAUDE\.md$/, /^REVIEW\.md$/, /^RISK\.md$/, /^CODEOWNERS$/, /^\.agents\//, /^\.claude\//, /^\.github\//,
  /^scripts\/gates\//, /^scripts\/rollback$/, /^scripts\/agents\//, /^evals\//];
const isPolicy = (p) => POLICY.some((re) => re.test(p));
// Runner credentials, Claude config and process memory are never readable by a model (REQ-CFG-3).
// Defence in depth: test runs on the code runners execute repo code that could read these anyway,
// which is why no App key ever lives on those runners. Paths only: `this.credentials` in code is fine.
const B = String.raw`(?:^|[\s"'=:(])`;   // start of a path token
const E = String.raw`(?![\w.-])`;        // end of a path component
const SECRET = new RegExp([
  String.raw`actions-runner[^/\s]*\/\.(?:credentials(?:_rsaparams)?|runner|env)${E}`,
  String.raw`(?:${B}|\/)\.credentials(?:_rsaparams)?${E}`,
  String.raw`(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+)\/\.claude(?:\/|${E})`,
  String.raw`${B}\/proc\/`,
].join('|'));
// A glob over a hidden name (`~/a*/.cred*`, `.?unner`) would slip past SECRET once the shell expands it.
const HIDDEN_GLOB = /(?:^|[\s"'=/])\.[^\s/]*[*?[]/;
// Claude jobs (GUARD_MODE=job): gh flags that read a local file into a comment or API call.
const GH_FILE_ARG = /\bgh\b[^|;&]*?(?:\s(?:--body-file|--input|-F|--field|--template)(?:[\s=]|$)|=@|\s@[~/.$])/;
const JOB = process.env.GUARD_MODE === 'job';

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(input); } catch { process.exit(0); }
  const root = (process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd()).replace(/\/$/, '');
  const t = ev.tool_input || {};
  const rel = (p) => String(p || '').replace(`${root}/`, '').replace(/^\.\//, '');
  if (['Read', 'Grep', 'Glob'].includes(ev.tool_name)) {
    // Grep's `pattern` is a search string, not a path; only paths are checked.
    const p = ev.tool_name === 'Glob' ? `${t.path || ''} ${t.pattern || ''}` : `${t.file_path || ''} ${t.path || ''}`;
    if (SECRET.test(p)) block('runner credentials and Claude config are not readable by models');
  }
  if (ev.tool_name === 'Bash') {
    const c = String(t.command || '');
    if (SECRET.test(c) || HIDDEN_GLOB.test(c)) block('runner credentials and Claude config are not readable by models (hidden-file globs are refused too)');
    if (JOB && GH_FILE_ARG.test(c)) block('gh flags that read local files (--body-file, -F, --input, @file) are not allowed; pass text with --body');
  }
  if (JOB) process.exit(0);   // Claude jobs: the rules below are the implementer's
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(ev.tool_name)) {
    const p = rel(t.file_path || t.notebook_path);
    const abs = String(t.file_path || t.notebook_path || '');
    if (isPolicy(p) || (abs.startsWith('/') && !abs.startsWith(`${root}/`))) {
      block(`${p} is a policy file or outside the worktree; implementers can't edit it. Stop with RESULT: blocked if the slice needs it.`);
    }
  }
  if (ev.tool_name === 'Bash') {
    const c = String(t.command || '');
    const touches = c.match(/(?:>|>>|tee|sed\s+-i|mv|cp|rm|chmod|truncate)\s+[^|;&]*?(CLAUDE\.md|REVIEW\.md|RISK\.md|CODEOWNERS|\.agents\/|\.claude\/|\.github\/|scripts\/gates|scripts\/rollback|scripts\/agents|evals\/)/);
    if (touches) block(`shell command would modify a policy path (${touches[1]})`);
    if (/\bgit\s+(push|remote|config)\b|\bgh\s|curl\s|wget\s|\bsudo\b/.test(c)) block('network, credential and push commands are not allowed for implementers');
  }
  process.exit(0);
});
function block(reason) { process.stderr.write(`policy-guard: ${reason}\n`); process.exit(2); }
