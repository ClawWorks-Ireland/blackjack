/**
 * Casino Advisor — Card Parser and Hi-Lo Count Engine
 * Shared module used by the background service worker.
 *
 * Card encoding: 2-char ASCII {rank}{suit}
 *   Rank: A 2 3 4 5 6 7 8 9 T J Q K
 *   Suit: H D C S
 *
 * Confirmed from Evolution Gaming live WS samples (TASK-459).
 */

'use strict';

// ---------------------------------------------------------------------------
// Card Parsing
// ---------------------------------------------------------------------------

/** @type {Record<string, number>} Hi-Lo count values */
export const HI_LO_VALUE = {
  '2': 1, '3': 1, '4': 1, '5': 1, '6': 1,
  '7': 0, '8': 0, '9': 0,
  'T': -1, 'J': -1, 'Q': -1, 'K': -1, 'A': -1,
};

/** @type {Record<string, number>} Blackjack hard values (Ace = 11 before soft/hard resolution) */
export const BJ_VALUE = {
  'A': 11, 'T': 10, 'J': 10, 'Q': 10, 'K': 10,
};

/**
 * Parse a 2-char card string into structured data.
 * @param {string} card e.g. "6D", "JC", "TS", "AD"
 * @returns {{ rank: string, suit: string, bjValue: number, countValue: number } | null}
 */
export function parseCard(card) {
  if (typeof card !== 'string' || card.length !== 2) return null;
  const rank = card[0].toUpperCase();
  const suit = card[1].toUpperCase();
  const validRanks = new Set(['A','2','3','4','5','6','7','8','9','T','J','Q','K']);
  const validSuits = new Set(['H','D','C','S']);
  if (!validRanks.has(rank) || !validSuits.has(suit)) return null;
  return {
    rank,
    suit,
    bjValue: BJ_VALUE[rank] ?? parseInt(rank, 10),
    countValue: HI_LO_VALUE[rank] ?? 0,
  };
}

/**
 * Compute the blackjack hand total for an array of card strings.
 * Handles soft/hard Ace logic.
 * @param {string[]} cards
 * @returns {{ total: number, soft: boolean, bust: boolean }}
 */
export function handTotal(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    const parsed = parseCard(card);
    if (!parsed) continue;
    if (parsed.rank === 'A') {
      aces++;
      total += 11;
    } else {
      total += parsed.bjValue;
    }
  }

  // Reduce Aces from 11 → 1 as needed
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return {
    total,
    soft: aces > 0 && total <= 21,
    bust: total > 21,
  };
}

// ---------------------------------------------------------------------------
// Hi-Lo Count Engine
// ---------------------------------------------------------------------------

/**
 * Running count state.
 * Accumulated across the shoe until a shuffle is detected.
 */
export class HiLoCounter {
  constructor() {
    this.runningCount = 0;
    this.cardsOut = 0;
    this.decksTotal = 8; // Evolution Infinite Blackjack: 8 decks = 416 cards
  }

  /**
   * Update the running count with a dealt card.
   * @param {string} card
   */
  addCard(card) {
    const parsed = parseCard(card);
    if (!parsed) return;
    this.runningCount += parsed.countValue;
    this.cardsOut++;
  }

  /**
   * Add multiple cards at once (e.g. on tableState).
   * @param {string[]} cards
   */
  addCards(cards) {
    for (const card of cards) this.addCard(card);
  }

  /**
   * True count = running count / decks remaining.
   * @returns {number} Rounded to 1 decimal place.
   */
  get trueCount() {
    const decksRemaining = this.decksRemaining;
    if (decksRemaining <= 0) return 0;
    return Math.round((this.runningCount / decksRemaining) * 10) / 10;
  }

  /**
   * Decks remaining in the shoe.
   * @returns {number}
   */
  get decksRemaining() {
    const cardsRemaining = this.decksTotal * 52 - this.cardsOut;
    return Math.max(cardsRemaining / 52, 0.5); // floor at 0.5 to avoid division by zero
  }

  /**
   * Penetration as a fraction (0–1).
   * @returns {number}
   */
  get penetration() {
    return this.cardsOut / (this.decksTotal * 52);
  }

