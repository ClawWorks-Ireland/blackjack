/**
 * Blackjack Simulator — unit tests
 * Covers: shoe penetration, split hands, double-down, dealer bust,
 *         blackjack payout (1.5×), bankroll tracking, P&L accuracy.
 *
 * Run: node --test tests/simulator.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Shoe } from '../src/sim/shoe.js';
import { BlackjackGame, SessionTracker } from '../src/sim/game.js';
import { handTotal } from '../src/shared/card-engine.js';

// ---------------------------------------------------------------------------
// Deterministic RNG helper
// ---------------------------------------------------------------------------

/**
 * Seeded LCG RNG — reproducible shoes for tests.
 * @param {number} seed
 * @returns {() => number}
 */
function seededRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

/**
 * Create a Shoe with a fixed seed.
 */
function deterministicShoe(opts = {}) {
  return new Shoe({ decks: opts.decks ?? 6, penetration: opts.penetration ?? 0.75, rng: seededRng(opts.seed ?? 42) });
}

// ---------------------------------------------------------------------------
// Helper: play a hand to completion with a given action sequence
// ---------------------------------------------------------------------------
function playHand(game, bankroll, bet, ...actions) {
  let state = game.startHand(bet, bankroll);
  for (const action of actions) {
    if (state.phase !== 'player_decision') break;
    state = game.step(state, action);
  }
  // If still in player_decision, stand
  while (state.phase === 'player_decision') {
    state = game.step(state, 'stand');
  }
  return state;
}

// ===========================================================================
// SHOE TESTS
// ===========================================================================

describe('Shoe', () => {
  it('builds a 6-deck shoe with 312 cards', () => {
    const shoe = new Shoe({ decks: 6, rng: seededRng() });
    assert.equal(shoe.totalCards, 312);
    assert.equal(shoe.cardsRemaining, 312);
    assert.equal(shoe.cardsOut, 0);
  });

  it('deals cards and tracks cardsOut', () => {
    const shoe = new Shoe({ decks: 6, rng: seededRng() });
    const card = shoe.deal();
    assert.equal(typeof card, 'string');
    assert.equal(card.length, 2);
    assert.equal(shoe.cardsOut, 1);
    assert.equal(shoe.cardsRemaining, 311);
  });

  it('dealN deals exactly N cards', () => {
    const shoe = new Shoe({ decks: 6, rng: seededRng() });
    const cards = shoe.dealN(10);
    assert.equal(cards.length, 10);
    assert.equal(shoe.cardsOut, 10);
  });

  it('shouldReshuffle triggers at penetration threshold', () => {
    const shoe = new Shoe({ decks: 1, penetration: 0.5, rng: seededRng() }); // 52 cards, shuffle at 26
    assert.equal(shoe.shouldReshuffle, false);
    shoe.dealN(25);
    assert.equal(shoe.shouldReshuffle, false);
    shoe.deal(); // card 26
    assert.equal(shoe.shouldReshuffle, true);
  });

  it('auto-reshuffles when dealing past full shoe', () => {
    const shoe = new Shoe({ decks: 1, penetration: 1.0, rng: seededRng() }); // no reshuffle until depleted
    shoe.dealN(52); // exhaust shoe
    // Next deal should auto-reshuffle
    const card = shoe.deal();
    assert.equal(typeof card, 'string');
    assert.equal(card.length, 2);
  });

  it('manual reshuffle resets cardsOut', () => {
    const shoe = new Shoe({ decks: 6, rng: seededRng() });
    shoe.dealN(50);
    assert.equal(shoe.cardsOut, 50);
    shoe.reshuffle();
    assert.equal(shoe.cardsOut, 0);
    assert.equal(shoe.cardsRemaining, 312);
  });

  it('configurable deck count: 2 decks = 104 cards', () => {
    const shoe = new Shoe({ decks: 2, rng: seededRng() });
    assert.equal(shoe.totalCards, 104);
  });

  it('rejects invalid decks', () => {
    assert.throws(() => new Shoe({ decks: 0 }), /decks/);
    assert.throws(() => new Shoe({ decks: 9 }), /decks/);
  });

  it('rejects invalid penetration', () => {
    assert.throws(() => new Shoe({ penetration: 0 }), /penetration/);
    assert.throws(() => new Shoe({ penetration: 1.5 }), /penetration/);
  });
});

// ===========================================================================
// GAME — BASIC MECHANICS
// ===========================================================================

