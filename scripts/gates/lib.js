'use strict';
/**
 * Pure gate logic for the agent team's software gates (spec §6, §7.3, §8.3).
 * No I/O here: scripts/gates/gate.js feeds it GitHub API data. Everything is
 * unit-tested in lib.test.js, because these functions decide what reaches main.
 *
 * Trust model: only statuses created by `github-actions[bot]` (deterministic
 * workflow steps using GITHUB_TOKEN) count as gate results, and only reviews by
 * the owner count as human approvals. Agents write as the Claude GitHub App
 * (their own Apps, spec §8.5), so nothing they post can satisfy a gate (REQ-ROLE-4).
 */

const OWNER = 'delmarolivier';
const GATE_BOT = 'github-actions[bot]';
const MERGE_BOT = 'clawworks-release-manager[bot]';   // spec §8.5: A9's own App
const ORCH_BOT = 'clawworks-orchestrator[bot]';   // A0's own App: the ladder comments and dispatches as A0
const REQUIRED_STATUSES = ['ai-review', 'security', 'tier-approval'];
const REQUIRED_CHECK = 'ci';

// ---------------------------------------------------------------- RISK.md

/** Parse the ```risk-rules block of RISK.md into [{tier, glob, re}]. */
function parseRiskRules(markdown) {
  const m = markdown.match(/```risk-rules\n([\s\S]*?)```/);
  if (!m) throw new Error('RISK.md has no ```risk-rules block');
  const rules = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const tier = Number(parts[0]);
    if (parts.length !== 2 || ![0, 1, 2].includes(tier)) throw new Error(`bad risk rule: "${raw}"`);
    rules.push({ tier, glob: parts[1], re: globToRegExp(parts[1]) });
  }
  return rules;
}

/** `*` = within a segment, `**` = any segments (incl. none), `?` = one char. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Tier of one path: the last matching rule wins; unmatched paths are Tier 1. */
function tierForPath(path, rules) {
  let tier = 1;
  for (const r of rules) if (r.re.test(path)) tier = r.tier;
  return tier;
}

/** Floor for a PR: the highest tier among its files (old and new paths). */
function riskFloor(paths, rules) {
  let floor = 0;
  const byPath = {};
  for (const p of paths) {
    const t = tierForPath(p, rules);
    byPath[p] = t;
    floor = Math.max(floor, t);
  }
  return { floor, byPath };
}

/** The tier the gates use: A8 may raise the floor, never lower it (REQ-RISK-1). */
function effectiveTier(floor, labels = []) {
  let labelled = -1;
  for (const l of labels) {
    const m = /^tier:([012])$/.exec(typeof l === 'string' ? l : l.name);
    if (m) labelled = Math.max(labelled, Number(m[1]));
  }
  return Math.max(floor, labelled);
}

// ---------------------------------------------------------------- autonomy

/** Parse `autonomy_level:` from PROJECT.md. */
function parseAutonomyLevel(projectMd) {
  const m = projectMd.match(/^autonomy_level:\s*(\d)/m);
  if (!m) throw new Error('PROJECT.md has no autonomy_level');
  return Number(m[1]);
}

/**
 * Effective level after circuit breakers (§7.3). A breaker is an OPEN issue
 * with a `cb:level-N` label (created by main-guard, A0 or A10); the lowest wins.
 * REQ-CB-6: without platform protection the cap is 2 unless the overlay opts in.
 */
function effectiveLevel(configured, openBreakerLabels = [], { acceptUnprotected = false } = {}) {
  let level = configured;
  if (!acceptUnprotected) level = Math.min(level, 2);
  for (const l of openBreakerLabels) {
    const m = /^cb:level-(\d)$/.exec(l);
    if (m) level = Math.min(level, Number(m[1]));
  }
  return level;
}

/** Human approvals a PR needs (§6 and §7.1). Level 0 Shadow: H approves every PR. */
function requiredApprovals(tier, level) {
  if (tier === 2) return 1;
  if (level === 0) return 1;
  if (tier === 0) return 0;
  return level >= 4 ? 0 : 1; // Tier 1
}

// ---------------------------------------------------------------- approvals

/**
 * Is the PR approved by the owner on its current head? Only the owner's
 * latest decisive review counts; a review on an older commit doesn't count
 * (so any new push needs a new approval). Bots never count (REQ-ROLE-4).
 * Returns {approved, approvedAt}.
 */
