# REVIEW.md — what reviewers check in BlackJack

Read by A4 (Self-Verifier), A5 (Bug Hunters), A6 (Verifiers) and A7 (Security), always from the **base branch** (REQ-CFG-3). Reviewers get the PR diff, this file, `RISK.md` and their own lens prompt, and nothing from the authoring session (REQ-COMMS-2).

## Severity
- **Important**: a real defect a user, agent or the project would hit. It blocks merge (G5/G6). Examples: wrong game rules or payouts, wrong money totals, a broken API/MCP/observation contract, a test that no longer tests what it claims, a crash, data loss, a security issue. You must be able to say *which input produces which wrong result*.
- **Nit**: style, naming, wording, a "could be cleaner". Never blocks (REQ-FLOW-5). Keep these rare. One line each.
- **Pre-existing**: a real defect that the PR didn't introduce. It doesn't block. It becomes a new issue (REQ-FLOW-5).
- If you can't name the failing input, it's not Important. Say what you'd need to check instead.

## Project invariants (Important if broken)
1. **Rules live only in `engine/`.** Web, agent, server and macOS code call the engine; they never re-implement rules.
2. **The macOS app embeds the current engine.** After any `engine/` or `agent/` change, `node macos/scripts/embed-engine.js` must have been run. `npm test` checks this, so a PR that edits `macos/Sources/BlackjackCore/EngineJS.generated.swift` by hand is wrong.
3. **Game rules** (see README "Table rules"):
   - Aces count 11 until the hand would bust, then 1, one ace at a time (`handValue`). `soft` means an ace still counts 11.
   - The dealer stands on 17. With `h17` on, the dealer hits **soft** 17 only (`dealerShouldHit`).
   - Blackjack pays `payout` (1.5 = 3:2, 1.2 = 6:5) and pushes against a dealer blackjack. A two-card 21 after a split is **not** a blackjack.
   - Surrender loses half the bet. Doubling follows `doubleOn` (`any`, `9-11`, `10-11`, hard totals only). Doubling after a split follows `das`. Split aces take one card each (no hit or double), and resplit aces only if `rsa`.
   - Insurance is offered only on a dealer ace and pays 2:1. Even money is insurance on a player blackjack.
   - The shoe reshuffles **between rounds** once the cut card (penetration, default 75%) has come out (`cutCardReached`), never mid-round.
   - Seeded shoes are reproducible: the same seed, shoe number and deck count give the same cards (`seededShoe`). Never call `Math.random` where a seeded `rng` is in scope.
4. **Counting:** tags per system in `engine/counting.js` (Hi-Lo: 2–6 = +1, 7–9 = 0, T/A = −1; KO's 7 = +1). Balanced systems sum to 0 over a deck. The true count divides the running count by decks *remaining*.
5. **Money:** amounts are dollars. `format.js` rounds via cents, so whole dollars show no cents and others show two decimals. Bankroll, stats and reports must add up exactly (round totals include insurance and side bets, `Game.net`).
6. **Side bets** (`sidebets.js`): Perfect Pairs 25/12/6:1, 21+3 per the table in the file header. Only the first two cards and the dealer up card count.
7. **Poker** (`engine/poker.js`): side pots come from what each seat put in. A split pot is shared equally, with odd chips going to the first winner after the button. A folded seat never wins a pot.
8. **Agent contracts:** observation fields, legal-move lists, CLI output and MCP tool names/schemas in `agent/` are used by external agents. Renaming or removing a field is Important unless the PR also updates every caller and documents it in `agent/README.md`.
9. **Server (`server/`):** home network only. Never default the bind to a public interface beyond the current `0.0.0.0` LAN default, never add auth bypasses, never write player data outside `server/data/` (git-ignored), and validate all request input. Any `server/` change is Tier 2.
10. **Web:** the service worker (`web/sw.js`) must cache every file the page needs (test F11). Keyboard and a11y behaviour is covered by `web/keys.test.js` and `web/a11y.test.js`; don't weaken those tests.

## Tests
- New behaviour comes with tests that fail without the change (G4 "tests written first").
- A PR that deletes, skips (`{ skip }`, `.todo`) or loosens an assertion must say why in the PR body. If it doesn't, that's Important.
- Run `npm test`. For `engine/`/`web/` changes, also note that a QA round (`node qa/run-round.js <sha>`) is owed after merge.

## Known footguns
- `qa/run-round.js` tests a committed snapshot (`git archive`), not the working tree, and needs port 8765 free.
- Don't serve the game with `python3 -m http.server` (it breaks parallel module loads); use `qa/serve.js` / `npm start`.
- `index.html` at the root and `web/index.html` both exist. Check which one a change belongs in.
- Small local models' feedback (`agent/feedback.js`) is often wrong. Verify it against the code before acting on it.
