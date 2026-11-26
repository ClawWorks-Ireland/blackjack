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
// ci conclusions that a branch update may cure (mergeVerdict staleCi). Not action_required, neutral or skipped.
const STALE_CI_CONCLUSIONS = ['cancelled', 'timed_out', 'failure'];

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

/**
 * REQ-OPS-15 (team v2.16): a template re-render that the gate proved to be exactly the render of a template
 * commit the owner merged carries that approval: a trusted (gate-bot) `template-render` success status on the
 * head. Pass the head's statuses. Returns {approved, approvedAt}.
 */
function templateApproval(statuses = []) {
  const t = trustedStatuses(statuses)['template-render'];
  return t && t.state === 'success' ? { approved: true, approvedAt: t.updated_at || t.created_at } : { approved: false, approvedAt: null };
}

/** The owner's approval of this head: his review, or his template merge for an exact re-render. */
function headApproval(reviews, headSha, statuses = []) {
  const own = ownerApproval(reviews, headSha);
  return own.approved ? own : templateApproval(statuses);
}

/**
 * Should the owner's review be requested on a PR? (team v2.22.3, spec §1.1) `request` while tier-approval waits for
 * him; `unrequest` when it doesn't need him but he is still asked, typically by GitHub's automatic code-owner request
 * when a PR opens (`* @owner` in CODEOWNERS, blackjack#173), so his review-requested list holds only real asks.
 * Never on his own PRs. Returns 'request' | 'unrequest' | 'none'.
 */
function ownerReviewAction({ state, requested = [], author, owner = OWNER }) {
  if (author === owner) return 'none';
  const asked = requested.some((u) => (typeof u === 'string' ? u : u && u.login) === owner);
  if (state === 'pending' && !asked) return 'request';
  if (state === 'success' && asked) return 'unrequest';
  return 'none';
}

/**
 * The tier-approval status for a PR. `statuses`: the head's statuses (for a template re-render, and the QA round).
 * `qa`: the closing slice's `QA:` line (qaLine), or null. A slice with one waits for a green `qa` round on the head
 * before any approval counts (REQ-COORD-10, team v2.32): H approves once the evidence exists, and a Tier 0 slice
 * can't merge without it. `qaWait` marks that wait: it isn't waiting for H, so no review request and no queue item.
 */
function tierApprovalStatus({ tier, level, reviews, headSha, statuses = [], qa = null }) {
  if (qa) {
    const sha7 = String(headSha).slice(0, 7);
    if (qa.error) return { state: 'pending', qaWait: true, description: `The slice's QA: line is invalid (${qa.error}): A2 re-plans it` };
    const q = trustedStatuses(statuses).qa;
    if (!q || q.state !== 'success') {
      return { state: 'pending', qaWait: true, description: q && (q.state === 'failure' || q.state === 'error')
        ? `QA round ${q.state === 'failure' ? 'failed' : 'could not run'} on ${sha7}: a fix round or re-run follows`
        : `Waiting for the QA round on ${sha7} (${qa.script}) before approval` };
    }
  }
  const need = requiredApprovals(tier, level);
  if (need === 0) return { state: 'success', description: `Tier ${tier} at Level ${level}: no human approval needed` };
  const { approved } = ownerApproval(reviews, headSha);
  if (!approved && templateApproval(statuses).approved) return { state: 'success', description: `Tier ${tier}: exact render of a template commit @${OWNER} merged (template-render)` };
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
function coolingStatus({ tier, reviews, headSha, labels = [], now = new Date(), hours = 24, statuses = [] }) {
  if (tier < 2) return { state: 'success', description: 'Not Tier 2: no cooling period' };
  const names = labels.map((l) => (typeof l === 'string' ? l : l.name));
  if (names.includes('tier2-cancel')) return { state: 'failure', description: `Cancelled by @${OWNER} (tier2-cancel label)` };
  const { approved, approvedAt } = headApproval(reviews, headSha, statuses);
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

// ---------------------------------------------------------------- QA before approval (REQ-COORD-10, team v2.32)
// blackjack#230, #228, #226, #191 and #185 waited in the Console work queue as "manual browser runs on the PC",
// although qa.yml already ran rounds on a sandbox VM with headless Chrome: nothing ran one on a PR head. A slice
// now names its round on a line `QA: qa/<script> [args]`; the model-free qa-sweep job dispatches it once the PR's
// other gates are green, and tier-approval waits for it.
const QA_SCRIPT = /^qa\/[A-Za-z0-9._\/-]+\.(?:js|mjs|cjs|sh)$/;
const QA_ARG = /^[A-Za-z0-9._:=,\/@+-]{1,64}$/;
/** A slice's `QA:` line: { script, args } or { error }, or null when it has none. */
function qaLine(body) {
  const m = /^QA:[ \t]*(.*)$/m.exec(String(body || ''));
  if (!m) return null;
  const [script, ...rest] = m[1].trim().split(/\s+/).filter(Boolean);
  if (!script || !QA_SCRIPT.test(script) || script.split('/').includes('..')) return { error: `needs a script under qa/ ending .js, .mjs, .cjs or .sh, got "${String(script || '').slice(0, 60)}"` };
  if (rest.length > 8 || rest.some((a) => !QA_ARG.test(a))) return { error: 'arguments must be at most 8 plain words (letters, digits and ._:=,/@+-)' };
  return { script, args: rest };
}
/** Issues a PR closes by a line of its own ("Closes #5"). */
function closingIssues(body) {
  return [...String(body || '').matchAll(/^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,7})\b/gim)].map((m) => Number(m[1]));
}
/**
 * Should the qa-sweep job start a QA round on this PR's head now? Only for a valid `QA:` line, an open PR that
 * isn't a draft, with no trusted `qa` status on the head yet (the sweep sets it pending when it dispatches), and
 * with ci, ai-review and security green: the round holds a sandbox VM for up to an hour, so it runs last.
 */
function qaDispatchDecision({ qa, pr, statuses = [], checkRuns = [] }) {
  if (!qa) return { dispatch: false, why: 'no QA: line' };
  if (qa.error) return { dispatch: false, why: `invalid QA: line (${qa.error})` };
  if (!pr || pr.state !== 'open' || pr.draft) return { dispatch: false, why: 'not an open, ready PR' };
  const head = pr.head.sha;
  const st = trustedStatuses(statuses);
  if (st.qa) return { dispatch: false, why: `qa is already ${st.qa.state} on ${head.slice(0, 7)}` };
  const ci = checkRuns.filter((c) => c.name === REQUIRED_CHECK && c.app && c.app.slug === 'github-actions' && c.head_sha === head);
  if (!ci.length || !ci.every((c) => c.status === 'completed' && c.conclusion === 'success')) return { dispatch: false, why: 'ci is not green yet' };
  for (const ctx of ['ai-review', 'security']) {
    if (!st[ctx] || st[ctx].state !== 'success') return { dispatch: false, why: `${ctx} is not green yet` };
  }
  return { dispatch: true, why: '' };
}

