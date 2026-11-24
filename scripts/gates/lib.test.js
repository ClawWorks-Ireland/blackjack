const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('./lib.js');

// A small, fixed sample of risk rules. The project's own RISK.md is tested separately in
// scripts/gates/risk-rules.test.js (project-owned, written by /setup-project).
const RISK = ['```risk-rules', '0 **/*.md', '0 **/*.test.js', '2 .github/**', '2 .claude/**', '2 .agents/**',
  '2 CLAUDE.md', '2 REVIEW.md', '2 RISK.md', '2 scripts/**', '2 package.json', '2 evals/review/**', '```'].join('\n');
const rules = G.parseRiskRules(RISK);
const H = { login: 'delmarolivier', type: 'User' };
const BOT = { login: 'claude[bot]', type: 'Bot' };
const GA = { login: 'github-actions[bot]' };
const review = (user, state, commit_id, submitted_at) => ({ user, state, commit_id, submitted_at });
const status = (context, state, creator = GA, updated_at = '2026-11-14T10:00:00Z') => ({ context, state, creator, updated_at, description: '' });

test('globs: ** spans segments, * stays in one', () => {
  assert.ok(G.globToRegExp('**/*.md').test('README.md'));
  assert.ok(G.globToRegExp('**/*.md').test('a/b/c.md'));
  assert.ok(G.globToRegExp('server/**').test('server/hub.js'));
  assert.ok(!G.globToRegExp('engine/*.js').test('engine/tools/house_edge.js'));
  assert.ok(G.globToRegExp('engine/*.js').test('engine/blackjack.js'));
  assert.ok(!G.globToRegExp('package.json').test('qa/package.json'));
});

test('risk rules: last match wins; unmatched paths are Tier 1', () => {
  const t = (p) => G.tierForPath(p, rules);
  assert.equal(t('README.md'), 0);
  assert.equal(t('src/a.test.js'), 0);
  assert.equal(t('src/a.js'), 1);
  assert.equal(t('some/new/file.txt'), 1);
  for (const p of ['CLAUDE.md', 'REVIEW.md', 'RISK.md', '.agents/SPEC.md', '.claude/agents/x.md',
    '.github/workflows/merge.yml', 'scripts/rollback', 'scripts/gates/lib.js', 'package.json', 'evals/review/01/case.md']) assert.equal(t(p), 2, p);
});

test('T5 policy tamper: a PR weakening REVIEW.md is Tier 2 even if labelled tier:0', () => {
  const { floor } = G.riskFloor(['REVIEW.md', 'docs/notes.md'], rules);
  assert.equal(floor, 2);
  assert.equal(G.effectiveTier(floor, ['tier:0']), 2);
});

test('A8 may raise the floor but never lower it', () => {
  assert.equal(G.effectiveTier(0, ['tier:1']), 1);
  assert.equal(G.effectiveTier(1, ['tier:0']), 1);
  assert.equal(G.effectiveTier(1, [{ name: 'tier:2' }]), 2);
  assert.equal(G.effectiveTier(0, []), 0);
});

test('autonomy: Level 0 needs H on every PR; Tier 2 always needs H', () => {
  assert.equal(G.requiredApprovals(0, 0), 1);
  assert.equal(G.requiredApprovals(1, 0), 1);
  assert.equal(G.requiredApprovals(0, 1), 0);
  assert.equal(G.requiredApprovals(1, 3), 1);
  assert.equal(G.requiredApprovals(1, 4), 0);
  for (let l = 0; l <= 4; l++) assert.equal(G.requiredApprovals(2, l), 1);
});

test('circuit breakers: open cb:level-N issues and the unprotected cap lower the level (CB-5, CB-6)', () => {
  assert.equal(G.effectiveLevel(3, []), 2);
  assert.equal(G.effectiveLevel(3, [], { acceptUnprotected: true }), 3);
  assert.equal(G.effectiveLevel(2, ['cb:level-0']), 0);
  assert.equal(G.effectiveLevel(2, ['cb:level-1', 'incident']), 1);
  assert.equal(G.parseAutonomyLevel('project: X\nautonomy_level: 0\n'), 0);
  assert.ok(Number.isInteger(G.parseAutonomyLevel(fs.readFileSync(path.join(__dirname, '../../.agents/PROJECT.md'), 'utf8'))));
});

test('T6/T16: bot approvals and approvals of an older commit never count', () => {
  const head = 'b'.repeat(40);
  assert.equal(G.ownerApproval([review(BOT, 'APPROVED', head, '2026-11-14T10:00:00Z')], head).approved, false);
  assert.equal(G.ownerApproval([review({ login: 'someone', type: 'User' }, 'APPROVED', head, '2026-11-14T10:00:00Z')], head).approved, false);
  assert.equal(G.ownerApproval([review(H, 'APPROVED', 'a'.repeat(40), '2026-11-14T10:00:00Z')], head).approved, false);
  assert.equal(G.ownerApproval([review(H, 'APPROVED', head, '2026-11-14T10:00:00Z')], head).approved, true);
  assert.equal(G.ownerApproval([
    review(H, 'APPROVED', head, '2026-11-14T10:00:00Z'),
    review(H, 'CHANGES_REQUESTED', head, '2026-11-14T11:00:00Z'),
  ], head).approved, false);
  assert.equal(G.ownerApproval([review(H, 'COMMENTED', head, '2026-11-14T12:00:00Z')], head).approved, false);
});

test('T12 Tier 2 cooling: 24h after approval of the current head; a new push restarts it', () => {
  const head = 'c'.repeat(40);
  const reviews = [review(H, 'APPROVED', head, '2026-11-14T10:00:00Z')];
  const at = (iso) => G.coolingStatus({ tier: 2, reviews, headSha: head, now: new Date(iso) });
  assert.equal(at('2026-11-15T09:59:00Z').state, 'pending');
  assert.equal(at('2026-11-15T10:00:00Z').state, 'success');
  // new push: head changes, the old approval no longer applies
  assert.equal(G.coolingStatus({ tier: 2, reviews, headSha: 'd'.repeat(40), now: new Date('2026-11-16T00:00:00Z') }).state, 'pending');
  assert.equal(G.coolingStatus({ tier: 2, reviews, headSha: head, labels: ['tier2-cancel'], now: new Date('2026-11-16T00:00:00Z') }).state, 'failure');
  assert.equal(G.coolingStatus({ tier: 1, reviews: [], headSha: head }).state, 'success');
});

function readyPr(over = {}) {
  const head = 'e'.repeat(40);
  return {
    pr: { state: 'open', draft: false, base: { ref: 'main' }, head: { sha: head }, labels: [] },
    statuses: G.REQUIRED_STATUSES.map((c) => status(c, 'success')),
    checkRuns: [{ name: 'ci', app: { slug: 'github-actions' }, head_sha: head, status: 'completed', conclusion: 'success' }],
    reviews: [review(H, 'APPROVED', head, '2026-11-14T10:00:00Z')],
    tier: 1, level: 0, now: new Date('2026-11-14T12:00:00Z'), ...over,
  };
}

test('merge verdict: all gates green + H approval on head → merge', () => {
  const v = G.mergeVerdict(readyPr());
  assert.deepEqual(v.reasons, []);
  assert.equal(v.ok, true);
});

test('merge verdict: a stale stored tier-approval does not block when the live level needs no approval (blackjack#74)', () => {
  const p = readyPr({ tier: 1, level: 4 });
  p.reviews = [];
  p.statuses = p.statuses.map((x) => (x.context === 'tier-approval' ? status('tier-approval', 'pending') : x));
  const v = G.mergeVerdict(p);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.ok, true);
  const q = readyPr({ tier: 1, level: 0 });   // and the other way round: a stale green never replaces a live approval
  q.reviews = [];
  assert.equal(G.mergeVerdict(q).ok, false);
});

test('CI retry: only jobs that never started are re-run, once (team v2.8)', () => {
  const never = { conclusion: 'failure', steps: [] };
  const ran = { conclusion: 'failure', runner_name: 'r', steps: [{ name: 'npm test', status: 'completed', conclusion: 'failure' }] };
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 1 }, [never]), 'rerun');
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 2 }, [never]), 'none', 'once only');
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 1 }, [ran]), 'none', 'a real test failure is not retried');
  assert.equal(G.ciRetryAction({ conclusion: 'success', attempt: 1 }, [never]), 'none');
  assert.equal(G.ciRetryAction(null, [never]), 'none');
});

test('CI/classify retry: a job whose runner was lost mid-run is re-run once (team v2.23.2, PC restart 2026-11-23)', () => {
  const lost = { id: 7, conclusion: 'failure', runner_name: 'agent-vm-1-1', steps: [{ name: 'npm test', status: 'in_progress', conclusion: null }] };
  const ann = { 7: [{ message: 'The self-hosted runner lost communication with the server. Verify the machine is running' }] };
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 1 }, [lost], ann), 'rerun');
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 2 }, [lost], ann), 'none', 'once only');
  const failed = { id: 8, conclusion: 'failure', runner_name: 'r', steps: [{ name: 'npm test', status: 'completed', conclusion: 'failure' }] };
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 1 }, [failed], { 8: [{ message: 'Process completed with exit code 1.' }] }), 'none', 'a real failure is not retried');
});

test('T16 missing approval: all checks green but no H approval (or only a bot approval) → refused', () => {
  const p = readyPr();
  p.reviews = [review(BOT, 'APPROVED', p.pr.head.sha, '2026-11-14T10:00:00Z')];
  const v = G.mergeVerdict(p);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /waiting for @delmarolivier/);
});

test('statuses posted by an agent (claude[bot]) cannot satisfy a gate', () => {
  const p = readyPr();
  p.statuses = [status('ai-review', 'success', BOT), status('security', 'success'), status('tier-approval', 'success')];
  const v = G.mergeVerdict(p);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /no trusted "ai-review"/);
});

test('a later failing gate status overrides an earlier success', () => {
  const p = readyPr();
  p.statuses.push(status('security', 'failure', GA, '2026-11-14T11:00:00Z'));
  assert.equal(G.mergeVerdict(p).ok, false);
});

test('T17 serial merge: a ready PR behind main is updated first, not merged', () => {
  const v = G.mergeVerdict(readyPr({ behindBy: 2 }));
  assert.equal(v.ok, false);
  assert.equal(v.behind, true);
});

