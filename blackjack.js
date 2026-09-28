/**
 * Blackjack core rules. Pure and DOM-free so it runs in the browser
 * (as window.Blackjack) and under Node for tests (via module.exports).
 *
 * Default rules: 6-deck shoe with a cut card at 75% (reshuffled only
 * between rounds), dealer stands on all 17s, blackjack pays 3:2,
 * double down on any first two cards (including after a split), split
 * same-rank pairs up to 4 hands, split aces get one card each, a 21 on a
 * split hand pays 1:1 (not blackjack), late surrender.
 *
 * Configurable (see Game constructor): decks, h17 (dealer hits soft 17),
 * payout (1.5 for 3:2, 1.2 for 6:5), das (double after split), lateSurrender.
 *
 * Insurance: offered when the dealer shows an ace, costs half the bet and
 * pays 2:1 if the dealer has blackjack. With a blackjack of your own it is
 * called even money: taking it pays 1:1 whatever the dealer holds, and it
 * needs no spare chips because it can't lose. The dealer peeks for blackjack
 * after insurance is settled (and immediately when showing a ten).
 *
 * Surrender (late): on the first two cards of an unsplit hand, after the
 * dealer peeks, give up half the bet and end the hand.
 */
(function (root) {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const DEALER_STAND = 17;
  const MAX_HANDS = 4; // per betting spot, after splits
  const MAX_SPOTS = 3;
  const PENETRATION = 0.75; // cut card sits three quarters of the way into the shoe
  const SIDE_MAX = 100; // per side bet
  const SIDE = typeof module !== 'undefined' && module.exports
    ? require('./sidebets.js') : root.BlackjackSideBets;

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
  /** A blackjack dealt to a spot (not made after a split). */
  const isNatural = (h) => !h.fromSplit && isBlackjack(h.cards);
  const isBust = (hand) => handValue(hand).total > 21;
  /** Dealer draws below 17, and on soft 17 when the table uses H17. */
  function dealerShouldHit(hand, h17 = false) {
    const { total, soft } = handValue(hand);
    return total < DEALER_STAND || (h17 && total === DEALER_STAND && soft);
  }
  const PAYOUTS = [1.5, 1.2]; // 3:2 and 6:5

  /**
   * Settle one finished hand against the dealer. Returns the outcome and the
   * net chip change relative to that hand's (possibly doubled) bet.
   * A two-card 21 on a split hand is an ordinary 21, not a blackjack.
   */
  function settle(playerHand, dealerHand, bet, { fromSplit = false, surrendered = false, payout = 1.5 } = {}) {
    if (surrendered) return { outcome: 'surrender', net: -bet / 2 };
    const pBJ = !fromSplit && isBlackjack(playerHand);
    const dBJ = isBlackjack(dealerHand);
    if (pBJ && dBJ) return { outcome: 'push', net: 0 };
    if (pBJ) return { outcome: 'blackjack', net: bet * payout };
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
   * Phases: betting -> [insurance] -> player -> done.
   */
  class Game {
    constructor({
      bankroll = 1000, decks = 6, minBet = 1, maxBet = Infinity, penetration = PENETRATION, rng = Math.random,
      h17 = false, payout = 1.5, das = true, lateSurrender = true,
    } = {}) {
      this.bankroll = bankroll;
      this.decks = decks;
      this.h17 = h17;
      this.payout = payout;
      this.das = das;
      this.lateSurrender = lateSurrender;
      this.minBet = minBet;
      this.maxBet = maxBet; // table limit
      this.penetration = penetration;
      this.rng = rng;
      this.shoe = shuffle(createShoe(decks), rng);
      this.shuffles = 0; // new shoes started at the cut card (between rounds)
      this.emergencyShuffles = 0; // shoe ran dry mid-round (tiny shoes only)
      this.phase = 'betting';
      this.hands = [];
      this.active = 0;
      this.dealer = [];
      this.results = [];
      this.insurance = 0; // side-bet stake
      this.insuranceNet = null; // null until insurance is settled
      this.tookEvenMoney = false;
      this.sideBets = []; // settled as soon as the cards are dealt
      this.spotBets = []; // initial bet on each spot this round
    }

    /** The table rules, in the shape the settings panel and strategy use. */
    get rules() {
      return {
        decks: this.decks, h17: this.h17, payout: this.payout, das: this.das, lateSurrender: this.lateSurrender,
        penetration: this.penetration,
      };
    }

    get currentHand() {
      return this.phase === 'player' ? this.hands[this.active] : null;
    }

    /** Total chip change for the finished round, including insurance and side bets. */
    get net() {
      return this.results.reduce((sum, r) => sum + r.net, 0) + (this.insuranceNet || 0) + this.sideNet;
    }

    /**
     * Money put at risk this round: every hand's final bet (after doubles
     * and splits), insurance, and side bets.
     */
    get wagered() {
      return this.hands.reduce((sum, h) => sum + h.bet, 0) + this.insurance +
        this.sideBets.reduce((sum, s) => sum + s.stake, 0);
    }

    /** Chip change from this round's side bets. */
    get sideNet() {
      return this.sideBets.reduce((sum, s) => sum + s.net, 0);
    }

    /** Between rounds with less than the minimum bet left: time to start over. */
    get isBroke() {
      return this.phase !== 'player' && this.phase !== 'insurance' && this.bankroll < this.minBet;
    }

    /** Insurance covers every spot: half the total of the initial bets. */
    get insuranceCost() {
      if (this.spotBets.length) return this.spotBets.reduce((a, b) => a + b, 0) / 2;
      return this.hands.length ? this.hands[0].bet / 2 : 0;
    }

    /** True once the cut card has come out: shuffle before the next round. */
    get cutCardReached() {
      return this.shoe.length <= Math.round(this.decks * 52 * (1 - this.penetration));
    }

    draw() {
      if (!this.shoe.length) this.refillFromDiscards();
      return this.shoe.pop();
    }

    /**
     * Last resort if a round outlasts the cards behind the cut card: shuffle
     * the discards (every card not on the table) and keep dealing, as a
     * dealer would. Only reachable with very small shoes.
     */
    refillFromDiscards() {
      const onTable = new Map();
      const key = (c) => c.rank + c.suit;
      for (const c of [...this.dealer, ...this.hands.flatMap((h) => h.cards)]) {
        onTable.set(key(c), (onTable.get(key(c)) || 0) + 1);
      }
      const discards = createShoe(this.decks).filter((c) => {
        const n = onTable.get(key(c)) || 0;
        if (n) onTable.set(key(c), n - 1);
        return !n;
      });
      this.shoe = shuffle(discards, this.rng);
      this.emergencyShuffles++;
    }

    /**
     * Sit-out ("Wong out") round: deal the dealer and an empty seat from the
     * shoe, play the seat with `decide(cards, upcard)` (hit/stand/double;
     * anything else stands, and a split is played as a hit), and play the
     * dealer out. No money moves and the table (hands, results, bankroll,
     * phase) is untouched: only the shoe changes, so the count moves just as
     * it would at a real table. Shuffles at the cut card like deal().
     */
    watchRound(decide) {
      if (this.phase === 'player' || this.phase === 'insurance') throw new Error('Round in progress');
      const newShoe = this.cutCardReached;
      if (newShoe) {
        this.shoe = shuffle(createShoe(this.decks), this.rng);
        this.shuffles++;
      }
      this.newShoe = newShoe;
      const seat = [this.draw(), this.draw()];
      const dealer = [this.draw(), this.draw()];
      if (!isBlackjack(dealer) && !isBlackjack(seat)) {
        for (let n = 0; n < 12 && handValue(seat).total < 21; n++) {
          const a = decide(seat, dealer[0]);
          if (a !== 'hit' && a !== 'double' && a !== 'split') break;
          seat.push(this.draw());
          if (a === 'double') break;
        }
        if (!isBust(seat)) while (dealerShouldHit(dealer, this.h17)) dealer.push(this.draw());
      }
      return { seat, dealer, newShoe };
    }

    /**
     * Insurance offered while you hold blackjack is called even money. It
     * only works out to a flat 1:1 when blackjack pays 3:2; at 6:5 it is
     * ordinary insurance.
     */
    get evenMoneyOffered() {
      return this.phase === 'insurance' && this.payout === 1.5 && this.hands.length === 1 &&
        isBlackjack(this.hands[0].cards);
    }

    canInsure() {
      return this.phase === 'insurance' && (this.evenMoneyOffered || this.bankroll >= this.insuranceCost);
    }

    canDouble() {
      const h = this.currentHand;
      return !!h && h.cards.length === 2 && (this.das || !h.fromSplit) && this.bankroll >= h.bet;
    }

    canSplit() {
      const h = this.currentHand;
      return !!h && h.cards.length === 2 && h.cards[0].rank === h.cards[1].rank &&
        this.hands.filter((x) => x.spot === h.spot).length < MAX_HANDS && this.bankroll >= h.bet;
    }

    canSurrender() {
      const h = this.currentHand;
      return this.lateSurrender && !!h && !h.fromSplit && h.cards.length === 2;
    }

    /**
     * Start a round. `side` holds optional side bets in dollars:
     * { pairs: Perfect Pairs, t213: 21+3 }. They settle as soon as the
     * cards are out, before insurance or play.
     */
    deal(bet, side = {}) {
      if (this.phase === 'player' || this.phase === 'insurance') throw new Error('Round in progress');
      // One bet per spot: a number for one spot, or an array for up to three.
      const bets = Array.isArray(bet) ? bet : [bet];
      if (bets.length < 1 || bets.length > MAX_SPOTS) throw new Error(`Play 1 to ${MAX_SPOTS} spots`);
      for (const b of bets) {
        if (!Number.isFinite(b) || b <= 0) throw new Error('Bet must be positive');
        if (b < this.minBet) throw new Error(`Minimum bet is $${this.minBet}`);
        if (b > this.maxBet) throw new Error(`Maximum bet is $${this.maxBet}`);
      }
      const sides = Object.entries(side).filter(([, stake]) => stake);
      for (const [name, stake] of sides) {
        if (!(name in SIDE.BETS)) throw new Error(`Unknown side bet ${name}`);
        if (!Number.isInteger(stake) || stake < 0) throw new Error('Side bets are in whole dollars');
        if (stake > SIDE_MAX) throw new Error(`Side bets are at most $${SIDE_MAX}`);
      }
      const main = bets.reduce((a, b) => a + b, 0);
      const total = main + sides.reduce((sum, [, stake]) => sum + stake, 0);
      if (total > this.bankroll) throw new Error('Bet exceeds bankroll');
      // Between rounds is the only time the shoe is replaced.
      this.newShoe = this.cutCardReached;
      if (this.newShoe) {
        this.shoe = shuffle(createShoe(this.decks), this.rng);
        this.shuffles++;
      }
      this.bankroll -= main;
      this.spotBets = bets.slice();
      this.results = [];
      this.insurance = 0;
      this.insuranceNet = null;
      this.tookEvenMoney = false;
      // Draw order: each spot's two cards, then the dealer's two.
      this.hands = bets.map((b, spot) => ({
        cards: [this.draw(), this.draw()], bet: b, spot,
        fromSplit: false, splitAces: false, surrendered: false, done: false,
      }));
      this.dealer = [this.draw(), this.draw()];
      this.active = 0;
      // Side bets ride on the first spot.
      const first = this.hands[0].cards;
      this.sideBets = sides.map(([name, stake]) => SIDE.settleSide(name, stake, [...first, this.dealer[0]]));
      for (const s of this.sideBets) this.bankroll += s.net; // stake stays or winnings added
      if (this.dealer[0].rank === 'A') this.phase = 'insurance';
      else this.peek();
    }

    takeInsurance() {
      if (!this.canInsure()) throw new Error('Cannot take insurance now');
      this.tookEvenMoney = this.evenMoneyOffered;
      this.insurance = this.insuranceCost;
      this.bankroll -= this.insurance;
      this.peek();
    }

    declineInsurance() {
      if (this.phase !== 'insurance') throw new Error('Insurance is not on offer');
      this.peek();
    }

    /** Dealer checks for blackjack; settles insurance; naturals end the round. */
    peek() {
      const dBJ = isBlackjack(this.dealer);
      if (this.insurance > 0) {
        this.insuranceNet = dBJ ? this.insurance * 2 : -this.insurance;
        if (dBJ) this.bankroll += this.insurance * 3; // stake back + 2:1
      }
      this.phase = 'player';
      if (dBJ) {
        this.finish();
        return;
      }
      // A natural on any spot is paid at the end; play moves to the next spot.
      for (const h of this.hands) if (isNatural(h)) h.done = true;
      this.advance();
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
      const second = {
        cards: [h.cards.pop()], bet: h.bet, spot: h.spot, fromSplit: true, splitAces: aces, surrendered: false, done: false,
      };
      h.fromSplit = true;
      h.splitAces = aces;
      this.hands.splice(this.active + 1, 0, second);
      this.prepare(this.active);
      this.advance();
    }

    surrender() {
      if (!this.canSurrender()) throw new Error('Cannot surrender now');
      const h = this.currentHand;
      h.surrendered = true;
      h.done = true;
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
      // (A natural is already paid off, so it doesn't make the dealer draw either.)
      if (this.hands.some((h) => !h.surrendered && !isBust(h.cards) && !isNatural(h))) {
        while (dealerShouldHit(this.dealer, this.h17)) this.dealer.push(this.draw());
      }
      this.finish();
    }

    finish() {
      this.results = this.hands.map((h) => settle(h.cards, this.dealer, h.bet, { ...h, payout: this.payout }));
      // Stakes were removed when placed, so return stake + net per hand.
      this.hands.forEach((h, i) => { this.bankroll += h.bet + this.results[i].net; });
      this.phase = 'done';
    }

    /** Plain-data snapshot for saving. Restore it with Game.fromJSON. */
    toJSON() {
      return {
        bankroll: this.bankroll, decks: this.decks, minBet: this.minBet,
        maxBet: Number.isFinite(this.maxBet) ? this.maxBet : null, penetration: this.penetration,
        h17: this.h17, payout: this.payout, das: this.das, lateSurrender: this.lateSurrender,
        shoe: this.shoe, phase: this.phase,
        hands: this.hands, active: this.active, dealer: this.dealer, results: this.results,
        insurance: this.insurance, insuranceNet: this.insuranceNet, tookEvenMoney: this.tookEvenMoney,
        sideBets: this.sideBets, spotBets: this.spotBets,
      };
    }

    /**
     * Rebuild a game from toJSON() output, including a round in progress,
     * so a reload neither refunds nor forfeits the chips on the table.
     * Returns null when the data is missing or inconsistent.
     */
    static fromJSON(data, { rng = Math.random } = {}) {
      if (!validSave(data)) return null;
      const g = new Game({
        bankroll: data.bankroll, decks: data.decks, rng,
        minBet: data.minBet ?? 1, maxBet: data.maxBet ?? Infinity, penetration: data.penetration ?? PENETRATION,
        h17: data.h17 ?? false, payout: data.payout ?? 1.5, das: data.das ?? true,
        lateSurrender: data.lateSurrender ?? true,
      });
      const copy = (cards) => cards.map(({ rank, suit }) => ({ rank, suit }));
      g.shoe = copy(data.shoe);
      g.phase = data.phase;
      g.hands = data.hands.map((h) => ({
        cards: copy(h.cards), bet: h.bet, spot: h.spot ?? 0, fromSplit: h.fromSplit, splitAces: h.splitAces,
        surrendered: h.surrendered, done: h.done,
      }));
      // Saves from before spots had one spot, bet as the first hand's.
      g.spotBets = Array.isArray(data.spotBets) ? data.spotBets.slice() : (data.hands.length ? [data.hands[0].bet] : []);
      g.active = data.active;
      g.dealer = copy(data.dealer);
      g.results = data.results.map(({ outcome, net }) => ({ outcome, net }));
      g.insurance = data.insurance;
      g.insuranceNet = data.insuranceNet;
      g.tookEvenMoney = data.tookEvenMoney === true;
      g.sideBets = (data.sideBets || []).map(({ bet, stake, win, odds, net }) => ({ bet, stake, win, odds, net }));
      return g;
    }
  }

  const PHASES = ['betting', 'insurance', 'player', 'done'];
  const OUTCOMES = ['win', 'blackjack', 'lose', 'bust', 'push', 'surrender'];
  const isObj = (x) => !!x && typeof x === 'object';
  const isBool = (x) => typeof x === 'boolean';
  const isMoney = (x) => Number.isFinite(x) && x >= 0;
  const validCard = (c) => isObj(c) && RANKS.includes(c.rank) && SUITS.includes(c.suit);
  const validCards = (a) => Array.isArray(a) && a.every(validCard);
  const validHand = (h) => isObj(h) && validCards(h.cards) && h.cards.length > 0 &&
    Number.isFinite(h.bet) && h.bet > 0 && isBool(h.fromSplit) && isBool(h.splitAces) &&
    isBool(h.surrendered) && isBool(h.done);
  const validResult = (r) => isObj(r) && OUTCOMES.includes(r.outcome) && Number.isFinite(r.net);

  const validSide = (s) => isObj(s) && ['pairs', 't213'].includes(s.bet) && Number.isFinite(s.stake) && s.stake > 0 &&
    (s.win === null || typeof s.win === 'string') && Number.isFinite(s.odds) && Number.isFinite(s.net);

  function validSave(d) {
    if (!isObj(d) || !isMoney(d.bankroll) || !PHASES.includes(d.phase)) return false;
    if (!Number.isInteger(d.decks) || d.decks < 1 || d.decks > 8) return false;
    // Limits were added later: older saves have neither and load with the defaults.
    if (d.minBet !== undefined && !(Number.isFinite(d.minBet) && d.minBet > 0)) return false;
    if (d.penetration !== undefined && !(Number.isFinite(d.penetration) && d.penetration >= 0 && d.penetration < 1)) return false;
    if (d.maxBet !== undefined && d.maxBet !== null && !(Number.isFinite(d.maxBet) && d.maxBet > 0)) return false;
    for (const k of ['h17', 'das', 'lateSurrender']) if (d[k] !== undefined && !isBool(d[k])) return false;
    if (d.payout !== undefined && !PAYOUTS.includes(d.payout)) return false;
    if (!validCards(d.shoe) || !validCards(d.dealer)) return false;
    if (!Array.isArray(d.hands) || !d.hands.every(validHand) || d.hands.length > MAX_HANDS * MAX_SPOTS) return false;
    if (!Array.isArray(d.results) || !d.results.every(validResult)) return false;
    if (!isMoney(d.insurance) || !(d.insuranceNet === null || Number.isFinite(d.insuranceNet))) return false;
    if (!Number.isInteger(d.active) || d.active < 0) return false;
    const live = d.phase === 'player' || d.phase === 'insurance';
    if (live && (!d.hands.length || d.active >= d.hands.length || d.dealer.length < 2)) return false;
    if (d.phase === 'insurance' && (d.hands.length > MAX_SPOTS || d.hands.some((h) => h.cards.length !== 2))) return false;
    if (d.spotBets !== undefined && !(Array.isArray(d.spotBets) && d.spotBets.length <= MAX_SPOTS &&
      d.spotBets.every((b) => Number.isFinite(b) && b > 0))) return false;
    if (d.hands.some((h) => h.spot !== undefined && !(Number.isInteger(h.spot) && h.spot >= 0 && h.spot < MAX_SPOTS))) return false;
    if (d.sideBets !== undefined && !(Array.isArray(d.sideBets) && d.sideBets.every(validSide))) return false;
    if (d.phase === 'done' && d.results.length !== d.hands.length) return false;
    return true;
  }

  const api = {
    SUITS, RANKS, MAX_HANDS, MAX_SPOTS, PAYOUTS, SIDE_MAX, createShoe, shuffle, cardValue, handValue,
    isBlackjack, isBust, dealerShouldHit, settle, Game,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Blackjack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
