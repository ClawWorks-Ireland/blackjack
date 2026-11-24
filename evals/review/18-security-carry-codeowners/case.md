# 18-security-carry-codeowners: the security carry-over stops resetting on `.github/CODEOWNERS`

Added by A10 for incident #207 (REQ-IMP-1). PR #205 (team v2.25.0 re-render) narrowed which changes on `main` reset a carried A7 `security` verdict or an owner waiver. The AI review kept 2 Important findings (3/3 votes each) on this exact change, and A9 refused to merge. @delmarolivier then merged #205 by hand, and main-guard reverted it (`b6770fe`). The patch is the carry-over part of #205 only (`gate.js` carry-over, `lib.js` `carryOverRefusal`, the new `lib.test.js` test), against `main` at `b6770fe`. This is the one real regression that reached `main` in the incident, so it is a real miss of every layer except the AI review.

- **File / function:** `scripts/gates/lib.js` · `SECURITY_INPUTS_RE` / `carryOverRefusal`
- **Expected severity:** Important
- **Expected lens:** logic, contract or state (any lens finding it counts)
- **Failing input:** `carryOverRefusal(['.github/CODEOWNERS'], 'security')` returns `null`, so the old verdict carries. On `main` (without the patch), `carryOverRefusal(['.github/CODEOWNERS'])` returns `'main changed policy since the review (.github/CODEOWNERS)'`, because `POLICY_RE` matches the whole `.github/` prefix. `SECURITY_INPUTS_RE` anchors `CODEOWNERS` at the repo root only (`^(…|CODEOWNERS|…)`). Yet the patch's own comment lists the project's policy files as A7 inputs, and `sliceCheckActions` in the same file treats CODEOWNERS as policy "wherever GitHub reads it (.github/, docs/ or the root)". So after the patch, a change to `.github/CODEOWNERS` on `main` lets a security verdict, or an owner's waiver of an A7 finding, carry over a branch update without being judged again. (`docs/CODEOWNERS` gets no reset on `main` either. That gap is pre-existing, not the planted bug, but a finding that names it along with `.github/CODEOWNERS` still counts as a hit.)
- **Caught by `npm test` today:** **no** (616/616 pass with the patch applied on `b6770fe`). The patch's new test checks only root `CODEOWNERS`.

## How to use
Apply `bug.patch` to `main` in a scratch branch, give the diff to the review pipeline (hunters, then verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding on `SECURITY_INPUTS_RE` or `carryOverRefusal` that says `.github/CODEOWNERS` (or CODEOWNERS outside the root) no longer resets the security carry-over.
- **Miss** = no kept Important finding about it, or the finding is only a Nit.
False Important findings elsewhere on the same diff count against precision.

Note: the change is a deliberate narrowing with a real reason (owner waivers were thrown away three times on home-automation#18), and it ships passing tests. The defect is one missing path in a list. This case measures whether reviewers check an allow-list against every place the same file says the rule applies. On #205 they did (round 1, 3/3 votes). Keep it in the set so that recall stays measured.