// ---------------------------------------------------------------- the team's own fix rounds and sources (REQ-COORD-10, team v2.33)
/**
 * Should this workflow dispatch the fix round for a PR head? SecurityClaw#21 sat as console work because A7's block
 * started nothing: review.yml started fix rounds only for Important AI-review findings. Now whichever of the two
 * finishes second dispatches exactly one round: review.yml when it found Important findings or `security` already
 * failed; security.yml when it blocked and `ai-review` already passed (if ai-review failed, review.yml's round
 * carries A7's findings too; if it's still running, review.yml decides when it finishes).
 * from: 'review' | 'security'; important: Important findings this review kept; aiReview, security: trusted states.
 */
function fixRoundFrom({ from, important = 0, aiReview = null, security = null }) {
  if (from === 'review') return important > 0 || security === 'failure';
  if (from === 'security') return security === 'failure' && aiReview === 'success';
  return false;
}

const ROUND_CAP_MARKER = '<!-- round-cap -->';
/**
 * The round cap, reached (REQ-FLOW-1, team v2.37). SecurityClaw#44 ended round 3 with two Important findings and
 * then sat failed: round 3 dispatches no fix round, and the cap's escalation only ran when a 4th push asked for a
 * review, which nothing would ever make. Now the workflow that would have dispatched the 4th round escalates at
 * once, with no ask of the owner: a PR with a slice goes back to A2 (`needs-replan` on the slice, as when the
 * ladder runs out) and is closed, its branch kept as evidence; a PR with no slice is console work, as before.
 * Re-slicing is A2's job, not a question for Delmar: A2 asks him only if a finding is a spec or plan choice.
 * Returns null when the cap was already handled (the marker comment is on the PR) or the PR isn't capped.
 */
function roundCapPlan({ pr, round, comments = [], from = 'review', runUrl = '' }) {
  if (Number(round) < 3) return null;
  if (comments.some((c) => String(c.body || '').includes(ROUND_CAP_MARKER))) return null;
  const n = pr.number;
  const issue = closingIssues(pr.body)[0] || null;
  const why = from === 'security' ? 'A7 still blocks it' : 'Important AI-review findings are still open';
  const evidence = `EVIDENCE: ${runUrl || 'the round 3 review'} (the findings are in the round 3 comment on #${n})`;
  if (!issue) {
    return { issue: null, prLabels: ['console-work'], issueLabels: [], close: false, issueComment: null,
      prComment: `${ROUND_CAP_MARKER}\nROLE: Orchestrator (A0)   ITEM: #${n}   RESULT: blocked\nWHAT CHANGED: three review rounds ran and ${why}. This PR has no \`Closes #n\` slice to re-slice.\n${evidence}\nNEXT: console: open a fresh PR with the open findings fixed (template first for team files) and close this one.\nCONSOLE-REASON: stuck` };
  }
  return { issue, prLabels: [], issueLabels: ['needs-replan', 'status:blocked'], close: true,
    prComment: `${ROUND_CAP_MARKER}\nROLE: Orchestrator (A0)   ITEM: #${n}   RESULT: blocked\nWHAT CHANGED: round cap (3) reached and ${why}, so this PR is closed and slice #${issue} goes back to A2 to re-slice (REQ-FLOW-1). The branch stays as evidence; an approval on this PR doesn't carry over.\n${evidence}\nNEXT: A2 Planner re-slices #${issue}`,
    issueComment: `ROLE: Orchestrator (A0)   ITEM: #${issue}   RESULT: blocked\nWHAT CHANGED: PR #${n} used its three review rounds and ${why}. It is closed; this slice needs a re-plan (\`needs-replan\`, REQ-FLOW-1).\n${evidence}\nNEXT: A2 Planner: read the open findings on #${n} and re-slice so each is fixed or designed out. Only a finding that is a spec or plan choice becomes a question for the owner, asked as a plan choice.` };
}

/**
 * A slice's `Source: <repo>@<sha>` line (blackjack#199 imported from botversusbot.com and sat as console work,
 * because a coder can only read its own repo): { repo, sha }, { error }, or null. The repo must be in this org and
 * named in the overlay's `source_repos` (H's Tier 2 choice per project); implement.yml then fetches that commit
 * read-only, in a key job, and hands it to the coder as `source/<repo>/`.
 */
function sourceLine(body, allowed = [], org = 'ClawWorks-Ireland') {
  const m = /^Source:[ \t]*(\S+)[ \t]*$/m.exec(String(body || ''));
  if (!m) return null;
  const r = new RegExp(`^(?:${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/)?([A-Za-z0-9._-]+)@([0-9a-f]{7,40})$`);
  const x = r.exec(m[1]);
  if (!x || x[1].startsWith('.')) return { error: `needs <repo>@<sha> for a repo in ${org}, got "${m[1].slice(0, 80)}"` };
  const ok = allowed.find((a) => a.toLowerCase() === x[1].toLowerCase());
  if (!ok) return { error: `${x[1]} isn't in this project's source_repos (${allowed.join(', ') || 'none'}): that is H's Tier 2 overlay choice` };
  return { repo: ok, sha: x[2] };
}

/**
 * REQ-GATE-7 (team v2.11.3): the PRs a QA round on `sha` covers. A newer merge can replace a waiting round,
 * so a round reports to the PR merged at `sha` and to each PR merged at an earlier first-parent commit, back
 * to (not including) the last commit with a trusted `qa` **verdict** (`success` or `failure`), at most `max` commits.
 * An `error` or `pending` round doesn't end the walk (blackjack#128): it gave no verdict, so the PRs it would have
 * covered stay owed to the next round that does.
 * `commitAt(sha)` returns { sha, parents }, `statusesAt(sha)` the commit's statuses and `prsAt(sha)` its PRs.
 */
async function qaCoveredPrs({ sha, commitAt, statusesAt, prsAt, max = 20 }) {
  const out = [];
  let cur = sha;
  for (let i = 0; i < max && cur; i++) {
    const qa = i > 0 && trustedStatuses(await statusesAt(cur)).qa;
    if (qa && ['success', 'failure'].includes(qa.state)) break;
    const pr = ((await prsAt(cur)) || []).find((p) => p.merge_commit_sha === cur);
    if (pr) out.push(pr);
    const c = await commitAt(cur);
    cur = c && c.parents && c.parents[0] && c.parents[0].sha;
  }
  return out;
}

/**
 * blackjack#128 (team v2.21): did a job lose its runner? It started (has steps) and didn't succeed, and one of the
 * signs GitHub records without logs is there (the two real incidents, 2026-11-21):
 *  - its failure annotation is "Process completed with exit code 143" (SIGTERM: the runner was shut down mid-step;
 *    QA run 44897404491);
 *  - a step was cancelled while the job itself ended `failure` (a person's cancel ends the job `cancelled`;
 *    release run 44909048559);
 *  - no runner is recorded, or a runner-loss message is annotated.
 * A job that hit its timeout ("exceeded the maximum execution time") is not a lost runner, nor is a person's cancel.
 */
