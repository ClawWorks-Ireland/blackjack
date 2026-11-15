# 03-shoe-not-renewed: Deck not reshuffled: at the cut card the remaining cards are reshuffled instead of a full new shoe

- **File / function:** `engine/blackjack.js` · `Game.freshShoe`
- **Expected severity:** Important
- **Expected lens:** state (any lens finding it counts)
- **Failing input:** Unseeded 6-deck game: after the cut card the shoe has ~78 cards instead of 312, and dealt cards never come back.
- **Caught by `npm test` today:** yes (fail 5)

## How to use
Apply `bug.patch` to `main` in a scratch branch, present the diff to the review pipeline (hunters → verifiers) as an ordinary PR, and score it:
- **Hit** = a kept (≥ 2/3 votes) Important finding that names `Game.freshShoe` (or `engine/blackjack.js` at the changed line) with this failure.
- **Miss** = no kept Important finding about it.
False Important findings elsewhere on the same diff count against precision (T3: ≥ 8/10 hits, ≤ 2 false Important).
