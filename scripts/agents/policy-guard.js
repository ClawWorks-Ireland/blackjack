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
// which is why no App key ever lives on those runners. The check works on resolved paths, not on
// raw text: words are split like a shell does, `cd` is followed, `~`/`$HOME` are expanded and
// `..` is resolved, so `../../proc/self/environ` and `/tmp/../proc` are caught while code text
// such as `this.credentials` or a quoted regex `'.*foo'` is not.
const fs = require('fs');
const path = require('path');
const os = require('os');
const JOB = process.env.GUARD_MODE === 'job';
const HOME = process.env.HOME || os.homedir();
const RUNNER_FILES = ['.credentials', '.credentials_rsaparams', '.runner', '.env'];
const LIT_DOLLAR = '\u0000';   // a $ inside single quotes: literal text, never an expansion
const EXPANSION = /\$[A-Za-z_{(]/;

/** Remove heredoc bodies (`<<'EOF' … EOF`): they are text fed to stdin, not paths. */
const stripHeredocs = (cmd) => cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<HEREDOC');

/** Split a shell command into simple commands of words: [{ text, glob }], glob = unquoted * ? [ {. */
function shellWords(cmd) {
  const cmds = []; let words = []; let w = null; let q = null; let glob = false;
  const end = () => { if (w !== null) words.push({ text: w, glob }); w = null; glob = false; };
  const sep = () => { end(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < cmd.length) w += cmd[++i]; else w += (q === "'" && c === '$') ? LIT_DOLLAR : c; continue; }
    if (c === "'" || c === '"') { q = c; w = w ?? ''; continue; }
    if (c === '\\' && i + 1 < cmd.length) { w = (w ?? '') + cmd[++i]; continue; }
    if (/\s/.test(c)) { if (c === '\n') sep(); else end(); continue; }
    if (';&|()<>'.includes(c)) { sep(); continue; }
    if ('*?[{'.includes(c)) glob = true;
    w = (w ?? '') + c;
  }
  sep();
  return cmds;
}
/** Shell glob segment → RegExp: * ? [..] and {a,b} (anything unparseable matches everything: refuse). */
function globRe(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '.*'; else if (c === '?') re += '.';
    else if (c === '[') { const j = seg.indexOf(']', i + 1); if (j < 0) return /.*/; re += `[${seg.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = j; }
    else if (c === '{') { const j = seg.indexOf('}', i + 1); if (j < 0) return /.*/; re += `(?:${seg.slice(i + 1, j).split(',').map((x) => x.replace(/[.+^$()|\\*?]/g, '\\$&')).join('|')})`; i = j; }
    else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`); } catch { return /.*/; }
}
/** Does a path segment name `name`? A glob that starts with * ? or [ never matches a leading dot (as in the shell). */
const segIs = (seg, name, glob) => {
  if (!glob) return seg === name;
  if (name.startsWith('.') && '*?['.includes(seg[0])) return false;
  return globRe(seg).test(name);
};
/** Expand ~, ~user, $HOME, $PWD, $OLDPWD at the start of a word. Returns null if another $ remains. */
function expand(p, cwd, oldpwd) {
  const out = p.replace(/^~(?=\/|$)/, HOME).replace(/^~([a-z_][\w-]*)(?=\/|$)/, '/home/$1')
    .replace(/^\$\{?HOME\}?(?=\/|$)/, HOME).replace(/^\$\{?PWD\}?(?=\/|$)/, cwd).replace(/^\$\{?OLDPWD\}?(?=\/|$)/, oldpwd || cwd);
  return EXPANSION.test(out) ? null : out;
}
/**
 * Resolve like the kernel: follow symlinks segment by segment, so `/dev/fd/..` lands in /proc.
 * Returns [lexical, physical]; physical is null if a `..` follows a symlink we couldn't resolve.
 */