const RUNNER_LOST_RE = /runner has received a shutdown signal|lost communication with the server|exit code 143\b/i;
const TIMEOUT_RE = /exceeded the maximum execution time/i;
function runnerLost(job, annotations = []) {
  if (!job || !(job.steps || []).length) return false;
  if (job.conclusion === 'success' || job.conclusion === 'skipped') return false;
  if (annotations.some((a) => TIMEOUT_RE.test(a.message || ''))) return false;
  if (!job.runner_name) return true;
  if (annotations.some((a) => RUNNER_LOST_RE.test(a.message || ''))) return true;
  return job.conclusion === 'failure' && job.steps.some((st) => st.conclusion === 'cancelled');
}

/**
 * Re-run a QA round once when its runner was lost (blackjack#128). `failed`: the run counts as failed (the report
 * job decides before the run has finished). Only attempt 1, only a lost runner, only when the round itself didn't
 * pass, and never when a newer round on main exists (it covers the same PRs). Returns { action, reason }.
 */
function qaRetryAction({ run, qaJob, annotations = [], newerMainRun = false, failed = null }) {
  const isFailed = failed === null ? ['failure', 'cancelled'].includes(run.conclusion) : failed;
  if (!isFailed) return { action: 'none', reason: `run ${run.conclusion || run.status}, not failed` };
  if (Number(run.run_attempt) !== 1) return { action: 'none', reason: `attempt ${run.run_attempt}: retried once already` };
  if (!runnerLost(qaJob, annotations)) return { action: 'none', reason: 'the qa job did not lose its runner (a real failure, a cancel, or it never started)' };
  const round = ((qaJob && qaJob.steps) || []).find((s) => s.name === 'QA round');
  if (round && round.conclusion === 'success') return { action: 'none', reason: 'the QA round step finished: its result stands' };
  if (newerMainRun) return { action: 'none', reason: 'attempt 1 but a newer main qa run exists' };
  return { action: 'rerun', reason: 'attempt 1 lost its runner mid-round' };
}

/** What qa-report posts for a result: { state, comment }. A runner-lost attempt 1 that will be retried posts pending, no comments. */
function qaReportPlan({ result, retry = false }) {
  if (result === 'pass') return { state: 'success', comment: true };
  if (result === 'fail') return { state: 'failure', comment: true };
  return retry ? { state: 'pending', comment: false } : { state: 'error', comment: true };
}

/**
 * Re-run a release once when its verify job lost its runner (blackjack#128). Only push runs (a workflow_dispatch is a
 * rollback, never retried), only attempt 1, only failed or cancelled runs. Returns { action, reason }.
 */
function releaseRetryAction({ run, jobs = [], annotations = [] }) {
  if (run.event !== 'push') return { action: 'none', reason: `${run.event} run (a rollback is never retried)` };
  if (!['failure', 'cancelled'].includes(run.conclusion)) return { action: 'none', reason: `run ${run.conclusion}` };
  if (Number(run.run_attempt) !== 1) return { action: 'none', reason: `attempt ${run.run_attempt}: retried once already` };
  const verify = jobs.find((j) => j.name === 'verify');
  if (!runnerLost(verify, annotations)) return { action: 'none', reason: 'verify did not lose its runner (a real failure or a cancel)' };
  return { action: 'rerun', reason: 'attempt 1: verify lost its runner' };
}

/**
 * REQ-GATE-1: everything A9 verifies before a merge, on the PR's latest head.
 * Recomputes approvals and cooling itself rather than trusting their statuses
 * (those workflows run on review events, which use the PR's own workflow files).
 * Returns {ok, behind, reasons[]}.
 */
function mergeVerdict({ pr, statuses, checkRuns, reviews, tier, level, now = new Date(), coolingHours = 24, behindBy = 0, qa = null }) {
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
  // The ci runs that aren't green, all finished with a conclusion that a newer main might change (staleCi below).
  const ciRed = ci.filter((c) => !(c.status === 'completed' && c.conclusion === 'success'));
  const ciRerunnable = ciRed.length > 0 && ciRed.every((c) => c.status === 'completed' && STALE_CI_CONCLUSIONS.includes(c.conclusion));
  const appr = tierApprovalStatus({ tier, level, reviews, headSha: head, statuses, qa });
  if (appr.state !== 'success') reasons.push(appr.description);
  if (tier === 2) {
    const cool = coolingStatus({ tier, reviews, headSha: head, labels: pr.labels, now, hours: coolingHours, statuses });
    if (cool.state !== 'success') reasons.push(cool.description);
    const t2 = st['tier2-cooling'];
    if (!t2 || t2.state !== 'success') reasons.push('no trusted green "tier2-cooling" status');
  }
  const behind = behindBy > 0;
  // finance-insights#39 (team v2.23.1): a PR whose only failing gate is ai-review, and which is behind main, may be
  // failing on something main has since fixed (#40 was blocked on a file that had landed on main). Updating the branch
  // is a pure update (gate.js pure-update), re-reviewed in the same round, so A9 does it rather than asking H.
  // Once updated it isn't behind, so this fires at most once per change to main.
  const staleReview = behind && reasons.length > 0 && reasons.every((r) => r.startsWith('"ai-review" is failure'));
  // SecurityClaw#27/#28 (team v2.28.4): ci was cancelled at its timeout by a slow test on main, which main then fixed.
  // On the same terms as staleReview: behind main, ci finished cancelled, timed_out or failure, and ci is the only
  // failing gate. The pure update gives the head a new commit, so ci runs again; once updated the PR isn't behind,
  // so this fires at most once per change to main. A merged or closed PR fails another gate, so it never fires.
  const staleCi = behind && pr.state === 'open' && ciRerunnable && reasons.length > 0 && reasons.every((r) => r === '"ci" is not green');
  return { ok: reasons.length === 0 && !behind, behind: reasons.length === 0 && behind, staleReview, staleCi, reasons };
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

/**
 * The PR number an A9 squash merge names in its subject ("Title (#N)", merge-execute's commit_title),
 * or null. main-guard runs seconds after the merge, when GitHub's commit→PR index
 * (/commits/{sha}/pulls) may not list the PR yet: that made a legitimate A9 merge a "direct push"
 * and reverted it (incident home-automation#7). The number only picks which PR to fetch;
 * guardVerdict still requires merged_by A9, merge_commit_sha === sha and trusted merge-evidence,
 * so a forged subject gains nothing.
 */
function guardPrNumber(message) {
  const m = /\(#(\d{1,7})\)\s*$/.exec(String(message || '').split('\n')[0]);
  return m ? Number(m[1]) : null;
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

/** The messages of an execution file (JSON array or JSON lines). */
function execMessages(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) ? j : [j];
  } catch {
    return s.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
  }
}

/** The last `{type: "result"}` message in an execution file (JSON array or JSON lines). */
function finalResult(text) {
  const msgs = execMessages(text);
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].type === 'result') return msgs[i];
  return null;
}

/**
 * REQ-OPS-14 (team v2.14): one team-metrics record per Claude run, built from the run's own execution file
 * by a step with no model. The health watcher reads these records (never job logs) to find wasted tokens
 * and time. `ctx`: role, subject (issue or PR number), sha, attempt, args (the role's "model --effort x").
 */
