// BlackjackApp: SwiftUI table on the shared engine (BlackjackCore).

import SwiftUI
import BlackjackCore

@main
struct BlackjackApp: App {
    var body: some Scene {
        WindowGroup("Blackjack") {
            ContentView()
                .frame(minWidth: 640, minHeight: 520)
        }
    }
}

struct ContentView: View {
    @StateObject private var model = GameModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if let obs = model.obs {
                dealer(obs)
                hands(obs)
            }
            Spacer(minLength: 0)
            Text(model.message).font(.headline)
            if let hint = model.hintText {
                Text(hint).foregroundStyle(.secondary)
            }
            controls
        }
        .padding(24)
        .background(Color(red: 0.04, green: 0.36, blue: 0.23))
        .foregroundStyle(.white)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Blackjack").font(.largeTitle.bold())
            Spacer()
            if let obs = model.obs {
                VStack(alignment: .trailing) {
                    Text("Bankroll \(GameModel.money(obs.bankroll))").font(.title3.monospacedDigit())
                    Text("Shoe \(obs.shoe.seed) · round \(obs.round) · \(obs.shoe.cardsLeft) cards left")
                        .font(.caption).foregroundStyle(.white.opacity(0.7))
                }
            }
        }
    }

    private func dealer(_ obs: Observation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(obs.dealer.cards.isEmpty ? "Dealer" : "Dealer · \(obs.dealer.holeCardHidden ? "shows" : "has") \(obs.dealer.total)")
                .font(.subheadline)
            HStack(spacing: 8) {
                ForEach(Array(obs.dealer.cards.enumerated()), id: \.offset) { CardView(code: $0.element) }
                if obs.dealer.holeCardHidden { CardView(code: nil) }
            }
        }
    }

    private func hands(_ obs: Observation) -> some View {
        HStack(alignment: .top, spacing: 20) {
            ForEach(Array(obs.hands.enumerated()), id: \.offset) { index, hand in
                VStack(alignment: .leading, spacing: 6) {
                    Text(handTitle(hand)).font(.subheadline)
                    HStack(spacing: 8) {
                        ForEach(Array(hand.cards.enumerated()), id: \.offset) { CardView(code: $0.element) }
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10)
                    .stroke(obs.active == index ? Color.yellow : Color.clear, lineWidth: 2))
            }
        }
    }

    private func handTitle(_ hand: Observation.Hand) -> String {
        var parts = ["\(hand.soft && hand.total < 21 ? "soft " : "")\(hand.total)", "bet \(GameModel.money(hand.bet))"]
        if let r = hand.result {
            parts.append("\(r.outcome) \(r.net >= 0 ? "+" : "−")\(GameModel.money(abs(r.net)))")
        }
        return parts.joined(separator: " · ")
    }

    private var controls: some View {
        HStack(spacing: 10) {
            if model.legal.contains(.deal) {
                Text("Bet")
                TextField("Bet", value: $model.bet, format: .number)
                    .frame(width: 80)
                    .textFieldStyle(.roundedBorder)
                    .foregroundStyle(.primary)
                    .onSubmit { model.deal() }
                Button("Deal") { model.deal() }
                    .keyboardShortcut(.return, modifiers: [])
                Spacer()
                TextField("Seed (optional)", text: $model.seedText)
                    .frame(width: 140)
                    .textFieldStyle(.roundedBorder)
                    .foregroundStyle(.primary)
                Button("New table") { model.newTable() }
            } else {
                ForEach(model.legal, id: \.self) { action in
                    Button(GameModel.label(action)) { model.act(action) }
                        .keyboardShortcut(Self.key(action), modifiers: [])
                }
                Spacer()
                Button("Hint") { model.showHint() }
                    .keyboardShortcut("?", modifiers: [])
            }
        }
        .buttonStyle(.borderedProminent)
    }

    private static func key(_ action: Action) -> KeyEquivalent {
        switch action {
        case .hit: return "h"
        case .stand: return "s"
        case .double: return "d"
        case .split: return "p"
        case .surrender: return "r"
        case .insurance: return "i"
        case .declineInsurance: return "n"
        case .deal: return .return
        }
    }
}

/// A card face, or a face-down card when `code` is nil.
struct CardView: View {
    let code: String?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(face == nil ? Color(red: 0.55, green: 0.1, blue: 0.12) : .white)
            RoundedRectangle(cornerRadius: 8).stroke(.black.opacity(0.25))
            if let face {
                VStack(spacing: 2) {
                    Text(face.rank).font(.title2.bold())
                    Text(face.suit).font(.title2)
                }
                .foregroundStyle(face.isRed ? Color.red : Color.black)
            }
        }
        .frame(width: 56, height: 80)
        .accessibilityLabel(face.map { "\($0.rank) of \($0.suit)" } ?? "face-down card")
    }

    private var face: CardFace? { code.flatMap(CardFace.init) }
}