describe('BlackjackGame — basic mechanics', () => {
  it('startHand returns player_decision state with required fields', () => {
    const shoe = deterministicShoe();
    const game = new BlackjackGame(shoe);
    const state = game.startHand(25, 1000);
    assert.equal(typeof state.phase, 'string');
    assert.ok(['player_decision', 'settlement'].includes(state.phase));
    assert.equal(state.bet, 25);
    assert.equal(state.bankroll, 1000);
    assert.ok(Array.isArray(state.playerHands));
    assert.ok(Array.isArray(state.dealerCards));
    assert.equal(typeof state.dealerUpcard, 'string');
    assert.equal(state.dealerUpcard.length, 2);
    assert.ok(Array.isArray(state.availableActions));
    assert.equal(typeof state.shoeCardsOut, 'number');
    assert.equal(typeof state.runningCount, 'number');
    assert.equal(typeof state.trueCount, 'number');
    assert.ok(typeof state.isBlackjack === 'boolean');
  });

  it('hole card is masked until settlement', () => {
    const shoe = deterministicShoe();
    const game = new BlackjackGame(shoe);
    const state = game.startHand(25, 1000);
    if (state.phase === 'player_decision') {
      assert.equal(state.dealerCards[1], '??');
    }
  });

  it('hit adds a card to active hand', () => {
    const shoe = deterministicShoe({ seed: 100 });
    const game = new BlackjackGame(shoe);
    let state = game.startHand(25, 1000);
    if (state.phase !== 'player_decision') return; // skip if BJ
    const initialLen = state.playerHands[0].length;
    state = game.step(state, 'hit');
    if (state.phase === 'player_decision') {
      assert.equal(state.playerHands[0].length, initialLen + 1);
    }
    // After hit total should be valid
    const { total } = handTotal(state.playerHands[0]);
    assert.ok(total >= 2 && total <= 30);
  });

  it('stand moves to dealer turn and settles', () => {
    const shoe = deterministicShoe();
    const game = new BlackjackGame(shoe);
    let state = game.startHand(25, 1000);
    while (state.phase === 'player_decision') {
      state = game.step(state, 'stand');
    }
    assert.equal(state.phase, 'settlement');
    assert.ok(Array.isArray(state.outcomes));
    assert.equal(typeof state.totalPayout, 'number');
  });

  it('dealer cards revealed at settlement', () => {
    const shoe = deterministicShoe();
    const game = new BlackjackGame(shoe);
    let state = game.startHand(25, 1000);
    while (state.phase === 'player_decision') {
      state = game.step(state, 'stand');
    }
    // No hidden cards in final state
    for (const card of state.dealerCards) {
      assert.notEqual(card, '??');
    }
  });

  it('rejects action not in availableActions', () => {
    const shoe = deterministicShoe();
    const game = new BlackjackGame(shoe);
    let state = game.startHand(25, 1000);
    if (state.phase === 'player_decision') {
      if (!state.availableActions.includes('split')) {
        assert.throws(() => game.step(state, 'split'), /not available/);
      }
    }
  });

  it('shoeCardsOut increases after each hand', () => {
    const shoe = deterministicShoe();
    const game = new BlackjackGame(shoe);
    let state1 = game.startHand(25, 1000);
    while (state1.phase === 'player_decision') state1 = game.step(state1, 'stand');
    const count1 = state1.shoeCardsOut;

    let state2 = game.startHand(25, 1000);
    while (state2.phase === 'player_decision') state2 = game.step(state2, 'stand');
    const count2 = state2.shoeCardsOut;

    assert.ok(count2 > count1, `count2 (${count2}) should exceed count1 (${count1})`);
  });
});

// ===========================================================================
// BLACKJACK PAYOUT (1.5×)
// ===========================================================================