function ownerApproval(reviews, headSha, owner = OWNER) {
  let latest = null;
  for (const r of reviews) {
    const login = r.user && r.user.login;
    if (login !== owner || (r.user.type && r.user.type !== 'User')) continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    if (!latest || new Date(r.submitted_at) >= new Date(latest.submitted_at)) latest = r;
  }
  if (!latest || latest.state !== 'APPROVED' || latest.commit_id !== headSha) return { approved: false, approvedAt: null };
  return { approved: true, approvedAt: latest.submitted_at };
}

/** The tier-approval status for a PR. */
function tierApprovalStatus({ tier, level, reviews, headSha }) {
  const need = requiredApprovals(tier, level);
  if (need === 0) return { state: 'success', description: `Tier ${tier} at Level ${level}: no human approval needed` };
  const { approved } = ownerApproval(reviews, headSha);
  return approved
    ? { state: 'success', description: `Tier ${tier}: approved by @${OWNER} on ${headSha.slice(0, 7)}` }
    : { state: 'pending', description: `Tier ${tier} at Level ${level}: waiting for @${OWNER} to approve ${headSha.slice(0, 7)}` };
}

// ---------------------------------------------------------------- Tier 2 cooling

/**
 * REQ-RISK-3: pending until `hours` after the owner's approval of the current
 * head; a new push needs a new approval, so it restarts the clock. A
 * `tier2-cancel` label (H cancelling during cooling) fails it.
 */
function coolingStatus({ tier, reviews, headSha, labels = [], now = new Date(), hours = 24 }) {
  if (tier < 2) return { state: 'success', description: 'Not Tier 2: no cooling period' };
  const names = labels.map((l) => (typeof l === 'string' ? l : l.name));
  if (names.includes('tier2-cancel')) return { state: 'failure', description: `Cancelled by @${OWNER} (tier2-cancel label)` };
  const { approved, approvedAt } = ownerApproval(reviews, headSha);
  if (!approved) return { state: 'pending', description: `Tier 2: cooling starts when @${OWNER} approves ${headSha.slice(0, 7)}` };
  const ends = new Date(new Date(approvedAt).getTime() + hours * 3600e3);
  if (now >= ends) return { state: 'success', description: `Cooled ${hours}h since approval (${approvedAt})`, ends };
  return { state: 'pending', description: `Cooling until ${ends.toISOString().slice(0, 16)}Z`, ends };
}

// ---------------------------------------------------------------- merge (A9)

/** Latest status per context, counting only statuses created by the gate bot. */
function trustedStatuses(statuses) {
  const latest = {};
  for (const s of statuses) {
    if (!s.creator || s.creator.login !== GATE_BOT) continue;
    const prev = latest[s.context];
    if (!prev || new Date(s.updated_at || s.created_at) > new Date(prev.updated_at || prev.created_at)) latest[s.context] = s;
  }
  return latest;
}

/**
 * REQ-GATE-7 (team v2.11.3): the PRs a QA round on `sha` covers. A newer merge can replace a waiting round,
 * so a round reports to the PR merged at `sha` and to each PR merged at an earlier first-parent commit, back
 * to (not including) the last commit with a trusted `qa` status, at most `max` commits.
 * `commitAt(sha)` returns { sha, parents }, `statusesAt(sha)` the commit's statuses and `prsAt(sha)` its PRs.
 */
async function qaCoveredPrs({ sha, commitAt, statusesAt, prsAt, max = 20 }) {
  const out = [];
  let cur = sha;
  for (let i = 0; i < max && cur; i++) {
    if (i > 0 && trustedStatuses(await statusesAt(cur)).qa) break;
    const pr = ((await prsAt(cur)) || []).find((p) => p.merge_commit_sha === cur);
    if (pr) out.push(pr);
    const c = await commitAt(cur);
    cur = c && c.parents && c.parents[0] && c.parents[0].sha;
  }
  return out;
}

/**
 * REQ-GATE-1: everything A9 verifies before a merge, on the PR's latest head.
 * Recomputes approvals and cooling itself rather than trusting their statuses
 * (those workflows run on review events, which use the PR's own workflow files).
 * Returns {ok, behind, reasons[]}.
 */
