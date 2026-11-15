const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('./lib.js');

const RISK = fs.readFileSync(path.join(__dirname, '../../RISK.md'), 'utf8');
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

test('RISK.md: docs and tests are Tier 0, engine Tier 1, policy and server Tier 2', () => {
  const t = (p) => G.tierForPath(p, rules);
  assert.equal(t('README.md'), 0);
  assert.equal(t('engine/blackjack.test.js'), 0);
  assert.equal(t('qa/reports/abc1234.md'), 0);
  assert.equal(t('engine/blackjack.js'), 1);
  assert.equal(t('web/app.js'), 1);
  assert.equal(t('some/new/file.txt'), 1);
  for (const p of ['CLAUDE.md', 'REVIEW.md', 'RISK.md', '.agents/SPEC.md', '.claude/agents/release-manager.md',
    '.github/workflows/merge.yml', 'scripts/rollback', 'scripts/gates/lib.js', 'server/server.js', 'server/README.md',
    'package.json', 'evals/review/01-ace/case.md', '.mcp.json', 'macos/scripts/ci.sh']) assert.equal(t(p), 2, p);
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
  assert.equal(G.parseAutonomyLevel(fs.readFileSync(path.join(__dirname, '../../.agents/PROJECT.md'), 'utf8')), 0);
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
