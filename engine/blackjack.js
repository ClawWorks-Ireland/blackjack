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
  const TABLE_SEATS = 7; // bots and your spots together
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

  /** Small, fast seeded generator (mulberry32): the same seed gives the same numbers. */
  function seededRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 32-bit FNV-1a hash of a string, to seed a shuffle from text. */
  function hashSeed(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * A shoe seed as typed: "lucky" starts at shoe 1, "lucky-7" at shoe 7.
   * Returns {seed, shoeNo}, or null for blank or unusable text.
   */
  function parseSeed(text) {
    const t = String(text ?? '').trim();
    if (!t || t.length > 40 || /[^\w.-]/.test(t)) return null;
    const m = t.match(/^(.+)-(\d{1,6})$/);
    return m && Number(m[2]) >= 1 ? { seed: m[1], shoeNo: Number(m[2]) } : { seed: t, shoeNo: 1 };
  }

  /** A random seed for a table the player didn't seed, so every shoe can still be replayed. */
  const randomSeed = (rng = Math.random) => Math.floor(rng() * 36 ** 6).toString(36).padStart(6, '0');

  /** Shoe number `shoeNo` of a seed: the same cards every time for the same deck count. */
  const seededShoe = (decks, seed, shoeNo) => shuffle(createShoe(decks), seededRng(hashSeed(`${seed}-${shoeNo}`)));

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
  const DOUBLE_ON = ['any', '9-11', '10-11']; // any two cards, or hard 9-11 / 10-11 only

  /** Whether a two-card hand may double under the table's doubling rule. */
  function canDoubleOn(cards, doubleOn = 'any') {
    if (doubleOn === 'any') return true;
    const { total, soft } = handValue(cards);
    if (soft) return false;
    return doubleOn === '10-11' ? total === 10 || total === 11 : total >= 9 && total <= 11;
  }

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
      rsa = false, enhc = false, obo = false, doubleOn = 'any', seed = null, shoeNo = 1,
      bots = 0, seat = 0, botDecide = null,
    } = {}) {
      this.bankroll = bankroll;
      this.decks = decks;
      this.h17 = h17;
      this.payout = payout;
      this.das = das;
      this.lateSurrender = lateSurrender;
      this.rsa = rsa; // resplit aces
      this.enhc = enhc; // European no hole card: no peek, a dealer blackjack takes doubles and splits
      this.obo = enhc && obo; // ENHC, but only the original bet is lost to a dealer blackjack
      this.doubleOn = DOUBLE_ON.includes(doubleOn) ? doubleOn : 'any';
      this.minBet = minBet;
      this.maxBet = maxBet; // table limit
      this.penetration = penetration;
      this.rng = rng;
      // F19: with a seed, shoe n is always the same cards (seed "x", shoe 3 = "x-3").
      this.seed = seed === null || seed === undefined ? null : String(seed);
      this.shoeNo = Number.isInteger(shoeNo) && shoeNo >= 1 ? shoeNo : 1;
      this.shoe = this.seed === null ? shuffle(createShoe(decks), rng) : seededShoe(decks, this.seed, this.shoeNo);
      this.drawLog = []; // cards drawn this round, in order (for replay)
      this.actionLog = []; // decisions this round, in order (for replay)
      this.logging = false;
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
      // CLA-99: other seats at the table, played by `botDecide(cards, upcard,
      // allowed)` with no money. Your spots sit together from seat `seat`;
      // seats on your right (lower numbers) play before you, the rest after.
      if (!Number.isInteger(bots) || bots < 0 || bots > TABLE_SEATS - 1) throw new Error(`Bots must be 0 to ${TABLE_SEATS - 1}`);
      if (!Number.isInteger(seat) || seat < 0 || seat > bots) throw new Error(`Seat must be 0 to ${bots}`);
      if (bots && typeof botDecide !== 'function') throw new Error('Bots need a botDecide function');
      this.bots = bots;
      this.seat = seat;
      this.botDecide = botDecide;
      this.others = []; // this round's bot seats: [{seat, hands: [{cards, ...}], results}]
    }

    /** The table rules, in the shape the settings panel and strategy use. */
    get rules() {
      return {
        decks: this.decks, h17: this.h17, payout: this.payout, das: this.das, lateSurrender: this.lateSurrender,
        penetration: this.penetration, rsa: this.rsa, enhc: this.enhc, obo: this.obo, doubleOn: this.doubleOn,
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
      const card = this.shoe.pop();
      if (this.logging) this.drawLog.push({ rank: card.rank, suit: card.suit });
      return card;
    }

    /** "x-3" for shoe 3 of seed x, or null for an unseeded game. */
    get shoeSeed() {
      return this.seed === null ? null : `${this.seed}-${this.shoeNo}`;
    }

    /** Replace the shoe at the cut card: the next seeded shoe, or a random one. */
    freshShoe() {
      if (this.seed === null) this.shoe = shuffle(createShoe(this.decks), this.rng);
      else this.shoe = seededShoe(this.decks, this.seed, ++this.shoeNo);
      this.shuffles++;
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
      if (newShoe) this.freshShoe();
      this.newShoe = newShoe;
      const first = [this.draw(), this.draw()];
      const dealer = [this.draw(), this.draw()];
      let seats = [first];
      if (!isBlackjack(dealer) && !isBlackjack(first)) {
        // Played like a bot seat (CLA-102): splits and resplits, one hand at a time.
        const hands = this.playSeat(first, dealer[0], decide);
        seats = hands.map((h) => h.cards);
        if (hands.some((h) => !h.surrendered && !isBust(h.cards))) while (dealerShouldHit(dealer, this.h17)) dealer.push(this.draw());
      }
      return { seat: seats[0], seats, dealer, newShoe };
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

    /** Split aces take one card each, so they can't hit (with RSA they can still split again). */
    canHit() {
      const h = this.currentHand;
      return this.phase === 'player' && !!h && !h.splitAces;
    }

    canDouble() {
      const h = this.currentHand;
      return !!h && h.cards.length === 2 && !h.splitAces && (this.das || !h.fromSplit) &&
        canDoubleOn(h.cards, this.doubleOn) && this.bankroll >= h.bet;
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
      if (this.bots + bets.length > TABLE_SEATS) throw new Error(`The table has ${TABLE_SEATS} seats: ${this.bots} bots leave room for ${TABLE_SEATS - this.bots} spots`);
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
      if (this.newShoe) this.freshShoe();
      this.drawLog = [];
      this.actionLog = [];
      this.logging = true;
      this.bankroll -= main;
      this.spotBets = bets.slice();
      this.results = [];
      this.insurance = 0;
      this.insuranceNet = null;
      this.tookEvenMoney = false;
      // Draw order: each seat's two cards in table order (bots and your
      // spots), then the dealer's two. Without bots: your spots, then the dealer.
      this.others = [];
      const yours = (spot) => ({
        cards: [this.draw(), this.draw()], bet: bets[spot], spot,
        fromSplit: false, splitAces: false, surrendered: false, done: false,
      });
      const bot = (seat) => this.others.push({ seat, hands: [{ cards: [this.draw(), this.draw()] }], results: [], played: false });
      for (let s = 0; s < this.seat; s++) bot(s);
      this.hands = bets.map((b, spot) => yours(spot));
      for (let s = this.seat + bets.length; s < this.bots + bets.length; s++) bot(s);
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
      this.actionLog.push('insurance');
      this.peek();
    }

    declineInsurance() {
      if (this.phase !== 'insurance') throw new Error('Insurance is not on offer');
      this.actionLog.push('no-insurance');
      this.peek();
    }

    /**
     * Dealer checks for blackjack; settles insurance; naturals end the round.
     * Under ENHC nobody looks: play goes on and insurance settles at the end.
     */
    peek() {
      if (this.enhc) {
        this.phase = 'player';
        this.playBots((o) => o.seat < this.seat);
        for (const h of this.hands) if (isNatural(h)) h.done = true;
        this.advance();
        return;
      }
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
      // Seats on your right play first; their cards are on the table before you act.
      this.playBots((o) => o.seat < this.seat);
      // A natural on any spot is paid at the end; play moves to the next spot.
      for (const h of this.hands) if (isNatural(h)) h.done = true;
      this.advance();
    }

    /** Play every bot seat matching `which` that hasn't played this round. */
    playBots(which) {
      for (const o of this.others) {
        if (o.played || !which(o)) continue;
        o.hands = this.playSeat(o.hands[0].cards, this.dealer[0], this.botDecide);
        o.played = true;
      }
    }

    /**
     * Play one seat with no money: `decide(cards, upcard, allowed)` picks
     * hit, stand, double, split or surrender for each hand. Split hands get
     * their second card when their turn comes, as at the table; pairs resplit
     * up to MAX_HANDS hands; split aces take one card each. Returns the hands:
     * [{cards, fromSplit, splitAces, doubled, surrendered}].
     */
    playSeat(cards, upcard, decide) {
      const hand = (c, fromSplit = false, splitAces = false) => ({ cards: c, fromSplit, splitAces, doubled: false, surrendered: false });
      const hands = [hand(cards)];
      if (isBlackjack(cards)) return hands;
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        if (h.cards.length === 1) h.cards.push(this.draw());
        if (h.splitAces) continue;
        while (handValue(h.cards).total < 21) {
          const two = h.cards.length === 2;
          const allowed = {
            canHit: true,
            canDouble: two && (this.das || !h.fromSplit) && canDoubleOn(h.cards, this.doubleOn),
            canSplit: two && h.cards[0].rank === h.cards[1].rank && hands.length < MAX_HANDS,
            canSurrender: this.lateSurrender && !this.enhc && two && hands.length === 1,
          };
          const a = decide(h.cards, upcard, allowed);
          if (a === 'split' && allowed.canSplit) {
            const aces = h.cards[0].rank === 'A';
            const moved = h.cards.pop();
            h.fromSplit = true;
            h.splitAces = aces;
            hands.splice(i + 1, 0, hand([moved], true, aces));
            h.cards.push(this.draw());
            if (aces) break;
            continue;
          }
          if (a === 'surrender' && allowed.canSurrender) { h.surrendered = true; break; }
          if (a === 'double' && allowed.canDouble) { h.cards.push(this.draw()); h.doubled = true; break; }
          if (a === 'hit') { h.cards.push(this.draw()); continue; }
          break; // stand, or a move the seat can't make
        }
      }
      return hands;
    }

    hit() {
      const h = this.requireHand();
      if (!this.canHit()) throw new Error('Split aces take one card');
      this.actionLog.push('hit');
      h.cards.push(this.draw());
      if (handValue(h.cards).total >= 21) h.done = true;
      this.advance();
    }

    stand() {
      this.requireHand().done = true;
      this.actionLog.push('stand');
      this.advance();
    }

    double() {
      if (!this.canDouble()) throw new Error('Cannot double now');
      this.actionLog.push('double');
      const h = this.currentHand;
      this.bankroll -= h.bet;
      h.bet *= 2;
      h.cards.push(this.draw());
      h.done = true;
      this.advance();
    }

    split() {
      if (!this.canSplit()) throw new Error('Cannot split now');
      this.actionLog.push('split');
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
      this.actionLog.push('surrender');
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
      if (h.splitAces && this.canResplitAces(h)) return; // RSA: split again or stand
      if (h.splitAces || handValue(h.cards).total >= 21) h.done = true;
    }

    canResplitAces(h) {
      return this.rsa && h.cards.length === 2 && h.cards[1].rank === 'A' &&
        this.hands.filter((x) => x.spot === h.spot).length < MAX_HANDS && this.bankroll >= h.bet;
    }

    /** Move past finished hands; once none remain, the dealer plays. */
    advance() {
      while (this.active < this.hands.length && this.hands[this.active].done) {
        this.active++;
        if (this.active < this.hands.length) this.prepare(this.active);
      }
      if (this.active < this.hands.length) return;
      this.playBots((o) => o.seat > this.seat);
      // Dealer only draws if at least one hand at the table is still live.
      // (A natural is already paid off, so it doesn't make the dealer draw either.)
      const live = (h) => !h.surrendered && !isBust(h.cards) && !isNatural(h);
      if (this.hands.some(live) || this.others.some((o) => o.hands.some(live))) {
        while (dealerShouldHit(this.dealer, this.h17)) this.dealer.push(this.draw());
      }
      this.finish();
    }

    finish() {
      this.results = this.hands.map((h) => settle(h.cards, this.dealer, h.bet, { ...h, payout: this.payout }));
      if (this.enhc) this.settleENHC();
      this.logging = false;
      // Stakes were removed when placed, so return stake + net per hand.
      this.hands.forEach((h, i) => { this.bankroll += h.bet + this.results[i].net; });
      for (const o of this.others) {
        o.results = o.hands.map((h) => settle(h.cards, this.dealer, h.doubled ? 2 : 1, { ...h, payout: this.payout }));
      }
      this.phase = 'done';
    }

    /**
     * ENHC: the dealer's blackjack shows up only now. It takes the full bet
     * of a surrendered hand (surrender is only against a non-blackjack), and
     * with OBO a spot loses just its original bet, however much was added
     * by doubling and splitting. Insurance settles here too.
     */
    settleENHC() {
      const dBJ = isBlackjack(this.dealer);
      if (this.insurance > 0) {
        this.insuranceNet = dBJ ? this.insurance * 2 : -this.insurance;
        if (dBJ) this.bankroll += this.insurance * 3;
      }
      if (!dBJ) return;
      this.hands.forEach((h, i) => {
        if (h.surrendered) this.results[i] = { outcome: 'lose', net: -h.bet };
      });
      if (!this.obo) return;
      const charged = new Set();
      this.hands.forEach((h, i) => {
        if (isNatural(h)) return;
        const first = !charged.has(h.spot);
        charged.add(h.spot);
        this.results[i] = first
          ? { outcome: 'lose', net: -this.spotBets[h.spot] }
          : { outcome: 'push', net: 0 };
      });
    }

    /** Plain-data snapshot for saving. Restore it with Game.fromJSON. */
    toJSON() {
      return {
        bankroll: this.bankroll, decks: this.decks, minBet: this.minBet,
        maxBet: Number.isFinite(this.maxBet) ? this.maxBet : null, penetration: this.penetration,
        h17: this.h17, payout: this.payout, das: this.das, lateSurrender: this.lateSurrender,
        rsa: this.rsa, enhc: this.enhc, obo: this.obo, doubleOn: this.doubleOn,
        seed: this.seed, shoeNo: this.shoeNo, drawLog: this.drawLog, actionLog: this.actionLog, logging: this.logging,
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
        lateSurrender: data.lateSurrender ?? true, rsa: data.rsa ?? false, enhc: data.enhc ?? false,
        obo: data.obo ?? false, doubleOn: data.doubleOn ?? 'any', seed: data.seed ?? null, shoeNo: data.shoeNo ?? 1,
      });
      g.drawLog = Array.isArray(data.drawLog) ? data.drawLog.filter(validCard).map(({ rank, suit }) => ({ rank, suit })) : [];
      g.actionLog = Array.isArray(data.actionLog) ? data.actionLog.filter((a) => typeof a === 'string') : [];
      g.logging = data.logging === true;
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
    for (const k of ['h17', 'das', 'lateSurrender', 'rsa', 'enhc', 'obo']) if (d[k] !== undefined && !isBool(d[k])) return false;
    if (d.doubleOn !== undefined && !DOUBLE_ON.includes(d.doubleOn)) return false;
    if (d.seed !== undefined && d.seed !== null && !(typeof d.seed === 'string' && d.seed.length <= 40)) return false;
    if (d.shoeNo !== undefined && !(Number.isInteger(d.shoeNo) && d.shoeNo >= 1)) return false;
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
    SUITS, RANKS, MAX_HANDS, MAX_SPOTS, TABLE_SEATS, PAYOUTS, DOUBLE_ON, SIDE_MAX, createShoe, shuffle, cardValue, handValue, canDoubleOn,
    isBlackjack, isBust, dealerShouldHit, settle, Game, seededRng, hashSeed, parseSeed, randomSeed, seededShoe,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Blackjack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
