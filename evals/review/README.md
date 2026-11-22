# Reviewer eval set (spec §10.2, REQ-IMP-1/2, T3)

17 planted bugs specific to BlackJack, each a real patch: cases 01–10 are patches against `main` at e284836 (2026-11-14), and later cases name their own base in their row. A10 adds a case after every revert or incident (REQ-IMP-1). Any change to a reviewer prompt (`.claude/agents/bug-hunter-*.md`, `finding-verifier.md`) or to `REVIEW.md` must replay this set and show recall didn't drop (REQ-IMP-2). This directory is Tier 2 (RISK.md).

| Case | Bug | Caught by `npm test` today |
|---|---|---|
| 01-ace-demotion | only one ace demoted 11→1 (spec T3 "ace valued wrong") | yes |
| 02-dealer-hard-17 | H17 dealer also hits hard 17 (spec T3 "dealer hits soft 17 incorrectly") | yes |
| 03-shoe-not-renewed | cut card reshuffles the remainder, not a new shoe (spec T3 "deck not reshuffled") | yes |
| 04-split-21-blackjack | split 21 paid as a blackjack | yes |
| 05-double-soft | restricted doubling allows soft totals | yes |
| 06-hilo-seven | Hi-Lo counts 7 as +1 (unbalanced) | yes |
| 07-money-floor | money formatting truncates cents | **no** |
| 08-colored-mixed-swap | Perfect Pairs colored/mixed swapped | yes |
| 09-folded-wins-pot | poker: folded seat eligible for pots | yes, by hanging `agent/poker-scout.test.js` |
| 10-qka-straight | 21+3 misses Q-K-A straight | yes |
| 11-guard-second-parent | main-guard judges second-parent commits of a merge (incident #12; patch against main after #12's fix) | yes, by `scripts/gates/guard-commits.test.js` |
| 12-local-relative-paths | local implementer uses relative prompt/log paths after `cd` into the worktree (incident #16; patch against main after #16's fix) | yes, by `scripts/agents/local-implement.test.js` |
| 13-throttle-whole-log | usage-limit detection scans the whole execution log, so `rate_limit_event` opens a false `throttled` issue (incidents #21, #20; patch against main after #21's fix) | yes, by `scripts/gates/lib.test.js` |
| 14-ladder-drops-handoff | local attempt 2 doesn't get attempt 1's work in progress (incident #21; patch against main after #21's fix) | yes, by `scripts/gates/lib.test.js` |
| 15-schema-apostrophe | an apostrophe in `.agents/schemas/hunter.json` ends the single-quoted `--json-schema '…'` argument, so every hunter fails and no review completes (incident #46, rollback of #37; patch against main after the rollback) | **no** |
| 16-owner-merge-allowed | main-guard accepts a merge by the owner when the head's gates are green, bypassing A9's merge-time checks and REQ-GATE-2 (incident #66; patch against main after the revert efc1bb0) | **no** |
| 17-break-glass-owner-merge | main-guard accepts the owner's hand merge when its commit message carries a self-written `Break-glass:` trailer, with no gate checked (incident #80; patch against main at dc35831) | **no** |

CI already catches 13 of 17; it misses 07, 15, 16 and 17. The set still measures **reviewer** recall: reviewers see only the diff (REQ-COMMS-2), and future bugs won't all be covered by tests. The next cases A10 adds should be ones the tests miss, like 07, 15, 16 and 17.

## Replay
```
scripts/evals/replay.js [--cases 01,07] [--out evals-results.json]
```
For each case it builds `pr-head/` (main + `bug.patch`) next to a base checkout, then runs the same agents, models, tools and schemas as `review.yml`: three blind hunters (logic, state, contract), then three verifiers voting, then `decideFindings` (≥ 2/3). It scores against `case.md`. **Hit** = a kept Important finding at the patched file/function. **Pass (T3)** = ≥ 80% of cases hit and false Important findings ≤ 20% of the case count (the original 10-case set used ≥ 8/10 and ≤ 2, spec §T3); a partial `--cases` run gets no T3 verdict. It uses the Claude subscription of whoever runs it (about 6 Claude runs per case, about 100 for the full set).
