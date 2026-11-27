/**
 * Blackjack Game State Machine — headless, stateless-step model.
 *
 * Usage:
 *   const game = new BlackjackGame(shoe, options);
 *   const state = game.startHand(bet);          // returns state at player decision
 *   const state2 = game.step(state, 'hit');     // advance with player action
 *   // when state.phase === 'settlement', call game.settle(state) to get outcome
 *
 * Each call to step() returns a NEW state object (immutable-style).
 *
 * State schema:
 * {
 *   phase: 'player_decision' | 'dealer_turn' | 'settlement',
 *   hand: number,                  // hand number in session (1-indexed)
 *   bet: number,                   // current bet amount
 *   bankroll: number,              // bankroll before bet deducted
 *   playerHands: string[][],       // array of hands (split creates multiple)
 *   activeHandIndex: number,       // which hand is currently active
 *   dealerCards: string[],         // dealer's cards (hole card masked until dealer_turn)
 *   dealerUpcard: string,          // dealer upcard (always visible)
 *   availableActions: string[],    // ['hit','stand','double','split','surrender']
 *   shoeCardsOut: number,
 *   decksRemaining: number,
 *   runningCount: number,
 *   trueCount: number,
 *   isBlackjack: boolean,          // player has natural blackjack
 *   playerTotals: {total, soft, bust}[],
 *   outcome: null | 'win'|'lose'|'push'|'blackjack'|'surrender', // set at settlement
 *   payout: null | number,         // net payout (+ win, - lose, 0 push)
 * }
 */

'use strict';

import { parseCard, handTotal, HiLoCounter } from '../shared/card-engine.js';

const BLACKJACK_PAYOUT = 1.5; // 3:2

/**
 * Compute available actions for the current player hand.
 * @param {string[]} hand
 * @param {number} bet
 * @param {number} bankroll
 * @param {boolean} isFirstAction - true if no actions taken yet on this hand
 * @returns {string[]}
 */
function computeAvailableActions(hand, bet, bankroll, isFirstAction) {
  const actions = ['hit', 'stand'];

  if (isFirstAction && hand.length === 2) {
    // Double down — needs sufficient bankroll
    if (bankroll >= bet) {
      actions.push('double');
    }
    // Split — same rank pair
    const c1 = parseCard(hand[0]);
    const c2 = parseCard(hand[1]);
    // Normalise face cards: T/J/Q/K all count as same for splitting
    const r1 = c1 ? ((['T','J','Q','K'].includes(c1.rank) ? 'T' : c1.rank)) : null;
    const r2 = c2 ? ((['T','J','Q','K'].includes(c2.rank) ? 'T' : c2.rank)) : null;
    if (r1 && r1 === r2 && bankroll >= bet) {
      actions.push('split');
    }
    // Surrender — only on first action (original 2 cards)
    actions.push('surrender');
  }

  return actions;
}

/**
 * Run dealer logic: dealer hits until 17+ (stands on soft 17 — S17 rules).
 * @param {string[]} dealerCards
 * @param {Shoe} shoe
 * @returns {string[]} final dealer hand
 */
function runDealer(dealerCards, shoe) {
  let cards = [...dealerCards];
  let result = handTotal(cards);
  // S17: stand on soft 17 (stands on all 17s)
  while (result.total < 17) {
    cards.push(shoe.deal());
    result = handTotal(cards);
  }
  return cards;
}

/**
 * Determine hand outcome for a single player hand vs dealer.
 * @param {{ total, soft, bust }} playerResult
 * @param {{ total, soft, bust }} dealerResult
 * @param {boolean} isBlackjack - player has natural 21 on 2 cards
 * @param {boolean} dealerBlackjack
 * @returns {{ outcome: string, payout: number }}
 */