test('Tier 2 merge needs cooling elapsed and a trusted tier2-cooling status', () => {
  const p = readyPr({ tier: 2 });
  assert.equal(G.mergeVerdict(p).ok, false);
  p.now = new Date('2026-11-15T10:01:00Z');
  assert.equal(G.mergeVerdict(p).ok, false); // no tier2-cooling status yet
  p.statuses.push(status('tier2-cooling', 'success'));
  assert.equal(G.mergeVerdict(p).ok, true);
});

test('ci check must be the github-actions "ci" run on the current head', () => {
  const p = readyPr();
  p.checkRuns = [{ name: 'ci', app: { slug: 'some-other-app' }, head_sha: p.pr.head.sha, status: 'completed', conclusion: 'success' }];
  assert.equal(G.mergeVerdict(p).ok, false);
});

test('T15 main-guard: direct pushes are not allowed; A9 merges and exact reverts are', () => {
  assert.equal(G.MERGE_BOT, 'clawworks-release-manager[bot]');
  // the old shared Claude App no longer counts as A9
  assert.equal(G.guardVerdict({ sha: 'f'.repeat(40), guardActive: true, pr: { number: 1, merged_at: 'x', merged_by: { login: 'claude[bot]' }, merge_commit_sha: 'f'.repeat(40) }, headStatuses: [status('merge-evidence', 'success')] }).allowed, false);
  const sha = 'f'.repeat(40);
  assert.equal(G.guardVerdict({ sha, guardActive: true, pr: null }).allowed, false);
  assert.equal(G.guardVerdict({ sha, guardActive: false, pr: null }).allowed, true);
  const pr = { number: 7, merged_at: '2026-11-14T10:00:00Z', merged_by: { login: G.MERGE_BOT }, merge_commit_sha: sha };
  assert.equal(G.guardVerdict({ sha, guardActive: true, pr, headStatuses: [status('merge-evidence', 'success')] }).allowed, true);
  assert.equal(G.guardVerdict({ sha, guardActive: true, pr, headStatuses: [status('merge-evidence', 'success', BOT)] }).allowed, false);
  assert.equal(G.guardVerdict({ sha, guardActive: true, pr: { ...pr, merged_by: { login: 'delmarolivier' } }, headStatuses: [status('merge-evidence', 'success')] }).allowed, false);
  assert.equal(G.guardVerdict({ sha, guardActive: true, pr: null, exactRevertOf: 'abc1234', message: 'Revert x\n\nRollback-of: abc1234' }).allowed, true);
  assert.equal(G.guardVerdict({ sha, guardActive: true, pr: null, exactRevertOf: null, message: 'Rollback-of: abc1234' }).allowed, false);
});

test('main-guard finds an A9 squash merge from its subject when the commit→PR index lags (incident home-automation#7)', () => {
  assert.equal(G.guardPrNumber('Render the agent team from the template (team v2.10.2, spec v0.29) (#4)\n\nMerged-by: A9 merge.yml'), 4);
  assert.equal(G.guardPrNumber('Fix the tariff band (#123)  '), 123);
  assert.equal(G.guardPrNumber('Direct push with no PR'), null);
  assert.equal(G.guardPrNumber('Mentions (#5) mid-subject only'), null, 'only the squash suffix counts');
  assert.equal(G.guardPrNumber('Subject\n\nbody line (#9)'), null, 'the body is not the subject');
  assert.equal(G.guardPrNumber(''), null);
  // The subject only picks which PR to fetch: a direct push that names an A9-merged PR is still refused,
  // because that PR's merge commit is not this sha.
  const sha = 'e'.repeat(40);
  const other = { number: 4, merged_at: 'x', merged_by: { login: G.MERGE_BOT }, merge_commit_sha: 'd'.repeat(40) };
  assert.equal(G.guardVerdict({ sha, guardActive: true, pr: other, headStatuses: [status('merge-evidence', 'success')] }).allowed, false);
});

test('revert trailers and the Dublin digest hour', () => {
  assert.equal(G.revertTrailer('Revert "x"\n\nRollback-of: abc1234'), 'abc1234');
  assert.equal(G.revertTrailer('Main-guard-revert: 0123456789abcdef0123456789abcdef01234567').length, 40);
  assert.equal(G.revertTrailer('just a commit'), null);
  assert.equal(G.dublinHour(new Date('2026-07-01T06:30:00Z')), 7); // IST, UTC+1
  assert.equal(G.dublinHour(new Date('2026-12-01T06:30:00Z')), 6); // GMT
  assert.equal(G.dublinHour(new Date('2026-12-01T08:15:00Z')), 8); // digest hour in winter
});

test('A6 majority vote: a finding needs 2 of 3 real votes; severity by majority', () => {
  const candidates = [{ id: 'logic-1' }, { id: 'state-1' }, { id: 'contract-1' }];
  const votes = [
    { votes: [{ id: 'logic-1', vote: 'real', severity: 'Important' }, { id: 'state-1', vote: 'real', severity: 'Nit' }, { id: 'contract-1', vote: 'false' }] },
    { votes: [{ id: 'logic-1', vote: 'real', severity: 'Important' }, { id: 'state-1', vote: 'false' }, { id: 'contract-1', vote: 'real', severity: 'Pre-existing' }] },
    { votes: [{ id: 'logic-1', vote: 'real', severity: 'Nit' }, { id: 'state-1', vote: 'false' }] },
  ];
  const d = G.decideFindings(candidates, votes);
  assert.deepEqual(d.kept.map((k) => [k.id, k.severity, k.votes]), [['logic-1', 'Important', '3/3']]);
  assert.deepEqual(d.dropped.map((k) => k.id), ['state-1', 'contract-1']);
  assert.equal(d.important.length, 1);
  // a 1-1 severity tie goes to the more severe tag
  const tie = G.decideFindings([{ id: 'x' }], [{ votes: [{ id: 'x', vote: 'real', severity: 'Nit' }] }, { votes: [{ id: 'x', vote: 'real', severity: 'Important' }] }, { votes: [] }]);
  assert.equal(tie.kept[0].severity, 'Important');
});

// Execution files as claude-code-action writes them: a JSON array of stream-json messages.
const execFile = (result, extra = []) => JSON.stringify([
  { type: 'system', subtype: 'init', session_id: 's' },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } },
  ...extra,
  { type: 'result', ...result },
]);

