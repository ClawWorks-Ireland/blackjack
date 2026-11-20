#!/usr/bin/env node
'use strict';
/**
 * Software gates CLI (spec §8.3). Workflows call it; all decisions are in lib.js.
 *
 *   gate.js floor --pr N                      tier floor/effective tier as JSON (reads RISK.md from cwd = base checkout)
 *   gate.js level                             effective autonomy level after circuit breakers
 *   gate.js tier-approval --pr N              set the `tier-approval` status
 *   gate.js cooling [--pr N]                  set `tier2-cooling` on one or all open PRs
 *   gate.js status --sha S --context C --state X --description D [--url U]
 *   gate.js merge-plan                        JSON: the next PR to merge or update, with reasons for the rest
 *   gate.js merge-evidence --pr N --sha S     post the trusted `merge-evidence` status (GITHUB_TOKEN step)
 *   gate.js merge-execute --pr N --sha S      re-verify, then squash-merge exactly S (App token step)
 *   gate.js update-branch --pr N              bring a PR up to date with main (App token step)
 *   gate.js guard --before B --after A | --sweep   check commits on main; JSON list of violations
 *   gate.js guard-revert --sha S              revert S on main with a Main-guard-revert trailer (App token step)
 *   gate.js review-decide --candidates F --votes F1,F2,F3 --pr N --sha S --round R [--repro F]   A6 majority → ai-review status + comment
 *   gate.js carry-over --pr N --sha S --context C   keep a green verdict across a pure branch update
 *   gate.js pure-update --pr N --sha S               pure=true if the head only merged the base branch in
 *   gate.js review-retry --run ID --context C [--dry]   retry a review that failed on infrastructure, once
 *   gate.js spec-check --issue N   may the orchestrator approve this spec (declared TIER 0/1, no needs-human)
 *   gate.js repro-run --candidates F --head DIR --base DIR --user U --out F   run hunters' checks as sandbox user U (no API; sandbox VM)
 *   gate.js publish --patch F --issue N --implementer local|claude [--pr N]   push a verified slice and open/update its PR (App token step)
 *   gate.js throttle-check --file F           REQ-CB-4: open the `throttled` issue if F shows a usage limit
 *   gate.js a10-publish --dir out [--incident N]   publish A10's output folder (no model in this step)
 *
 * Token: GITHUB_TOKEN or GH_TOKEN. Repo: GITHUB_REPOSITORY (owner/name).
 * Policy (RISK.md, .agents/PROJECT.md) is read from the working directory,
 * which workflows set to a base-branch checkout, never the PR head.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('./lib.js');

const REPO = process.env.GITHUB_REPOSITORY || 'ClawWorks-Ireland/blackjack';
const TEMPLATE = 'ClawWorks-Ireland/agent-team-template';   // the agent-team template this project is rendered from (team fixes go there first)
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
// Reads (statuses, checks, reviews) may use a separate read-only token: the Claude App
// token can't read commit statuses (403), so A9's re-verification reads with the job's
// read-only GITHUB_TOKEN and only the merge itself uses the App token.
const READ_TOKEN = process.env.GATE_READ_TOKEN || TOKEN;
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const RUN_URL = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
const POLICY_DIR = process.env.GATE_POLICY_DIR || process.cwd();

async function gh(method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${method === 'GET' ? READ_TOKEN : TOKEN}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'agent-team-gates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data && data.message}`);
  return data;
}
async function all(url) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const data = await gh('GET', `${url}${sep}per_page=100&page=${page}`);
    const items = Array.isArray(data) ? data : data.check_runs || data.statuses || [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}
const repo = (p) => `/repos/${REPO}${p}`;
const args = (() => {
  const a = process.argv.slice(3); const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return o;
})();

const readPolicy = (f) => fs.readFileSync(path.join(POLICY_DIR, f), 'utf8');
const riskRules = () => G.parseRiskRules(readPolicy('RISK.md'));
const projectMd = () => readPolicy('.agents/PROJECT.md');
const overlayNumber = (key, dflt) => { const m = projectMd().match(new RegExp(`^${key}:\\s*(\\d+)`, 'm')); return m ? Number(m[1]) : dflt; };

async function level() {
  const md = projectMd();
  const configured = G.parseAutonomyLevel(md);
  const acceptUnprotected = /^accept_unprotected_autonomy:\s*true/m.test(md);
  const issues = await all(repo('/issues?state=open&labels=circuit-breaker'));
  const labels = issues.flatMap((i) => i.labels.map((l) => l.name));
  return G.effectiveLevel(configured, labels, { acceptUnprotected });
}

async function prFacts(n) {
  const pr = await gh('GET', repo(`/pulls/${n}`));
  const files = await all(repo(`/pulls/${n}/files`));
  const paths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  const { floor, byPath } = G.riskFloor(paths, riskRules());
  const tier = G.effectiveTier(floor, pr.labels);
  const reviews = await all(repo(`/pulls/${n}/reviews`));
  return { pr, paths, floor, byPath, tier, reviews };
}

async function setStatus(sha, context, state, description, url = RUN_URL) {
  return gh('POST', repo(`/statuses/${sha}`), { state, context, description: description.slice(0, 140), target_url: url });
}

async function verdictFor(n, lvl, behindCheck = true) {
  const f = await prFacts(n);
  const head = f.pr.head.sha;
  const statuses = await all(repo(`/commits/${head}/statuses`));
  const checkRuns = await all(repo(`/commits/${head}/check-runs`));
  let behindBy = 0;
  if (behindCheck) {
    const cmp = await gh('GET', repo(`/compare/${head}...${f.pr.base.ref}`));
    behindBy = cmp.ahead_by; // commits on main the PR head doesn't have
  }
  const v = G.mergeVerdict({ pr: f.pr, statuses, checkRuns, reviews: f.reviews, tier: f.tier, level: lvl,
    coolingHours: overlayNumber('tier2_cooling_hours', 24), behindBy });
  return { ...v, number: n, sha: head, tier: f.tier, created: f.pr.created_at };
}

const commands = {
  async floor() {
    const f = await prFacts(args.pr);
    console.log(JSON.stringify({ pr: Number(args.pr), floor: f.floor, tier: f.tier, byPath: f.byPath,
      touchesWorkflows: f.paths.some((p) => p.startsWith('.github/workflows/')) }, null, 2));
  },
  async level() { console.log(await level()); },
  async 'tier-approval'() {
    const f = await prFacts(args.pr);
    const s = G.tierApprovalStatus({ tier: f.tier, level: await level(), reviews: f.reviews, headSha: f.pr.head.sha });
    await setStatus(f.pr.head.sha, 'tier-approval', s.state, s.description);
    console.log(`#${args.pr} tier ${f.tier}: tier-approval ${s.state} — ${s.description}`);
  },
  async cooling() {
    const prs = args.pr ? [await gh('GET', repo(`/pulls/${args.pr}`))] : await all(repo('/pulls?state=open'));
    for (const p of prs) {
      const f = await prFacts(p.number);
      const s = G.coolingStatus({ tier: f.tier, reviews: f.reviews, headSha: f.pr.head.sha, labels: f.pr.labels,
        hours: overlayNumber('tier2_cooling_hours', 24) });
      await setStatus(f.pr.head.sha, 'tier2-cooling', s.state, s.description);
      console.log(`#${p.number} tier ${f.tier}: tier2-cooling ${s.state} — ${s.description}`);
    }
  },
  async status() { await setStatus(args.sha, args.context, args.state, args.description || '', args.url || RUN_URL); },
  async 'merge-plan'() {
    const lvl = await level();
    const prs = (await all(repo('/pulls?state=open&base=main'))).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const results = [];
    for (const p of prs) results.push(await verdictFor(p.number, lvl));
    const next = results.find((r) => r.ok) || results.find((r) => r.behind);
    console.log(JSON.stringify({ level: lvl, action: next ? (next.ok ? 'merge' : 'update') : 'none',
      pr: next ? next.number : null, sha: next ? next.sha : null, results }, null, 2));
  },
  async 'merge-evidence'() {
    const v = await verdictFor(args.pr, await level());
    if (!v.ok || v.sha !== args.sha) throw new Error(`#${args.pr} not mergeable at ${args.sha}: ${v.reasons.join('; ') || 'behind main'}`);
    await setStatus(args.sha, 'merge-evidence', 'success', `A9 verified all gates on ${args.sha.slice(0, 7)}`);
    console.log(`merge-evidence posted on ${args.sha}`);
  },
  async 'merge-execute'() {
    const v = await verdictFor(args.pr, await level());
    if (!v.ok || v.sha !== args.sha) throw new Error(`refusing to merge #${args.pr}: ${v.reasons.join('; ') || 'behind main or head moved'}`);
    const st = G.trustedStatuses(await all(repo(`/commits/${args.sha}/statuses`)))['merge-evidence'];
    if (!st || st.state !== 'success') throw new Error('no trusted merge-evidence on head');
    const pr = await gh('GET', repo(`/pulls/${args.pr}`));
    const r = await gh('PUT', repo(`/pulls/${args.pr}/merge`), {
      sha: args.sha, merge_method: 'squash', commit_title: `${pr.title} (#${args.pr})`,
      commit_message: `${pr.body ? pr.body.split('\n')[0].slice(0, 200) : ''}\n\nMerged-by: A9 merge.yml${RUN_URL ? ` ${RUN_URL}` : ''}`,
    });
    console.log(`merged #${args.pr} as ${r.sha}`);
  },
  async 'update-branch'() {
    const pr = await gh('GET', repo(`/pulls/${args.pr}`));
    await gh('PUT', repo(`/pulls/${args.pr}/update-branch`), { expected_head_sha: pr.head.sha });
    console.log(`#${args.pr}: update-branch requested (gates will re-run on the new head)`);
  },
  async guard() {
    let shas;
    if (args.sweep) {
      const since = new Date(Date.now() - 7 * 86400e3).toISOString();
      // First-parent history only, not the REST commits list (it includes second-parent commits).
      shas = [];
      for (const sha of G.guardCommits(git, { since, ref: 'origin/main' })) {
        const st = G.trustedStatuses(await all(repo(`/commits/${sha}/statuses`)))['main-guard'];
        if (!st) shas.push(sha);
      }
    } else {
      shas = G.guardCommits(git, { before: args.before, after: args.after });
    }
    const violations = [];
    for (const sha of shas) {
      const guardActive = G.guardActiveFor((rev, p) => gitOk('cat-file', '-e', `${rev}:${p}`), sha);
      const message = git('log', '-1', '--format=%B', sha);
      const prs = await gh('GET', repo(`/commits/${sha}/pulls`));
      const pr = prs.find((p) => p.merge_commit_sha === sha) || null;
      const headStatuses = pr ? await all(repo(`/commits/${pr.head.sha}/statuses`)) : [];
      const fullPr = pr ? await gh('GET', repo(`/pulls/${pr.number}`)) : null;
      const target = G.revertTrailer(message);
      const exactRevertOf = target && isExactRevert(sha, target) ? target : null;
      const v = G.guardVerdict({ sha, guardActive, pr: fullPr, headStatuses, exactRevertOf, message });
      await setStatus(sha, 'main-guard', v.allowed ? 'success' : 'failure', v.why);
      console.error(`${sha.slice(0, 7)} ${v.allowed ? 'ok' : 'VIOLATION'}: ${v.why}`);
      if (!v.allowed) violations.push({ sha, why: v.why });
    }
    console.log(JSON.stringify(violations));
  },
  async 'guard-revert'() {
    git('config', 'user.name', 'clawworks-release-manager[bot]');
    git('config', 'user.email', 'clawworks-release-manager[bot]@users.noreply.github.com');
    gitNet('fetch', 'origin', 'main');
    git('checkout', '-B', 'main', 'origin/main');
    const parents = git('log', '-1', '--format=%P', args.sha).split(' ').filter(Boolean);
    git('revert', '--no-edit', ...(parents.length > 1 ? ['-m', '1'] : []), args.sha);
    const msg = `${git('log', '-1', '--format=%B')}\nMain-guard-revert: ${args.sha}\n`;
    git('commit', '--amend', '-m', msg);
    gitNet('push', `https://github.com/${REPO}.git`, 'HEAD:main');
    console.log(`reverted ${args.sha} on main as ${git('rev-parse', 'HEAD')}`);
  },
};

/** Implementers may never change policy files (spec §8.1). Re-checked here, on the trusted runner, after `git am` (A7 on #23). */
function refusePolicyPaths(base) {
  const bad = G.policyViolations(G.changedPaths(git, base));
  if (bad.length) throw new Error(`refusing to publish: the patch touches policy paths: ${bad.join(', ')}`);
}
function git(...a) { return execFileSync('git', a, { encoding: 'utf8' }).trim(); }
/**
 * git with the job's token for github.com. Checkouts don't persist credentials, and the
 * private repo refuses anonymous fetches, so fetch needs it as much as push does.
 */