  /**
   * Update cardsOut from a WebSocket shoeCardsOut field.
   * Detects shuffle if new value < current cardsOut.
   * @param {number} shoeCardsOut
   */
  syncShoeCardsOut(shoeCardsOut) {
    if (typeof shoeCardsOut !== 'number') return;
    if (shoeCardsOut < this.cardsOut) {
      // Shuffle detected — reset count
      this.reset();
    }
    this.cardsOut = shoeCardsOut;
  }

  /**
   * Reset on shuffle.
   */
  reset() {
    this.runningCount = 0;
    this.cardsOut = 0;
  }

  toJSON() {
    return {
      runningCount: this.runningCount,
      trueCount: this.trueCount,
      cardsOut: this.cardsOut,
      decksRemaining: Math.round(this.decksRemaining * 10) / 10,
      penetration: Math.round(this.penetration * 1000) / 10, // as percent
    };
  }
}

// ---------------------------------------------------------------------------
// Basic Strategy Matrix (Infinite Blackjack, 8 decks, S17, no surrender)
// ---------------------------------------------------------------------------

/**
 * Basic strategy recommendation.
 * @typedef {'H' | 'S' | 'D' | 'SP' | 'SU'} Action
 * H = Hit, S = Stand, D = Double, SP = Split, SU = Surrender
 */