function mergeVerdict({ pr, statuses, checkRuns, reviews, tier, level, now = new Date(), coolingHours = 24, behindBy = 0 }) {
  const reasons = [];
  if (pr.state !== 'open') reasons.push(`PR is ${pr.state}`);
  if (pr.draft) reasons.push('PR is a draft');
  if (pr.base.ref !== 'main') reasons.push(`base is ${pr.base.ref}, not main`);
  const head = pr.head.sha;
  const st = trustedStatuses(statuses);
  // tier-approval is judged live below (tierApprovalStatus: the current level and reviews), not from its stored
  // status, which goes stale when the level changes after it was posted (blackjack#74/#78 on 2026-11-20).
  for (const ctx of REQUIRED_STATUSES.filter((c) => c !== 'tier-approval')) {
    const s = st[ctx];
    if (!s) reasons.push(`no trusted "${ctx}" status`);
    else if (s.state !== 'success') reasons.push(`"${ctx}" is ${s.state}: ${s.description || ''}`.trim());
  }
  const ci = checkRuns.filter((c) => c.name === REQUIRED_CHECK && c.app && c.app.slug === 'github-actions' && c.head_sha === head);
  if (!ci.length) reasons.push('no "ci" check run on head');
  else if (!ci.every((c) => c.status === 'completed' && c.conclusion === 'success')) reasons.push('"ci" is not green');
  const appr = tierApprovalStatus({ tier, level, reviews, headSha: head });
  if (appr.state !== 'success') reasons.push(appr.description);
  if (tier === 2) {
    const cool = coolingStatus({ tier, reviews, headSha: head, labels: pr.labels, now, hours: coolingHours });
    if (cool.state !== 'success') reasons.push(cool.description);
    const t2 = st['tier2-cooling'];
    if (!t2 || t2.state !== 'success') reasons.push('no trusted green "tier2-cooling" status');
  }
  const behind = behindBy > 0;
  return { ok: reasons.length === 0 && !behind, behind: reasons.length === 0 && behind, reasons };
}

// ---------------------------------------------------------------- main-guard

/**
 * main-guard is armed for a commit only if the commit's parent contains this
 * marker. The PR that adds it (bootstrap) is therefore exempt, and every commit
 * after it is judged. Removing the marker is a Tier 2 change (.github/**).
 */
const GUARD_MARKER = '.github/main-guard.v5';
/** `hasFile(rev, path)` → true if the file exists at that revision. */
const guardActiveFor = (hasFile, sha) => hasFile(`${sha}^`, GUARD_MARKER);

/**
 * The commits main-guard judges (REQ-GATE-2): only those that landed on main
 * itself, i.e. its first-parent history. Commits that arrive through a merge's
 * second parent are covered by the merge commit's own verdict (an A9 merge
 * needs MERGE_BOT + trusted merge-evidence), so judging them again flags
 * every branch commit of a legitimate merge as a "direct push" (incident #12).
 * `git` runs a git command and returns stdout. Push mode: before..after.
 * Sweep mode: first-parent commits on `ref` since `since` (ISO date). Oldest first.
 */
function guardCommits(git, { before, after, since, ref = 'origin/main' } = {}) {
  const range = since ? [`--since=${since}`, ref] : [`${before}..${after}`];
  return git('rev-list', '--reverse', '--first-parent', ...range).split('\n').map((x) => x.trim()).filter(Boolean);
}

/**
 * REQ-GATE-2: is a commit on main allowed? Allowed are:
 *  - an A9 squash merge: the commit's PR was merged by MERGE_BOT (A9's App) at this sha,
 *    and its head carries a trusted green `merge-evidence` status;
 *  - an exact revert (scripts/rollback or main-guard's own revert), proved by
 *    the caller replaying the revert (`exactRevertOf` = the reverted sha);
 *  - anything before main-guard existed on main (bootstrap: guardActive false).
 */
function guardVerdict({ sha, guardActive, pr, headStatuses = [], exactRevertOf = null, message = '' }) {
  if (!guardActive) return { allowed: true, why: `${GUARD_MARKER} was not on main before this commit (bootstrap)` };
  if (exactRevertOf && /^(Rollback-of|Main-guard-revert): [0-9a-f]{7,40}$/m.test(message)) {
    return { allowed: true, why: `exact revert of ${exactRevertOf.slice(0, 7)}` };
  }
  if (pr) {
    if (!pr.merged_at) return { allowed: false, why: `PR #${pr.number} is not merged` };
    if (!pr.merged_by || pr.merged_by.login !== MERGE_BOT) return { allowed: false, why: `PR #${pr.number} merged by ${pr.merged_by ? pr.merged_by.login : 'unknown'}, not A9 (${MERGE_BOT})` };
    if (pr.merge_commit_sha !== sha) return { allowed: false, why: `PR #${pr.number} merge commit is ${pr.merge_commit_sha}, not ${sha}` };
    const ev = trustedStatuses(headStatuses)['merge-evidence'];
    if (!ev || ev.state !== 'success') return { allowed: false, why: `PR #${pr.number} head has no trusted merge-evidence` };
    return { allowed: true, why: `A9 merge of PR #${pr.number}` };
  }
  return { allowed: false, why: 'direct push: not an A9 merge or an exact revert' };
}

