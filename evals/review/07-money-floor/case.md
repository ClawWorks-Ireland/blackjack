# 07-money-floor: Money formatting truncates instead of rounding cents

- **File / function:** `engine/format.js` · `format.digits`
- **Expected severity:** Important
- **Expected lens:** contract (any lens finding it counts)
- **Failing input:** money(0.29) shows $0.28 (0.29*100 = 28.999…); money(1002.5) still looks right, which hides it.
- **Caught by `npm test` today:** no: only review can catch it

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `format.digits` (or `engine/format.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