function resolveHand(playerResult, dealerResult, isBlackjack, dealerBlackjack, bet) {
  if (playerResult.bust) {
    return { outcome: 'lose', payout: -bet };
  }
  if (isBlackjack && dealerBlackjack) {
    return { outcome: 'push', payout: 0 };
  }
  if (isBlackjack) {
    return { outcome: 'blackjack', payout: Math.floor(bet * BLACKJACK_PAYOUT) };
  }
  if (dealerBlackjack) {
    return { outcome: 'lose', payout: -bet };
  }
  if (dealerResult.bust) {
    return { outcome: 'win', payout: bet };
  }
  if (playerResult.total > dealerResult.total) {
    return { outcome: 'win', payout: bet };
  }
  if (playerResult.total < dealerResult.total) {
    return { outcome: 'lose', payout: -bet };
  }
  return { outcome: 'push', payout: 0 };
}

/**
 * Headless blackjack game engine.
 */
export class BlackjackGame {
  /**
   * @param {import('./shoe.js').Shoe} shoe
   * @param {{ minBet?: number, maxBet?: number }} [options]
   */
  constructor(shoe, { minBet = 1, maxBet = Infinity } = {}) {
    this.shoe = shoe;
    this.minBet = minBet;
    this.maxBet = maxBet;
    this.counter = new HiLoCounter();
    this.counter.decksTotal = shoe.decks;
    this._handNumber = 0;
  }

  /**
   * Deal a new hand. Returns initial game state at player decision point.
   * @param {number} bet
   * @param {number} bankroll
   * @returns {object} game state
   */
  startHand(bet, bankroll) {
    if (bet < this.minBet) throw new RangeError(`Bet ${bet} below minimum ${this.minBet}`);
    if (bet > this.maxBet) throw new RangeError(`Bet ${bet} above maximum ${this.maxBet}`);
    if (bet > bankroll) throw new RangeError(`Bet ${bet} exceeds bankroll ${bankroll}`);

    this._handNumber++;

    // Check for pending reshuffle before dealing
    if (this.shoe.shouldReshuffle) {
      this.shoe.reshuffle();
      this.counter.reset();
    }

    // Deal: p1, d1, p2, d2 (standard deal order)
    const p1 = this.shoe.deal();
    const d1 = this.shoe.deal();
    const p2 = this.shoe.deal();
    const d2 = this.shoe.deal(); // hole card

    // Update counter for all visible cards + hole card (we track internally)
    this.counter.addCards([p1, d1, p2, d2]);
    this.counter.cardsOut = this.shoe.cardsOut;

    const playerHand = [p1, p2];
    const dealerCards = [d1, d2]; // d2 is hole (hidden from model)

    const playerResult = handTotal(playerHand);
    const dealerResult = handTotal(dealerCards);

    const isPlayerBlackjack = playerHand.length === 2 && playerResult.total === 21;
    const isDealerBlackjack = dealerCards.length === 2 && dealerResult.total === 21;

    // If player has blackjack, go straight to settlement
    if (isPlayerBlackjack) {
      const { outcome, payout } = resolveHand(
        playerResult, dealerResult,
        true, isDealerBlackjack, bet
      );
      return {
        phase: 'settlement',
        hand: this._handNumber,
        bet,
        bankroll,
        playerHands: [playerHand],
        activeHandIndex: 0,
        dealerCards, // reveal hole card at settlement
        dealerUpcard: d1,
        shoeCardsOut: this.shoe.cardsOut,
        decksRemaining: Math.round(this.counter.decksRemaining * 10) / 10,
        runningCount: this.counter.runningCount,
        trueCount: this.counter.trueCount,
        availableActions: [],
        isBlackjack: true,
        playerTotals: [playerResult],
        outcomes: [{ outcome, payout }],
        totalPayout: payout,
      };
    }

    // Normal play — player decision
    return {
      phase: 'player_decision',
      hand: this._handNumber,
      bet,
      bankroll,
      playerHands: [playerHand],
      activeHandIndex: 0,
      dealerCards: [d1, '??'], // hole card hidden
      dealerUpcard: d1,
      shoeCardsOut: this.shoe.cardsOut,
      decksRemaining: Math.round(this.counter.decksRemaining * 10) / 10,
      runningCount: this.counter.runningCount,
      trueCount: this.counter.trueCount,
      availableActions: computeAvailableActions(playerHand, bet, bankroll, true),
      isBlackjack: false,
      playerTotals: [playerResult],
      outcomes: null,
      totalPayout: null,
      // Internal: keep hole card for resolution
      _dealerHole: d2,
      _splitBets: [],
    };
  }