// ---------------------------------------------------------------- review (A5 → A6)

/**
 * Keep a candidate finding only if a majority of verifiers vote it real
 * (2 of 3); its severity is the most common severity among the real votes,
 * ties going to the more severe. Returns {kept, dropped, important}.
 */
function decideFindings(candidates, voteSets, { quorum } = {}) {
  const n = voteSets.length;
  const need = quorum || Math.floor(n / 2) + 1;
  const rank = { Important: 3, 'Pre-existing': 2, Nit: 1 };
  const kept = []; const dropped = [];
  for (const c of candidates) {
    const votes = voteSets.map((vs) => (vs.votes || []).find((v) => v.id === c.id)).filter(Boolean);
    const real = votes.filter((v) => v.vote === 'real');
    if (real.length >= need) {
      const counts = {};
      for (const v of real) counts[v.severity] = (counts[v.severity] || 0) + 1;
      const severity = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (rank[b] || 0) - (rank[a] || 0))[0];
      kept.push({ ...c, severity, votes: `${real.length}/${n}`, reasons: real.map((v) => v.reason) });
    } else dropped.push({ ...c, votes: `${real.length}/${n}` });
  }
  return { kept, dropped, important: kept.filter((k) => k.severity === 'Important') };
}

/**
 * Reviewers reason about failing inputs; they can't run code (template#12). A hunter may attach a
 * `check`: a Node program that exits 0 when the code is right and non-zero when the defect is present.
 * The repro job runs it on the PR head and on main (no keys, no model). Here its results adjust the
 * kept findings: an Important finding whose check PASSES on the PR head didn't reproduce, so it is
 * downgraded to a Nit with the reason; one whose check fails is marked reproduced. A check that
 * errored or timed out changes nothing. Findings without a check are unchanged.
 *   repro: [{ id, head: 'passes'|'fails'|'timeout', base: ... }]
 */
function applyRepro(kept, repro = []) {
  const byId = new Map((repro || []).map((r) => [r.id, r]));
  return kept.map((k) => {
    const r = byId.get(k.id);
    if (!r) return k;
    // Failing on main too is inconclusive: the check may just crash (a bad require, a syntax error).
    if (r.head === 'fails' && r.base === 'fails') return { ...k, repro: 'inconclusive: its check fails on main too (it may not exercise the defect)' };
    if (r.head === 'fails') return { ...k, repro: `reproduced on the PR${r.base === 'passes' ? ' (passes on main)' : ''}` };
    if (r.head === 'passes' && k.severity === 'Important') return { ...k, severity: 'Nit', repro: "not reproduced: its check passes on the PR, so it was downgraded from Important" };
    if (r.head === 'passes') return { ...k, repro: 'not reproduced: its check passes on the PR' };
    return { ...k, repro: `check ${r.head}: no change` };
  });
}

/**
 * REQ-CB-4: does a Claude run's execution file show a subscription usage limit?
 *
 * Only the run's final `result` message is checked, and only when that result is an
 * error (incident #21 / #20). Claude Code's stream-json carries a `rate_limit_event`
 * in every run, and a successful run's final text may quote a limit message (A0 or A10
 * writing about throttling), so neither may open a `throttled` issue.
 */
const USAGE_LIMIT_RE = /usage_limit_reached|usage limit reached|you(?:'|’)ve hit your (?:[\w-]+ )*limit|\b(?:5-hour|weekly|opus) limit\b|API Error: 429\b/i;

/** The last `{type: "result"}` message in an execution file (JSON array or JSON lines). */
function finalResult(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let msgs;
  try {
    const j = JSON.parse(s);
    msgs = Array.isArray(j) ? j : [j];
  } catch {
    msgs = s.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
  }
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].type === 'result') return msgs[i];
  return null;
}

function isUsageLimited(text) {
  const r = finalResult(text);
  if (!r) return false;
  if (Number(r.api_error_status) === 429) return true;
  if (r.is_error !== true) return false;
  const said = [r.result, r.error, r.subtype, ...(Array.isArray(r.errors) ? r.errors : [])]
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x ?? ''))).join('\n');
  return USAGE_LIMIT_RE.test(said);
}

