// A blackjack table backed by the shared JavaScript engine.
//
// The rules live in ../engine (JavaScript) and the reset/step/observe
// interface in ../agent/env.js; both are embedded (EngineJS.generated.swift)
// and run in JavaScriptCore. This file only moves JSON across the bridge, so
// the macOS app, the web game and agents all play the same game.

import Foundation
import JavaScriptCore

/// An error from the environment: an illegal action, a bad bet, an invalid rule.
public struct TableError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
}

public final class Table {
    private let context: JSContext
    private var thrown: String?

    /// - Parameters:
    ///   - seed: shoe seed ("lucky", or "lucky-5" to start at shoe 5); nil picks one.
    ///   - rules: table rules; nil fields use the engine defaults.
    public init(seed: String? = nil, rules: Rules = Rules(), bankroll: Double = 1000,
                minBet: Double = 1, maxBet: Double = 500) throws {
        guard let context = JSContext() else { throw TableError(message: "JavaScriptCore is unavailable") }
        self.context = context
        context.exceptionHandler = { [weak self] _, exception in
            self?.thrown = exception?.objectForKeyedSubscript("message")?.toString() ?? exception?.toString() ?? "unknown error"
        }
        for file in EngineJS.files {
            context.evaluateScript(file.source, withSourceURL: URL(string: "blackjack:///\(file.name)"))
            if let error = thrown { throw TableError(message: "\(file.name): \(error)") }
        }
        let options = Options(seed: seed, rules: rules, bankroll: bankroll, minBet: minBet, maxBet: maxBet)
        _ = try call("globalThis.__env = new BlackjackEnv.BlackjackEnv(JSON.parse(__arg)); 'ok'", argument: options)
    }

    /// What a seated player can see now, including the rules and limits.
    public func observe() throws -> Observation {
        try decode(call("JSON.stringify(__env.observe())"))
    }

    /// Start a round with one bet per spot (up to three).
    @discardableResult
    public func deal(_ bets: [Double], side: [String: Int] = [:]) throws -> StepResult {
        try decode(call("JSON.stringify(__env.step(JSON.parse(__arg)))", argument: DealRequest(bet: bets, side: side)))
    }

    /// Start a round with a single bet.
    @discardableResult
    public func deal(_ bet: Double) throws -> StepResult {
        try deal([bet])
    }

    /// Take a decision: hit, stand, double, split, surrender, insurance, declineInsurance.
    @discardableResult
    public func act(_ action: Action) throws -> StepResult {
        guard action != .deal else { throw TableError(message: "use deal(_:) to start a round") }
        return try decode(call("JSON.stringify(__env.step(JSON.parse(__arg)))", argument: ["action": action.rawValue]))
    }

    /// The basic-strategy play for the current decision, or nil between rounds.
    public func hint() throws -> Hint? {
        let json = try call("JSON.stringify(__env.hint())")
        return json == "null" ? nil : try decode(json)
    }

    // MARK: - Bridge

    private struct Options: Encodable {
        let seed: String?
        let rules: Rules
        let bankroll: Double
        let minBet: Double
        let maxBet: Double
    }

    private struct DealRequest: Encodable {
        let action = "deal"
        let bet: [Double]
        let side: [String: Int]
    }

    /// Run `script` with `argument` available as the JSON string `__arg`; returns the result as a string.
    private func call(_ script: String, argument: some Encodable = [String: String]()) throws -> String {
        let data = try JSONEncoder().encode(argument)
        context.setObject(String(decoding: data, as: UTF8.self), forKeyedSubscript: "__arg" as NSString)
        thrown = nil
        let value = context.evaluateScript(script)
        if let error = thrown { throw TableError(message: error) }
        guard let text = value?.toString() else { throw TableError(message: "no result from the engine") }
        return text
    }

    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