  /**
   * Advance game state with a player action.
   * @param {object} state - current game state
   * @param {'hit'|'stand'|'double'|'split'|'surrender'} action
   * @returns {object} next game state
   */
  step(state, action) {
    if (state.phase === 'settlement') {
      throw new Error('Hand already settled');
    }
    if (!state.availableActions.includes(action)) {
      throw new Error(`Action '${action}' not available. Options: ${state.availableActions.join(', ')}`);
    }

    const s = { ...state, playerHands: state.playerHands.map(h => [...h]) };

    if (action === 'surrender') {
      return this._settle(s, 'surrender');
    }

    if (action === 'stand') {
      // Advance to next split hand, or go to dealer turn
      const nextIndex = s.activeHandIndex + 1;
      if (nextIndex < s.playerHands.length) {
        // Next split hand
        const nextHand = s.playerHands[nextIndex];
        const nextTotal = handTotal(nextHand);
        return {
          ...s,
          activeHandIndex: nextIndex,
          availableActions: computeAvailableActions(nextHand, s.bet, s.bankroll, true),
          playerTotals: s.playerHands.map(h => handTotal(h)),
        };
      }
      // All hands done — dealer turn
      return this._runDealerAndSettle(s);
    }

    if (action === 'hit') {
      const card = this.shoe.deal();
      this.counter.addCard(card);
      this.counter.cardsOut = this.shoe.cardsOut;

      const hand = s.playerHands[s.activeHandIndex];
      hand.push(card);
      const result = handTotal(hand);
      s.playerTotals = s.playerHands.map(h => handTotal(h));
      s.shoeCardsOut = this.shoe.cardsOut;
      s.decksRemaining = Math.round(this.counter.decksRemaining * 10) / 10;
      s.runningCount = this.counter.runningCount;
      s.trueCount = this.counter.trueCount;

      if (result.bust) {
        // Bust: move to next hand or settle
        const nextIndex = s.activeHandIndex + 1;
        if (nextIndex < s.playerHands.length) {
          const nextHand = s.playerHands[nextIndex];
          return {
            ...s,
            activeHandIndex: nextIndex,
            availableActions: computeAvailableActions(nextHand, s.bet, s.bankroll, true),
          };
        }
        return this._runDealerAndSettle(s);
      }

      if (result.total === 21) {
        // Auto-stand on 21
        const nextIndex = s.activeHandIndex + 1;
        if (nextIndex < s.playerHands.length) {
          const nextHand = s.playerHands[nextIndex];
          return {
            ...s,
            activeHandIndex: nextIndex,
            availableActions: computeAvailableActions(nextHand, s.bet, s.bankroll, true),
          };
        }
        return this._runDealerAndSettle(s);
      }

      return {
        ...s,
        availableActions: computeAvailableActions(hand, s.bet, s.bankroll, false),
      };
    }

    if (action === 'double') {
      const card = this.shoe.deal();
      this.counter.addCard(card);
      this.counter.cardsOut = this.shoe.cardsOut;

      const hand = s.playerHands[s.activeHandIndex];
      hand.push(card);
      const result = handTotal(hand);
      s.playerTotals = s.playerHands.map(h => handTotal(h));
      s.shoeCardsOut = this.shoe.cardsOut;
      s.decksRemaining = Math.round(this.counter.decksRemaining * 10) / 10;
      s.runningCount = this.counter.runningCount;
      s.trueCount = this.counter.trueCount;
      s._splitBets = [...(s._splitBets || [])];
      // Double the bet for this hand
      s._splitBets[s.activeHandIndex] = (s._splitBets[s.activeHandIndex] || s.bet) * 2;

      // After double: exactly one card, auto-advance
      const nextIndex = s.activeHandIndex + 1;
      if (!result.bust && nextIndex < s.playerHands.length) {
        const nextHand = s.playerHands[nextIndex];
        return {
          ...s,
          activeHandIndex: nextIndex,
          availableActions: computeAvailableActions(nextHand, s.bet, s.bankroll, true),
        };
      }
      return this._runDealerAndSettle(s);
    }

    if (action === 'split') {
      const hand = s.playerHands[s.activeHandIndex];
      const card1 = hand[0];
      const card2 = hand[1];

      // Create two new hands
      const card1a = this.shoe.deal();
      const card2a = this.shoe.deal();
      this.counter.addCards([card1a, card2a]);
      this.counter.cardsOut = this.shoe.cardsOut;

      const newHand1 = [card1, card1a];
      const newHand2 = [card2, card2a];

      // Replace current hand with two new hands
      const newHands = [...s.playerHands];
      newHands.splice(s.activeHandIndex, 1, newHand1, newHand2);

      const newSplitBets = [...(s._splitBets || [])];
      // Insert bet for the new second hand
      newSplitBets.splice(s.activeHandIndex, 0, s.bet);

      s.playerHands = newHands;
      s._splitBets = newSplitBets;
      s.playerTotals = newHands.map(h => handTotal(h));
      s.shoeCardsOut = this.shoe.cardsOut;
      s.decksRemaining = Math.round(this.counter.decksRemaining * 10) / 10;
      s.runningCount = this.counter.runningCount;
      s.trueCount = this.counter.trueCount;

      const currentHand = newHands[s.activeHandIndex];
      return {
        ...s,
        availableActions: computeAvailableActions(currentHand, s.bet, s.bankroll, true),
      };
    }

    throw new Error(`Unknown action: ${action}`);
  }

