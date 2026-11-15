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
  for (const ctx of REQUIRED_STATUSES) {
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
const GUARD_MARKER = '.github/main-guard.lock';
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
 * REQ-FLOW-2 / FLOW-7: what the ladder does after an attempt that didn't publish.
 *   ctx.job        the implementer job's result: success | failure | cancelled
 *   ctx.retry      infra retries of this rung so far (0 or 1)
 *   ctx.run        this run's id: its `attempt` artifact holds the work in progress
 *   ctx.handoffRun the run whose artifact this attempt was given, if any
 * An infra failure (runner lost, gaming pause, job timeout) re-runs the same rung once
 * with the hand-off it already had. Otherwise the next rung gets THIS attempt's
 * slice.patch + test.log (local→local, local→Claude, Claude→Claude), as hints for a
 * clean tree (incident #21). Returns {implementer, attempt, handoffRun, retry} or {replan}.
 */
function nextRung(implementer, attempt, ctx = {}) {
  const run = ctx.run ? String(ctx.run) : '';
  const inherited = ctx.handoffRun ? String(ctx.handoffRun) : '';
  if ((ctx.job === 'failure' || ctx.job === 'cancelled') && Number(ctx.retry || 0) === 0) {
    return { implementer, attempt, handoffRun: inherited, retry: 1, infra: true };
  }
  if (implementer === 'local' && attempt < 2) return { implementer: 'local', attempt: attempt + 1, handoffRun: run, retry: 0 };
  if (implementer === 'local') return { implementer: 'claude', attempt: 1, handoffRun: run, retry: 0 };
  if (implementer === 'claude' && attempt < 2) return { implementer: 'claude', attempt: attempt + 1, handoffRun: run, retry: 0 };
  return { replan: true };
}

// ---------------------------------------------------------------- misc

/** Parse "Rollback-of: <sha>" / "Main-guard-revert: <sha>" trailers. */
function revertTrailer(message) {
  const m = /^(?:Rollback-of|Main-guard-revert): ([0-9a-f]{7,40})$/m.exec(message);
  return m ? m[1] : null;
}

/** Hour in Europe/Dublin: the daily digest runs at 08:00 (REQ-COORD-4). */
function dublinHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', hourCycle: 'h23' }).format(now));
}

module.exports = {
  OWNER, GATE_BOT, MERGE_BOT, REQUIRED_STATUSES, REQUIRED_CHECK,
  parseRiskRules, globToRegExp, tierForPath, riskFloor, effectiveTier,
  parseAutonomyLevel, effectiveLevel, requiredApprovals,
  ownerApproval, tierApprovalStatus, coolingStatus,
  trustedStatuses, mergeVerdict, guardCommits, guardVerdict, revertTrailer, GUARD_MARKER, guardActiveFor,
  dublinHour, decideFindings, isUsageLimited, finalResult, nextRung,
};