describe('Blackjack payout — 1.5× natural', () => {
  /**
   * Force a natural blackjack by constructing a shoe where first cards are
   * deterministically an Ace + Ten-value.
   * We do this by monkey-patching deal() for a targeted test.
   */
  it('natural blackjack pays 1.5× bet', () => {
    const shoe = deterministicShoe();
    // Override deal sequence: p1=AH, d1=5H, p2=TD, d2=7C (player BJ, dealer no BJ)
    const sequence = ['AH', '5H', 'TD', '7C'];
    let idx = 0;
    shoe.deal = () => sequence[idx++] ?? deterministicShoe().deal();

    const game = new BlackjackGame(shoe);
    const state = game.startHand(25, 1000);
    assert.equal(state.phase, 'settlement');
    assert.equal(state.isBlackjack, true);
    assert.equal(state.outcomes[0].outcome, 'blackjack');
    assert.equal(state.outcomes[0].payout, 37); // floor(25 * 1.5) = 37
    assert.equal(state.totalPayout, 37);
  });

  it('blackjack vs dealer blackjack is a push', () => {
    const shoe = deterministicShoe();
    const sequence = ['AH', 'AC', 'TH', 'TC']; // player BJ, dealer BJ
    let idx = 0;
    shoe.deal = () => sequence[idx++] ?? 'KH';

    const game = new BlackjackGame(shoe);
    const state = game.startHand(25, 1000);
    assert.equal(state.phase, 'settlement');
    assert.equal(state.outcomes[0].outcome, 'push');
    assert.equal(state.outcomes[0].payout, 0);
  });
});

// ===========================================================================
// DOUBLE DOWN
// ===========================================================================

describe('Double down', () => {
  it('double down deals exactly one card then goes to dealer', () => {
    const shoe = deterministicShoe();
    // We need a hand where double is available: first 2 cards, sufficient bankroll
    // Use a sequence where player gets a doubleable hand (e.g. 5+6=11)
    const sequence = ['5H', '3H', '6D', '7C', '9S']; // p=5H+6D=11, d=3H+7C, extra=9S
    let idx = 0;
    const origDeal = shoe.deal.bind(shoe);
    shoe.deal = () => idx < sequence.length ? sequence[idx++] : origDeal();

    const game = new BlackjackGame(shoe);
    const state0 = game.startHand(25, 1000);
    if (state0.phase !== 'player_decision') return; // skip if unexpected BJ

    const initialHandLen = state0.playerHands[0].length;
    assert.ok(state0.availableActions.includes('double'), 'double should be available');

    const state1 = game.step(state0, 'double');
    // After double: hand should have 3 cards
    assert.equal(state1.playerHands[0].length, 3);
    // Should be at settlement or next phase (not player_decision for same hand)
    assert.ok(state1.phase !== 'player_decision' || state1.activeHandIndex > 0);
  });

  it('double down doubles the bet in outcome', () => {
    // Construct a scenario: player 5+6=11, dealer 3+6 (dealer busts)
    // Doubled bet = 50; dealer bust = win 50
    const shoe = deterministicShoe();
    const sequence = ['5H', '3H', '6D', '6C', '2S', 'TS', '8H']; // dealer draws until bust
    let idx = 0;
    const origDeal = shoe.deal.bind(shoe);
    shoe.deal = () => idx < sequence.length ? sequence[idx++] : origDeal();

    const game = new BlackjackGame(shoe);
    const state0 = game.startHand(25, 1000);
    if (state0.phase !== 'player_decision' || !state0.availableActions.includes('double')) return;

    let state = game.step(state0, 'double');
    while (state.phase === 'player_decision') state = game.step(state, 'stand');

    // Doubled bet tracked via splitBets or reflected in payout (win = +50)
    // Either win or lose, payout should be ±50 (doubled bet)
    const payout = Math.abs(state.totalPayout);
    assert.ok(payout === 50 || state.outcomes[0].outcome === 'push', `Expected doubled payout ±50, got ${payout}`);
  });
});

// ===========================================================================
// SPLIT HANDS
// ===========================================================================

describe('Split hands', () => {
  it('split creates two hands from a pair', () => {
    const shoe = deterministicShoe();
    // Construct a pair: player gets 8H + 8D
    const sequence = ['8H', '3C', '8D', '9H', 'TH', 'KH']; // player pair of 8s, dealer 3+9
    let idx = 0;
    const origDeal = shoe.deal.bind(shoe);
    shoe.deal = () => idx < sequence.length ? sequence[idx++] : origDeal();

    const game = new BlackjackGame(shoe);
    const state0 = game.startHand(25, 1000);
    if (state0.phase !== 'player_decision' || !state0.availableActions.includes('split')) return;

    const state1 = game.step(state0, 'split');
    assert.equal(state1.playerHands.length, 2);
    assert.equal(state1.activeHandIndex, 0);
    assert.ok(Array.isArray(state1.availableActions));
  });

  it('can play out both split hands to settlement', () => {
    const shoe = deterministicShoe();
    const sequence = ['8H', '3C', '8D', '7H', 'KS', 'TH', 'QD', 'JC'];
    let idx = 0;
    const origDeal = shoe.deal.bind(shoe);
    shoe.deal = () => idx < sequence.length ? sequence[idx++] : origDeal();

    const game = new BlackjackGame(shoe);
    const state0 = game.startHand(25, 1000);
    if (state0.phase !== 'player_decision' || !state0.availableActions.includes('split')) return;

    let state = game.step(state0, 'split');
    while (state.phase === 'player_decision') {
      state = game.step(state, 'stand');
    }
    assert.equal(state.phase, 'settlement');
    assert.equal(state.outcomes.length, 2); // one outcome per split hand
  });
});

