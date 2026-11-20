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
  const ran = { conclusion: 'failure', steps: [{ name: 'npm test' }] };
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 1 }, [never]), 'rerun');
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 2 }, [never]), 'none', 'once only');
  assert.equal(G.ciRetryAction({ conclusion: 'failure', attempt: 1 }, [ran]), 'none', 'a real test failure is not retried');
  assert.equal(G.ciRetryAction({ conclusion: 'success', attempt: 1 }, [never]), 'none');
  assert.equal(G.ciRetryAction(null, [never]), 'none');
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