function metricsRecord(text, ctx = {}) {
  const msgs = execMessages(text).filter(Boolean);
  const r = finalResult(text);
  const init = msgs.find((m) => m.type === 'system' && m.subtype === 'init');
  const clean = (v, re) => (re.test(String(v ?? '')) ? String(v) : null);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const u = (r && r.usage) || {};
  const effort = (/--effort (low|medium|high|xhigh|max)\b/.exec(ctx.args || '') || [])[1] || 'default';
  const advisor = (/--advisor ([a-z0-9.-]{1,40})\b/.exec(ctx.args || '') || [])[1] || null;
  return {
    v: 1,
    role: clean(ctx.role, /^[a-z][a-z0-9-]{0,40}$/) || 'unknown',
    subject: clean(ctx.subject, /^[0-9]{1,7}$/) ? Number(ctx.subject) : null,
    sha: clean(ctx.sha, /^[0-9a-f]{7,40}$/),
    attempt: clean(ctx.attempt, /^[0-9]{1,3}$/) ? Number(ctx.attempt) : null,
    model: clean(init && init.model, /^[A-Za-z0-9._:\[\]-]{1,60}$/) || clean((ctx.args || '').split(' ')[0], /^[a-z0-9.-]{1,60}$/),
    effort,
    advisor,
    outcome: r ? clean(r.subtype, /^[a-z_]{1,40}$/) || 'unknown' : 'no-result',
    error: r ? r.is_error === true : true,
    turns: n(r && r.num_turns),
    cost: Math.round(n(r && r.total_cost_usd) * 1e4) / 1e4,
    ms: n(r && r.duration_ms),
    denials: r ? (Array.isArray(r.permission_denials) ? r.permission_denials.length : n(r.permission_denials_count)) : 0,
    denied: deniedTools(r && r.permission_denials),
    tokens: { in: n(u.input_tokens), out: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) },
  };
}

/**
 * Which tools a run was refused, counted by name (team v2.18.1): a tool name, and for Bash its first two words
 * (`Bash(gh pr)`), so the waste check can say what to allow or stop asking for. No other argument is kept: a
 * command line can hold anything. At most 20 names.
 */
