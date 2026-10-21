// BlackjackCore runs the shared JavaScript engine; these tests check the
// bridge and the game as seen from Swift. Rules correctness is tested once,
// in ../engine and ../agent (npm test).

import Foundation
import XCTest
@testable import BlackjackCore

final class TableTests: XCTestCase {

    /// Play `rounds` rounds of basic strategy; returns every step result.
    private func playBasic(_ table: Table, rounds: Int, bet: Double = 10) throws -> [StepResult] {
        var steps: [StepResult] = []
        for _ in 0..<rounds {
            var res = try table.deal(bet)
            steps.append(res)
            while !res.done {
                res = try table.act(try XCTUnwrap(table.hint()).action)
                steps.append(res)
            }
        }
        return steps
    }

    func testNewTableShowsRulesAndBettingPhase() throws {
        let obs = try Table(seed: "swift").observe()
        XCTAssertEqual(obs.phase, .betting)
        XCTAssertEqual(obs.legal, [.deal])
        XCTAssertEqual(obs.bankroll, 1000)
        XCTAssertEqual(obs.shoe.seed, "swift-1")
        XCTAssertEqual(obs.rules?.decks, 6)
        XCTAssertEqual(obs.rules?.payout, 1.5)
        XCTAssertEqual(obs.table?.maxBet, 500)
    }

    func testSameSeedSameSession() throws {
        let a = try playBasic(Table(seed: "repeat"), rounds: 100)
        let b = try playBasic(Table(seed: "repeat"), rounds: 100)
        XCTAssertEqual(a, b)
        let c = try playBasic(Table(seed: "other"), rounds: 100)
        XCTAssertNotEqual(a, c)
    }

    func testHoleCardHiddenUntilRoundEnds() throws {
        for res in try playBasic(Table(seed: "hole"), rounds: 200) {
            if res.obs.phase == .player || res.obs.phase == .insurance {
                XCTAssertEqual(res.obs.dealer.cards.count, 1)
                XCTAssertTrue(res.obs.dealer.holeCardHidden)
            }
            if res.done {
                XCTAssertGreaterThanOrEqual(res.obs.dealer.cards.count, 2)
                XCTAssertFalse(res.obs.dealer.holeCardHidden)
            }
        }
    }

    func testRewardIsBankrollChangeAndCardsAreConserved() throws {
        let table = try Table(seed: "conserve", bankroll: 100_000)
        var before = try table.observe().bankroll
        for res in try playBasic(table, rounds: 500) {
            let seen = res.obs.shoe.seen.values.reduce(0, +)
            XCTAssertEqual(seen + res.obs.shoe.cardsLeft, res.obs.shoe.decks * 52)
            if res.done {
                XCTAssertEqual(res.obs.bankroll - before, res.reward, accuracy: 0.001)
                before = res.obs.bankroll
            }
        }
    }

    func testRulesReachTheEngine() throws {
        let table = try Table(seed: "rules", rules: Rules(decks: 2, h17: true, payout: 1.2, enhc: true))
        let rules = try XCTUnwrap(table.observe().rules)
        XCTAssertEqual(rules.decks, 2)
        XCTAssertEqual(rules.h17, true)
        XCTAssertEqual(rules.payout, 1.2)
        XCTAssertEqual(rules.enhc, true)
        XCTAssertEqual(try table.observe().shoe.cardsLeft, 104)
    }

    func testErrorsComeBackAsTableErrors() throws {
        let table = try Table(seed: "strict")
        XCTAssertThrowsError(try table.act(.hit)) { error in
            XCTAssertTrue((error as? TableError)?.message.contains("not legal now") ?? false, "\(error)")
        }
        XCTAssertThrowsError(try table.deal(5000)) { error in
            XCTAssertTrue((error as? TableError)?.message.contains("Maximum bet") ?? false, "\(error)")
        }
        XCTAssertThrowsError(try Table(rules: Rules(decks: 3))) { error in
            XCTAssertTrue((error as? TableError)?.message.contains("decks") ?? false, "\(error)")
        }
        // A failed action changes nothing.
        XCTAssertEqual(try table.observe().phase, .betting)
        XCTAssertNoThrow(try table.deal(10))
    }

    func testCardFaces() {
        XCTAssertEqual(CardFace("Td"), CardFace("Td"))
        XCTAssertEqual(CardFace("Td")?.rank, "10")
        XCTAssertEqual(CardFace("Td")?.suit, "♦")
        XCTAssertEqual(CardFace("As")?.isRed, false)
        XCTAssertNil(CardFace("Xx"))
    }

    /// Swift and Node run the same JavaScript, so the same seed and policy must
    /// end with the same bankroll. Skipped when `node` is not on PATH.
    func testMatchesNodeForTheSameSeed() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../..").standardizedFileURL
        let script = repo.appendingPathComponent("agent/examples/selfplay.js").path
        guard FileManager.default.fileExists(atPath: script) else { throw XCTSkip("agent/examples/selfplay.js not found") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", script, "--rounds", "300", "--seed", "cross", "--bet", "10"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do { try process.run() } catch { throw XCTSkip("node is not available: \(error)") }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw XCTSkip("node exited \(process.terminationStatus)") }
        struct Summary: Decodable { let rounds: Int; let bankroll: Double }
        let node = try JSONDecoder().decode(Summary.self, from: pipe.fileHandleForReading.readDataToEndOfFile())

        let table = try Table(seed: "cross", bankroll: 100_000)
        _ = try playBasic(table, rounds: 300)
        XCTAssertEqual(node.rounds, 300)
        XCTAssertEqual(try table.observe().bankroll, node.bankroll)
    }
}