/**
 * The model never ran (team v2.10.2): the Claude result is an error with no model usage, no cost and at most
 * one turn. That is a refusal before any work (a usage limit with no message, an auth or API failure), so
 * it must not count as a ladder attempt (blackjack#57 lost its last attempt this way on 2026-11-20).
 */
function modelNeverRan(text) {
  const r = finalResult(text);
  if (!r || r.is_error !== true) return false;
  const usage = r.modelUsage && typeof r.modelUsage === 'object' ? Object.keys(r.modelUsage).length : 0;
  return usage === 0 && Number(r.total_cost_usd || 0) === 0 && Number(r.num_turns || 0) <= 1;
}

const MAX_NEVER_RAN = 2;
/**
 * The resume marker of a paused ladder attempt (team v2.10.3; A7 sec-1 on blackjack#91). Only markers written
 * by the team (the gate step as github-actions[bot], the ladder as A0's App) count: anyone else's comment is
 * data (REQ-COMMS-3). Returns the validated dispatch inputs of the newest team marker, or null.
 */
const RESUME_AUTHORS = [GATE_BOT, ORCH_BOT];
function parseLadderResume(comments) {
  const mine = (comments || []).filter((c) => c && c.user && RESUME_AUTHORS.includes(c.user.login) && /<!-- ladder-resume: /.test(c.body || ''))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const last = mine[mine.length - 1];
  if (!last) return null;
  const m = /<!-- ladder-resume: ([^>]*) -->/.exec(last.body);
  const kv = Object.fromEntries(m[1].trim().split(/\s+/).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  const out = { implementer: kv.implementer, attempt: kv.attempt, handoff_run: kv.handoff_run || '', retry: kv.retry || '0', pr: kv.pr || '', pauses: kv.pauses || '0' };
  if (!/^(local|claude)$/.test(out.implementer) || !/^[12]$/.test(out.attempt) || !/^[01]$/.test(out.retry)
    || !/^\d*$/.test(out.handoff_run) || !/^\d*$/.test(out.pr) || !/^\d{1,2}$/.test(out.pauses)) return null;
  return out;
}

/**
 * REQ-FLOW-2 / FLOW-7: what the ladder does after an attempt that didn't publish.
 *   ctx.job        the implementer job's result: success | failure | cancelled
 *   ctx.retry      infra retries of this rung so far (0 or 1)
 *   ctx.run        this run's id: its `attempt` artifact holds the work in progress
 *   ctx.handoffRun the run whose artifact this attempt was given, if any
 *   ctx.hasArtifact whether this run uploaded an `attempt` artifact (its work in progress)
 *   ctx.verified / ctx.publish  A4's verdict and the publish job's result
 * An infra failure (runner lost, gaming pause, job timeout) re-runs the same rung once
 * with the hand-off it already had. Otherwise the next rung gets THIS attempt's
 * slice.patch + test.log (local→local, local→Claude, Claude→Claude), as hints for a
 * clean tree (incident #21). Returns {implementer, attempt, handoffRun, retry} or {replan}.
 */
function nextRung(implementer, attempt, ctx = {}) {
  // A4 passed but publishing failed: that's infrastructure (e.g. no git credentials), not the
  // model's attempt. Don't advance the ladder; ask Delmar (slice #24).
  if (ctx.verified && (ctx.publish === 'failure' || ctx.publish === 'cancelled')) return { publishFailed: true };
  // A usage limit (an open `throttled` issue) or a model that never ran: pause this exact attempt, consuming
  // neither the attempt nor its infra retry. A0 resumes it once the limits reset (team v2.10.2). A model that
  // never ran with no usage limit open may be a permanent failure (expired auth, a broken key): after
  // MAX_NEVER_RAN pauses in a row it goes to H instead of looping (team v2.10.3).
  if ((ctx.job === 'failure' || ctx.job === 'cancelled') && (ctx.throttled || ctx.neverRan)) {
    const pauses = ctx.throttled ? Number(ctx.pauses || 0) : Number(ctx.pauses || 0) + 1;
    if (!ctx.throttled && pauses > MAX_NEVER_RAN) return { stuck: true };
    return { paused: true, implementer, attempt, handoffRun: (ctx.hasArtifact && ctx.run ? String(ctx.run) : '') || String(ctx.handoffRun || ''), retry: Number(ctx.retry || 0), pauses };
  }
  const run = ctx.run ? String(ctx.run) : '';
  const inherited = ctx.handoffRun ? String(ctx.handoffRun) : '';
  if ((ctx.job === 'failure' || ctx.job === 'cancelled') && Number(ctx.retry || 0) === 0) {
    // Prefer this run's own saved work in progress (saved even after a timeout); fall back to
    // the hand-off it already had if the run left no `attempt` artifact (runner lost early).
    return { implementer, attempt, handoffRun: ctx.hasArtifact && run ? run : inherited, retry: 1, infra: true };
  }
  // A local rung that failed on infrastructure twice (e.g. Ollama can't serve the model): the next
  // local rung would hit the same wall, so go straight to Claude (template#12, review item 8).
  if (implementer === 'local' && (ctx.job === 'failure' || ctx.job === 'cancelled')) return { implementer: 'claude', attempt: 1, handoffRun: run, retry: 0 };
  if (implementer === 'local' && attempt < 2) return { implementer: 'local', attempt: attempt + 1, handoffRun: run, retry: 0 };
  if (implementer === 'local') return { implementer: 'claude', attempt: 1, handoffRun: run, retry: 0 };
  if (implementer === 'claude' && attempt < 2) return { implementer: 'claude', attempt: attempt + 1, handoffRun: run, retry: 0 };
  return { replan: true };
}

// ---------------------------------------------------------------- publishing

/** Implementers may never change these (spec §8.1); A10 proposals may, except `.github/`. */
const POLICY_RE = /^(CLAUDE\.md|REVIEW\.md|RISK\.md|CODEOWNERS|\.agents\/|\.claude\/|\.github\/|scripts\/gates\/|scripts\/agents\/|scripts\/rollback|evals\/)/;
/**
 * Every path a range touches. `--no-renames` reports a rename as a delete plus an add, so
 * BOTH the old and the new path are listed (a renamed policy file can't hide; A7 on #23).
 */
const changedPaths = (git, base, head = 'HEAD') =>
  [...new Set(git('diff', '--name-only', '--no-renames', base, head).split('\n').map((x) => x.trim()).filter(Boolean))];
const policyViolations = (paths, re = POLICY_RE) => paths.filter((f) => re.test(f));

/**
 * Carry-over (gate.js carry-over) keeps an old verdict only if main didn't change the rules it was
 * judged by: any policy path (REVIEW.md, RISK.md, the agents, the gates, the workflows) changed on
 * main since the reviewed head's merge base means a fresh review (A7 sec-1 on blackjack#63).
 * Returns the refusal reason, or null if carrying over is allowed.
 */
function carryOverRefusal(mainChangedPaths) {
  const hit = (mainChangedPaths || []).find((f) => POLICY_RE.test(f));
  return hit ? `main changed policy since the review (${hit})` : null;
}

/**
 * A review run that ended without a verdict (its status on the head is still pending) failed on
 * infrastructure, not on findings: retry its failed jobs once; if the retry fails too, mark the status
 * as an error so the digest shows it instead of a pending that never ends (team v2.1).
 *   run: { conclusion, attempt }   status: the context's latest state on the head ('pending', ...)
 */
function reviewRetryAction(run, status) {
  if (!run || run.conclusion !== 'failure' || status !== 'pending') return 'none';
  return Number(run.attempt || 1) < 2 ? 'rerun' : 'mark-error';
}

/**
 * CI that failed on infrastructure (team v2.8): a job that failed with no steps never started (no runner,
 * billing, a lost runner). Re-run the failed jobs once; a second failure stays red for the orchestrator.
 *   run: { conclusion, attempt }   jobs: the run's jobs ({ conclusion, steps })
 */
function ciRetryAction(run, jobs) {
  if (!run || run.conclusion !== 'failure' || Number(run.attempt || 1) >= 2) return 'none';
  return (jobs || []).some((j) => j && j.conclusion === 'failure' && (!j.steps || j.steps.length === 0)) ? 'rerun' : 'none';
}

/**
 * Was this head actually reviewed? True only if github-actions[bot] posted a VERDICT for `context` on it:
 * success or failure with "Round N: ..." (gate.js decide) or "Carried over from ..." (gate.js carry-over).
 * Not a pending status (a run can be cancelled after posting it, before its round is recorded), not the
 * round-cap failure (a capped head had no review), not an error. A7 sec-2 on blackjack#81, rounds 1 and 2.
 */
function reviewedHead(statuses, context) {
  return (statuses || []).some((x) => x && x.context === context && x.creator && x.creator.login === 'github-actions[bot]'
    && (x.state === 'success' || x.state === 'failure')
    && /^(Round [1-9][0-9]*: |Carried over from )/.test(x.description || ''));
}

/**
 * Does a branch update keep the current review round (REQ-FLOW-1)? `u` is gate.js pureUpdate's result for
 * the head ({ pure, why, prev }); `prevStatuses` are the statuses on u.prev. Pure only if the head merely
 * merged the base branch into a previous head that was actually reviewed (reviewedHead).
 */
function roundKeepsPure(u, prevStatuses) {
  if (!u || !u.pure) return { pure: false, why: (u && u.why) || 'not a pure branch update' };
  if (!reviewedHead(prevStatuses, 'ai-review')) return { pure: false, why: `the previous head ${String(u.prev).slice(0, 7)} has no review verdict` };
  return { pure: true, why: '' };
}

/**
 * Where an A10 proposal's changes belong (team v2.7). Team files (listed in the project's .agents/TEAM_FILES)
 * are rendered from the template, so a fix to them must land in the template first (REQ-OPS-11) and reach
 * every project by re-render. The manifest and version stamp are generated by the renderer: never edited.
 */
const TEAM_GENERATED = new Set(['.agents/TEAM_FILES', '.agents/TEAM_VERSION']);
function splitProposal(files, teamFiles) {
  const out = { team: [], project: [], generated: [] };
  for (const f of files || []) {
    if (TEAM_GENERATED.has(f)) out.generated.push(f);
    else if (teamFiles.has(f)) out.team.push(f);
    else out.project.push(f);
  }
  return out;
}
/** A team file's path in the template repo: `.agents/SPEC.md` is the template's own spec; the rest live under team/. */
function templatePathFor(p) { return p === '.agents/SPEC.md' ? p : `team/${p}`; }
/** Rewrite a git patch's paths with `map` (diff, ---/+++ and rename/copy headers), so it applies in the template. */
function retargetPatch(patch, map) {
  return String(patch).split('\n').map((l) => {
    let m;
    if ((m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l))) return `diff --git a/${map(m[1])} b/${map(m[2])}`;
    if ((m = /^(---|\+\+\+) ([ab])\/(.+)$/.exec(l))) return `${m[1]} ${m[2]}/${map(m[3])}`;
    if ((m = /^(rename|copy) (from|to) (.+)$/.exec(l))) return `${m[1]} ${m[2]} ${map(m[3])}`;
    return l;
  }).join('\n');
}