/** Dealer upcard index: 2=0, 3=1, 4=2, 5=3, 6=4, 7=5, 8=6, 9=7, T=8, A=9 */
function dealerIndex(upcard) {
  const parsed = parseCard(upcard);
  if (!parsed) return -1;
  const map = { '2':0,'3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,'T':8,'J':8,'Q':8,'K':8,'A':9 };
  return map[parsed.rank] ?? -1;
}

/**
 * Hard totals strategy table (player total 8–17 vs dealer 2–A).
 * Rows: player total 8→17 (index 0→9)
 * Cols: dealer upcard 2→A (index 0→9)
 * Values: H=Hit, S=Stand, D=Double
 */
const HARD_STRATEGY = {
  //      2    3    4    5    6    7    8    9    T    A
  8:  ['H','H','H','H','H','H','H','H','H','H'],
  9:  ['H','D','D','D','D','H','H','H','H','H'],
  10: ['D','D','D','D','D','D','D','D','H','H'],
  11: ['D','D','D','D','D','D','D','D','D','H'],
  12: ['H','H','S','S','S','H','H','H','H','H'],
  13: ['S','S','S','S','S','H','H','H','H','H'],
  14: ['S','S','S','S','S','H','H','H','H','H'],
  15: ['S','S','S','S','S','H','H','H','H','H'],
  16: ['S','S','S','S','S','H','H','H','H','H'],
  17: ['S','S','S','S','S','S','S','S','S','S'],
};

/**
 * Soft totals strategy (Ace + X, where X is 2–9).
 * Key: the non-ace card rank value (2–9).
 */
const SOFT_STRATEGY = {
  //     2    3    4    5    6    7    8    9    T    A
  2: ['H','H','H','D','D','H','H','H','H','H'],
  3: ['H','H','H','D','D','H','H','H','H','H'],
  4: ['H','H','D','D','D','H','H','H','H','H'],
  5: ['H','H','D','D','D','H','H','H','H','H'],
  6: ['H','D','D','D','D','H','H','H','H','H'],
  7: ['S','D','D','D','D','S','S','H','H','H'],
  8: ['S','S','S','S','S','S','S','S','S','S'],
  9: ['S','S','S','S','S','S','S','S','S','S'],
};

/**
 * Pair splitting strategy.
 * Key: the pair rank.
 */
const PAIR_STRATEGY = {
  //      2    3    4    5    6    7    8    9    T    A
  'A': ['SP','SP','SP','SP','SP','SP','SP','SP','SP','SP'],
  'T': ['S', 'S', 'S', 'S', 'S', 'S', 'S', 'S', 'S', 'S'],
  '9': ['SP','SP','SP','SP','SP','S', 'SP','SP','S', 'S'],
  '8': ['SP','SP','SP','SP','SP','SP','SP','SP','SP','SP'],
  '7': ['SP','SP','SP','SP','SP','SP','H', 'H', 'H', 'H'],
  '6': ['SP','SP','SP','SP','SP','H', 'H', 'H', 'H', 'H'],
  '5': ['D', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'H', 'H'],
  '4': ['H', 'H', 'H', 'SP','SP','H', 'H', 'H', 'H', 'H'],
  '3': ['SP','SP','SP','SP','SP','SP','H', 'H', 'H', 'H'],
  '2': ['SP','SP','SP','SP','SP','SP','H', 'H', 'H', 'H'],
};

/**
 * Get basic strategy recommendation.
 * @param {string[]} playerCards - Array of card strings
 * @param {string} dealerUpcard - Single card string
 * @returns {{ action: Action, label: string, reason: string }}
 */
export function basicStrategy(playerCards, dealerUpcard) {
  const di = dealerIndex(dealerUpcard);
  if (di === -1) {
    return { action: 'H', label: 'Hit', reason: 'Unknown dealer upcard' };
  }

  const { total, soft } = handTotal(playerCards);
  const dealerUpcardParsed = parseCard(dealerUpcard);

  // Blackjack (natural 21 on 2 cards)
  if (playerCards.length === 2 && total === 21) {
    return { action: 'S', label: 'Stand', reason: 'Blackjack — natural 21' };
  }

  // Bust
  if (total > 21) {
    return { action: 'S', label: 'Stand', reason: 'Bust' };
  }

  // Check for pairs (2-card hand, same rank)
  if (playerCards.length === 2) {
    const c1 = parseCard(playerCards[0]);
    const c2 = parseCard(playerCards[1]);
    if (c1 && c2 && c1.rank === c2.rank) {
      // Normalise T/J/Q/K to '10' for pair lookup; keep face ranks
      const pairKey = c1.rank;
      if (PAIR_STRATEGY[pairKey]) {
        const action = PAIR_STRATEGY[pairKey][di];
        // If split isn't available (e.g. Infinite Blackjack limits), fall through to hard/soft
        if (action === 'SP') {
          return { action: 'SP', label: 'Split', reason: `Pair of ${pairKey}s vs dealer ${dealerUpcardParsed?.rank}` };
        }
      }
    }
  }

  // Soft hands (Ace counted as 11)
  if (soft && playerCards.length === 2) {
    const nonAce = playerCards.find(c => parseCard(c)?.rank !== 'A');
    if (nonAce) {
      const nonAceCard = parseCard(nonAce);
      // Soft strategy keyed by non-Ace card value (2–9)
      const key = nonAceCard?.bjValue;
      if (key && key >= 2 && key <= 9 && SOFT_STRATEGY[key]) {
        const action = SOFT_STRATEGY[key][di];
        return {
          action,
          label: actionLabel(action),
          reason: `Soft ${total} (A+${nonAceCard?.rank}) vs dealer ${dealerUpcardParsed?.rank}`,
        };
      }
    }
  }

  // Hard totals
  if (total <= 8) {
    return { action: 'H', label: 'Hit', reason: `Hard ${total} — always hit` };
  }
  if (total >= 17) {
    return { action: 'S', label: 'Stand', reason: `Hard ${total} — always stand` };
  }

  const row = HARD_STRATEGY[total];
  if (row) {
    const action = row[di];
    return {
      action,
      label: actionLabel(action),
      reason: `Hard ${total} vs dealer ${dealerUpcardParsed?.rank}`,
    };
  }

  return { action: 'H', label: 'Hit', reason: 'Default' };
}

/**
 * Count-adjusted bet sizing recommendation.
 * Returns a bet unit multiplier based on true count (Hi-Lo).
 * @param {number} trueCount
 * @returns {{ multiplier: number, label: string }}
 */
export function betSizing(trueCount) {
  if (trueCount <= 1)  return { multiplier: 1, label: 'Min bet — negative/neutral count' };
  if (trueCount <= 2)  return { multiplier: 2, label: '2× — slight positive count' };
  if (trueCount <= 3)  return { multiplier: 3, label: '3× — positive count' };
  if (trueCount <= 4)  return { multiplier: 4, label: '4× — strong positive count' };
  return               { multiplier: 5, label: '5× — max bet — very strong count (TC≥5)' };
}

function actionLabel(action) {
  return { 'H': 'Hit', 'S': 'Stand', 'D': 'Double', 'SP': 'Split', 'SU': 'Surrender' }[action] ?? action;
}
