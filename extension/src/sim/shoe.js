/**
 * Blackjack Shoe — configurable multi-deck shoe with penetration-based shuffle.
 *
 * Card encoding: 2-char ASCII {rank}{suit}
 *   Rank: A 2 3 4 5 6 7 8 9 T J Q K
 *   Suit: H D C S
 */

'use strict';

const RANKS = ['A','2','3','4','5','6','7','8','9','T','J','Q','K'];
const SUITS = ['H','D','C','S'];

/**
 * Build a fresh unshuffled deck of 52 cards.
 * @returns {string[]}
 */
function buildDeck() {
  const cards = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      cards.push(rank + suit);
    }
  }
  return cards;
}

/**
 * Fisher-Yates shuffle in place.
 * @param {string[]} arr
 * @param {() => number} [rng] Random number generator (default: Math.random)
 */
function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Multi-deck shoe for blackjack simulation.
 *
 * Configuration:
 *   decks        — number of decks in the shoe (default: 6)
 *   penetration  — fraction of shoe dealt before reshuffle (default: 0.75)
 *   rng          — random number generator function (default: Math.random)
 */
export class Shoe {
  /**
   * @param {{ decks?: number, penetration?: number, rng?: () => number }} [options]
   */
  constructor({ decks = 6, penetration = 0.75, rng = Math.random } = {}) {
    if (decks < 1 || decks > 8) throw new RangeError(`decks must be 1-8, got ${decks}`);
    if (penetration <= 0 || penetration > 1) throw new RangeError(`penetration must be (0,1], got ${penetration}`);

    this.decks = decks;
    this.penetration = penetration;
    this.rng = rng;

    this._cards = [];
    this._dealtCount = 0;
    this.totalCards = decks * 52;
    this.shufflePoint = Math.floor(this.totalCards * penetration);

    this._build();
  }

  /** Build and shuffle the shoe. */
  _build() {
    const all = [];
    for (let i = 0; i < this.decks; i++) {
      all.push(...buildDeck());
    }
    shuffle(all, this.rng);
    this._cards = all;
    this._dealtCount = 0;
  }

  /**
   * Deal one card from the top of the shoe.
   * Auto-reshuffles when penetration threshold is reached.
   * @returns {string}
   */
  deal() {
    if (this._dealtCount >= this.totalCards) {
      this._build();
    }
    const card = this._cards[this._dealtCount++];
    return card;
  }

  /**
   * Deal N cards.
   * @param {number} n
   * @returns {string[]}
   */
  dealN(n) {
    const cards = [];
    for (let i = 0; i < n; i++) cards.push(this.deal());
    return cards;
  }

  /** Number of cards dealt so far in this shoe. */
  get cardsOut() {
    return this._dealtCount;
  }

  /** Number of cards remaining in the shoe. */
  get cardsRemaining() {
    return this.totalCards - this._dealtCount;
  }

  /** True if the penetration threshold has been reached and a reshuffle is pending after this hand. */
  get shouldReshuffle() {
    return this._dealtCount >= this.shufflePoint;
  }

  /** Penetration as a fraction (0–1). */
  get penetrationReached() {
    return this._dealtCount / this.totalCards;
  }

  /**
   * Force a reshuffle now (e.g. mid-shoe reset for testing).
   */
  reshuffle() {
    this._build();
  }
}
