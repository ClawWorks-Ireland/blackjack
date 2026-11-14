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

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(input); } catch { process.exit(0); }
  const root = (process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd()).replace(/\/$/, '');
  const t = ev.tool_input || {};
  const rel = (p) => String(p || '').replace(`${root}/`, '').replace(/^\.\//, '');
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