test('CB-4 usage-limit detection: the 2026-11-14 limit message matches', () => {
  // T13 (SETUP_REPORT): the real limit hit during setup said `You've hit your 5-hour limit`
  // with `usage_limit_reached`. Envelope reconstructed; the strings are the ones seen.
  assert.ok(G.isUsageLimited(execFile({ subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 7pm" })));
  assert.ok(G.isUsageLimited(execFile({ subtype: 'error_during_execution', is_error: true, result: '', errors: ['usage_limit_reached'] })));
  assert.ok(G.isUsageLimited(execFile({ subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1731600000' })));
  assert.ok(G.isUsageLimited(execFile({ subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429 Too Many Requests' })));
  // JSON-lines form too
  const jsonl = JSON.parse(execFile({ is_error: true, result: "You've hit your weekly limit" })).map((m) => JSON.stringify(m)).join('\n');
  assert.ok(G.isUsageLimited(jsonl));
});

test('CB-4 usage-limit detection: no false positives (incident #21 / #18)', () => {
  // Every normal run carries rate_limit_event in its stream: must not match.
  assert.ok(!G.isUsageLimited(execFile({ subtype: 'success', is_error: false, result: 'Done.' })));
  // A failed run for another reason (max turns, a gh error) with rate_limit_event in the stream.
  assert.ok(!G.isUsageLimited(execFile({ subtype: 'error_max_turns', is_error: true, result: '' })));
  assert.ok(!G.isUsageLimited(execFile({ subtype: 'success', is_error: true, result: 'GraphQL: Projects (classic) is being deprecated' },
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 429 usage_limit_reached' }] } }])));
  // A successful run whose final text quotes a limit message (A0/A10 writing about throttling).
  assert.ok(!G.isUsageLimited(execFile({ subtype: 'success', is_error: false, result: "Retro: the real one said You've hit your 5-hour limit" })));
  // No result message, empty or missing file, plain text logs.
  assert.ok(!G.isUsageLimited(JSON.stringify([{ type: 'rate_limit_event' }])));
  assert.ok(!G.isUsageLimited(''));
  assert.ok(!G.isUsageLimited('rate_limit_event usage limit reached 429'));
  assert.ok(!G.isUsageLimited('Error: tests failed'));
});

test('T11 ladder: local ×2, then Claude ×2, then re-slice; each rung gets the previous attempt (incident #21)', () => {
  const ctx = { job: 'success', retry: 0, run: '200', handoffRun: '100' };
  assert.deepEqual(G.nextRung('local', 1, ctx), { implementer: 'local', attempt: 2, handoffRun: '200', retry: 0 });
  assert.deepEqual(G.nextRung('local', 2, ctx), { implementer: 'claude', attempt: 1, handoffRun: '200', retry: 0 });
  assert.deepEqual(G.nextRung('claude', 1, ctx), { implementer: 'claude', attempt: 2, handoffRun: '200', retry: 0 });
  assert.deepEqual(G.nextRung('claude', 2, ctx), { replan: true });
  // Local attempt 1 timing out inside local-implement.sh (no commit) is a model attempt: hand it over.
  assert.deepEqual(G.nextRung('local', 1, { job: 'success', run: '43753799564' }).handoffRun, '43753799564');
  // First attempt with no context still works
  assert.deepEqual(G.nextRung('local', 1), { implementer: 'local', attempt: 2, handoffRun: '', retry: 0 });
});

test('T11 ladder: infra failure re-runs the same rung once with the hand-off it had', () => {
  for (const job of ['failure', 'cancelled']) {
    assert.deepEqual(G.nextRung('claude', 1, { job, retry: 0, run: '300', handoffRun: '200' }),
      { implementer: 'claude', attempt: 1, handoffRun: '200', retry: 1, infra: true });
    assert.deepEqual(G.nextRung('local', 2, { job, retry: '0', run: '300' }),
      { implementer: 'local', attempt: 2, handoffRun: '', retry: 1, infra: true });
  }
  // #23 review: an infra retry gets this run's own saved work in progress when it has one
  assert.deepEqual(G.nextRung('local', 1, { job: 'cancelled', retry: 0, run: 'R1', handoffRun: '', hasArtifact: true }),
    { implementer: 'local', attempt: 1, handoffRun: 'R1', retry: 1, infra: true });
  assert.deepEqual(G.nextRung('claude', 1, { job: 'failure', retry: 0, run: '300', handoffRun: '200', hasArtifact: false }),
    { implementer: 'claude', attempt: 1, handoffRun: '200', retry: 1, infra: true });
  // Second infra failure advances, handing over that run's saved work in progress
  assert.deepEqual(G.nextRung('claude', 1, { job: 'failure', retry: 1, run: '301', handoffRun: '200' }),
    { implementer: 'claude', attempt: 2, handoffRun: '301', retry: 0 });
  assert.deepEqual(G.nextRung('claude', 2, { job: 'failure', retry: 1, run: '302' }), { replan: true });
  // A local rung's second infra failure (Ollama can't serve the model) goes straight to Claude (template#12)
  assert.deepEqual(G.nextRung('local', 1, { job: 'failure', retry: 1, run: '303' }), { implementer: 'claude', attempt: 1, handoffRun: '303', retry: 0 });
});

test('fix rounds only push to agent-owned slice PRs (A7 on #23)', () => {
  const R = 'ClawWorks-Ireland/blackjack';
  const ok = { state: 'open', user: { login: 'clawworks-local-coder[bot]' }, head: { ref: 'agent/15-local', repo: { full_name: R } } };
  assert.equal(G.fixRoundRefusal(ok, R), '');
  assert.equal(G.fixRoundRefusal({ ...ok, head: { ...ok.head, ref: 'agent/15-claude' }, user: { login: 'clawworks-claude-coder[bot]' } }, R), '');
  assert.match(G.fixRoundRefusal({ ...ok, head: { ...ok.head, ref: 'main' } }, R), /not an agent slice branch/);
  assert.match(G.fixRoundRefusal({ ...ok, head: { ...ok.head, ref: 'agent-team/identities' } }, R), /not an agent slice branch/);
  assert.match(G.fixRoundRefusal({ ...ok, user: { login: 'clawworks-console[bot]' } }, R), /not a coder App/);
  assert.match(G.fixRoundRefusal({ ...ok, user: { login: 'delmarolivier' } }, R), /not a coder App/);
  assert.match(G.fixRoundRefusal({ ...ok, head: { ...ok.head, repo: { full_name: 'someone/fork' } } }, R), /not in this repo/);
  assert.match(G.fixRoundRefusal({ ...ok, state: 'closed' }, R), /not open/);
});

test('a verified attempt whose publish fails stops the ladder instead of advancing (slice #24)', () => {
  assert.deepEqual(G.nextRung('local', 1, { verified: true, publish: 'failure', run: '9' }), { publishFailed: true });
  assert.deepEqual(G.nextRung('claude', 2, { verified: true, publish: 'cancelled' }), { publishFailed: true });
  // not verified: the ladder advances as before
  assert.deepEqual(G.nextRung('local', 1, { verified: false, publish: 'skipped', run: '9', hasArtifact: true }), { implementer: 'local', attempt: 2, handoffRun: '9', retry: 0 });
});

test('#28: the digest is due on the first run after 08:00 Dublin that day, whatever kind of run', () => {
  // winter (GMT): 08:30 UTC = 08:30 Dublin
  assert.equal(G.digestDue(new Date('2026-12-01T08:30:00Z'), '2026-11-30'), true);
  assert.equal(G.digestDue(new Date('2026-12-01T07:59:00Z'), '2026-11-30'), false);   // before 08:00
  assert.equal(G.digestDue(new Date('2026-12-01T13:00:00Z'), '2026-12-01'), false);   // already written today
  assert.equal(G.digestDue(new Date('2026-12-01T22:00:00Z'), '2026-11-29'), true);    // a late run still writes it
  assert.equal(G.digestStamp('<!-- digest 2026-12-01 -->\n# Digest'), '2026-12-01');
  assert.equal(G.digestStamp('a comment-only update leaves no stamp'), null);
  // summer (IST): 07:30 UTC = 08:30 Dublin
  assert.equal(G.digestDue(new Date('2026-07-01T07:30:00Z'), '2026-06-30'), true);
  assert.equal(G.digestDue(new Date('2026-07-01T06:30:00Z'), null), false);
  assert.equal(G.dublinDate(new Date('2026-07-01T23:30:00Z')), '2026-07-02');                   // after midnight Dublin
});

test('#14: T3 verdict scales with the eval set; partial replays get none', () => {
  assert.equal(G.t3Verdict(8, 10, 2), true);
  assert.equal(G.t3Verdict(7, 10, 0), false);
  assert.equal(G.t3Verdict(10, 10, 3), false);
  assert.equal(G.t3Verdict(12, 14, 2), true);    // 86%, 2 ≤ 2.8
  assert.equal(G.t3Verdict(11, 14, 0), false);   // 79%
  assert.equal(G.t3Verdict(14, 14, 3), false);   // 3 > 2.8
  assert.equal(G.t3Verdict(5, 5, 0, true), null);
  assert.equal(G.t3Verdict(0, 0, 0), null);
});

test('manual checks come from the overlay as "<path regex> => <message>"', () => {
  const md = 'project: X\nmanual_checks:\n  - ^(web/|engine/) => QA round owed\n  - ^macos/ => macOS CI owed\n  - just a note without arrow\nnext_key: 1\n';
  const c = G.parseManualChecks(md);
  assert.deepEqual(c.map((x) => x.message), ['QA round owed', 'macOS CI owed']);
  assert.ok(c[0].re.test('engine/x.js') && !c[0].re.test('agent/x.js'));
  assert.deepEqual(G.parseManualChecks('project: X\n'), []);
  const md2 = 'manual_checks:   # owed checks\n  - ^a/ => first   # why\n  # a comment\n\n  - ^b/ => run `x # y`\nnext_key: 1\n  - ^c/ => not in the list\n';
  assert.deepEqual(G.parseManualChecks(md2).map((x) => x.message), ['first', 'run `x # y`']);
  const md3 = "manual_checks:\n  - ^(web/ => broken regex\n  - ^b/ => don't skip this   # trailing comment\n";
  assert.deepEqual(G.parseManualChecks(md3).map((x) => x.message), ["don't skip this"]);
});

test('applyRepro: a check that passes on the PR downgrades an Important finding; one that fails confirms it (template#12)', () => {
  const kept = [{ id: 'logic-1', severity: 'Important' }, { id: 'logic-2', severity: 'Important' }, { id: 'state-1', severity: 'Important' }, { id: 'rules-1', severity: 'Nit' }, { id: 'contract-1', severity: 'Important' }];
  const out = G.applyRepro(kept, [
    { id: 'logic-1', head: 'fails', base: 'passes' },
    { id: 'logic-2', head: 'passes', base: 'passes' },
    { id: 'state-1', head: 'timeout', base: 'passes' },
    { id: 'rules-1', head: 'passes', base: 'passes' },
  ]);
  assert.match(G.applyRepro([{ id: 'x-1', severity: 'Important' }], [{ id: 'x-1', head: 'fails', base: 'fails' }])[0].repro, /inconclusive/);
  assert.equal(out[0].severity, 'Important'); assert.match(out[0].repro, /reproduced on the PR \(passes on main\)/);
  assert.equal(out[1].severity, 'Nit'); assert.match(out[1].repro, /downgraded/);
  assert.equal(out[2].severity, 'Important'); assert.match(out[2].repro, /timeout: no change/);
  assert.equal(out[3].severity, 'Nit');
  assert.equal(out[4].repro, undefined, 'no check: unchanged');
  assert.deepEqual(G.applyRepro(kept), kept);
});

test('carry-over refuses when main changed policy since the review (A7 sec-1 on blackjack#63)', () => {
  assert.equal(G.carryOverRefusal(['engine/blackjack.js', 'README.md']), null);
  for (const p of ['REVIEW.md', 'RISK.md', 'CLAUDE.md', '.claude/agents/security-reviewer.md', '.github/workflows/review.yml',
    'scripts/gates/lib.js', 'scripts/agents/policy-guard.js', 'scripts/rollback', '.agents/PROJECT.md']) {
    assert.match(G.carryOverRefusal(['web/app.js', p]), /main changed policy/, p);
  }
  assert.equal(G.carryOverRefusal([]), null);
});

test('review rounds: a pure branch update is re-reviewed in the same round (team v2.3; blackjack#62)', () => {
  assert.equal(G.reviewRound(0, false), 1, 'first review');
  assert.equal(G.reviewRound(0, true), 1, 'a first review is round 1 even after a branch update');
  assert.equal(G.reviewRound(2, false), 3, 'a coder push starts the next round');
  assert.equal(G.reviewRound(3, true), 3, 'a branch update at the cap stays at round 3, not 4');
  assert.equal(G.reviewRound(3, false), 4, 'a 4th coder round still escalates');
  assert.equal(G.reviewRound(NaN, true), 1);
});

test('review rounds: only a previous head with a review verdict counts (A7 sec-2 on blackjack#81)', () => {
  const bot = { login: 'github-actions[bot]' };
  const st = (state, description, creator = bot, context = 'ai-review') => [{ context, state, description, creator }];
  assert.equal(G.reviewedHead(st('failure', 'Round 3: 2 Important finding(s)'), 'ai-review'), true);
  assert.equal(G.reviewedHead(st('success', 'Round 1: no Important findings'), 'ai-review'), true);
  assert.equal(G.reviewedHead(st('success', 'Carried over from abc1234: same changes, only main moved'), 'ai-review'), true);
  assert.equal(G.reviewedHead(st('pending', 'AI review running'), 'ai-review'), false, 'a run cancelled before its round was recorded');
  assert.equal(G.reviewedHead(st('failure', 'Round cap (3) reached: escalated (REQ-FLOW-1)'), 'ai-review'), false, 'a capped head had no review');
  assert.equal(G.reviewedHead(st('error', 'Round 2: review failed twice'), 'ai-review'), false);
  assert.equal(G.reviewedHead([], 'ai-review'), false, 'an unreviewed first parent: a coder commit merged with main');
  assert.equal(G.reviewedHead(st('success', 'Round 1: no Important findings', { login: 'someone' }), 'ai-review'), false, 'only the workflow\'s own statuses count');
  assert.equal(G.reviewedHead(st('success', 'Round 1: x', bot, 'security'), 'ai-review'), false);
  assert.equal(G.reviewedHead(null, 'ai-review'), false);
  // The whole pure-update decision: a pure merge of main keeps the round only on a reviewed previous head.
  const u = { pure: true, why: '', prev: 'abcdef1234' };
  assert.deepEqual(G.roundKeepsPure(u, st('failure', 'Round 2: 1 Important finding(s)')), { pure: true, why: '' });
  assert.equal(G.roundKeepsPure(u, st('pending', 'AI review running')).pure, false);
  assert.equal(G.roundKeepsPure(u, []).pure, false, 'dropping the review check would make this true');
  assert.equal(G.roundKeepsPure({ pure: false, why: 'not a merge commit' }, st('success', 'Round 1: x')).pure, false);
  assert.equal(G.roundKeepsPure(null, []).pure, false);
});

test('A10 proposals: team files go to the template, project files stay (team v2.7)', () => {
  const team = new Set(['.agents/SPEC.md', 'scripts/gates/lib.js', '.github/workflows/review.yml', '.agents/TEAM_FILES']);
  assert.deepEqual(G.splitProposal(['scripts/gates/lib.js', 'evals/review/18/case.md', '.agents/TEAM_FILES', '.agents/SPEC.md'], team),
    { team: ['scripts/gates/lib.js', '.agents/SPEC.md'], project: ['evals/review/18/case.md'], generated: ['.agents/TEAM_FILES'] });
  assert.equal(G.templatePathFor('.agents/SPEC.md'), '.agents/SPEC.md');
  assert.equal(G.templatePathFor('scripts/gates/lib.js'), 'team/scripts/gates/lib.js');
  const patch = ['diff --git a/scripts/gates/lib.js b/scripts/gates/lib.js', 'index 1..2 100644', '--- a/scripts/gates/lib.js', '+++ b/scripts/gates/lib.js',
    '@@ -1 +1 @@', '-const a = 1;', '+const a = 2;', 'diff --git a/x.js b/y.js', 'rename from x.js', 'rename to y.js', '--- /dev/null'].join('\n');
  const out = G.retargetPatch(patch, G.templatePathFor).split('\n');
  assert.equal(out[0], 'diff --git a/team/scripts/gates/lib.js b/team/scripts/gates/lib.js');
  assert.equal(out[2], '--- a/team/scripts/gates/lib.js');
  assert.equal(out[3], '+++ b/team/scripts/gates/lib.js');
  assert.equal(out[5], '-const a = 1;', 'content lines are untouched');
  assert.equal(out[8], 'rename from team/x.js');
  assert.equal(out[10], '--- /dev/null');
});

test('ladder: a usage limit or a model that never ran pauses the attempt instead of using it up (blackjack#57)', () => {
  const refused = JSON.stringify([{ type: 'result', subtype: 'success', is_error: true, duration_ms: 438, num_turns: 1, total_cost_usd: 0, modelUsage: {} }]);
  const worked = JSON.stringify([{ type: 'result', subtype: 'success', is_error: true, num_turns: 14, total_cost_usd: 0.42, modelUsage: { 'claude-sonnet': { inputTokens: 9000 } } }]);
  assert.equal(G.modelNeverRan(refused), true);
  assert.equal(G.modelNeverRan(worked), false, 'a model that worked and then failed is a real attempt');
  assert.equal(G.modelNeverRan(JSON.stringify([{ type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0, modelUsage: {} }])), false);
  assert.equal(G.modelNeverRan(''), false);
  const paused = G.nextRung('claude', 2, { job: 'failure', retry: 1, neverRan: true, run: '300', hasArtifact: false, handoffRun: '200' });
  assert.deepEqual(paused, { paused: true, implementer: 'claude', attempt: 2, handoffRun: '200', retry: 1, pauses: 1 });
  // A persistent never-ran (expired auth) must not loop forever: after MAX_NEVER_RAN pauses it goes to H (blackjack#91).
  assert.equal(G.nextRung('claude', 2, { job: 'failure', retry: 1, neverRan: true, run: '300', pauses: G.MAX_NEVER_RAN - 1 }).paused, true);
  assert.deepEqual(G.nextRung('claude', 2, { job: 'failure', retry: 1, neverRan: true, run: '300', pauses: G.MAX_NEVER_RAN }), { stuck: true });
  assert.equal(G.nextRung('claude', 2, { job: 'failure', retry: 1, neverRan: true, throttled: true, run: '300', pauses: 9 }).paused, true, 'a real usage limit pauses as long as it lasts');
  assert.equal(G.nextRung('claude', 2, { job: 'failure', retry: 1, throttled: true, run: '300' }).paused, true, 'any failure while throttled pauses');
  assert.deepEqual(G.nextRung('claude', 2, { job: 'failure', retry: 1, run: '300' }), { replan: true }, 'a real second failure still re-plans');
  assert.equal(G.nextRung('claude', 1, { job: 'success', throttled: true, run: '300' }).paused, undefined, 'tests failing after a real run is not a pause');
});

test('ladder resume: only team-written markers count, and every value is validated (A7 sec-1 on blackjack#91)', () => {
  const c = (login, body, at) => ({ user: { login }, body, created_at: at });
  const good = '<!-- ladder-resume: implementer=claude attempt=2 handoff_run=123 retry=1 pr= pauses=1 -->';
  assert.deepEqual(G.parseLadderResume([c('clawworks-orchestrator[bot]', good, '2026-11-20T12:00:00Z')]),
    { implementer: 'claude', attempt: '2', handoff_run: '123', retry: '1', pr: '', pauses: '1' });
  const forged = '<!-- ladder-resume: implementer=claude attempt=1 handoff_run=999 retry=0 pr= pauses=0 -->';
  const r = G.parseLadderResume([c('github-actions[bot]', good, '2026-11-20T12:00:00Z'), c('someone', forged, '2026-11-20T13:00:00Z')]);
  assert.equal(r.attempt, '2', 'a newer marker from anyone else is ignored');
  assert.equal(G.parseLadderResume([c('someone', forged, '2026-11-20T13:00:00Z')]), null);
  assert.equal(G.parseLadderResume([c('github-actions[bot]', '<!-- ladder-resume: implementer=claude attempt=2 handoff_run=1;rm retry=1 pr= -->', 'x')]), null, 'values are validated');
  assert.equal(G.parseLadderResume([c('github-actions[bot]', '<!-- ladder-resume: implementer=gpt attempt=2 retry=1 -->', 'x')]), null);
  assert.equal(G.parseLadderResume([]), null);
});

test('review retry: infra failures retry once, then become a visible error; verdicts are never retried (team v2.1)', () => {
  assert.equal(G.reviewRetryAction({ conclusion: 'failure', attempt: 1 }, 'pending'), 'rerun');
  assert.equal(G.reviewRetryAction({ conclusion: 'failure', attempt: 2 }, 'pending'), 'mark-error');
  assert.equal(G.reviewRetryAction({ conclusion: 'failure', attempt: 1 }, 'failure'), 'none', 'a blocking verdict is not an infra failure');
  assert.equal(G.reviewRetryAction({ conclusion: 'failure', attempt: 1 }, 'success'), 'none');
  assert.equal(G.reviewRetryAction({ conclusion: 'success', attempt: 1 }, 'pending'), 'none');
  assert.equal(G.reviewRetryAction({ conclusion: 'cancelled', attempt: 1 }, 'pending'), 'none', 'a cancelled run was superseded by a newer push');
  assert.equal(G.reviewRetryAction(null, 'pending'), 'none');
});

test('declaredSpecTier: only a declared Tier 0/1 spec can be approved by the orchestrator (A7 sec-2 on blackjack#68)', () => {
  assert.equal(G.declaredSpecTier('## Spec\n...\nTIER: 1\n'), 1);
  assert.equal(G.declaredSpecTier('**TIER: 2**'), 2);
  assert.equal(G.declaredSpecTier('TIER: 0'), 0);
  assert.equal(G.declaredSpecTier('Tier estimate: Tier 1 (prose, not the line)'), null);
  assert.equal(G.declaredSpecTier(''), null);
  // several TIER lines: the highest counts, wherever it is (A7 and AI review on blackjack#68)
  assert.equal(G.declaredSpecTier('## Spec\nTIER: 0\n...\nTIER: 2\n'), 2);
  assert.equal(G.declaredSpecTier('## Spec\nAC: the writer emits a line\n  TIER: 1\n...\nTIER: 2\n'), 2);
  assert.equal(G.declaredSpecTier('TIER: 2\nlater: TIER: 0 quoted\n  TIER: 0'), 2);
  assert.equal(G.declaredSpecTier('TIER: 1\nTIER: 0'), 1);
  // any format counts (AI review round 3 on blackjack#68)
  assert.equal(G.declaredSpecTier('TIER: 0 (draft)\n- TIER: 2'), 2);
  assert.equal(G.declaredSpecTier('TIER: 0\n> TIER: 2'), 2);
  assert.equal(G.declaredSpecTier('TIER: 1\nthe spec is `TIER: 2`'), 2);
  assert.equal(G.declaredSpecTier('TIER: 1\n**TIER: 2**'), 2);
  assert.equal(G.declaredSpecTier('TIER: 7'), null);
});

test('qaCoveredPrs: a QA round covers every PR merged since the last trusted qa status (team v2.11.3)', async () => {
  // first-parent chain: d (PR 4) -> c (PR 3) -> b (no PR, direct revert) -> a (PR 1, has a qa status)
  const chain = { d: 'c', c: 'b', b: 'a', a: 'z' };
  const prAt = { d: 4, c: 3, a: 1 };
  const qaAt = { a: G.GATE_BOT };
  const fakes = (qa) => ({
    commitAt: async (s) => ({ sha: s, parents: chain[s] ? [{ sha: chain[s] }] : [] }),
    statusesAt: async (s) => (qa[s] ? [{ context: 'qa', state: 'success', creator: { login: qa[s] }, created_at: '2026-11-21T00:00:00Z' }] : []),
    prsAt: async (s) => (prAt[s] ? [{ number: prAt[s], merge_commit_sha: s }, { number: 99, merge_commit_sha: 'other' }] : []),
  });
  const nums = async (o) => (await G.qaCoveredPrs({ sha: 'd', ...o })).map((p) => p.number);
  assert.deepEqual(await nums(fakes(qaAt)), [4, 3]);
  // a qa status from anyone but the gate bot doesn't end the walk
  assert.deepEqual(await nums(fakes({ a: 'someone' })), [4, 3, 1]);
  // bounded walk
  assert.deepEqual(await nums({ ...fakes({}), max: 1 }), [4]);
  // the round's own commit counts even if it already has a qa status (a re-run)
  assert.deepEqual(await nums(fakes({ d: G.GATE_BOT, a: G.GATE_BOT })), [4, 3]);
});

test('REQ-OPS-14 metrics record: built from the execution file, inputs validated', () => {
  const exec = JSON.stringify([
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    { type: 'assistant', message: { content: [] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 29, total_cost_usd: 0.70999180001, duration_ms: 125643,
      permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Edit' }], usage: { input_tokens: 10, output_tokens: 2000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000 } },
  ]);
  const r = G.metricsRecord(exec, { role: 'orchestrator', subject: '43', sha: 'abc1234', args: 'opus --effort high' });
  assert.deepEqual(r, { v: 1, role: 'orchestrator', subject: 43, sha: 'abc1234', attempt: null, model: 'claude-opus-5-5', effort: 'high', advisor: null,
    outcome: 'success', error: false, turns: 29, cost: 0.71, ms: 125643, denials: 2, denied: { Bash: 1, Edit: 1 }, tokens: { in: 10, out: 2000, cacheRead: 90000, cacheWrite: 5000 } });
  // the stream-json variant reports a count; a max-turns stop is an error outcome
  const lines = [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 50, total_cost_usd: 1.2, permission_denials_count: 6 })].join('\n');
  const m = G.metricsRecord(lines, { role: 'review-hunt', args: 'sonnet' });
  assert.deepEqual([m.outcome, m.error, m.denials, m.model, m.effort, m.subject], ['error_max_turns', true, 6, 'sonnet', 'default', null]);
  // no file (the run died before a result) and hostile context values
  const x = G.metricsRecord('', { role: 'Bad Role; rm', subject: '12abc', sha: 'zz', attempt: '2' });
  assert.deepEqual([x.outcome, x.error, x.role, x.subject, x.sha, x.attempt], ['no-result', true, 'unknown', null, null, 2]);
  // one line, % escaped for the workflow-command parser
  const notice = G.metricsNotice({ role: 'a', note: '100%\nx' });
  assert.ok(notice.startsWith('::notice title=team-metrics::') && !notice.includes('\n') && notice.includes('100%25'));
});

test('REQ-COORD-5: a spec approval settles by default only on an orchestrator ask that recommends approval, via the console', () => {
  const spec = { id: 1, login: 'clawworks-spec-writer[bot]', body: '## Spec\nTIER: 2' };
  const ask = { id: 2, login: 'clawworks-orchestrator[bot]', body: 'NEXT: @delmar, approve the spec? (A, recommended) yes\nDEFAULT-CHOICE: approve-spec' };
  const dflt = { id: 3, login: 'clawworks-console[bot]', body: '<!-- ask-default:2 choice:approve-spec -->\nNo answer' };
  const ON = { hours: 2, scope: 'all' };
  assert.equal(G.specApprovalDefaulted([spec, ask, dflt], ON, 'delmar'), true);
  assert.equal(G.specApprovalDefaulted([spec, ask, dflt], { hours: 2, scope: 'non-tier2' }, 'delmar'), false, 'scope');
  assert.equal(G.specApprovalDefaulted([spec, ask, dflt], { hours: 0, scope: 'all' }, 'delmar'), false, 'off');
  assert.equal(G.specApprovalDefaulted([spec, ask, { ...dflt, login: 'clawworks-orchestrator[bot]' }], ON, 'delmar'), false, 'forged by a model');
  assert.equal(G.specApprovalDefaulted([ask, dflt, spec], ON, 'delmar'), false, 'a newer spec needs a new answer');
  assert.equal(G.specApprovalDefaulted([spec, ask, { ...dflt, body: '<!-- ask-default:9 choice:approve-spec -->' }], ON, 'delmar'), false, 'default for another ask');
  // A7 sec-1 on blackjack#150: the recommendation was to send it back, so no machine-readable approve line
  const reject = { ...ask, body: 'NEXT: @delmar, approve the spec? (A, recommended) No: rework the auth section first. (B) yes' };
  assert.equal(G.specApprovalDefaulted([spec, reject, dflt], ON, 'delmar'), false, 'recommended rejection');
  assert.equal(G.specApprovalDefaulted([spec, ask, { ...dflt, body: '<!-- ask-default:2 -->' }], ON, 'delmar'), false, 'default without the choice');
  assert.equal(G.specApprovalDefaulted([spec, { ...ask, login: 'clawworks-spec-writer[bot]' }, dflt], ON, 'delmar'), false, 'asked by another bot');
});

test('REQ-OPS-15: an exact template re-render carries the template approval; nothing else does', () => {
  const head = 'c'.repeat(40);
  const tr = (state, login = 'github-actions[bot]') => ({ context: 'template-render', state, creator: { login }, updated_at: '2026-11-22T01:00:00Z' });
  assert.equal(G.tierApprovalStatus({ tier: 2, level: 4, reviews: [], headSha: head, statuses: [tr('success')] }).state, 'success');
  assert.equal(G.tierApprovalStatus({ tier: 2, level: 4, reviews: [], headSha: head, statuses: [tr('failure')] }).state, 'pending');
  assert.equal(G.tierApprovalStatus({ tier: 2, level: 4, reviews: [], headSha: head, statuses: [tr('success', 'clawworks-console[bot]')] }).state, 'pending', 'only the gate bot');
  assert.equal(G.tierApprovalStatus({ tier: 2, level: 4, reviews: [], headSha: head }).state, 'pending');
  // cooling starts at the template-render approval
  const c = G.coolingStatus({ tier: 2, reviews: [], headSha: head, statuses: [tr('success')], hours: 0, now: new Date('2026-11-22T01:00:01Z') });
  assert.equal(c.state, 'success');
});

test('REQ-OPS-15: renderMatch accepts only the exact render (content, executable bit, team files only)', () => {
  const blob = (s) => G.gitBlobSha(s);
  assert.equal(G.gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a', 'same id as git hash-object');
  const rendered = { 'scripts/gates/gate.js': { blob: blob('a'), mode: '100644' }, 'scripts/rollback': { blob: blob('r'), mode: '100755' } };
  const head = { 'scripts/gates/gate.js': { blob: blob('a'), mode: '100644' }, 'scripts/rollback': { blob: blob('r'), mode: '100755' }, 'web/app.js': { blob: blob('x'), mode: '100644' } };
  const changed = [{ filename: 'scripts/gates/gate.js', status: 'modified' }, { filename: '.agents/TEAM_SOURCE', status: 'modified' }];
  assert.deepEqual(G.renderMatch({ changed, rendered, head }), { ok: true, why: 'exact render' });
  assert.equal(G.renderMatch({ changed: [...changed, { filename: 'web/app.js', status: 'modified' }], rendered, head }).ok, false, 'a project file rides along');
  assert.equal(G.renderMatch({ changed, rendered, head: { ...head, 'scripts/gates/gate.js': { blob: blob('evil'), mode: '100644' } } }).ok, false, 'edited after render');
  assert.equal(G.renderMatch({ changed, rendered, head: { ...head, 'scripts/rollback': { blob: blob('r'), mode: '100644' } } }).ok, false, 'mode');
  const { 'scripts/rollback': _gone, ...partial } = head;
  assert.equal(G.renderMatch({ changed, rendered, head: partial }).ok, false, 'missing file');
  const dropped = [{ filename: '.github/workflows/tier2-cooling.yml', status: 'removed' }];
  assert.equal(G.renderMatch({ changed: dropped, rendered, head, baseManifest: ['.github/workflows/tier2-cooling.yml'] }).ok, true, 'a dropped team file is pruned');
  assert.equal(G.renderMatch({ changed: [{ filename: 'RISK.md', status: 'removed' }], rendered, head, baseManifest: [] }).ok, false, 'deleting a project file');
});

// ---- REQ-FLOW-9 slice check (blackjack#158)
test('slicePolicyCheck flags policy files (AC1)', () => {
  assert.deepEqual(G.slicePolicyCheck('Part of #48\n\nFiles: `evals/review/README.md`\n').policy, ['evals/review/README.md']);
  const c = G.slicePolicyCheck('Files: `engine/blackjack.js`, `.github/workflows/ci.yml:12`, `web/app.js:3-9`');
  assert.deepEqual(c.files, ['engine/blackjack.js', '.github/workflows/ci.yml', 'web/app.js']);
  assert.deepEqual(c.policy, ['.github/workflows/ci.yml']);
});

test('slicePolicyCheck ignores paths outside the Files line (AC2)', () => {
  const body = 'Part of #48\n\n**Change:** edit only docs. Don\'t touch `scripts/gates/lib.js:574` or `.agents/SETUP_REPORT.md`.\n\nFiles: `docs/x.md`\nFiles: `RISK.md`\n';
  assert.deepEqual(G.slicePolicyCheck(body), { files: ['docs/x.md'], policy: [], missing: false });
});

test('slicePolicyCheck reports a missing Files line (AC3)', () => {
  assert.equal(G.slicePolicyCheck('Part of #1\nChange: x').missing, true);
  assert.equal(G.slicePolicyCheck('Files:\n`a.js`').missing, true, 'the paths must be on the Files line');
  assert.equal(G.slicePolicyCheck('Files: a.js, b.js').missing, true, 'not backticked');
  assert.equal(G.sliceCheckResult(G.slicePolicyCheck('')), 'ok=false reason=no-files');
});

test('sliceCheckActions: team files and evals are console work; project policy files ask the owner (REQ-COORD-6)', () => {
  const evals = G.slicePolicyCheck('Files: `evals/review/README.md`');
  const a = G.sliceCheckActions(evals, { labels: [{ name: 'status:planned' }, { name: 'needs-human' }], comments: [] });
  assert.deepEqual([a.addLabels, a.removeLabels], [['console-work'], ['needs-human', 'status:planned']]);
  assert.match(a.comment, /<!-- slice-check: console -->/);
  assert.doesNotMatch(a.comment, /@/, 'no @-mention of the owner for console work');
  const team = G.sliceCheckActions(G.slicePolicyCheck('Files: `scripts/gates/lib.js`, `.github/workflows/qa.yml`'), { teamFiles: ['scripts/gates/lib.js'] });
  assert.deepEqual(team.addLabels, ['console-work']);
  // team v2.24: the overlay is rendered from the template (listed in TEAM_FILES), so changing it is console work
  const ovl = G.sliceCheckActions(G.slicePolicyCheck('Files: `.agents/PROJECT.md`'), { teamFiles: ['.agents/PROJECT.md'] });
  assert.deepEqual(ovl.addLabels, ['console-work']);
  const again = G.sliceCheckActions(evals, { labels: ['console-work'], comments: [{ user: { login: 'github-actions[bot]' }, body: a.comment }] });
  assert.deepEqual([again.addLabels, again.comment], [[], null]);
  // a project policy file is the owner's decision
  const risk = G.sliceCheckActions(G.slicePolicyCheck('Files: `RISK.md`, `engine/x.js`'), { labels: [{ name: 'status:planned' }] });
  assert.deepEqual([risk.addLabels, risk.removeLabels], [['needs-human', 'status:awaiting-human'], ['status:planned']]);
  assert.match(risk.comment, /<!-- slice-check: policy -->/);
  const forged = G.sliceCheckActions(G.slicePolicyCheck('Files: `RISK.md`'), { comments: [{ user: { login: 'someone' }, body: risk.comment }] });
  assert.ok(forged.comment, 'a marker from a non-bot does not count');
  const nf = G.sliceCheckActions(G.slicePolicyCheck('no files'), {});
  assert.deepEqual(nf.addLabels, ['needs-replan']);
  assert.match(nf.comment, /<!-- slice-check: no-files -->/);
  // CODEOWNERS is his wherever GitHub reads it, even under .github/ (blackjack#174 ai-review)
  for (const f of ['.github/CODEOWNERS', 'CODEOWNERS']) {
    const co = G.sliceCheckActions(G.slicePolicyCheck(`Files: \`${f}\``), {});
    assert.deepEqual(co.addLabels, ['needs-human', 'status:awaiting-human'], f);
  }
  // mixed evals and project policy: the owner is asked, and no A10 text (finance-insights#43 ai-review)
  const mixed = G.sliceCheckActions(G.slicePolicyCheck('Files: `evals/review/README.md`, `RISK.md`'), {});
  assert.deepEqual(mixed.addLabels, ['needs-human', 'status:awaiting-human']);
  assert.doesNotMatch(mixed.comment, /A10/);
  assert.deepEqual(G.sliceCheckActions(G.slicePolicyCheck('Files: `engine/x.js`')), { addLabels: [], removeLabels: [], comment: null });
});


test('policy lists agree: the guard, lib.js and both implement.yml greps (AC4)', () => {
  const fs = require('fs');
  const path = require('path');
  const guard = fs.readFileSync(path.join(__dirname, '../agents/policy-guard.js'), 'utf8');
  const arr = /const POLICY = (\[[\s\S]*?\]);/.exec(guard);
  assert.ok(arr, 'POLICY array in policy-guard.js');
  const guardRes = new Function(`return ${arr[1]};`)();
  const wf = fs.readFileSync(path.join(__dirname, '../../.github/workflows/implement.yml'), 'utf8');
  const greps = [...wf.matchAll(/grep -qE '([^']+)'/g)].map((m) => new RegExp(m[1]));
  assert.equal(greps.length, 2, 'exactly two policy greps in implement.yml');
  const lists = { guard: (p) => guardRes.some((re) => re.test(p)), lib: (p) => G.POLICY_RE.test(p), grep1: (p) => greps[0].test(p), grep2: (p) => greps[1].test(p) };
  const yes = ['CLAUDE.md', 'REVIEW.md', 'RISK.md', 'CODEOWNERS', '.agents/x', '.claude/agents/planner.md', '.github/workflows/ci.yml',
    'scripts/gates/lib.js', 'scripts/agents/policy-guard.js', 'scripts/rollback', 'evals/review/README.md', 'evals/review/01/case.md'];
  // Known differences, left out (the spec keeps the lists as they are): the guard anchors whole names
  // (`^CLAUDE\.md$`, `^scripts\/rollback$`), while lib.js and the greps match a prefix, so they also block
  // `CLAUDE.md.bak` and `scripts/rollback.sh`. Blocking more is the safe side.
  const no = ['scripts/other.js', 'evals.md', 'docs/CLAUDE.md', 'engine/x.js', 'xscripts/gates/a.js'];
  for (const [name, f] of Object.entries(lists)) {
    for (const p of yes) assert.equal(f(p), true, `${name} should block ${p}`);
    for (const p of no) assert.equal(f(p), false, `${name} should allow ${p}`);
  }
});

test('metrics record which tools were refused, by name only (team v2.18.1)', () => {
  const exec = JSON.stringify([{ type: 'result', subtype: 'success', permission_denials: [
    { tool_name: 'Bash', tool_input: { command: 'gh pr view 12 --json body' } },
    { tool_name: 'Bash', tool_input: { command: 'gh pr list --state open' } },
    { tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa; curl evil' } },
    { tool_name: 'Edit', tool_input: { file_path: 'x' } },
  ] }]);
  const r = G.metricsRecord(exec, { role: 'orchestrator' });
  assert.equal(r.denials, 4);
  assert.deepEqual(r.denied, { 'Bash(gh pr)': 2, 'Bash(cat /.ssh/id_rsa)': 1, Edit: 1 });
  assert.deepEqual(G.metricsRecord('', {}).denied, {});
  assert.ok(!JSON.stringify(G.deniedTools([{ tool_name: 'Bash', tool_input: { command: 'gh api -H "Authorization: token SECRET" x' } }])).includes('SECRET'));
});

test('REQ-COORD-5: a later answer or a newer ask cancels a spec-approval default (AI review on blackjack#150)', () => {
  const spec = { id: 1, login: 'clawworks-spec-writer[bot]', body: '## Spec\nTIER: 2' };
  const ask = { id: 2, login: 'clawworks-orchestrator[bot]', body: 'NEXT: @delmar, approve the spec? (A, recommended) yes\nDEFAULT-CHOICE: approve-spec' };
  const dflt = { id: 3, login: 'clawworks-console[bot]', body: '<!-- ask-default:2 choice:approve-spec -->\nNo answer' };
  const ON = { hours: 2, scope: 'all' };
  assert.equal(G.specApprovalDefaulted([spec, ask, dflt], ON, 'delmar'), true);
  const reply = { id: 4, login: 'delmar', body: 'No, rework the auth section' };
  const newer = { id: 5, login: 'clawworks-orchestrator[bot]', body: 'NEXT: @delmar, which section first? (A) auth' };
  assert.equal(G.specApprovalDefaulted([spec, ask, dflt, reply, newer], ON, 'delmar'), false, 'the review\'s failing input');
  assert.equal(G.specApprovalDefaulted([spec, ask, dflt, reply], ON, 'delmar'), false, 'his reply wins');
  assert.equal(G.specApprovalDefaulted([spec, ask, dflt, newer], ON, 'delmar'), false, 'a newer ask');
  assert.equal(G.specApprovalDefaulted([spec, ask, { id: 6, login: 'clawworks-console[bot]', body: "(B) rework\n\n_(Posted by the console on Delmar's instruction.)_" }, dflt], ON, 'delmar'), false, 'a relayed answer');
});

test('REQ-OPS-15: a rename is checked as a removal plus an addition (A7 sec-1 on blackjack#150)', () => {
  const blob = (x) => G.gitBlobSha(x);
  const rendered = { 'scripts/gates/new.js': { blob: blob('n'), mode: '100644' } };
  const head = { 'scripts/gates/new.js': { blob: blob('n'), mode: '100644' } };
  const renamedProject = [{ filename: 'scripts/gates/new.js', status: 'renamed', previous_filename: 'RISK.md' }];
  assert.equal(G.renderMatch({ changed: renamedProject, rendered, head, baseManifest: [] }).ok, false, 'a project file renamed away');
  const renamedTeam = [{ filename: 'scripts/gates/new.js', status: 'renamed', previous_filename: 'scripts/gates/old.js' }];
  assert.equal(G.renderMatch({ changed: renamedTeam, rendered, head, baseManifest: ['scripts/gates/old.js'] }).ok, true, 'a team file the template renamed');
});

test('REQ-OPS-15: template-approved renders only move forward (A7 sec-1 on home-automation#11)', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.deepEqual(G.renderDirection(a, b, 'ahead'), { ok: true, why: 'forward' });
  assert.equal(G.renderDirection(a, b, 'behind').ok, false, 'a downgrade');
  assert.equal(G.renderDirection(a, b, 'diverged').ok, false, 'a side branch');
  assert.equal(G.renderDirection(a, a, 'identical').ok, false, 'no change');
  assert.equal(G.renderDirection(null, b, null).ok, false, 'first render');
  assert.equal(G.renderDirection('unverified', b, null).ok, false, 'unverified base');
});

test('REQ-FLOW-10: metrics record the advisor a run had', () => {
  const exec = JSON.stringify([{ type: 'result', subtype: 'success' }]);
  assert.equal(G.metricsRecord(exec, { role: 'implement', args: 'sonnet --advisor opus' }).advisor, 'opus');
  assert.equal(G.metricsRecord(exec, { role: 'implement', args: 'sonnet ' }).advisor, null);
});

// ---- blackjack#128: QA and release retries after a lost runner (team v2.21)
const ok = (sha) => ({ context: 'qa', state: sha, creator: { login: 'github-actions[bot]' }, updated_at: '2026-11-21T10:00:00Z' });
async function walk(states) {
  // chain d -> c -> b -> a; states maps a commit to its qa state
  const parent = { d: 'c', c: 'b', b: 'a', a: null };
  return (await G.qaCoveredPrs({ sha: 'd',
    commitAt: async (x) => ({ sha: x, parents: parent[x] ? [{ sha: parent[x] }] : [] }),
    statusesAt: async (x) => (states[x] ? [typeof states[x] === 'string' ? ok(states[x]) : states[x]] : []),
    prsAt: async (x) => [{ number: x, merge_commit_sha: x }] })).map((p) => p.number);
}
test('qaCoveredPrs: an error round on an earlier merge does not end the walk (#128)', async () => {
  assert.deepEqual(await walk({ c: 'error', a: 'success' }), ['d', 'c', 'b']);
});
test('qaCoveredPrs: a pending round on an earlier merge does not end the walk (#128)', async () => {
  assert.deepEqual(await walk({ c: 'pending', a: 'success' }), ['d', 'c', 'b']);
});
test('qaCoveredPrs: still stops at an earlier failure; an untrusted error is ignored (#128)', async () => {
  assert.deepEqual(await walk({ b: 'failure' }), ['d', 'c']);
  assert.deepEqual(await walk({ c: { context: 'qa', state: 'success', creator: { login: 'someone' } }, b: 'success' }), ['d', 'c']);
});

const step = (name, conclusion) => ({ name, conclusion });
// Modelled on the real incidents: QA run 44897404491 (runner recorded, annotation "exit code 143") and release
// run 44909048559 (runner recorded, job failure with a cancelled step).
const lostJob = { name: 'qa', runner_name: 'agent-vm-1-1795257187', conclusion: 'failure', steps: [step('Set up job', 'success'), step('QA round', 'failure'), step('Complete job', 'success')] };
const exit143 = [{ annotation_level: 'warning', message: 'Node.js 20 is deprecated.' }, { annotation_level: 'failure', message: 'Process completed with exit code 143.' }];
test('runnerLost: the real signs, but not a cancel, a timeout, a never-started job or a success', () => {
  assert.equal(G.runnerLost(lostJob, exit143), true, 'QA run 44897404491');
  const verify = { name: 'verify', runner_name: 'agent-vm-1-1795268019', conclusion: 'failure', steps: [step('Set up job', 'success'), step('Run : no install_command in the overlay', 'cancelled')] };
  assert.equal(G.runnerLost(verify, [{ message: 'The operation was canceled.' }]), true, 'release run 44909048559');
  assert.equal(G.runnerLost({ ...lostJob, runner_name: null }), true, 'no runner recorded');
  assert.equal(G.runnerLost(lostJob, [{ message: 'The runner has received a shutdown signal.' }]), true);
  assert.equal(G.runnerLost({ ...verify, conclusion: 'cancelled' }, [{ message: 'The operation was canceled.' }]), false, "a person's cancel");
  assert.equal(G.runnerLost(lostJob, [{ message: 'The job running on runner x has exceeded the maximum execution time of 60 minutes.' }, ...exit143]), false, 'a timeout');
  assert.equal(G.runnerLost(lostJob, [{ message: 'Process completed with exit code 1.' }]), false, 'a real test failure');
  assert.equal(G.runnerLost({ ...lostJob, steps: [] }), false);
  assert.equal(G.runnerLost({ ...lostJob, conclusion: 'success' }, exit143), false);
});
test('qaRetryAction: reruns a runner-lost round on attempt 1, and only then', () => {
  const run = { run_attempt: 1, conclusion: 'failure' };
  assert.equal(G.qaRetryAction({ run, qaJob: lostJob, annotations: exit143 }).action, 'rerun');
  assert.equal(G.qaRetryAction({ run: { ...run, conclusion: 'cancelled' }, qaJob: lostJob, annotations: exit143 }).action, 'rerun');
  assert.equal(G.qaRetryAction({ run: { ...run, run_attempt: 2 }, qaJob: lostJob, annotations: exit143 }).action, 'none');
  assert.equal(G.qaRetryAction({ run, qaJob: { ...lostJob, conclusion: 'cancelled' }, annotations: [{ message: 'The operation was canceled.' }] }).action, 'none');
  assert.equal(G.qaRetryAction({ run, qaJob: { ...lostJob, steps: [step('Set up job', 'success'), step('QA round', 'success')] }, annotations: exit143 }).action, 'none');
  assert.equal(G.qaRetryAction({ run, qaJob: { ...lostJob, steps: [] }, annotations: exit143 }).action, 'none');
  assert.match(G.qaRetryAction({ run, qaJob: lostJob, annotations: exit143, newerMainRun: true }).reason, /newer main qa run/);
  assert.equal(G.qaRetryAction({ run: { run_attempt: 1, conclusion: null, status: 'in_progress' }, qaJob: lostJob, annotations: exit143, failed: true }).action, 'rerun', 'report decides before the run ends');
});
test('qaReportPlan: a retried runner-lost round posts pending and no comments (AC4)', () => {
  assert.deepEqual(G.qaReportPlan({ result: 'error', retry: true }), { state: 'pending', comment: false });
  assert.deepEqual(G.qaReportPlan({ result: 'error' }), { state: 'error', comment: true });
  assert.deepEqual(G.qaReportPlan({ result: 'pass', retry: true }), { state: 'success', comment: true });
  assert.deepEqual(G.qaReportPlan({ result: 'fail' }), { state: 'failure', comment: true });
});
test('releaseRetryAction: reruns a push release whose verify lost its runner, never a rollback or a real failure (AC2)', () => {
  const verify = { name: 'verify', runner_name: 'agent-vm-1-1795268019', conclusion: 'failure', steps: [step('Set up job', 'success'), step('Run : no install_command in the overlay', 'cancelled')] };
  const run = { event: 'push', conclusion: 'failure', run_attempt: 1 };
  assert.equal(G.releaseRetryAction({ run, jobs: [verify] }).action, 'rerun');
  assert.equal(G.releaseRetryAction({ run: { ...run, conclusion: 'failure' }, jobs: [{ ...verify, runner_name: 'agent-vm-1-1', conclusion: 'failure', steps: [step('npm test', 'failure')] }] }).action, 'none');
  assert.equal(G.releaseRetryAction({ run: { ...run, run_attempt: 2 }, jobs: [verify] }).action, 'none');
  assert.equal(G.releaseRetryAction({ run: { ...run, event: 'workflow_dispatch' }, jobs: [verify] }).action, 'none');
});

test('waiverCarries: only when main touched none of the PR\'s files (home-automation#5)', () => {
  assert.deepEqual(G.waiverCarries(['.agents/PROJECT.md'], ['web/app.js', 'README.md']).ok, true);
  const r = G.waiverCarries(['.agents/PROJECT.md', 'scripts/x.js'], ['scripts/x.js']);
  assert.equal(r.ok, false);
  assert.match(r.why, /scripts\/x\.js/);
});

// ---- home-automation#18: per-finding security waivers (A10 weekly 2026-11-23)
test('parseWaiveCommands: every waiver line in a comment, not just the first', () => {
  const w = G.parseWaiveCommands('/security-waive sec-1 tracked in #16\n/security-waive sec-2 tracked in #17\nthanks');
  assert.deepEqual(w.map((x) => x.id), ['sec-1', 'sec-2']);
  assert.equal(w[1].reason, 'tracked in #17');
  assert.deepEqual(G.parseWaiveCommands('/security-waive sec-1'), [], 'a waiver needs a reason');
  assert.deepEqual(G.parseWaiveCommands('please /security-waive sec-1 x'), [], 'only at the start of a line');
});

test('securityMarker: round-trips, and model text cannot close the comment', () => {
  const rec = { sha: 'a'.repeat(40), findings: [{ id: 'sec-1', category: 'other', file: 'x --> <!-- y', blob: 'b' }] };
  const m = G.securityMarker(rec);
  assert.equal((m.match(/-->/g) || []).length, 1);
  assert.deepEqual(G.readSecurityMarker(`text\n${m}`), rec);
  assert.equal(G.readSecurityMarker('<!-- security-findings bm90IGpzb24= -->'), null);
});

test('securityWaiverState: one waiver never greens a PR with other findings (home-automation#18)', () => {
  const S1 = '1'.repeat(40);
  const cur = { sha: S1, findings: [
    { id: 'sec-1', category: 'network-exposure', file: 'media/docker-compose.yml', blob: 'c1' },
    { id: 'sec-2', category: 'supply-chain', file: 'media/docker-compose.yml', blob: 'c1' },
    { id: 'sec-3', category: 'file-permissions', file: 'media/scripts/configure-jellyfin.py', blob: 'j1' }] };
  const comments = [
    { login: 'github-actions[bot]', body: G.securityMarker(cur) },
    { login: 'delmarolivier', body: '/security-waive sec-1 tracked in #16' },
  ];
  const st = G.securityWaiverState({ comments, current: cur, owner: 'delmarolivier' });
  assert.deepEqual(st.waived.map((w) => w.id), ['sec-1']);
  assert.deepEqual(st.open, ['sec-2', 'sec-3']);
});

test('securityWaiverState: no waiver counts on a PR that is not Tier 2 (G7)', () => {
  const cur = { sha: '1'.repeat(40), findings: [{ id: 'sec-1', category: 'web', file: 'app.js', blob: 'a1' }] };
  const comments = [
    { login: 'github-actions[bot]', body: G.securityMarker(cur) },
    { login: 'delmarolivier', body: 'thoughts first\n/security-waive sec-1 not the first line, so the waive job never ran' },
  ];
  assert.deepEqual(G.securityWaiverState({ comments, current: cur, owner: 'delmarolivier', waivable: false }).open, ['sec-1']);
  assert.deepEqual(G.securityWaiverState({ comments, current: cur, owner: 'delmarolivier', waivable: true }).open, []);
});

test('securityWaiverState: waivers from every owner comment count (a cancelled waiver run loses nothing)', () => {
  const S1 = '1'.repeat(40);
  const cur = { sha: S1, findings: [{ id: 'sec-1', category: 'a', file: 'f', blob: 'x' }, { id: 'sec-2', category: 'b', file: 'f', blob: 'x' }] };
  const comments = [
    { login: 'github-actions[bot]', body: G.securityMarker(cur) },
    { login: 'delmarolivier', body: '/security-waive sec-1 one' },
    { login: 'delmarolivier', body: '/security-waive sec-2 two' },
    { login: 'someone-else', body: '/security-waive sec-9 not the owner' },
  ];
  const st = G.securityWaiverState({ comments, current: cur, owner: 'delmarolivier' });
  assert.deepEqual(st.open, []);
  assert.deepEqual(st.unknown, []);
});

test('securityWaiverState: a waiver carries to a new head only while the waived file is unchanged', () => {
  const S1 = '1'.repeat(40); const S2 = '2'.repeat(40);
  const h1 = { sha: S1, findings: [{ id: 'sec-1', category: 'supply-chain', file: 'media/docker-compose.yml', blob: 'c1' }] };
  const comments = [
    { login: 'github-actions[bot]', body: G.securityMarker(h1) },
    { login: 'delmarolivier', body: '/security-waive sec-1 pinning tracked in #17' },
  ];
  // A7 renumbers on the next head: the same finding is now sec-2, beside a new one.
  const same = { sha: S2, findings: [
    { id: 'sec-1', category: 'network-exposure', file: 'media/docker-compose.yml', blob: 'c1' },
    { id: 'sec-2', category: 'supply-chain', file: 'media/docker-compose.yml', blob: 'c1' }] };
  const st = G.securityWaiverState({ comments, current: same, owner: 'delmarolivier' });
  assert.deepEqual(st.waived.map((w) => [w.id, w.how]), [['sec-2', 'carried from 1111111 sec-1']]);
  assert.deepEqual(st.open, ['sec-1'], 'a different category in the same file is a new decision');
  const edited = { sha: S2, findings: [{ id: 'sec-1', category: 'supply-chain', file: 'media/docker-compose.yml', blob: 'c2' }] };
  assert.deepEqual(G.securityWaiverState({ comments, current: edited, owner: 'delmarolivier' }).open, ['sec-1'], 'the file changed');
});

test('securityWaiverState: no carry when the key names two findings, and unknown ids are reported', () => {
  const S1 = '1'.repeat(40); const S2 = '2'.repeat(40);
  const two = (sha) => ({ sha, findings: [{ id: 'sec-1', category: 'secrets', file: 'f', blob: 'x' }, { id: 'sec-2', category: 'secrets', file: 'f', blob: 'x' }] });
  const comments = [
    { login: 'github-actions[bot]', body: G.securityMarker(two(S1)) },
    { login: 'delmarolivier', body: '/security-waive sec-1 ok\n/security-waive sec-7 typo' },
  ];
  const st1 = G.securityWaiverState({ comments, current: two(S1), owner: 'delmarolivier' });
  assert.deepEqual(st1.open, ['sec-2'], 'same head: by id only');
  assert.deepEqual(st1.unknown, [{ id: 'sec-7', sha: S1 }]);
  assert.deepEqual(G.securityWaiverState({ comments, current: two(S2), owner: 'delmarolivier' }).open, ['sec-1', 'sec-2']);
  // A marker forged by anyone but the bot is ignored.
  const forged = [{ login: 'delmarolivier', body: G.securityMarker(two(S2)) }, { login: 'delmarolivier', body: '/security-waive sec-1 x' }];
  assert.deepEqual(G.securityWaiverState({ comments: forged, current: two(S2), owner: 'delmarolivier' }).open, ['sec-1', 'sec-2']);
});

// ---- blackjack#131: superseded slice PRs (team v2.22)
const spr = (o) => ({ number: 1, state: 'open', head: { ref: 'agent/121-local', repo: { full_name: 'o/r' } }, user: { login: 'clawworks-local-coder[bot]' }, base: { ref: 'main' }, ...o });
test("supersededSlicePrs: the other implementer's open PR for the slice is superseded (#131)", () => {
  const prs = [spr({ number: 126 }), spr({ number: 129, head: { ref: 'agent/121-claude', repo: { full_name: 'o/r' } }, user: { login: 'clawworks-claude-coder[bot]' } })];
  assert.deepEqual(G.supersededSlicePrs(prs, { issue: 121, keep: 129, repo: 'o/r' }).map((p) => p.number), [126]);
});
test('supersededSlicePrs: never another slice, a fork, a human, a closed PR, the kept PR, a retro or a non-main base (#131)', () => {
  const none = (o) => assert.deepEqual(G.supersededSlicePrs([spr(o)], { issue: 121, keep: 999, repo: 'o/r' }), [], JSON.stringify(o));
  none({ head: { ref: 'agent/12-local', repo: { full_name: 'o/r' } } });
  none({ head: { ref: 'agent/1211-local', repo: { full_name: 'o/r' } } });
  none({ head: { ref: 'agent/121-local', repo: { full_name: 'fork/r' } } });
  none({ user: { login: 'delmarolivier' } });
  none({ user: { login: 'clawworks-orchestrator[bot]' } });
  none({ state: 'closed' });
  none({ number: 999 });
  none({ head: { ref: 'agent/retro-2026-11-21-1', repo: { full_name: 'o/r' } } });
  none({ base: { ref: 'release' } });
  assert.deepEqual(G.supersededSlicePrs([spr()], { issue: '1.*', keep: 2, repo: 'o/r' }), [], 'no regex injection');
});
test('supersededSlicePrs: empty or odd input gives an empty list and never throws (#131)', () => {
  for (const x of [[], undefined, null, 'x', [null], [{ state: 'open' }], [spr({ head: { ref: 'agent/121-local', repo: null } })], [spr({ user: undefined })], [spr({ head: undefined })], [spr({ base: undefined })]]) {
    assert.deepEqual(G.supersededSlicePrs(x, { issue: 121, keep: 2, repo: 'o/r' }), []);
  }
});
function fakeGh(fail = {}) {
  const calls = [];
  return { calls,
    gh: async (m, u, b) => { calls.push([m, u, b]); if (fail[m] && u.includes(fail.on)) throw new Error('HTTP 403'); return {}; },
    all: async (u) => { if (fail.list) throw new Error('HTTP 500'); calls.push(['LIST', u]); return [spr({ number: 126 }), spr({ number: 140, head: { ref: 'agent/121-claude', repo: { full_name: 'o/r' } }, user: { login: 'clawworks-claude-coder[bot]' } })]; } };
}
test('closeSuperseded: comments then closes each superseded PR, keeps the branch (#131)', async () => {
  const f = fakeGh();
  const closed = await G.closeSuperseded({ ...f, issue: 121, implementer: 'claude', newPr: 140, repo: 'o/r', newBranch: 'agent/121-claude' });
  assert.deepEqual(closed, [126]);
  const mine = f.calls.filter((c) => c[0] !== 'LIST');
  assert.deepEqual(mine.map((c) => [c[0], c[1]]), [['POST', '/repos/o/r/issues/126/comments'], ['PATCH', '/repos/o/r/pulls/126']]);
  assert.match(mine[0][2].body, /^Superseded by #140 \(agent\/121-claude\)/);
  assert.deepEqual(mine[1][2], { state: 'closed' });
  assert.ok(!f.calls.some((c) => /git\/refs/.test(c[1] || '')), 'the branch is never deleted');
});
test('closeSuperseded: a failed close is reported on the slice and does not throw (#131)', async () => {
  const f = fakeGh({ PATCH: true, on: '/pulls/126' });
  const closed = await G.closeSuperseded({ ...f, issue: 121, implementer: 'local', newPr: 140, repo: 'o/r', newBranch: 'agent/121-local', owner: 'delmar' });
  assert.deepEqual(closed, []);
  const report = f.calls.find((c) => c[1] === '/repos/o/r/issues/121/comments');
  assert.match(report[2].body, /Local Coder \(A3a\).*RESULT: needs-human[\s\S]*Could not close #126 automatically: HTTP 403/);
});
test('closeSuperseded: a failed listing is reported and does not throw (#131)', async () => {
  const f = fakeGh({ list: true });
  assert.deepEqual(await G.closeSuperseded({ ...f, issue: 121, implementer: 'claude', newPr: 140, repo: 'o/r', newBranch: 'agent/121-claude' }), []);
  assert.match(f.calls.find((c) => c[1] === '/repos/o/r/issues/121/comments')[2].body, /superseded PRs for this slice/);
});

test('ownerReviewAction: ask while waiting, withdraw the code-owner request when not needed (blackjack#173)', () => {
  const o = 'delmar';
  assert.equal(G.ownerReviewAction({ state: 'pending', requested: [], author: 'bot', owner: o }), 'request');
  assert.equal(G.ownerReviewAction({ state: 'pending', requested: [{ login: o }], author: 'bot', owner: o }), 'none');
  assert.equal(G.ownerReviewAction({ state: 'success', requested: [{ login: o }], author: 'bot', owner: o }), 'unrequest');
  assert.equal(G.ownerReviewAction({ state: 'success', requested: [{ login: 'someone' }], author: 'bot', owner: o }), 'none');
  assert.equal(G.ownerReviewAction({ state: 'pending', requested: [], author: o, owner: o }), 'none', 'never on his own PR');
});

test('mergeVerdict: behind main with only ai-review failing is a stale-review update (finance-insights#39)', () => {
  const p = readyPr();
  p.statuses = p.statuses.map((x) => (x.context === 'ai-review' ? { ...x, state: 'failure', description: 'Round 3: 2 Important finding(s)' } : x));
  assert.equal(G.mergeVerdict({ ...p, behindBy: 2 }).staleReview, true);
  assert.equal(G.mergeVerdict({ ...p, behindBy: 0 }).staleReview, false, 'up to date: the finding stands');
  const q = { ...p, behindBy: 2, statuses: p.statuses.map((x) => (x.context === 'security' ? { ...x, state: 'failure' } : x)) };
  assert.equal(G.mergeVerdict(q).staleReview, false, 'another gate failing: not just a stale review');
  assert.equal(G.mergeVerdict({ ...readyPr(), behindBy: 2 }).staleReview, false, 'all green: the plain behind case');
});

test('renderMatch: inherited Object keys are not team files (home-automation#12 ai-review)', () => {
  const blob = { blob: 'b', mode: '100644' };
  for (const p of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const v = G.renderMatch({ changed: [{ filename: 'a', status: 'modified' }, { filename: p, status: 'added' }], rendered: { a: blob }, head: { a: blob } });
    assert.equal(v.ok, false, p);
  }
  assert.equal(G.renderMatch({ changed: [{ filename: 'a', status: 'modified' }], rendered: { a: blob }, head: { a: blob } }).ok, true);
});

test('pull_request_target workflows run main\'s code on PRs to main only (A7 sec-1 on blackjack#194)', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '../../.github/workflows');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    const y = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/^\s*pull_request_target:/m.test(y)) continue;
    // every checkout is pinned: main for trusted code, or an explicit ref (the PR head, as data in pr-head/)
    for (const m of y.matchAll(/uses: actions\/checkout@v4[^\n]*\n\s+with: \{([^\n]*)\}/g)) {   // to the line's end: `${{ }}` has braces
      assert.match(m[1], /\bref:/, `${f}: a checkout without ref runs the PR's target branch`);
      if (!/path: pr-head/.test(m[1])) assert.match(m[1], /ref: main\b/, `${f}: trusted code must come from main`);
    }
  }
  for (const f of ['template-render.yml', 'tier-approval.yml', 'classify.yml', 'review.yml', 'security.yml']) {
    assert.ok(fs.readFileSync(path.join(dir, f), 'utf8').includes("github.event.pull_request.base.ref == 'main'"), `${f} acts on PRs to main only`);
  }
});

test('carry-over for security resets only on what A7 judges by (home-automation#18)', () => {
  // home-automation#18: A10's push-guard fix (scripts/agents/, evals/) reset the security verdict and the owner's waivers
  assert.equal(G.carryOverRefusal(['scripts/agents/push-guard.js', 'evals/review/12-x/case.md', '.claude/agents/planner.md', '.github/workflows/review.yml'], 'security'), null);
  for (const p of ['REVIEW.md', 'RISK.md', 'CLAUDE.md', 'AGENTS.md', 'CODEOWNERS', '.agents/PROJECT.md', '.claude/agents/security-reviewer.md',
    '.claude/settings.json', '.github/workflows/security.yml', 'scripts/gates/lib.js']) {
    assert.match(G.carryOverRefusal(['web/app.js', p], 'security'), /main changed policy/, p);
  }
  // the AI review keeps the wide rule
  assert.match(G.carryOverRefusal(['scripts/agents/push-guard.js']), /main changed policy/);
  assert.match(G.carryOverRefusal(['evals/review/12-x/case.md'], 'ai-review'), /main changed policy/);
});