function resolveBoth(abs) {
  const lexical = path.resolve(abs);
  let real = '/'; let broken = false;
  for (const seg of abs.split('/').filter(Boolean)) {
    if (seg === '.') continue;
    if (seg === '..') { if (broken) return [lexical, null]; real = path.dirname(real); continue; }
    const next = path.join(real, seg);
    let st = null; try { st = fs.lstatSync(next); } catch { /* doesn't exist: lexical from here */ }
    if (st && st.isSymbolicLink()) { try { real = fs.realpathSync(next); } catch { broken = true; real = next; } } else real = next;
  }
  return [lexical, real];
}
/** True if the path (maybe a glob) could name a runner file, Claude config or /proc. */
function secretPath(raw, cwd, glob = false, root = cwd, oldpwd = cwd) {
  if (!raw) return false;
  const e = expand(String(raw), cwd, oldpwd);
  // A variable we can't expand could be anything (`${X:-/proc}`, `$X/.cl*`): only a lone `$NAME` is allowed,
  // as an argument that is not a path (`gh pr view $PR`). A7 sec-1 on BlackJack #32, round 3.
  if (e === null) return !/^\$\{?[A-Za-z_]\w*\}?$/.test(String(raw));
  const [lexical, real] = resolveBoth(path.isAbsolute(e) ? e : `${cwd}/${e}`);   // unnormalised: `..` must follow symlinks
  if (real === null) return true;   // a `..` after an unresolvable symlink (/dev/stdin/..): refuse
  return [lexical, real].some((abs) => {
    const segs = abs.split('/').filter(Boolean);
    const is = (seg, name) => segIs(seg, name, glob);
    if (segs.length && is(segs[0], 'proc')) return true;
    if (segs[0] === 'dev' && segs.length > 2 && /^(?:fd|std)/.test(segs[1])) return true;
    // Runner files: in a runner directory, or anywhere outside the project (a project fixture named .runner is fine).
    const outside = !(`${abs}/`).startsWith(`${root}/`);
    const inRunnerDir = (i) => i > 0 && /^actions-runner/.test(segs[i - 1]);
    // .env only in a runner directory (projects have their own .env files); the others also anywhere outside the project.
    if (segs.some((s, i) => RUNNER_FILES.some((n) => is(s, n) && (inRunnerDir(i) || (outside && n !== '.env'))))) return true;
    // ~/.claude of any user (the project's own .claude/ is under the workspace, not a home root)
    if (segs[0] === 'home' && segs.length >= 3 && is(segs[2], '.claude')) return true;
    return segs[0] === 'root' && segs.length >= 2 && is(segs[1], '.claude');
  });
}
/** Every word of a Bash command that is (or ends in, after `=`) a path, checked with `cd` followed. */
function bashReadsSecret(cmd, cwd0, root) {
  let cwd = cwd0; let oldpwd = cwd0;
  // Claude jobs' `$(cat <<'EOF' … EOF)` body (allowed by hidesArgs) is text, not a path.
  const text = stripHeredocs(cmd).replace(/\$\(\s*cat\s+<<HEREDOC\s*\)/g, JOB ? 'HEREDOC_TEXT' : '$&');
  for (const words of shellWords(text)) {
    if (words[0] && words[0].text === 'cd') {
      const to = expand(words[1] ? words[1].text : '~', cwd, oldpwd);
      if (to === null) return true;   // cd into an unknown variable: we'd lose track of the cwd
      oldpwd = cwd; cwd = path.resolve(cwd, to);
      if (secretPath(cwd, cwd, false, root, oldpwd)) return true;
      continue;
    }
    for (const { text, glob } of words) {
      for (const cand of [text, text.includes('=') ? text.slice(text.indexOf('=') + 1) : null]) {
        if (cand && /[/~.$]/.test(cand) && secretPath(cand, cwd, glob, root, oldpwd)) return true;
      }
    }
  }
  return false;
}
/** Command or process substitution hides the real argument from this check. */
function hidesArgs(cmd) {
  const c = stripHeredocs(cmd);
  if (/`|<\(|>\(/.test(c)) return true;
  // Claude jobs pass long text as --body "$(cat <<'EOF' … EOF)": a heredoc into cat reads no file.
  const subs = c.match(/\$\([^)]*/g) || [];
  return subs.some((x) => !(JOB && /^\$\(\s*cat\s+<<HEREDOC\s*$/.test(x.trim())));
}
/** A gh command in the line uses a flag that reads a local file. */
function ghReadsFile(cmd) {
  return shellWords(stripHeredocs(cmd)).some((ws) => ws.some((w, i) => {
    if (w.text !== 'gh') return false;
    const sub = ws[i + 1] ? ws[i + 1].text : '';
    const rest = ws.slice(i + 2).map((x) => x.text);
    return rest.some((a, j) => {
      if (/^--(?:body-file|input)(?:=|$)/.test(a)) return true;
      if (sub === 'api') {   // gh api: -F/--field reads a file only for an @ value
        if (/^(?:-F|--field)$/.test(a)) return /^[^=]*=@/.test(rest[j + 1] || '');
        return /^(?:-F|--field=)[^=]*=@/.test(a);
      }
      return /^-F(?:=|$)|^-F./.test(a);   // issue/pr/release …: -F is --body-file / --notes-file
    });
  }));
}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(input); } catch { process.exit(0); }
  const root = (process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd()).replace(/\/$/, '');
  const cwd = ev.cwd || root;
  const t = ev.tool_input || {};
  const rel = (p) => String(p || '').replace(`${root}/`, '').replace(/^\.\//, '');
  if (['Read', 'Grep', 'Glob'].includes(ev.tool_name)) {
    // Grep's `pattern` is a search string, not a path; Glob's pattern is a path glob.
    const hit = secretPath(t.file_path, cwd, false, root) || secretPath(t.path, cwd, false, root)
      || (ev.tool_name === 'Glob' && secretPath(path.isAbsolute(String(t.pattern || '')) ? t.pattern : path.join(t.path || cwd, t.pattern || ''), cwd, true, root));
    // A recursive search rooted at /, a home folder or a runner's root directory would reach the credentials.
    const root2 = ['Grep', 'Glob'].includes(ev.tool_name) && t.path ? path.resolve(cwd, expand(String(t.path), cwd) || '/') : '';
    const tooWide = root2 && (/^\/(?:home(?:\/[^/]+)?|root|proc)?\/?$/.test(root2) || /^\/home\/[^/]+\/actions-runner[^/]*\/?$/.test(root2) || root2 === HOME);
    if (hit || tooWide) block('runner credentials, Claude config and /proc are not readable by models (search inside the project instead)');
  }
  if (ev.tool_name === 'Bash') {
    const c = String(t.command || '');
    if (hidesArgs(c)) block('command and process substitution ($( ), backticks, <( )) are not allowed: write the path out');
    if (bashReadsSecret(c, cwd, root)) block('runner credentials, Claude config and /proc are not readable by models');
    if (JOB && ghReadsFile(c)) block('gh flags that read local files (--body-file, --input, -F file) are not allowed; pass text with --body');
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