function gitNet(...a) {
  if (!TOKEN) return git(...a);
  const auth = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  return git('-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, ...a);
}
function gitOk(...a) { try { execFileSync('git', a, { stdio: 'ignore' }); return true; } catch { return false; } }

/** Replay `git revert target` on sha's parent and compare trees (REQ-GATE-2 rollback evidence). */
function isExactRevert(sha, target) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'guard-'));
  try {
    git('worktree', 'add', '--detach', dir, `${sha}^`);
    const parents = git('log', '-1', '--format=%P', target).split(' ').filter(Boolean);
    execFileSync('git', ['-C', dir, '-c', 'user.name=g', '-c', 'user.email=g@g', 'revert', '--no-edit',
      ...(parents.length > 1 ? ['-m', '1'] : []), target], { stdio: 'ignore' });
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() === git('rev-parse', `${sha}^{tree}`);
  } catch { return false; } finally {
    try { git('worktree', 'remove', '--force', dir); } catch { /* ignore */ }
  }
}

// A branch update from main (the release manager's "update branch") doesn't change what a PR changes.
// If the new head is a merge of main into the previous head, the previous head has a green verdict
// for this context posted by github-actions[bot], and the PR's own diff is identical (same files,
// same patches), carry the verdict over instead of re-reviewing. CI still runs on the new head.
// Prints carried=true|false (team v2; slow re-review loop on blackjack#47/#53).
// Is `sha` a pure branch update of the PR: a merge of the base branch into the previous head that
// leaves the PR's own changes identical (same files, patches, and tree entries)? Returns
// { pure, why, prev, mainParent, pr }. Used by carry-over and by review rounds (team v2.3).
async function pureUpdate(prNumber, sha) {
  const no = (why, extra) => ({ pure: false, why, ...extra });
  const head = await gh('GET', repo(`/commits/${sha}`));
  if ((head.parents || []).length !== 2) return no('not a merge commit');
  const [prev, mainParent] = head.parents.map((x) => x.sha);
  const pr = await gh('GET', repo(`/pulls/${prNumber}`));
  const onMain = await gh('GET', repo(`/compare/${pr.base.ref}...${mainParent}`));
  if (!['identical', 'behind'].includes(onMain.status)) return no('second parent is not on the base branch');
  const diffOf = async (h) => {
    const c = await gh('GET', repo(`/compare/${mainParent}...${h}`));
    const files = c.files || [];
    if (files.length >= 300 || files.some((f) => typeof f.patch !== 'string')) return null;   // truncated or binary: can't compare
    return JSON.stringify(files.map((f) => [f.filename, f.status, f.previous_filename || '', f.patch]).sort());
  };
  const [a, b] = [await diffOf(prev), await diffOf(sha)];
  if (!a || a !== b) return no('the PR\'s own changes differ');
  // Patch text doesn't show a mode or type change (e.g. a file turned into a symlink): compare the
  // tree entries (mode, type, blob) of every changed path too.
  const paths = JSON.parse(b).map((f) => f[0]);
  const tree = async (c) => {
    const t = await gh('GET', repo(`/git/trees/${c}?recursive=1`));
    if (t.truncated) return null;
    return new Map(t.tree.map((e) => [e.path, `${e.mode} ${e.type} ${e.sha}`]));
  };
  const [tp, th] = [await tree(prev), await tree(sha)];
  if (!tp || !th || paths.some((x) => tp.get(x) !== th.get(x))) return no('a changed file differs in mode, type or content');
  return { pure: true, why: '', prev, mainParent, pr };
}