  /**
   * Run dealer and settle all hands.
   * @param {object} s - mutable working state
   * @returns {object} settlement state
   */
  _runDealerAndSettle(s) {
    const holeCard = s._dealerHole;
    const fullDealerHand = [s.dealerCards[0], holeCard, ...s.dealerCards.slice(2)];
    const finalDealerHand = runDealer(fullDealerHand, this.shoe);

    // Update counter for dealer draws (skip first 2 already counted)
    const dealerDraws = finalDealerHand.slice(2);
    for (const card of dealerDraws) {
      this.counter.addCard(card);
    }
    this.counter.cardsOut = this.shoe.cardsOut;

    const dealerResult = handTotal(finalDealerHand);
    const dealerBlackjack = finalDealerHand.length === 2 && dealerResult.total === 21;

    const outcomes = s.playerHands.map((hand, i) => {
      const betForHand = (s._splitBets && s._splitBets[i]) ? s._splitBets[i] : s.bet;
      const playerResult = handTotal(hand);
      return resolveHand(playerResult, dealerResult, false, dealerBlackjack, betForHand);
    });

    const totalPayout = outcomes.reduce((sum, o) => sum + o.payout, 0);

    return {
      ...s,
      phase: 'settlement',
      dealerCards: finalDealerHand, // reveal hole card
      outcomes,
      totalPayout,
      availableActions: [],
      playerTotals: s.playerHands.map(h => handTotal(h)),
      shoeCardsOut: this.shoe.cardsOut,
      decksRemaining: Math.round(this.counter.decksRemaining * 10) / 10,
      runningCount: this.counter.runningCount,
      trueCount: this.counter.trueCount,
    };
  }