/**
 * The AI review round for a PR head (REQ-FLOW-1): rounds count the coder's changes, not branch updates.
 * `last` is the highest round:N label so far; `pure` is true when the head only merged the base branch
 * into the previous head (gate.js pure-update). A pure update is re-reviewed in the same round, so
 * branch updates alone never reach the cap (team v2.3; blackjack#62). The first review is round 1.
 */
function reviewRound(last, pure) {
  const n = Number.isInteger(last) && last > 0 ? last : 0;
  return pure && n > 0 ? n : n + 1;
}

/**
 * The tier the spec writer declared for a spec: a line `TIER: <0|1|2>` (the RISK.md tier of the paths
 * the work will change; spec-writer role). The orchestrator may approve only a declared Tier 0 or 1
 * spec (A7 sec-2 on blackjack#68). Fails closed: with several TIER lines (a quoted example, a template,
 * an earlier draft) the HIGHEST counts, so no earlier line can mask a Tier 2 declaration.
 * Returns the number, or null if there is no such line.
 */
function declaredSpecTier(specText) {
  // Any `TIER: n` anywhere (in a list item, a quote, backticks, mid-line): no format can hide a Tier 2.
  const all = [...String(specText || '').matchAll(/TIER:\s*\**\s*([0-9])/g)].map((m) => Number(m[1]));
  if (all.some((t) => t > 2)) return null;   // not a tier: fail closed
  return all.length ? Math.max(...all) : null;
}

