# Blackjack for macOS

A SwiftUI app on the same engine as the web game and the agent CLI. It has
no rules of its own: `BlackjackCore` runs `agent/env.js` and the engine
files it needs in JavaScriptCore (built into macOS) and decodes the
observation JSON described in [../agent/README.md](../agent/README.md).

Requires macOS 13+ and Swift 5.9+ (Xcode 15+). Node 18+ is needed for the
CI cross-check and to regenerate the embedded engine.

## Run

```bash
macos/scripts/run-app.sh                 # build, package .build/BlackjackApp.app, open it
macos/scripts/selfplay.sh 10000 s1       # headless basic strategy, invariant checks
```

Keys: Return deals; H hit, S stand, D double, P split, R surrender, I/N
insurance; ? shows the basic-strategy hint.

## Use from Swift

```swift
import BlackjackCore

let table = try Table(seed: "s1", rules: Rules(h17: true))
var step = try table.deal(10)
while !step.done {
    step = try table.act(try table.hint()!.action)
}
print(step.reward, step.obs.bankroll)
```

Errors from the engine (illegal actions, bad bets, invalid rules) throw
`TableError` with the engine's message, and leave the table unchanged.

## The embedded engine

SwiftPM can't take resources from outside the package, so
`scripts/embed-engine.js` writes `Sources/BlackjackCore/EngineJS.generated.swift`:
`agent/env.js` plus the engine files it `require()`s, in the web page's
load order. After changing any of them:

```bash
node macos/scripts/embed-engine.js
```

`npm test` (macos/embed.test.js) and `scripts/ci.sh` fail if the generated
file is out of date.

## CI

```bash
macos/scripts/ci.sh
```

Checks the embedded engine is current, builds, runs the XCTests, and plays
2000 seeded rounds of basic strategy in both Swift and Node: the summaries
must match exactly.

## History

This app started as `delmarolivier/blackjack-macos` with its own Swift rules
engine (CLA-12 scaffold, CLA-13 rules). It moved here when both games
switched to one shared engine; the Swift engine was retired.