// A branch update from main (the release manager's "update branch") doesn't change what a PR changes.
// If the new head is a pure branch update (pureUpdate), the previous head has a green verdict for this
// context posted by github-actions[bot], and main's changes since don't touch policy, carry the verdict
// over instead of re-reviewing. CI still runs on the new head.
// Prints carried=true|false (team v2; slow re-review loop on blackjack#47/#53).
commands['carry-over'] = async () => {
  const say = (v, why) => { console.log(`carried=${v}`); if (why) console.error(`carry-over: ${why}`); };
  const u = await pureUpdate(args.pr, args.sha);
  if (!u.pure) return say(false, u.why);
  const { prev, mainParent, pr } = u;
  const st = (await all(repo(`/commits/${prev}/statuses`)))
    .filter((x) => x.context === args.context && x.creator && x.creator.login === 'github-actions[bot]')
    .sort((x, y) => (y.updated_at > x.updated_at ? 1 : -1))[0];
  if (!st || st.state !== 'success') return say(false, `no green ${args.context} on ${prev.slice(0, 7)}`);
  if (/^Waived by/.test(st.description || '')) return say(false, 'a waiver applies to the reviewed head only');
  // The rules the verdict was judged by must not have changed on main (A7 sec-1 on blackjack#63).
  const base = await gh('GET', repo(`/compare/${pr.base.ref}...${prev}`));
  const since = await gh('GET', repo(`/compare/${base.merge_base_commit.sha}...${mainParent}`));
  if ((since.files || []).length >= 300) return say(false, 'too many changes on main to check');
  const refusal = G.carryOverRefusal((since.files || []).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
  if (refusal) return say(false, refusal);
  if (args.dry) return say(true, `dry run: would carry ${args.context} over from ${prev.slice(0, 7)}`);
  await setStatus(args.sha, args.context, 'success', `Carried over from ${prev.slice(0, 7)}: same changes, only ${pr.base.ref} moved`, st.target_url || RUN_URL);
  return say(true);
};

// Review rounds (REQ-FLOW-1) count the coder's changes, not branch updates: prints pure=true|false
// for the PR head, so review.yml re-reviews a pure branch update in the same round (team v2.3;
// blackjack#62 hit the 3-round cap through branch updates alone).
// The previous head must carry a review verdict (lib.js roundKeepsPure), or a coder could commit a change,
// merge main into it and push only the merge (A7 sec-2 on blackjack#81).
commands['pure-update'] = async () => {
  const u = await pureUpdate(args.pr, args.sha);
  const r = G.roundKeepsPure(u, u.pure ? await all(repo(`/commits/${u.prev}/statuses`)) : []);
  console.log(`pure=${r.pure}`);
  if (r.why) console.error(`pure-update: ${r.why}`);
};

// A review or security run that failed before giving a verdict (team v2.1): retry it once, then
// make it a visible error. Decided by lib.js reviewRetryAction (only github-actions statuses count).
commands['review-retry'] = async () => {
  const run = await gh('GET', repo(`/actions/runs/${args.run}`));
  // For these pull_request_target runs, run.head_sha is the PR head (checked on blackjack#62's run:
  // head_sha c52b4a5 = the PR head). Prefer the linked PR's head anyway, so this holds either way.
  const head = (run.pull_requests && run.pull_requests[0] && run.pull_requests[0].head.sha) || run.head_sha;
  const st = (await all(repo(`/commits/${head}/statuses`)))
    .filter((x) => x.context === args.context && x.creator && x.creator.login === 'github-actions[bot]')
    .sort((x, y) => (y.updated_at > x.updated_at ? 1 : -1))[0];
  const action = G.reviewRetryAction({ conclusion: run.conclusion, attempt: run.run_attempt }, st ? st.state : '');
  console.log(`review-retry: run ${args.run} (${run.name}, attempt ${run.run_attempt}, ${run.conclusion}), ${args.context}=${st ? st.state : 'none'}: ${action}`);
  if (args.dry || action === 'none') return;
  if (action === 'rerun') { await gh('POST', repo(`/actions/runs/${args.run}/rerun-failed-jobs`), {}); return; }
  await setStatus(head, args.context, 'error', `${run.name} failed twice on infrastructure (no verdict): see the run`, run.html_url);
};

// May the orchestrator approve this spec? Only if the issue doesn't need Delmar, isn't labelled Tier 2,
// and the spec writer's latest spec declares `TIER: 0` or `TIER: 1` (A7 sec-2 on blackjack#68).
// Only the spec writer's own comments count. Prints ok=true|false; the reason goes to stderr.
commands['spec-check'] = async () => {
  const no = (why) => { console.log('ok=false'); console.error(`spec-check: ${why}`); };
  const issue = await gh('GET', repo(`/issues/${args.issue}`));
  const labels = issue.labels.map((l) => l.name);
  if (labels.includes('needs-human')) return no('the issue needs Delmar');
  if (labels.includes('tier:2')) return no('the issue is Tier 2');
  const specs = (await all(repo(`/issues/${args.issue}/comments`)))
    .filter((c) => c.user && c.user.login === 'clawworks-spec-writer[bot]' && /^\s*#*\s*Spec\b/m.test(c.body || ''));
  const tier = specs.length ? G.declaredSpecTier(specs[specs.length - 1].body) : null;
  if (tier === null) return no('the spec declares no TIER line');
  if (tier >= 2) return no('the spec is Tier 2');
  console.log('ok=true');
};

commands['repro-run'] = async () => {
  // Hunters' checks (template#12, REQ-ROLE-3a). Runs on a sandbox VM (review.yml repro job).
  // --head/--base are root-owned copies made by a SEPARATE install account; every check runs as --user
  // in a FRESH copy, in its own PID and network namespace, with a 10 s limit and an empty
  // environment. This process (another user) owns the gate script and the results, so PR code
  // can't rewrite them, signal us or reach the network; when a check ends, the kernel kills
  // anything it left in its namespace. Needs passwordless sudo. Any setup error is 'error' (no change).
  const { spawnSync } = require('child_process');
  const user = args.user;
  if (!/^[a-z][a-z0-9-]*$/.test(String(user || ''))) throw new Error('repro-run needs --user <sandbox account>');
  const candidates = fs.existsSync(args.candidates) ? JSON.parse(fs.readFileSync(args.candidates, 'utf8')) : [];
  const sudo = (...a) => spawnSync('sudo', ['-n', ...a], { encoding: 'utf8', maxBuffer: 1 << 22, timeout: 120000 });
  const node = process.execPath;
  const gid = String(spawnSync('id', ['-g', user], { encoding: 'utf8' }).stdout || '').trim();   // the account's own group (nobody's is nogroup)
  if (!/^\d+$/.test(gid)) throw new Error(`no such account: ${user}`);
  // Run dirs: random names in a root-owned 0711 folder (no guessable paths, no /tmp races).
  const RUNS = path.resolve(args.runs || '/sandbox-run');   // root-owned; --runs only for local testing (CI uses the default on its throwaway VM)
  sudo('mkdir', '-p', RUNS); sudo('chown', 'root:root', RUNS); sudo('chmod', '0711', RUNS);
  const run = (code, src) => {
    const dir = String(sudo('mktemp', '-d', `${RUNS}/run.XXXXXXXX`).stdout || '').trim();
    if (!dir.startsWith(`${RUNS}/run.`)) return 'error';
    if (sudo('rmdir', dir).status !== 0 || sudo('cp', '-a', path.resolve(src), dir).status !== 0
      || sudo('chown', '-R', `${user}:${gid}`, dir).status !== 0) { sudo('rm', '-rf', dir); return 'error'; }
    const r = spawnSync('sudo', ['-n', 'unshare', '-n', '-p', '-f', '--kill-child', '--mount-proc', '--wd', dir,
      'setpriv', `--reuid=${user}`, `--regid=${gid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all',
      'env', '-i', `PATH=${path.dirname(node)}:/usr/bin:/bin`, `HOME=${dir}`, 'LANG=C.UTF-8',
      'timeout', '-s', 'KILL', '10', node, '-e', code], { encoding: 'utf8', maxBuffer: 1 << 20, timeout: 30000 });
    sudo('rm', '-rf', dir);
    if (r.error && r.error.code !== 'ETIMEDOUT') return 'error';
    if (r.status === 124 || r.status === 137 || r.signal || (r.error && r.error.code === 'ETIMEDOUT')) return 'timeout';   // 124: GNU timeout fired
    if (/^(unshare|setpriv|sudo): /m.test(r.stderr || '')) return 'error';
    return r.status === 0 ? 'passes' : 'fails';
  };
  const out = [];
  for (const c of candidates) {
    if (typeof c.check !== 'string' || !c.check.trim()) continue;
    out.push({ id: c.id, head: run(c.check, args.head), base: run(c.check, args.base) });
  }
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${out.length} check(s) run: ${out.map((o) => `${o.id} head=${o.head} base=${o.base}`).join('; ') || 'none'}`);
};

commands['review-decide'] = async () => {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const candidates = fs.existsSync(args.candidates) ? read(args.candidates) : [];
  const voteSets = String(args.votes || '').split(',').filter((f) => f && fs.existsSync(f)).map(read);
  const d0 = candidates.length ? G.decideFindings(candidates, voteSets) : { kept: [], dropped: [], important: [] };
  // Hunters' runnable checks (template#12): a finding whose check passes on the PR loses its Important rating.
  const repro = args.repro && fs.existsSync(args.repro) ? read(args.repro) : [];
  const kept = G.applyRepro(d0.kept, repro);
  const d = { ...d0, kept, important: kept.filter((k) => k.severity === 'Important') };
  const line = (k) => `- **${k.severity}** \`${k.file}:${k.line}\` (${k.votes} verifiers): ${k.claim}\n  - Failing input: ${k.failing_input}${k.repro ? `\n  - Check: ${k.repro}` : ''}`;
  const body = [`<!-- ai-review round ${args.round} -->`, `### AI review: round ${args.round} of 3 on ${args.sha.slice(0, 7)}`,
    `Hunters: ${[...new Set(candidates.map((c) => c.id.split('-')[0]))].join(', ') || 'none found anything'} · candidates ${candidates.length} · kept ${d.kept.length} (≥ 2/3 verifier votes)`,
    ...(kept.some((k) => /downgraded/.test(k.repro || '')) ? ['', `> **⚠ @delmarolivier: ${kept.filter((k) => /downgraded/.test(k.repro || '')).length} Important finding(s) were downgraded to Nit because their check passed on the PR (REQ-ROLE-3a).** The PR's own code ran those checks, so read each one before approving.`] : []),
    '', ...(d.kept.length ? d.kept.map(line) : ['No findings survived verification.']),
    '', `Important findings block merge (G6). Nits never block. Pre-existing findings become new issues (REQ-FLOW-5).`].join('\n');
  await gh('POST', repo(`/issues/${args.pr}/comments`), { body });
  for (const k of d.kept.filter((x) => x.severity === 'Pre-existing')) {
    await gh('POST', repo('/issues'), { title: `Pre-existing: ${k.claim.slice(0, 80)}`, labels: ['bug', 'pre-existing'],
      body: `Found by AI review of #${args.pr} (round ${args.round}), not introduced by that PR.\n\n\`${k.file}:${k.line}\`\n\n${k.claim}\n\nFailing input: ${k.failing_input}` });
  }
  const ok = d.important.length === 0;
  await setStatus(args.sha, 'ai-review', ok ? 'success' : 'failure', ok ? `Round ${args.round}: no Important findings` : `Round ${args.round}: ${d.important.length} Important finding(s)`);
  fs.writeFileSync('review-decision.json', JSON.stringify(d, null, 2));
  console.log(JSON.stringify({ important: d.important.length, kept: d.kept.length }));
};

commands.publish = async () => {
  const issue = await gh('GET', repo(`/issues/${args.issue}`));
  const push = (ref) => gitNet('push', `https://github.com/${REPO}.git`, ref);
  const author = args.implementer === 'local' ? 'clawworks-local-coder[bot]' : 'clawworks-claude-coder[bot]';   // spec §8.5
  git('config', 'user.name', author);
  git('config', 'user.email', `${author}@users.noreply.github.com`);
  if (args.pr) {
    const pr = await gh('GET', repo(`/pulls/${args.pr}`));
    const why = G.fixRoundRefusal(pr, REPO);
    if (why) throw new Error(`refusing fix round on #${args.pr}: ${why}`);
    gitNet('fetch', 'origin', pr.head.ref); git('checkout', '-B', pr.head.ref, `origin/${pr.head.ref}`);
    git('am', '--3way', args.patch);
    refusePolicyPaths(`origin/${pr.head.ref}`);   // only the commits this patch adds
    push(`HEAD:refs/heads/${pr.head.ref}`);
    console.log(`pushed fix round to #${args.pr}`);
    return;
  }
  const branch = `agent/${args.issue}-${args.implementer}`;
  gitNet('fetch', 'origin', 'main'); git('checkout', '-B', branch, 'origin/main');
  git('am', '--3way', args.patch);
  refusePolicyPaths('origin/main');
  push(`+HEAD:refs/heads/${branch}`);
  const body = `Closes #${args.issue}\n\n${issue.title}\n\n\`\`\`\nROLE: ${args.implementer === 'local' ? 'Local Coder (A3a)' : 'Claude Coder (A3b)'}   ITEM: #${args.issue}   RESULT: done\nWHAT CHANGED: see diff\nEVIDENCE: npm test green; A4 self-verify passed (${RUN_URL || 'run'})\nRISKS / ASSUMPTIONS: see A4 notes\nNEXT: A5/A7/A8 review\n\`\`\``;
  const pr = await gh('POST', repo('/pulls'), { title: `${issue.title} (#${args.issue})`, head: branch, base: 'main', body });
  await gh('POST', repo(`/issues/${pr.number}/labels`), { labels: [`impl:${args.implementer}`] });
  await gh('POST', repo(`/issues/${args.issue}/labels`), { labels: [`impl:${args.implementer}`, 'status:in-review'] });
  console.log(`opened #${pr.number} from ${branch}`);
};

/**
 * A10's GitHub writes, done without a model (A7 on #23): the A10 job runs the model on
 * the claude-code runner with no App key, and leaves its output in a folder. This step,
 * on claude-jobs with A10's App token, publishes only what that folder allows:
 *   comment.md          posted on the incident issue (--incident N) or, weekly, on the digest issue
 *   proposal.mbox       its commits, pushed as agent/retro-<date>-<run> and opened as ONE PR
 *   pr.json             {title, body} for that PR
 *   issues.json         [{title, body, labels}] — only circuit-breaker issues (REQ-CB-3)
 */
commands['a10-publish'] = async () => {
  const dir = args.dir || 'out';
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const done = [];
  // 1. the retro / weekly report comment
  let target = args.incident && /^\d+$/.test(args.incident) ? Number(args.incident) : null;
  if (!target) {
    const digest = await all(repo('/issues?state=open&labels=digest'));
    target = digest.length ? digest[0].number : null;
  }
  const comment = read('comment.md').trim();
  if (comment && target) {
    await gh('POST', repo(`/issues/${target}/comments`), { body: comment.slice(0, 60000) });
    done.push(`comment on #${target}`);
  }
  // 2. circuit-breaker issues only (fixed label allowlist)
  // circuit-breaker + exactly one cb:level-N; never `incident` (that would start A10 on its own output; A7 on #23)
  let issues = [];
  try { issues = JSON.parse(read('issues.json') || '[]'); } catch { issues = []; }
  for (const it of (Array.isArray(issues) ? issues : []).slice(0, 3)) {
    const lv = (it.labels || []).filter((l) => /^cb:level-[01]$/.test(l));
    if (!(it.labels || []).includes('circuit-breaker') || lv.length !== 1 || !it.title) continue;
    const labels = ['circuit-breaker', lv[0]];
    const r = await gh('POST', repo('/issues'), { title: String(it.title).slice(0, 200), body: String(it.body || '').slice(0, 30000), labels });
    done.push(`issue #${r.number}`);
  }
  // 3. the proposal. Team files go to the template as their own PR (fixes are template-first, REQ-OPS-11;
  //    team v2.7); project files go to this repo as one PR. Never main, never a workflow file.
  const mbox = path.join(dir, 'proposal.mbox');
  if (fs.existsSync(mbox) && fs.statSync(mbox).size > 0) {
    let pr = {}; try { pr = JSON.parse(read('pr.json') || '{}'); } catch { pr = {}; }
    const branch = `agent/retro-${new Date().toISOString().slice(0, 10)}-${process.env.GITHUB_RUN_ID || 'local'}`;
    const title = String(pr.title || `A10 proposal (${branch})`).slice(0, 200);
    const body = String(pr.body || '').slice(0, 55000);
    git('config', 'user.name', 'clawworks-incident-reviewer[bot]');
    git('config', 'user.email', 'clawworks-incident-reviewer[bot]@users.noreply.github.com');
    gitNet('fetch', 'origin', 'main'); git('checkout', '-B', 'a10-proposal', 'origin/main');
    git('am', '--3way', mbox);
    const proposed = git('rev-parse', 'HEAD');
    const teamFiles = new Set(fs.readFileSync('.agents/TEAM_FILES', 'utf8').split('\n').map((x) => x.trim()).filter(Boolean));
    const split = G.splitProposal(G.changedPaths(git, 'origin/main'), teamFiles);
    const diffOf = (files) => execFileSync('git', ['diff', '--binary', 'origin/main', proposed, '--', ...files], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const note = (m) => (target ? gh('POST', repo(`/issues/${target}/comments`), { body: m }) : Promise.resolve());
    if (split.generated.length) await note(`A10 proposal: ignored changes to ${split.generated.map((f) => `\`${f}\``).join(', ')} (generated by the renderer).`);
    // 3a. project files: one branch and PR in this repo.
    const projectFiles = split.project;
    if (projectFiles.some((f) => f.startsWith('.github/'))) {
      await note('A10 proposal not opened: it changes `.github/`, which no agent may push (REQ-GATE-4). Put workflow changes in the PR body as a patch for @delmarolivier to apply.');
      throw new Error('proposal touches .github/: refused');
    }
    if (projectFiles.length) {
      git('checkout', '-B', branch, 'origin/main');
      execFileSync('git', ['apply', '--index'], { input: diffOf(projectFiles) });
      git('commit', '-m', title);
      gitNet('push', `https://github.com/${REPO}.git`, `HEAD:refs/heads/${branch}`);
      const opened = await gh('POST', repo('/pulls'), { title, head: branch, base: 'main', body });
      done.push(`PR #${opened.number} from ${branch} (${projectFiles.length} files)`);
    }
    // 3b. team files: a PR in the template, with paths mapped to the template (team/<path>; the spec as is).
    //     A workflow change, or a patch that doesn't apply there (a line the renderer filled in), becomes a
    //     template issue carrying the patch, for the console or H to apply.
    if (split.team.length) {
      const patch = G.retargetPatch(diffOf(split.team), G.templatePathFor);
      const from = `From ${REPO}${target ? `#${target}` : ''} (A10, run ${process.env.GITHUB_RUN_ID || 'local'}). Team v${fs.readFileSync('.agents/TEAM_VERSION', 'utf8').trim()}.`;
      const issue = async (why) => {
        const r = await gh('POST', `/repos/${TEMPLATE}/issues`, { title: `A10 team proposal: ${title}`.slice(0, 200), labels: ['team-proposal'],
          body: `${from}\n\n**Not opened as a PR:** ${why}\n\n${body}\n\n<details><summary>Patch (template paths)</summary>\n\n\`\`\`diff\n${patch.slice(0, 30000)}\n\`\`\`\n</details>` });
        done.push(`template issue ${TEMPLATE}#${r.number}`);
      };
      if (split.team.some((f) => f.startsWith('.github/'))) await issue('it changes a workflow, which no agent may push (REQ-GATE-4)');
      else {
        const tdir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tpl-'));
        gitNet('clone', '--depth', '1', `https://github.com/${TEMPLATE}.git`, tdir);
        let applied = true;
        try { execFileSync('git', ['-C', tdir, 'apply', '--index'], { input: patch, stdio: ['pipe', 'ignore', 'ignore'] }); } catch { applied = false; }
        if (!applied) await issue('the patch does not apply to the template as is (it likely touches a line the renderer fills in)');
        else {
          const tg = (...a) => execFileSync('git', ['-C', tdir, ...a], { encoding: 'utf8' }).trim();
          tg('config', 'user.name', 'clawworks-incident-reviewer[bot]');
          tg('config', 'user.email', 'clawworks-incident-reviewer[bot]@users.noreply.github.com');
          tg('checkout', '-b', branch); tg('commit', '-m', title);
          const auth = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
          tg('-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, 'push', 'origin', `HEAD:refs/heads/${branch}`);
          const opened = await gh('POST', `/repos/${TEMPLATE}/pulls`, { title, head: branch, base: 'main',
            body: `${from}\n\nTier 2 (team files): needs H's merge, a spec version bump and a Changelog line (CLAUDE.md), then a re-render of each project.\n\n${body}` });
          done.push(`template PR ${TEMPLATE}#${opened.number} (${split.team.length} team files)`);
        }
      }
    }
  }
  console.log(done.length ? `published: ${done.join('; ')}` : 'nothing to publish');
};

/**
 * Manual checks owed after a merge (overlay `manual_checks`, entries "<path regex> => <message>").
 * Reads changed file paths on stdin; prints one "- <message>" line per check that applies.
 */
commands['manual-checks'] = async () => {
  const files = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
  for (const c of G.parseManualChecks(projectMd())) if (files.some((f) => c.re.test(f))) console.log(`- ${c.message}`);
};

commands['throttle-check'] = async () => {
  const text = args.file && fs.existsSync(args.file) ? fs.readFileSync(args.file, 'utf8') : '';
  if (!G.isUsageLimited(text)) { console.log('no usage limit detected'); return; }
  const open = await all(repo('/issues?state=open&labels=throttled'));
  if (open.length) { await gh('POST', repo(`/issues/${open[0].number}/comments`), { body: `Still throttled: ${RUN_URL || ''}` }); return; }
  await gh('POST', repo('/issues'), { title: 'Throttled: Claude usage limit reached', labels: ['throttled'],
    body: `REQ-CB-4: a Claude job hit the subscription usage limit (${RUN_URL || 'run'}). New slices pause; in-flight reviews finish first; A0 closes this issue when a run succeeds again. Opened at ${new Date().toISOString()}.` });
  console.log('opened throttled issue');
};

const cmd = commands[process.argv[2]];
if (!cmd) { console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 21).join('\n')); process.exit(2); }
const OFFLINE = new Set(['repro-run', 'manual-checks']);   // no API calls: they run without a token
if (!TOKEN && !OFFLINE.has(process.argv[2])) { console.error('GITHUB_TOKEN or GH_TOKEN is required'); process.exit(2); }
cmd().catch((e) => { console.error(e.message); process.exit(1); });