/** The coder Apps that open slice PRs (spec §8.5). */
const CODER_BOTS = ['clawworks-local-coder[bot]', 'clawworks-claude-coder[bot]'];
/**
 * A fix round may only push to an agent-owned slice PR (A7 on #23): open, same repo, opened
 * by a coder App, on a branch named agent/<issue>-local|claude. Returns a reason, or '' if OK.
 */
function fixRoundRefusal(pr, repoFullName) {
  if (!pr || pr.state !== 'open') return 'PR is not open';
  if (!pr.head || !pr.head.repo || pr.head.repo.full_name !== repoFullName) return 'head is not in this repo';
  if (!/^agent\/\d+-(local|claude)$/.test(pr.head.ref || '')) return `branch ${pr.head && pr.head.ref} is not an agent slice branch`;
  if (!pr.user || !CODER_BOTS.includes(pr.user.login)) return `PR was opened by ${pr.user && pr.user.login}, not a coder App`;
  return '';
}

/**
 * T3 / REQ-IMP-2 verdict for a full eval replay (issue #14): spec T3 is "≥ 8 of 10 flagged,
 * ≤ 2 false Important", scaled to the set's size: recall ≥ 80% and false Important ≤ 0.2 per
 * case. A partial replay (--cases) gets no verdict (null).
 */
