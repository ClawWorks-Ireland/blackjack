// View model: holds a BlackjackCore.Table and the latest observation. The
// table (the shared JavaScript engine) decides everything; the UI only shows
// `obs` and offers `obs.legal`.

import Foundation
import BlackjackCore

@MainActor
final class GameModel: ObservableObject {
    @Published private(set) var obs: Observation?
    @Published private(set) var message = "Place your bet to start."
    @Published private(set) var hintText: String?
    @Published var bet: Double = 10
    @Published var seedText = ""

    private var table: Table?

    init() {
        newTable()
    }

    /// Start a fresh table, seeded from `seedText` (blank picks a seed).
    func newTable() {
        let seed = seedText.trimmingCharacters(in: .whitespaces)
        do {
            let table = try Table(seed: seed.isEmpty ? nil : seed)
            self.table = table
            obs = try table.observe()
            seedText = ""
            hintText = nil
            message = "New table. Place your bet to start."
        } catch {
            message = "\(error)"
        }
    }

    var legal: [Action] { obs?.legal ?? [] }

    func deal() {
        perform { try $0.deal(bet) }
    }

    func act(_ action: Action) {
        perform { try $0.act(action) }
    }

    func showHint() {
        guard let table else { return }
        do {
            hintText = try table.hint().map { "Basic strategy: \(Self.label($0.action)). \($0.reason)." }
        } catch {
            message = "\(error)"
        }
    }

    private func perform(_ step: (Table) throws -> StepResult) {
        guard let table else { return }
        do {
            let res = try step(table)
            obs = res.obs
            hintText = nil
            message = res.done ? Self.summary(res) : Self.prompt(res.obs)
        } catch {
            message = "\(error)"
        }
    }

    static func label(_ action: Action) -> String {
        switch action {
        case .deal: return "Deal"
        case .hit: return "Hit"
        case .stand: return "Stand"
        case .double: return "Double"
        case .split: return "Split"
        case .surrender: return "Surrender"
        case .insurance: return "Insurance"
        case .declineInsurance: return "No insurance"
        }
    }

    private static func prompt(_ obs: Observation) -> String {
        if obs.phase == .insurance {
            return obs.insurance.evenMoney ? "Even money?" : "Insurance for \(money(obs.insurance.cost))?"
        }
        if let i = obs.active, obs.hands.count > 1 { return "Hand \(i + 1) of \(obs.hands.count): your move." }
        return "Your move."
    }

    private static func summary(_ res: StepResult) -> String {
        let outcomes = res.obs.hands.compactMap { $0.result?.outcome }.joined(separator: ", ")
        let net = res.reward == 0 ? "even" : (res.reward > 0 ? "+" : "−") + money(abs(res.reward))
        return "\(outcomes.capitalized): \(net)."
    }

    static func money(_ x: Double) -> String {
        x == x.rounded() ? "$\(Int(x))" : String(format: "$%.2f", x)
    }
}