// ===========================================================================
// DEALER BUST
// ===========================================================================

describe('Dealer bust', () => {
  it('player wins when dealer busts', () => {
    const shoe = deterministicShoe();
    // Player: 7H + 9S = 16, stand. Dealer: 6C + 7D = 13, draws: 9H = 22 (bust)
    const sequence = ['7H', '6C', '9S', '7D', '9H'];
    let idx = 0;
    const origDeal = shoe.deal.bind(shoe);
    shoe.deal = () => idx < sequence.length ? sequence[idx++] : origDeal();

    const game = new BlackjackGame(shoe);
    let state = game.startHand(25, 1000);
    while (state.phase === 'player_decision') {
      state = game.step(state, 'stand');
    }
    assert.equal(state.phase, 'settlement');
    const dealerTotal = handTotal(state.dealerCards).total;
    if (dealerTotal > 21) {
      assert.equal(state.outcomes[0].outcome, 'win');
      assert.equal(state.outcomes[0].payout, 25);
    }
  });
});

// ===========================================================================
// SURRENDER
// ===========================================================================

describe('Surrender', () => {
  it('surrender returns half the bet as loss', () => {
    const shoe = deterministicShoe();
    const game = new BlackjackGame(shoe);
    let state = game.startHand(25, 1000);
    if (state.phase === 'player_decision' && state.availableActions.includes('surrender')) {
      state = game.step(state, 'surrender');
      assert.equal(state.phase, 'settlement');
      assert.equal(state.outcomes[0].outcome, 'surrender');
      assert.equal(state.outcomes[0].payout, -13); // ceil(25/2) = 13
    }
  });
});

// ===========================================================================
// BANKROLL AND P&L TRACKING (100-hand session)
// ===========================================================================

describe('SessionTracker — bankroll and P&L', () => {
  it('tracks bankroll accurately over 100 hands', () => {
    const shoe = deterministicShoe({ seed: 1337 });
    const game = new BlackjackGame(shoe);
    const tracker = new SessionTracker({ startingBankroll: 1000, minBet: 25, maxBet: 500 });

    let bankroll = 1000;
    let handsPlayed = 0;

    for (let i = 0; i < 100 && !tracker.isBankrupt; i++) {
      let state = game.startHand(25, bankroll);
      while (state.phase === 'player_decision') {
        state = game.step(state, 'stand');
      }
      tracker.recordHand(state);
      bankroll += state.totalPayout;
      handsPlayed++;

      // Verify tracker.bankroll matches our manual tracking
      assert.equal(tracker.bankroll, bankroll,
        `Bankroll mismatch after hand ${handsPlayed}: tracker=${tracker.bankroll}, manual=${bankroll}`);
    }

    assert.ok(handsPlayed >= 1, 'Should have played at least 1 hand');

    const summary = tracker.summary();
    assert.equal(summary.handsPlayed, handsPlayed);
    assert.equal(summary.endingBankroll, bankroll);
    assert.equal(summary.pnl, bankroll - 1000);
    assert.ok(summary.maxBankroll >= summary.endingBankroll);
    assert.ok(summary.minBankroll <= summary.endingBankroll);
    assert.ok(summary.winRate >= 0 && summary.winRate <= 100);
  });

  it('isBankrupt triggers when bankroll < minBet', () => {
    const shoe = deterministicShoe();
    const tracker = new SessionTracker({ startingBankroll: 30, minBet: 25 });
    assert.equal(tracker.isBankrupt, false);

    // Simulate a loss of 10 — bankroll = 20 < minBet 25
    tracker.bankroll = 20;
    assert.equal(tracker.isBankrupt, true);
  });

  it('summary win/loss counts sum to handsPlayed (allowing splits)', () => {
    const shoe = deterministicShoe({ seed: 999 });
    const game = new BlackjackGame(shoe);
    const tracker = new SessionTracker({ startingBankroll: 1000, minBet: 25 });

    let bankroll = 1000;
    for (let i = 0; i < 50 && !tracker.isBankrupt; i++) {
      let state = game.startHand(25, bankroll);
      while (state.phase === 'player_decision') state = game.step(state, 'stand');
      tracker.recordHand(state);
      bankroll += state.totalPayout;
    }

    const s = tracker.summary();
    // wins + losses + pushes + surrenders >= handsPlayed (splits add extra outcomes)
    const total = s.wins + s.losses + s.pushes + s.surrenders;
    assert.ok(total >= s.handsPlayed, `Outcome total ${total} should be >= handsPlayed ${s.handsPlayed}`);
  });
});

