// Swift views of the agent environment's JSON (agent/README.md). These mirror
// what agent/env.js returns; the engine itself stays in JavaScript.

import Foundation

public enum Phase: String, Codable, Sendable {
    case betting, insurance, player, done
}

public enum Action: String, Codable, CaseIterable, Sendable {
    case deal, hit, stand, double, split, surrender, insurance
    case declineInsurance = "decline_insurance"
}

/// Table rules. Leave a field nil for the engine default.
public struct Rules: Codable, Equatable, Sendable {
    public var decks: Int?
    public var h17: Bool?
    public var payout: Double?
    public var das: Bool?
    public var lateSurrender: Bool?
    public var rsa: Bool?
    public var enhc: Bool?
    public var obo: Bool?
    public var doubleOn: String?
    public var penetration: Double?

    public init(
        decks: Int? = nil, h17: Bool? = nil, payout: Double? = nil, das: Bool? = nil, lateSurrender: Bool? = nil,
        rsa: Bool? = nil, enhc: Bool? = nil, obo: Bool? = nil, doubleOn: String? = nil, penetration: Double? = nil
    ) {
        self.decks = decks
        self.h17 = h17
        self.payout = payout
        self.das = das
        self.lateSurrender = lateSurrender
        self.rsa = rsa
        self.enhc = enhc
        self.obo = obo
        self.doubleOn = doubleOn
        self.penetration = penetration
    }
}

public struct Observation: Codable, Equatable, Sendable {
    public struct TableLimits: Codable, Equatable, Sendable {
        public let minBet: Double
        public let maxBet: Double
        public let maxSpots: Int
        public let maxHandsPerSpot: Int
        public let sideMax: Int
    }

    public struct ShoeInfo: Codable, Equatable, Sendable {
        public let seed: String
        public let decks: Int
        public let cardsLeft: Int
        public let cutCardReached: Bool
        /// Cards revealed since the last shuffle, by rank key (A 2-9 T J Q K).
        public let seen: [String: Int]
    }

    public struct Dealer: Codable, Equatable, Sendable {
        public let cards: [String]
        public let total: Int
        public let holeCardHidden: Bool
    }

    public struct HandResult: Codable, Equatable, Sendable {
        public let outcome: String
        public let net: Double
    }

    public struct Hand: Codable, Equatable, Sendable {
        public let cards: [String]
        public let total: Int
        public let soft: Bool
        public let bet: Double
        public let spot: Int
        public let fromSplit: Bool
        public let splitAces: Bool
        public let surrendered: Bool
        public let result: HandResult?
    }

    public struct Insurance: Codable, Equatable, Sendable {
        public let offered: Bool
        public let evenMoney: Bool
        public let cost: Double
        public let stake: Double
        public let net: Double?
    }

    public struct SideBet: Codable, Equatable, Sendable {
        public let bet: String
        public let stake: Double
        public let win: String?
        public let net: Double
    }

    public let phase: Phase
    public let round: Int
    public let bankroll: Double
    public let legal: [Action]
    /// Present on reset/observe; left out of step results.
    public let rules: Rules?
    public let table: TableLimits?
    public let shoe: ShoeInfo
    public let dealer: Dealer
    public let hands: [Hand]
    public let active: Int?
    public let insurance: Insurance
    public let sideBets: [SideBet]
    public let net: Double?
    public let broke: Bool
}

public struct StepResult: Codable, Equatable, Sendable {
    public let obs: Observation
    /// The round's total chip change on the step that ends it, otherwise 0.
    public let reward: Double
    public let done: Bool
}

public struct Hint: Codable, Equatable, Sendable {
    public let action: Action
    public let reason: String
}

/// A card string from the environment ("Td", "As") split for display.
public struct CardFace: Equatable, Sendable {
    public let rank: String
    public let suit: String
    public let isRed: Bool

    public init?(_ code: String) {
        guard code.count == 2, let r = code.first, let s = code.last else { return nil }
        let suits: [Character: String] = ["s": "♠", "h": "♥", "d": "♦", "c": "♣"]
        guard let suit = suits[s] else { return nil }
        rank = r == "T" ? "10" : String(r)
        self.suit = suit
        isRed = s == "h" || s == "d"
    }
}
