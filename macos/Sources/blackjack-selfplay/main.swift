// blackjack-selfplay: plays basic strategy through BlackjackCore (the shared
// JavaScript engine in JavaScriptCore), checks invariants on every step, and
// prints the same one-line JSON summary as `node agent/examples/selfplay.js`,
// so CI can confirm Swift and Node agree for a seed.
//
//   blackjack-selfplay [--rounds N] [--seed S] [--bet B] [--bankroll N]

import Foundation
import BlackjackCore

func option(_ name: String, _ fallback: String) -> String {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return fallback }
    return args[i + 1]
}

if CommandLine.arguments.contains("--help") || CommandLine.arguments.contains("-h") {
    print("usage: blackjack-selfplay [--rounds N] [--seed S] [--bet B] [--bankroll N]")
    exit(0)
}

let rounds = Int(option("--rounds", "1000")) ?? 1000
let seed = option("--seed", "selfplay")
let bet = Double(option("--bet", "10")) ?? 10
let bankroll = Double(option("--bankroll", "100000")) ?? 100_000

/// Numbers as JavaScript's JSON.stringify writes them (no ".0" on whole numbers).
func format(_ x: Double) -> String {
    x == x.rounded() && abs(x) < 1e15 ? String(Int(x)) : String(x)
}

var violations: [String] = []
func check(_ ok: Bool, _ what: @autoclosure () -> String) {
    if !ok && violations.count < 20 { violations.append(what()) }
}

do {
    let table = try Table(seed: seed, bankroll: bankroll)
    var played = 0
    var before = try table.observe().bankroll
    while played < rounds, try !table.observe().broke {
        var res = try table.deal(bet)
        var steps = 0
        while true {
            let obs = res.obs
            let seen = obs.shoe.seen.values.reduce(0, +)
            check(seen + obs.shoe.cardsLeft == obs.shoe.decks * 52, "round \(played + 1): cards not conserved")
            check(obs.phase == .done || obs.dealer.holeCardHidden, "round \(played + 1): hole card shown mid-round")
            check(!obs.legal.isEmpty || obs.broke, "round \(played + 1): no legal actions")
            if res.done { break }
            steps += 1
            if steps > 64 { check(false, "round \(played + 1): did not finish"); break }
            guard let hint = try table.hint() else { check(false, "round \(played + 1): no hint mid-round"); break }
            res = try table.act(hint.action)
        }
        check(abs(res.obs.bankroll - before - res.reward) < 0.001, "round \(played + 1): reward is not the bankroll change")
        before = res.obs.bankroll
        played += 1
    }
    let final = try table.observe().bankroll
    let net = (final - bankroll) * 100
    // Same keys and order as agent/examples/selfplay.js.
    print("{\"seed\":\"\(seed)\",\"rounds\":\(played),\"bet\":\(format(bet)),\"bankroll\":\(format(final)),\"net\":\(format(net.rounded() / 100))}")
} catch {
    FileHandle.standardError.write(Data("error: \(error)\n".utf8))
    exit(2)
}

if !violations.isEmpty {
    FileHandle.standardError.write(Data(("FAIL: invariant violations\n" + violations.joined(separator: "\n") + "\n").utf8))
    exit(1)
}