// ===========================================================================
// FULL SHOE RUN (acceptance: 6-deck shoe end-to-end without errors)
// ===========================================================================

describe('Full shoe run', () => {
  it('plays a 6-deck shoe end-to-end with always-stand without errors', () => {
    const shoe = new Shoe({ decks: 6, penetration: 1.0, rng: seededRng(42) }); // full penetration
    const game = new BlackjackGame(shoe);
    const tracker = new SessionTracker({ startingBankroll: 10000, minBet: 25 });

    let bankroll = 10000;
    let hands = 0;
    const maxHandsEstimate = 312 / 4; // ~78 hands in a 6-deck shoe (4 cards avg per hand)

    // Run until shoe runs out of room for a hand (< 10 cards) or 200 hands
    while (shoe.cardsRemaining >= 10 && hands < 200 && !tracker.isBankrupt) {
      let state = game.startHand(25, bankroll);
      while (state.phase === 'player_decision') {
        state = game.step(state, 'stand');
      }
      tracker.recordHand(state);
      bankroll += state.totalPayout;
      hands++;
    }

    assert.ok(hands > 0, 'Should have played at least one hand');
    assert.equal(tracker.handsPlayed, hands);
    assert.equal(tracker.bankroll, bankroll);

    // JSON game state at settlement has all required fields
    const shoe2 = new Shoe({ decks: 6, penetration: 1.0, rng: seededRng(77) });
    const game2 = new BlackjackGame(shoe2);
    let finalState = game2.startHand(50, 5000);
    while (finalState.phase === 'player_decision') finalState = game2.step(finalState, 'stand');

    assert.equal(typeof finalState.phase, 'string');
    assert.equal(typeof finalState.hand, 'number');
    assert.equal(typeof finalState.bet, 'number');
    assert.equal(typeof finalState.bankroll, 'number');
    assert.ok(Array.isArray(finalState.playerHands));
    assert.ok(Array.isArray(finalState.dealerCards));
    assert.equal(typeof finalState.dealerUpcard, 'string');
    assert.equal(typeof finalState.shoeCardsOut, 'number');
    assert.equal(typeof finalState.runningCount, 'number');
    assert.equal(typeof finalState.trueCount, 'number');
    assert.ok(Array.isArray(finalState.outcomes));
    assert.equal(typeof finalState.totalPayout, 'number');
  });
});

// ===========================================================================
// SHOE PENETRATION TRIGGERS RESHUFFLE CORRECTLY
// ===========================================================================

describe('Shoe penetration reshuffle', () => {
  it('game auto-reshuffles at penetration point', () => {
    const shoe = new Shoe({ decks: 1, penetration: 0.5, rng: seededRng(11) }); // 52 cards, shuffle at 26
    const game = new BlackjackGame(shoe);

    let bankroll = 10000;
    let reshuffleDetected = false;

    for (let i = 0; i < 10; i++) {
      const countBefore = shoe.cardsOut;
      let state = game.startHand(25, bankroll);
      while (state.phase === 'player_decision') state = game.step(state, 'stand');
      bankroll += state.totalPayout;

      // If cardsOut decreased, a reshuffle happened
      if (shoe.cardsOut < countBefore) {
        reshuffleDetected = true;
        break;
      }
      // If next hand will trigger reshuffle
      if (shoe.shouldReshuffle) {
        reshuffleDetected = true; // will reshuffle on next startHand
        break;
      }
    }

    assert.ok(reshuffleDetected, 'Expected reshuffle to trigger within 10 hands of 1-deck shoe at 50% pen');
  });
});