function deniedTools(denials) {
  if (!Array.isArray(denials)) return {};
  const out = {};
  for (const d of denials) {
    const tool = /^[A-Za-z][\w-]{0,40}$/.test(String(d && d.tool_name)) ? d.tool_name : 'unknown';
    let key = tool;
    if (tool === 'Bash' && d.tool_input && typeof d.tool_input.command === 'string') {
      const words = d.tool_input.command.trim().split(/\s+/).slice(0, 2).map((w) => w.replace(/[^\w./-]/g, '').slice(0, 30)).filter(Boolean);
      key = `Bash(${words.join(' ')})`;
    } else if (tool === 'mcp' || /^mcp__/.test(tool)) key = tool.slice(0, 60);
    if (key in out || Object.keys(out).length < 20) out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** The record as a GitHub Actions notice titled team-metrics (one line; `%` escaped per the workflow-command rules). */
function metricsNotice(rec) {
  return `::notice title=team-metrics::${JSON.stringify(rec).replace(/%/g, '%25')}`;
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
 * Slice check (team v2.18, spec REQ-FLOW-9; blackjack#158). A slice names every file it will create, change or
 * delete on one `Files:` line of backticked paths (planner.md). Only that line is read: other prose may mention
 * policy paths as context (#132 named `scripts/gates/lib.js:574` under "Don't touch"). Returns
 * { files, policy, missing }; a trailing `:line` or `:a-b` is stripped from each path.
 */
function slicePolicyCheck(body, { labels = [], comments = [] } = {}) {
  const line = (/^Files:(.*)$/m.exec(String(body || '')) || [])[1] || '';
  const files = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim().replace(/:\d+(?:-\d+)?$/, '')).filter(Boolean);
  const names = labels.map((l) => (typeof l === 'string' ? l : l.name));
  // REQ-COORD-10 (team v2.36.1, agent-team-template#290): a slice for the console needs a CONSOLE-REASON line.
  // Spec 0.93 designed this refusal but 0.98 didn't build it, so blackjack#230 (a QA round on a PR head, marked
  // `Implementer: console`) reached the console with no reason. Browser and run evidence is a `QA:` line instead.
  const forConsole = names.includes('console-work') || /^Implementer:[^\n]*\bconsole\b/im.test(String(body || ''));
  const consoleNoReason = forConsole && !sliceConsoleReason(body, comments);
  return { files, policy: policyViolations(files), missing: files.length === 0, consoleNoReason };
}

/**
 * The latest valid CONSOLE-REASON, on a line of its own in the body or a comment, or null. This is the same rule as
 * the watcher's scripts/pc/health/routing.js (consoleReason), which isn't rendered into projects.
 */
const SLICE_CONSOLE_REASONS = ['pc', 'identity', 'private-data', 'stuck'];
function sliceConsoleReason(body, comments = []) {
  let found = null;
  for (const text of [body, ...comments.map((c) => c.body)]) {
    const m = /^CONSOLE-REASON:[ \t]*([a-z-]+)[ \t]*$/m.exec(String(text || ''));
    if (m && SLICE_CONSOLE_REASONS.includes(m[1])) found = m[1];
  }
  return found;
}

/** The one line `gate.js slice-check` prints. A policy path wins over everything else. */
function sliceCheckResult(check) {
  if (check.policy.length) return `ok=false reason=policy paths=${check.policy.join(',')}`;
  if (check.consoleNoReason) return 'ok=false reason=console-no-reason';
  if (check.missing) return 'ok=false reason=no-files';
  return 'ok=true';
}

/** Comments by these logins count as the team's own slice-check marker (the workflow token and the team Apps). */
const SLICE_CHECK_BOTS = ['github-actions[bot]', 'clawworks-orchestrator[bot]', 'clawworks-spec-writer[bot]', 'clawworks-planner[bot]', 'clawworks-console[bot]'];

/**
 * What `slice-check --apply` does for a check: { addLabels, removeLabels, comment }. A policy slice waits for a
 * human (A10 is suggested when every path is under evals/); a slice with no Files: line goes back to the planner
 * (`needs-replan`, never `needs-human`). Labels already present aren't added again, and the comment is null when
 * a team bot already posted that marker.
 */
function sliceCheckActions(check, { labels = [], comments = [], bots = SLICE_CHECK_BOTS, teamFiles = [] } = {}) {
  const have = labels.map((l) => (typeof l === 'string' ? l : l.name));
  const posted = (marker) => comments.some((c) => c.user && bots.includes(c.user.login) && (c.body || '').includes(marker));
  const add = (ls) => ls.filter((l) => !have.includes(l));
  // REQ-COORD-6 (team v2.20): team files (rendered from the template, listed in .agents/TEAM_FILES) and eval content
  // are console work, not a decision for the owner: the console makes them (template first) and he reviews the PR.
  // Only the project's own policy files (RISK.md, CLAUDE.md, REVIEW.md, CODEOWNERS) still ask him. The overlay is a
  // team file since team v2.24 (listed in TEAM_FILES): it is changed in the template's projects/, so console work.
  // CODEOWNERS is the project's own policy file wherever GitHub reads it (.github/, docs/ or the root): never console work.
  const consoleFile = (p) => !/(^|\/)CODEOWNERS$/.test(p) && (teamFiles.includes(p) || p.startsWith('evals/') || /^(\.github|\.claude|scripts\/gates|scripts\/agents)\//.test(p));
  // REQ-OPS-18 (team v2.35): team work, not console work. A team-file slice is copied to the template by the health
  // watcher, where A10t makes it; eval content is A10's in this repo. The marker stays `console` for existing items.
  if (check.policy.length && check.policy.every(consoleFile)) {
    const marker = '<!-- slice-check: console -->';
    return {
      addLabels: add(['team-improve']),
      removeLabels: ['needs-human', 'status:awaiting-human', 'status:planned', 'status:in-progress', 'console-work'].filter((l) => have.includes(l)),
      comment: posted(marker) ? null : `${marker}\n**Slice check:** this slice changes ${check.policy.map((p) => `\`${p}\``).join(', ')}, which no implementer may edit. It is **team work** (\`team-improve\`, REQ-OPS-18): team files are made in the agent-team template by A10t (the health watcher copies this item there) and reach this repo in the daily re-render; eval content is made by A10 here. No decision is needed from \`${OWNER}\`, who reviews the resulting PR. Not dispatched.`,
    };
  }
  if (check.policy.length) {
    const marker = '<!-- slice-check: policy -->';
    return {
      addLabels: add(['needs-human', 'status:awaiting-human']),
      removeLabels: ['status:planned', 'status:in-progress'].filter((l) => have.includes(l)),
      comment: posted(marker) ? null : `${marker}\n**Slice check:** this slice changes implementer policy paths, which no implementer may edit: ${check.policy.map((p) => `\`${p}\``).join(', ')}. Suggested owner: @${OWNER} or the console.\n\n` +
        `@${OWNER}, how should it be done?\n- **(A, recommended)** Delmar or the console makes the change as a Tier 2 PR (team files go to the template first, REQ-OPS-11).\n- **(B)** The planner re-slices so that only the non-policy part remains here.`,
    };
  }
  if (check.consoleNoReason) {
    // Without a reason it isn't console work: it goes back to A2 and off the console's queue (REQ-COORD-10, #290).
    const marker = '<!-- slice-check: console-no-reason -->';
    return {
      addLabels: add(['needs-replan']),
      removeLabels: ['console-work', 'status:planned', 'status:in-progress'].filter((l) => have.includes(l)),
      comment: posted(marker) ? null : `${marker}\n**Slice check:** this slice is for the console but has no \`CONSOLE-REASON\` line, so it isn't console work and isn't dispatched. Planner: re-slice it (planner rules 1d2 and 1e).\n` +
        '- Browser or run evidence on built code (headless Chrome, a local server, repeated runs) is a `QA: qa/<script> [args]` line on the slice it checks. qa-sweep runs it on the PR head; nobody runs it by hand.\n' +
        '- Team files, the overlay and eval content are `team-improve` (A10t in the template, A10 for evals).\n' +
        '- Only what needs the PC itself, an App, key or org setting, or the owner\'s own data is console work, and it ends with a line `CONSOLE-REASON: pc|identity|private-data`.',
    };
  }
  if (check.missing) {
    const marker = '<!-- slice-check: no-files -->';
    return {
      addLabels: add(['needs-replan']),
      removeLabels: [],
      comment: posted(marker) ? null : `${marker}\n**Slice check:** this slice has no \`Files:\` line, so it can't be checked against the implementer policy paths and isn't dispatched. Planner: add a \`Files:\` line naming every file it creates, changes or deletes.`,
    };
  }
  return { addLabels: [], removeLabels: [], comment: null };
}

/**
 * Carry-over (gate.js carry-over) keeps an old verdict only if main didn't change the rules it was
 * judged by: any policy path (REVIEW.md, RISK.md, the agents, the gates, the workflows) changed on
 * main since the reviewed head's merge base means a fresh review (A7 sec-1 on blackjack#63).
 * For the `security` verdict (team v2.23.8), only what A7 judges by counts: its definition, its workflow, the
 * project's policy and instruction files and the gate scripts. A change to other agents, other workflows or the
 * evals can't change A7's verdict, and resetting on it threw away the owner's waivers three times on
 * home-automation#18 (2026-11-23). Code changes on main never reset any verdict, as before.
 * Returns the refusal reason, or null if carrying over is allowed.
 */
const SECURITY_INPUTS_RE = /^(CLAUDE\.md|AGENTS\.md|REVIEW\.md|RISK\.md|(\.github\/|docs\/)?CODEOWNERS|\.agents\/PROJECT\.md|\.agents\/SPEC\.md|\.agents\/schemas\/|\.claude\/agents\/security-reviewer\.md|\.claude\/settings[^/]*\.json|\.github\/workflows\/security\.yml|scripts\/gates\/)/;
function carryOverRefusal(mainChangedPaths, context = 'ai-review') {
  const re = context === 'security' ? SECURITY_INPUTS_RE : POLICY_RE;
  const hit = (mainChangedPaths || []).find((f) => re.test(f));
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
function ciRetryAction(run, jobs, annotationsByJob = {}) {
  if (!run || run.conclusion !== 'failure' || Number(run.attempt || 1) >= 2) return 'none';
  // A job that never started, or (team v2.23.2) one whose runner was lost mid-run: the PC restarting killed #179's
  // ci and classify jobs on 2026-11-23, and nothing re-ran them. A real test failure is never retried.
  return (jobs || []).some((j) => j && j.conclusion === 'failure'
    && (!j.steps || j.steps.length === 0 || runnerLost(j, annotationsByJob[j.id] || []))) ? 'rerun' : 'none';
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
// A project's .claude/agents/x.md comes from the template's team/agents/x.md (#337).
function templatePathFor(p) { return p === '.agents/SPEC.md' ? p : p.startsWith('.claude/agents/') ? `team/${p.slice('.claude/'.length)}` : `team/${p}`; }
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

/**
 * REQ-COORD-5 (team v2.15.2): did Delmar's ask default settle this spec's approval? True only when the overlay
 * lets defaults cover everything (`ask_default_scope: all`, `ask_default_hours` > 0) and, after the spec
 * writer's latest spec:
 *  - the orchestrator asked Delmar with the machine-readable line `DEFAULT-CHOICE: approve-spec` (its
 *    recommendation is to approve; any other recommendation carries no line, A7 sec-1 on blackjack#150), and
 *  - the console App posted `<!-- ask-default:<that ask's id> choice:approve-spec -->` for it.
 * The console identity is held by the PC's health watcher and the console session, which can already act for
 * Delmar with his own login, so this adds no new power to any model (A7 sec-3). spec-check keeps its
 * needs-human check before this path, and the watcher removes needs-human when it posts (A7 sec-2).
 * `comments` oldest first: [{ id, login, body }].
 */
function specApprovalDefaulted(comments, overlay = {}, owner = OWNER) {
  if (!(overlay.hours > 0) || overlay.scope !== 'all') return false;
  const isSpec = (c) => c.login === 'clawworks-spec-writer[bot]' && /^\s*#*\s*Spec\b/m.test(c.body || '');
  let s = -1;
  comments.forEach((c, i) => { if (isSpec(c)) s = i; });
  if (s < 0) return false;
  const after = comments.slice(s + 1);
  // Only the owner's LATEST ask counts, and only while he hasn't answered it (AI review round 2 on blackjack#150):
  // a later ask, or any reply from him (or relayed for him), cancels an older default.
  const isAsk = (c) => /\[bot\]$/.test(c.login || '') && !['clawworks-console[bot]', 'github-actions[bot]'].includes(c.login) && (c.body || '').includes(`@${owner}`);
  let k = after.length - 1;
  while (k >= 0 && !isAsk(after[k])) k--;
  if (k < 0) return false;
  const ask = after[k];
  if (ask.login !== 'clawworks-orchestrator[bot]' || !/^DEFAULT-CHOICE: approve-spec\s*$/m.test(ask.body || '')) return false;
  const later = after.slice(k + 1);
  if (later.some((c) => c.login === owner || (c.login === 'clawworks-console[bot]' && /Posted by the console on Delmar's instruction/.test(c.body || '')))) return false;
  return later.some((c) => c.login === 'clawworks-console[bot]' && (/<!-- ask-default:(\d+) choice:approve-spec -->/.exec(c.body || '') || [])[1] === String(ask.id));
}

/**
 * REQ-OPS-15 forward-only rule (A7 sec-1 on home-automation#11): may a re-render to template commit `src` carry
 * the owner's template approval, given the base branch's TEAM_SOURCE `baseSrc` and GitHub's compare status of
 * `baseSrc...src`? Only when `src` strictly descends from `baseSrc`. A base with no recorded source (the first
 * v2.16 render) or an unverified one gets no automatic approval. Returns { ok, why }.
 */
function renderDirection(baseSrc, src, compareStatus) {
  if (!baseSrc) return { ok: false, why: 'the base records no template source: the first template-approved render needs the owner\'s review' };
  if (!/^[0-9a-f]{40}$/.test(baseSrc)) return { ok: false, why: `the base's template source is "${String(baseSrc).slice(0, 20)}": needs the owner's review` };
  if (baseSrc === src) return { ok: false, why: 'same template commit as the base: nothing to re-render' };
  if (compareStatus !== 'ahead') return { ok: false, why: `template ${src.slice(0, 7)} is not newer than the base's ${baseSrc.slice(0, 7)} (${compareStatus || 'unknown'}): a downgrade or a side branch` };
  return { ok: true, why: 'forward' };
}

/**
 * May an owner's security waiver carry across a pure branch update? Only when main changed none of the files the PR
 * changes (home-automation#5), so the waived code sits in the same surroundings he looked at. `prPaths`: the PR's
 * changed paths at the waived head; `mainPaths`: what main changed since. Returns { ok, why }.
 */
function waiverCarries(prPaths = [], mainPaths = []) {
  const touched = prPaths.filter((p) => mainPaths.includes(p));
  return touched.length ? { ok: false, why: `main changed ${touched.slice(0, 3).join(', ')}, which this PR also changes: the waiver needs a fresh look` } : { ok: true, why: 'main touched none of the PR\'s files' };
}

/**
 * Every `/security-waive <id> <reason>` line in an owner comment, not just the first (home-automation#18: a comment
 * with two waiver lines recorded only the first).
 */
function parseWaiveCommands(body = '') {
  return String(body).split(/\r?\n/)
    .map((l) => l.trim().match(/^\/security-waive\s+(\S+)\s+(\S.*)$/))
    .filter(Boolean)
    .map((m) => ({ id: m[1], reason: m[2].trim().slice(0, 300) }));
}

/**
 * A7's findings at one head, as a hidden marker in the bot's review comment: { sha, findings: [{ id, category, file, blob }] }.
 * Base64 so no file name or text from the model can close the HTML comment.
 */
function securityMarker(rec) {
  return `<!-- security-findings ${Buffer.from(JSON.stringify(rec)).toString('base64')} -->`;
}
// Model text the gates post as github-actions[bot] can't open an HTML comment, so it can't carry a hidden
// marker of any kind (security-findings, ladder-resume). It shows as plain `<!--` text.
function inert(text) {
  return String(text == null ? '' : text).replace(/<!--/g, '&lt;!--');
}
// Read only from the head of A7's own comment (gate.js security-decide), whose first two lines are fixed.
// Other github-actions[bot] comments quote model text that a PR can steer (hunter claims, A8's rationale), so a
// marker anywhere else, even in A7's own finding text, is not a finding list (A7 sec-1 on the v2.26.0 renders).
const SECURITY_HEAD_RE = /^<!-- security -->\r?\n<!-- security-findings ([A-Za-z0-9+/=]+) -->\r?\n/;
/**
 * A7's findings with every id unique (team v2.28.1). A second finding that reuses an id is kept, renamed `<id>#2`
 * (then #3…), so it is posted, counted and gated like any other and needs its own waiver. Before, it was dropped
 * unseen, so a high-severity finding could hide behind a low one's id (AI review on SecurityClaw#34).
 */
function uniqueFindingIds(findings = []) {
  const ids = new Set((findings || []).map((f) => String(f && f.id)));
  const seen = new Set();
  return (findings || []).filter((f) => f && typeof f === 'object').map((f) => {
    let id = String(f.id);
    if (seen.has(id)) { let k = 2; while (ids.has(`${id}#${k}`) || seen.has(`${id}#${k}`)) k++; id = `${id}#${k}`; }
    seen.add(id);
    return { ...f, id };
  });
}

function readSecurityMarker(body = '') {
  const m = String(body).match(SECURITY_HEAD_RE);
  if (!m) return null;
  try {
    const r = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return r && typeof r.sha === 'string' && Array.isArray(r.findings) ? r : null;
  } catch { return null; }
}

/**
 * Which of A7's findings at the current head has the owner waived? (home-automation#18, A10 weekly 2026-11-23.)
 * Before this, any one `/security-waive` turned the whole `security` status green, whatever the other findings,
 * and a waiver died with every push even when the waived file was unchanged (9 waivers for 3 decisions on #18).
 *
 * `comments`: the PR's comments in order, { login, body }. A finding list is a `security-findings` marker posted
 * by `botLogin`; each waiver line in an `owner` comment names an id in the latest list posted before it. A waiver
 * covers that finding at that head. It carries to a later head's finding with the same category, file and file
 * blob (the waived file is byte-for-byte unchanged), but only when that key names exactly one finding on both
 * heads, so one waiver never covers two findings. Waivers are read from all the owner's comments, so a waiver
 * run that GitHub cancels in the concurrency queue loses nothing. An owner comment marked `edited` counts for
 * nothing: its body may not be what he wrote (an App with issues:write can edit his comments).
 * Returns { waived: [{ id, how, reason }], open: [id], unknown: [{ id, sha }], edited: [id] }.
 */
function securityWaiverState({ comments = [], current, owner, botLogin = 'github-actions[bot]', waivable = true }) {
  const key = (f) => JSON.stringify([f.category || 'other', f.file || '', f.blob || '']);
  const unique = (list, k) => list.filter((f) => key(f) === k).length === 1;
  let latest = null;
  const records = [];
  const unknown = [];
  const edited = [];
  for (const c of comments) {
    // A7's findings list counts only from its comment as posted: an App with issues:write could edit the marker to
    // drop findings or point their ids elsewhere (A7 sec-1 on SecurityClaw#32, team v2.28.1). An edited one leaves no
    // list at all, so later waivers are unknown: falling back to an older list would let them bind to findings A7
    // has since replaced (review of v2.28.1).
    if (c.login === botLogin) { const m = readSecurityMarker(c.body); if (m) latest = c.edited ? null : m; continue; }
    if (c.login !== owner || !waivable) continue;   // waivable: the PR is Tier 2 (G7)
    // An edited comment's waiver lines don't count: anyone with issues:write could have added them (A7 sec-1, v2.26.1).
    if (c.edited) { for (const w of parseWaiveCommands(c.body)) edited.push(w.id); continue; }
    for (const w of parseWaiveCommands(c.body)) {
      const f = latest && latest.findings.find((x) => x.id === w.id);
      if (!f) { unknown.push({ id: w.id, sha: latest ? latest.sha : '' }); continue; }
      records.push({ sha: latest.sha, id: f.id, key: key(f), blob: f.blob || '', unique: unique(latest.findings, key(f)), reason: w.reason });
    }
  }
  const waived = [];
  const open = [];
  for (const f of (current && current.findings) || []) {
    const k = key(f);
    const same = records.find((r) => r.sha === current.sha && r.id === f.id && r.key === k);
    const carried = !same && f.blob && unique(current.findings, k)
      && records.find((r) => r.sha !== current.sha && r.unique && r.blob && r.key === k);
    if (same) waived.push({ id: f.id, how: 'waived', reason: same.reason });
    else if (carried) waived.push({ id: f.id, how: `carried from ${carried.sha.slice(0, 7)} ${carried.id}`, reason: carried.reason });
    else open.push(f.id);
  }
  return { waived, open, unknown, edited };
}

/** A file's git blob id (what a tree lists), so rendered files compare with a PR's tree without downloading it. */
function gitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  return require('crypto').createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
}

/**
 * REQ-OPS-15: is a PR exactly the render of a template commit? Pure; gate.js template-render fetches the facts.
 *  - changed: the PR's changed files [{ filename, status, previous_filename }]; a rename is checked as the
 *    removal of its old path plus the addition of its new one (A7 sec-1 on blackjack#150: a project file
 *    "renamed" into a team file must not be deleted unseen)
 *  - rendered: { path: { blob, mode } } for every team file the template commit renders for this project
 *    (its manifest), TEAM_SOURCE excluded
 *  - head: { path: { blob, mode } } from the PR head's tree
 *  - baseManifest: the team files listed on the base (a file the template dropped may be deleted)
 * Every changed path must be a team file (rendered, or a dropped one now deleted) or TEAM_SOURCE, and every
 * rendered file must be on the head with the same content and executable bit. Returns { ok, why }.
 */
function renderMatch({ changed = [], rendered = {}, head = {}, baseManifest = [] }) {
  const entries = changed.flatMap((c) => (c.status === 'renamed' && c.previous_filename
    ? [{ filename: c.previous_filename, status: 'removed' }, { filename: c.filename, status: 'added' }] : [c]));
  for (const c of entries) {
    const p = c.filename;
    if (p === '.agents/TEAM_SOURCE') continue;
    if (Object.prototype.hasOwnProperty.call(rendered, p)) continue;   // own keys only: not `constructor` etc. (home-automation#12)
    if (c.status === 'removed' && baseManifest.includes(p)) continue;
    return { ok: false, why: `${p} is not a team file this template commit renders` };
  }
  for (const [p, r] of Object.entries(rendered)) {
    const h = Object.prototype.hasOwnProperty.call(head, p) ? head[p] : undefined;
    if (!h) return { ok: false, why: `${p} is missing from the PR head` };
    if (h.blob !== r.blob) return { ok: false, why: `${p} differs from the template's render` };
    if ((h.mode === '100755') !== (r.mode === '100755')) return { ok: false, why: `${p} has a different executable bit` };
  }
  return { ok: true, why: 'exact render' };
}

/** The coder Apps that open slice PRs (spec §8.5). */
const CODER_BOTS = ['clawworks-local-coder[bot]', 'clawworks-claude-coder[bot]'];
/**
 * A fix round may only push to an agent-owned slice PR (A7 on #23): open, same repo, opened
 * by a coder App, on a branch named agent/<issue>-local|claude. Returns a reason, or '' if OK.
 */
/**
 * blackjack#131 (team v2.22): the open agent PRs a new slice PR supersedes. When the ladder moves a slice to its next
 * attempt and opens a new PR, the earlier attempt's PR stays open and holds a WIP slot. These are the ones to close:
 * open; not the new PR (`keep`); from this repo (a fork is never closed); on exactly the ladder's branch for this
 * slice, `agent/<issue>-(local|claude)` (so another slice, a retro or a human branch never matches); opened by a
 * coder App (never a person or another App); based on main. Pure: never throws, odd input gives [].
 */
function supersededSlicePrs(openPrs, { issue, keep, repo } = {}) {
  if (!Array.isArray(openPrs) || !Number.isInteger(Number(issue)) || Number(issue) <= 0) return [];
  const branch = new RegExp(`^agent/${String(Number(issue))}-(local|claude)$`);
  return openPrs.filter((p) => p && p.state === 'open' && p.number !== keep
    && p.head?.repo?.full_name === repo && branch.test(p.head?.ref || '')
    && CODER_BOTS.includes(p.user?.login) && p.base?.ref === 'main');
}

/**
 * Close the PRs a new slice PR supersedes (blackjack#131), with I/O injected so it is testable: `gh(method, url, body)`
 * and `all(url)`. Comments, then closes, each one (the branch is kept); a failure is reported once on the slice issue
 * and never thrown, because the new PR is already open. Returns the closed PR numbers.
 */
async function closeSuperseded({ gh, all, issue, implementer, newPr, repo, newBranch, owner = OWNER }) {
  const closed = [], failed = [];
  let open;
  try { open = await all(`/repos/${repo}/pulls?state=open&base=main`); } catch (e) { failed.push({ n: null, why: e.message }); }
  for (const p of open ? supersededSlicePrs(open, { issue, keep: newPr, repo }) : []) {
    try {
      await gh('POST', `/repos/${repo}/issues/${p.number}/comments`, { body: `Superseded by #${newPr} (${newBranch}): the ladder moved this slice to the next attempt, and this PR's work went to it as hand-off hints. Closed by the ladder (#131).` });
      await gh('PATCH', `/repos/${repo}/pulls/${p.number}`, { state: 'closed' });
      closed.push(p.number);
    } catch (e) { failed.push({ n: p.number, why: e.message }); }
  }
  for (const f of failed) {
    try {
      const role = implementer === 'local' ? 'Local Coder (A3a)' : 'Claude Coder (A3b)';
      const what = f.n ? `#${f.n}` : 'superseded PRs for this slice';
      await gh('POST', `/repos/${repo}/issues/${issue}/comments`, { body: `ROLE: ${role}   ITEM: #${issue}   RESULT: needs-human\nWHAT CHANGED: Could not close ${what} automatically: ${String(f.why).slice(0, 300)}. It still counts toward WIP.\nEVIDENCE: new PR #${newPr}\nRISKS / ASSUMPTIONS: none\nNEXT: @${owner} close ${what}?` });
    } catch { /* the new PR is open; never fail publish over this */ }
  }
  return closed;
}

const OWNER_CHANGES_MARKER = (id) => `<!-- owner-changes:${id} -->`;
/**
 * Delmar's change request starts a fix round (#337 follow-up). His job is to point out gaps; on 2026-11-25 nothing
 * acted on a change request of his: only AI-review and A7 findings started a fix round. Given the PR, its reviews and
 * its comments: when his latest review on the current head asks for changes and no fix round was started for that
 * review, the round to start ({ reviewId, issue, impl }, or { reviewId, noSlice } for a PR with no `Closes #n`).
 * Otherwise null. His words reach the coder in the fix-round prompt (implement.yml).
 */
function ownerChangesPlan({ pr, reviews = [], comments = [], owner = OWNER }) {
  if (!pr || pr.state !== 'open') return null;
  const mine = reviews.filter((r) => r.user && r.user.login === owner && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED'].includes(r.state))
    .filter((r) => r.state !== 'COMMENTED');
  const last = mine[mine.length - 1];
  if (!last || last.state !== 'CHANGES_REQUESTED' || last.commit_id !== pr.head.sha) return null;
  if (comments.some((c) => String(c.body || '').includes(OWNER_CHANGES_MARKER(last.id)))) return null;
  const issue = closingIssues(pr.body)[0] || null;
  if (!issue) return { reviewId: last.id, noSlice: true };
  const impl = (pr.labels || []).some((l) => (l.name || l) === 'impl:local') ? 'local' : 'claude';
  return { reviewId: last.id, issue, impl };
}

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

/**
 * Team v2.28.2 (H, 2026-11-24: "if I should not action it, it should not be assigned to me"). When an ask's label
 * comes off an issue, unassign the owner at once instead of at the health watcher's next hourly run, but only:
 *  - on an issue, not a PR (a PR's assignment follows its tier-approval, which the watcher's queue tracks);
 *  - when no ask label is left and it isn't an incident (both stay in his queue);
 *  - when his latest assignment there was made by the console App. The timeline API names the App as the
 *    actor (the events API names him, blackjack#45), so an assignment he or anyone made by hand is never removed.
 * timeline: the issue's timeline events, oldest first. Returns { unassign, why }.
 */
const OWNER_ASK_LABELS = ['needs-human', 'status:awaiting-human', 'incident'];
const CONSOLE_APP_BOT = 'clawworks-console[bot]';
function ownerUnassign({ isPr, labels, timeline }, owner = OWNER) {
  if (isPr) return { unassign: false, why: 'a PR: its assignment follows tier-approval' };
  const names = (labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const left = names.filter((n) => OWNER_ASK_LABELS.includes(n));
  if (left.length) return { unassign: false, why: `still asks ${owner} (${left.join(', ')})` };
  const last = (timeline || []).filter((e) => (e.event === 'assigned' || e.event === 'unassigned') && e.assignee && e.assignee.login === owner).pop();
  if (!last || last.event !== 'assigned') return { unassign: false, why: `not assigned to ${owner}` };
  if (!last.actor || last.actor.login !== CONSOLE_APP_BOT) return { unassign: false, why: `assigned by ${(last.actor && last.actor.login) || 'unknown'}, not the console: never removed` };
  return { unassign: true, why: 'the ask ended and the console made the assignment' };
}

// ---------------------------------------------------------------- GitHub API retries

/**
 * SecurityClaw#39 (team v2.28.4): a one-off 504 from POST /statuses failed the template-render check and nothing
 * re-ran it. Which calls may be retried: reads (GET, HEAD), DELETE, and status POSTs (a status is a "latest wins"
 * record, so posting it twice is harmless). Never PUT (merge, update-branch), PATCH or any other POST.
 */
function retryableCall(method, url) {
  const m = String(method).toUpperCase();
  if (['GET', 'HEAD', 'DELETE'].includes(m)) return true;
  return m === 'POST' && /\/statuses\/[^/?]+(\?|$)/.test(String(url));
}
const RETRY_STATUSES = [502, 503, 504];
/**
 * Run `attempt()` (one fetch, resolving to a Response) and retry a retryable call up to `retries` times, with
 * backoff, on 502/503/504 or a network error (fetch rejects). A 4xx, or any other status, is returned at once.
 * Returns the last Response; rethrows the last network error.
 */
async function withRetry(attempt, { method, url, retries = 3, delayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  const may = retryableCall(method, url);
  for (let i = 0; ; i++) {
    let res; let err;
    try { res = await attempt(); } catch (e) { err = e; }
    const transient = err || RETRY_STATUSES.includes(res.status);
    if (!transient || !may || i >= retries) { if (err) throw err; return res; }
    log(`${method} ${url}: ${err ? `network error (${String(err.message).slice(0, 80)})` : res.status}; retry ${i + 1} of ${retries}`);
    await sleep(delayMs * 2 ** i);
  }
}

module.exports = {
  retryableCall, withRetry, STALE_CI_CONCLUSIONS,
  digestStamp, ownerUnassign, OWNER_ASK_LABELS, CONSOLE_APP_BOT,
  OWNER, GATE_BOT, MERGE_BOT, REQUIRED_STATUSES, REQUIRED_CHECK,
  parseRiskRules, globToRegExp, tierForPath, riskFloor, effectiveTier,
  parseAutonomyLevel, effectiveLevel, requiredApprovals,
  ownerApproval, ownerReviewAction, templateApproval, headApproval, tierApprovalStatus, qaLine, closingIssues, qaDispatchDecision, coolingStatus, gitBlobSha, renderMatch, renderDirection, waiverCarries,
  parseWaiveCommands, securityMarker, readSecurityMarker, uniqueFindingIds, inert, securityWaiverState,
  trustedStatuses, fixRoundFrom, roundCapPlan, ownerChangesPlan, OWNER_CHANGES_MARKER, ROUND_CAP_MARKER, sourceLine, qaCoveredPrs, runnerLost, qaRetryAction, qaReportPlan, releaseRetryAction, mergeVerdict, guardCommits, guardVerdict, guardPrNumber, revertTrailer, GUARD_MARKER, guardActiveFor,
  dublinHour, dublinDate, digestDue, decideFindings, applyRepro, carryOverRefusal, reviewRetryAction, ciRetryAction, modelNeverRan, parseLadderResume, MAX_NEVER_RAN, reviewRound, reviewedHead, roundKeepsPure, splitProposal, templatePathFor, retargetPatch, declaredSpecTier, specApprovalDefaulted, isUsageLimited, execMessages, metricsRecord, metricsNotice, deniedTools, finalResult, nextRung, POLICY_RE, changedPaths, policyViolations, slicePolicyCheck, sliceConsoleReason, SLICE_CONSOLE_REASONS, sliceCheckResult, sliceCheckActions, SLICE_CHECK_BOTS, CODER_BOTS, fixRoundRefusal, supersededSlicePrs, closeSuperseded, parseManualChecks, t3Verdict,
};