  /**
   * Handle surrender action — immediate settlement.
   * @param {object} s
   * @returns {object}
   */
  _settle(s, action) {
    if (action === 'surrender') {
      const holeCard = s._dealerHole;
      const fullDealerHand = [s.dealerCards[0], holeCard];
      return {
        ...s,
        phase: 'settlement',
        dealerCards: fullDealerHand,
        outcomes: [{ outcome: 'surrender', payout: -Math.ceil(s.bet / 2) }],
        totalPayout: -Math.ceil(s.bet / 2),
        availableActions: [],
        playerTotals: s.playerHands.map(h => handTotal(h)),
        shoeCardsOut: this.shoe.cardsOut,
        decksRemaining: Math.round(this.counter.decksRemaining * 10) / 10,
        runningCount: this.counter.runningCount,
        trueCount: this.counter.trueCount,
      };
    }
  }
}

/**
 * Session tracker — accumulates P&L and stats across hands.
 */
export class SessionTracker {
  /**
   * @param {{ startingBankroll: number, minBet: number, maxBet: number }} options
   */
  constructor({ startingBankroll = 1000, minBet = 25, maxBet = 500 } = {}) {
    this.startingBankroll = startingBankroll;
    this.bankroll = startingBankroll;
    this.minBet = minBet;
    this.maxBet = maxBet;
    this.handsPlayed = 0;
    this.wins = 0;
    this.losses = 0;
    this.pushes = 0;
    this.surrenders = 0;
    this.blackjacks = 0;
    this.busts = 0;
    this.totalBet = 0;
    this.maxBankroll = startingBankroll;
    this.minBankroll = startingBankroll;
    this.handLog = [];
  }

  /**
   * Record a settled hand.
   * @param {object} settlementState
   */
  recordHand(settlementState) {
    const { outcomes, totalPayout, bet, hand } = settlementState;
    this.bankroll += totalPayout;
    this.handsPlayed++;
    this.totalBet += bet * (settlementState.playerHands?.length || 1);

    // Track per-outcome
    for (const o of (outcomes || [])) {
      if (o.outcome === 'win') this.wins++;
      else if (o.outcome === 'blackjack') { this.wins++; this.blackjacks++; }
      else if (o.outcome === 'lose') this.losses++;
      else if (o.outcome === 'push') this.pushes++;
      else if (o.outcome === 'surrender') this.surrenders++;
    }

    // Check for busts
    for (const t of (settlementState.playerTotals || [])) {
      if (t.bust) this.busts++;
    }

    this.maxBankroll = Math.max(this.maxBankroll, this.bankroll);
    this.minBankroll = Math.min(this.minBankroll, this.bankroll);

    this.handLog.push({
      hand,
      bet,
      payout: totalPayout,
      bankroll: this.bankroll,
      outcomes: outcomes?.map(o => o.outcome),
    });
  }

  /**
   * Returns a bankrupt flag — can't cover minimum bet.
   * @returns {boolean}
   */
  get isBankrupt() {
    return this.bankroll < this.minBet;
  }

  /**
   * Full session summary.
   * @returns {object}
   */
  summary() {
    const totalHands = this.wins + this.losses + this.pushes + this.surrenders;
    return {
      handsPlayed: this.handsPlayed,
      wins: this.wins,
      losses: this.losses,
      pushes: this.pushes,
      surrenders: this.surrenders,
      blackjacks: this.blackjacks,
      busts: this.busts,
      winRate: totalHands > 0 ? Math.round((this.wins / totalHands) * 1000) / 10 : 0,
      pushRate: totalHands > 0 ? Math.round((this.pushes / totalHands) * 1000) / 10 : 0,
      startingBankroll: this.startingBankroll,
      endingBankroll: this.bankroll,
      pnl: this.bankroll - this.startingBankroll,
      pnlPercent: Math.round(((this.bankroll - this.startingBankroll) / this.startingBankroll) * 1000) / 10,
      maxBankroll: this.maxBankroll,
      minBankroll: this.minBankroll,
      avgBet: this.handsPlayed > 0 ? Math.round(this.totalBet / this.handsPlayed) : 0,
      totalWagered: this.totalBet,
    };
  }
}
