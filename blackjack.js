/**
 * Blackjack core rules. Pure and DOM-free so it runs in the browser
 * (as window.Blackjack) and under Node for tests (via module.exports).
 *
 * House rules: 6-deck shoe, dealer stands on all 17s, blackjack pays 3:2,
 * double down on any first two cards (including after a split), split
 * same-rank pairs up to 4 hands, split aces get one card each, a 21 on a
 * split hand pays 1:1 (not blackjack), no insurance.
 */
(function (root) {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const DEALER_STAND = 17;
  const MAX_HANDS = 4;
  const RESHUFFLE_AT = 52; // reshuffle when fewer cards than one deck remain

  function createShoe(decks = 6) {
    const shoe = [];
    for (let d = 0; d < decks; d++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) shoe.push({ rank, suit });
      }
    }
    return shoe;
  }

  /** Fisher-Yates shuffle. `rng` is injectable for deterministic tests. */
  function shuffle(cards, rng = Math.random) {
    const out = cards.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function cardValue(card) {
    if (card.rank === 'A') return 11;
    if (['J', 'Q', 'K'].includes(card.rank)) return 10;
    return Number(card.rank);
  }

  /** Best total for a hand; `soft` is true when an ace still counts as 11. */
  function handValue(hand) {
    let total = 0;
    let aces = 0;
    for (const card of hand) {
      total += cardValue(card);
      if (card.rank === 'A') aces++;
    }
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }
    return { total, soft: aces > 0 };
  }

  const isBlackjack = (hand) => hand.length === 2 && handValue(hand).total === 21;
  const isBust = (hand) => handValue(hand).total > 21;
  const dealerShouldHit = (hand) => handValue(hand).total < DEALER_STAND;

  /**
   * Settle one finished hand against the dealer. Returns the outcome and the
   * net chip change relative to that hand's (possibly doubled) bet.
   * A two-card 21 on a split hand is an ordinary 21, not a blackjack.
   */
  function settle(playerHand, dealerHand, bet, { fromSplit = false } = {}) {
    const pBJ = !fromSplit && isBlackjack(playerHand);
    const dBJ = isBlackjack(dealerHand);
    if (pBJ && dBJ) return { outcome: 'push', net: 0 };
    if (pBJ) return { outcome: 'blackjack', net: bet * 1.5 };
    if (isBust(playerHand)) return { outcome: 'bust', net: -bet };
    if (dBJ) return { outcome: 'lose', net: -bet };
    if (isBust(dealerHand)) return { outcome: 'win', net: bet };
    const p = handValue(playerHand).total;
    const d = handValue(dealerHand).total;
    if (p > d) return { outcome: 'win', net: bet };
    if (p < d) return { outcome: 'lose', net: -bet };
    return { outcome: 'push', net: 0 };
  }

  /**
   * Stateful game wrapper around the rules. The player may hold several
   * hands after splitting; `hands[active]` is the one being played.
   */
  class Game {
    constructor({ bankroll = 1000, decks = 6, rng = Math.random } = {}) {
      this.bankroll = bankroll;
      this.decks = decks;
      this.rng = rng;
      this.shoe = shuffle(createShoe(decks), rng);
      this.phase = 'betting'; // betting | player | done
      this.hands = [];
      this.active = 0;
      this.dealer = [];
      this.results = [];
    }

    get currentHand() {
      return this.phase === 'player' ? this.hands[this.active] : null;
    }

    /** Total chip change for the finished round. */
    get net() {
      return this.results.reduce((sum, r) => sum + r.net, 0);
    }

    draw() {
      if (this.shoe.length < RESHUFFLE_AT) {
        this.shoe = shuffle(createShoe(this.decks), this.rng);
      }
      return this.shoe.pop();
    }

    canDouble() {
      const h = this.currentHand;
      return !!h && h.cards.length === 2 && this.bankroll >= h.bet;
    }

    canSplit() {
      const h = this.currentHand;
      return !!h && h.cards.length === 2 && h.cards[0].rank === h.cards[1].rank &&
        this.hands.length < MAX_HANDS && this.bankroll >= h.bet;
    }

    deal(bet) {
      if (this.phase === 'player') throw new Error('Round in progress');
      if (!Number.isFinite(bet) || bet <= 0) throw new Error('Bet must be positive');
      if (bet > this.bankroll) throw new Error('Bet exceeds bankroll');
      this.bankroll -= bet;
      this.results = [];
      const cards = [this.draw(), this.draw()];
      this.dealer = [this.draw(), this.draw()];
      this.hands = [{ cards, bet, fromSplit: false, splitAces: false, done: false }];
      this.active = 0;
      this.phase = 'player';
      // Naturals end the round at once; the dealer does not draw.
      if (isBlackjack(cards) || isBlackjack(this.dealer)) this.finish();
    }

    hit() {
      const h = this.requireHand();
      h.cards.push(this.draw());
      if (handValue(h.cards).total >= 21) h.done = true;
      this.advance();
    }

    stand() {
      this.requireHand().done = true;
      this.advance();
    }

    double() {
      if (!this.canDouble()) throw new Error('Cannot double now');
      const h = this.currentHand;
      this.bankroll -= h.bet;
      h.bet *= 2;
      h.cards.push(this.draw());
      h.done = true;
      this.advance();
    }

    split() {
      if (!this.canSplit()) throw new Error('Cannot split now');
      const h = this.currentHand;
      const aces = h.cards[0].rank === 'A';
      this.bankroll -= h.bet;
      const second = { cards: [h.cards.pop()], bet: h.bet, fromSplit: true, splitAces: aces, done: false };
      h.fromSplit = true;
      h.splitAces = aces;
      this.hands.splice(this.active + 1, 0, second);
      this.prepare(this.active);
      this.advance();
    }

    requireHand() {
      if (this.phase !== 'player') throw new Error('Not your turn');
      return this.currentHand;
    }

    /** Give a split hand its second card and auto-finish it if it can't act. */
    prepare(i) {
      const h = this.hands[i];
      if (h.cards.length === 1) h.cards.push(this.draw());
      if (h.splitAces || handValue(h.cards).total >= 21) h.done = true;
    }

    /** Move past finished hands; once none remain, the dealer plays. */
    advance() {
      while (this.active < this.hands.length && this.hands[this.active].done) {
        this.active++;
        if (this.active < this.hands.length) this.prepare(this.active);
      }
      if (this.active < this.hands.length) return;
      // Dealer only draws if at least one player hand is still live.
      if (this.hands.some((h) => !isBust(h.cards))) {
        while (dealerShouldHit(this.dealer)) this.dealer.push(this.draw());
      }
      this.finish();
    }

    finish() {
      this.results = this.hands.map((h) =>
        settle(h.cards, this.dealer, h.bet, { fromSplit: h.fromSplit }));
      // Stakes were removed when placed, so return stake + net per hand.
      this.hands.forEach((h, i) => { this.bankroll += h.bet + this.results[i].net; });
      this.phase = 'done';
    }
  }

  const api = {
    SUITS, RANKS, MAX_HANDS, createShoe, shuffle, cardValue, handValue,
    isBlackjack, isBust, dealerShouldHit, settle, Game,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Blackjack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