function t3Verdict(hits, cases, falseImportant, partial = false) {
  if (partial || !cases) return null;
  return hits / cases >= 0.8 && falseImportant <= 0.2 * cases;
}

/** Overlay `manual_checks:` entries of the form `- <path regex> => <message>`. */
function parseManualChecks(projectMd) {
  // Same YAML subset as the template's render.js: comments (outside backticks/quotes) and
  // blank lines inside the list don't end it; the next top-level key does.
  const strip = (line) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; continue; }
      // An apostrophe inside a word ("don't") is not a quote; one at the start of a token is.
      if (c === '`' || c === '"' || (c === "'" && (i === 0 || /[\s:=-]/.test(line[i - 1])))) { q = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  };
  const out = []; let inList = false;
  for (const raw of String(projectMd).split('\n')) {
    const line = strip(raw).replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^manual_checks:\s*$/.test(line)) { inList = true; continue; }
    if (!inList) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (!item) { inList = false; continue; }
    const l = item[1].trim(); const i = l.indexOf(' => ');
    if (i <= 0) continue;
    try { out.push({ re: new RegExp(l.slice(0, i).trim()), message: l.slice(i + 4).trim() }); } catch (e) {
      process.stderr.write(`manual_checks: skipping a malformed regex (${e.message})\n`);   // one bad entry mustn't hide the rest
    }
  }
  return out;
}

// ---------------------------------------------------------------- misc

/** Parse "Rollback-of: <sha>" / "Main-guard-revert: <sha>" trailers. */
function revertTrailer(message) {
  const m = /^(?:Rollback-of|Main-guard-revert): ([0-9a-f]{7,40})$/m.exec(message);
  return m ? m[1] : null;
}

/** Calendar date (YYYY-MM-DD) in Europe/Dublin. */
const dublinDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
/** The Dublin date A0 stamped on the digest body (`<!-- digest YYYY-MM-DD -->`), or null. */
function digestStamp(body) {
  const m = /<!-- digest (\d{4}-\d{2}-\d{2}) -->/.exec(String(body || ''));
  return m ? m[1] : null;
}
/**
 * REQ-COORD-4 (issue #28): the digest is due on the first A0 run of any kind at or after
 * 08:00 Dublin time whose digest body isn't stamped with that Dublin day. Scheduled runs
 * are often late or skipped, so "only the scheduled run in the 08:00 hour" could miss every
 * day. The stamp, not the issue's updatedAt, decides: a comment or label on the digest
 * issue mustn't count as the digest being written.
 */
function digestDue(now = new Date(), lastStamp = null) {
  if (dublinHour(now) < 8) return false;
  return !lastStamp || lastStamp < dublinDate(now);
}
/** Hour in Europe/Dublin: the daily digest runs at 08:00 (REQ-COORD-4). */
function dublinHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

module.exports = {
  digestStamp,
  OWNER, GATE_BOT, MERGE_BOT, REQUIRED_STATUSES, REQUIRED_CHECK,
  parseRiskRules, globToRegExp, tierForPath, riskFloor, effectiveTier,
  parseAutonomyLevel, effectiveLevel, requiredApprovals,
  ownerApproval, tierApprovalStatus, coolingStatus,
  trustedStatuses, qaCoveredPrs, mergeVerdict, guardCommits, guardVerdict, revertTrailer, GUARD_MARKER, guardActiveFor,
  dublinHour, dublinDate, digestDue, decideFindings, applyRepro, carryOverRefusal, reviewRetryAction, ciRetryAction, modelNeverRan, parseLadderResume, MAX_NEVER_RAN, reviewRound, reviewedHead, roundKeepsPure, splitProposal, templatePathFor, retargetPatch, declaredSpecTier, isUsageLimited, finalResult, nextRung, POLICY_RE, changedPaths, policyViolations, CODER_BOTS, fixRoundRefusal, parseManualChecks, t3Verdict,
};
