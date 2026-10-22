/**
 * Shared table (CLA-110): up to seven players, each in their own seat with
 * their own bankroll, sharing one shoe and one dealer. Pure and DOM-free
 * (window.BlackjackTable in the browser, module.exports under Node).
 *
 * Every player plays the dealer, as at a real table; the players don't play
 * each other. A round goes:
 *
 *   betting   seated players bet (bet) or sit the round out (sitOut);
 *             deal() starts the round once at least one seat has bet
 *   insurance with an ace up, each seat that bet decides in seat order
 *   player    seats play in order, each hand of a seat in turn
 *   done      the dealer has played and every seat is settled
 *
 * Only the seat whose turn it is may act (`turn`). The table doesn't keep
 * time: whoever hosts it (server/) decides what happens to a slow player
 * (stand, decline, sit out) and plays bots by calling the same methods.
 *
 * Rules and play match Game (engine/blackjack.js): splits and resplits up to
 * MAX_HANDS hands, one card to split aces (RSA optional), doubles under
 * doubleOn and DAS, late surrender, H17, 6:5, ENHC and OBO, the cut card and
 * seeded shoes. Seats are dealt two cards each in seat order, then the
 * dealer, so one seat reproduces Game exactly for the same seed and moves.
 *
 * Fair by construction for everyone watching: `view(seat)` shows what a
 * player at the table can see (the hole card only once the round is over),
 * and the shoe's seed, which fixes the order of the cards, is never shown
 * while that shoe is in play.
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;
  const { handValue, isBlackjack, isBust, dealerShouldHit, settle, canDoubleOn, createShoe, shuffle, seededShoe, seededRng, hashSeed } = BJ;

  const SEATS = BJ.TABLE_SEATS;
  const RANK_KEYS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
  const rankKey = (rank) => (rank === '10' ? 'T' : rank);
  const SUIT = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
  const cardText = (c) => rankKey(c.rank) + SUIT[c.suit];
  const isNatural = (h) => !h.fromSplit && isBlackjack(h.cards);
  const round2 = (n) => Math.round(n * 100) / 100;
  const emptySeen = () => Object.fromEntries(RANK_KEYS.map((r) => [r, 0]));

  class TableError extends Error {}

  class Table {
    /**
     * Options: seed (required: the shoe order; keep it secret while playing),
     * shoeNo, decks, h17, payout, das, lateSurrender, rsa, enhc, obo,
     * doubleOn, penetration, minBet, maxBet.
     */
    constructor({
      seed, shoeNo = 1, decks = 6, h17 = false, payout = 1.5, das = true, lateSurrender = true,
      rsa = false, enhc = false, obo = false, doubleOn = 'any', penetration = 0.75, minBet = 1, maxBet = 500,
    } = {}) {
      if (seed === undefined || seed === null || String(seed) === '') throw new TableError('A table needs a seed');
      Object.assign(this, { decks, h17, payout, das, lateSurrender, rsa, enhc, obo: enhc && obo, doubleOn, penetration, minBet, maxBet });
      this.seed = String(seed);
      this.shoeNo = shoeNo;
      this.shoe = seededShoe(decks, this.seed, shoeNo);
      this.seen = emptySeen(); // cards shown since this shoe was shuffled
      this.finishedShoes = []; // seeds of shoes already played out, safe to publish
      this.seats = Array.from({ length: SEATS }, () => null);
      this.round = 0;
      this.phase = 'betting';
      this.dealer = [];
      this.turn = null; // seat whose move it is (insurance or play)
      this.newShoe = false;
    }

    get rules() {
      const { decks, h17, payout, das, lateSurrender, penetration, rsa, enhc, obo, doubleOn } = this;
      return { decks, h17, payout, das, lateSurrender, penetration, rsa, enhc, obo, doubleOn };
    }

    get cutCardReached() {
      return this.shoe.length <= Math.round(this.decks * 52 * (1 - this.penetration));
    }

    // --- Seating ---

    /** Seat `player` ({id, name, kind}) at `seat`, or the first free seat. Returns the seat number. */
    sit(player, bankroll, seat = this.seats.indexOf(null)) {
      if (!player || !player.id) throw new TableError('A player needs an id');
      if (this.seats.some((s) => s && s.player.id === player.id)) throw new TableError('Already seated');
      if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) throw new TableError(seat === -1 ? 'The table is full' : `Seats are 0 to ${SEATS - 1}`);
      if (this.seats[seat]) throw new TableError(`Seat ${seat} is taken`);
      if (!(bankroll > 0)) throw new TableError('Bankroll must be positive');
      this.seats[seat] = {
        player: { ...player }, bankroll, bet: 0, out: false, inRound: false,
        hands: [], active: 0, insurance: 0, insuranceDecided: false, insuranceNet: null, tookEvenMoney: false, results: [], net: null,
      };
      return seat;
    }

    /** Leave the table. Between rounds only, or while sitting the round out. */
    leave(seat) {
      const s = this.seatOf(seat);
      if (s.inRound && this.phase !== 'done' && this.phase !== 'betting') throw new TableError('Finish the round first');
      this.seats[seat] = null;
    }

    seatOf(seat) {
      const s = this.seats[seat];
      if (!s) throw new TableError(`Nobody sits at seat ${seat}`);
      return s;
    }

    // --- Betting ---

    /** Place (or change) this round's bet. */
    bet(seat, amount) {
      this.toBetting();
      const s = this.seatOf(seat);
      if (!Number.isFinite(amount) || amount <= 0) throw new TableError('Bet must be positive');
      if (amount < this.minBet) throw new TableError(`Minimum bet is ${this.minBet}`);
      if (amount > this.maxBet) throw new TableError(`Maximum bet is ${this.maxBet}`);
      if (amount > s.bankroll) throw new TableError('Bet exceeds bankroll');
      s.bet = amount;
      s.out = false;
    }

    /** Sit this round out (Wonging, or a player who didn't bet in time). */
    sitOut(seat) {
      this.toBetting();
      const s = this.seatOf(seat);
      s.bet = 0;
      s.out = true;
    }

    /** True when every seated player has bet or sat out. */
    get ready() {
      const seated = this.seats.filter(Boolean);
      return seated.length > 0 && seated.every((s) => s.bet > 0 || s.out) && seated.some((s) => s.bet > 0);
    }

    /** After a round ends, betting for the next one opens on the first bet. */
    toBetting() {
      if (this.phase === 'done') {
        this.phase = 'betting';
        this.dealer = [];
        for (const s of this.seats) if (s) Object.assign(s, { hands: [], results: [], net: null, inRound: false, insurance: 0, insuranceNet: null, tookEvenMoney: false, insuranceDecided: false, bet: 0, out: false });
      }
      if (this.phase !== 'betting') throw new TableError('A round is in play');
    }

    // --- The round ---

    deal() {
      if (this.phase !== 'betting') throw new TableError('A round is in play');
      const playing = this.seats.map((s, i) => (s && s.bet > 0 ? i : -1)).filter((i) => i >= 0);
      if (!playing.length) throw new TableError('Nobody has bet');
      this.newShoe = this.cutCardReached;
      if (this.newShoe) this.freshShoe();
      this.round++;
      for (const i of playing) {
        const s = this.seats[i];
        s.bankroll -= s.bet;
        s.inRound = true;
        s.hands = [{ cards: [this.draw(), this.draw()], bet: s.bet, fromSplit: false, splitAces: false, surrendered: false, done: false }];
        s.active = 0;
      }
      this.dealer = [this.draw(false), this.draw(false)];
      this.show(this.dealer[0]);
      if (this.dealer[0].rank === 'A') {
        this.phase = 'insurance';
        this.turn = this.nextInsurance(-1);
      } else this.peek();
    }

    playingSeats() {
      return this.seats.map((s, i) => (s && s.inRound ? i : -1)).filter((i) => i >= 0);
    }

    nextInsurance(after) {
      const next = this.playingSeats().find((i) => i > after && !this.seats[i].insuranceDecided);
      return next === undefined ? null : next;
    }

    /** Insurance covers the seat's bet: half of it. With blackjack at 3:2 it is even money. */
    insuranceCost(seat) { return this.seatOf(seat).bet / 2; }

    evenMoney(seat) {
      const s = this.seatOf(seat);
      return this.phase === 'insurance' && this.payout === 1.5 && isBlackjack(s.hands[0].cards);
    }

    canInsure(seat) {
      const s = this.seats[seat];
      return this.phase === 'insurance' && this.turn === seat && (this.evenMoney(seat) || s.bankroll >= this.insuranceCost(seat));
    }

    insure(seat, take) {
      if (this.phase !== 'insurance' || this.turn !== seat) throw new TableError(this.phase === 'insurance' ? `It is seat ${this.turn}'s turn` : 'Insurance is not on offer');
      const s = this.seats[seat];
      if (take) {
        if (!this.canInsure(seat)) throw new TableError('Cannot take insurance');
        s.tookEvenMoney = this.evenMoney(seat);
        s.insurance = this.insuranceCost(seat);
        s.bankroll -= s.insurance;
      }
      s.insuranceDecided = true;
      this.turn = this.nextInsurance(seat);
      if (this.turn === null) this.peek();
    }

    /** The dealer checks for blackjack (not under ENHC); naturals stand; play starts. */
    peek() {
      this.phase = 'player';
      if (!this.enhc) {
        const dBJ = isBlackjack(this.dealer);
        for (const i of this.playingSeats()) {
          const s = this.seats[i];
          if (s.insurance > 0) {
            s.insuranceNet = dBJ ? s.insurance * 2 : -s.insurance;
            if (dBJ) s.bankroll += s.insurance * 3;
          }
        }
        if (dBJ) return this.finish();
      }
      for (const i of this.playingSeats()) for (const h of this.seats[i].hands) if (isNatural(h)) h.done = true;
      this.turn = this.playingSeats()[0];
      this.advance();
    }

    // --- Moves ---

    hand(seat) {
      if (this.phase !== 'player') throw new TableError('Not in play');
      if (this.turn !== seat) throw new TableError(`It is seat ${this.turn}'s turn`);
      const s = this.seats[seat];
      return s.hands[s.active];
    }

    /** Moves the seat can make now; empty when it isn't its turn. */
    legal(seat) {
      const s = this.seats[seat];
      if (!s) return [];
      if (this.phase === 'betting' || this.phase === 'done') return ['bet', 'sit_out'];
      if (this.turn !== seat) return [];
      if (this.phase === 'insurance') return this.canInsure(seat) ? ['insurance', 'decline_insurance'] : ['decline_insurance'];
      const h = s.hands[s.active];
      const out = [];
      if (!h.splitAces) out.push('hit');
      out.push('stand');
      if (h.cards.length === 2 && !h.splitAces && (this.das || !h.fromSplit) && canDoubleOn(h.cards, this.doubleOn) && s.bankroll >= h.bet) out.push('double');
      if (this.canSplit(s, h)) out.push('split');
      if (this.lateSurrender && !h.fromSplit && h.cards.length === 2) out.push('surrender');
      return out;
    }

    canSplit(s, h) {
      const pair = h.cards.length === 2 && h.cards[0].rank === h.cards[1].rank;
      if (!pair || s.hands.length >= BJ.MAX_HANDS || s.bankroll < h.bet) return false;
      return !h.splitAces || (this.rsa && h.cards[1].rank === 'A');
    }

    /** Play a move for `seat`: hit, stand, double, split, surrender, insurance or decline_insurance. */
    act(seat, action) {
      if (action === 'insurance' || action === 'decline_insurance') return this.insure(seat, action === 'insurance');
      const h = this.hand(seat);
      const s = this.seats[seat];
      if (!this.legal(seat).includes(action)) throw new TableError(`"${action}" is not legal now; legal: ${this.legal(seat).join(', ')}`);
      if (action === 'hit') {
        h.cards.push(this.draw());
        if (handValue(h.cards).total >= 21) h.done = true;
      } else if (action === 'stand') {
        h.done = true;
      } else if (action === 'double') {
        s.bankroll -= h.bet;
        h.bet *= 2;
        h.cards.push(this.draw());
        h.done = true;
      } else if (action === 'split') {
        const aces = h.cards[0].rank === 'A';
        s.bankroll -= h.bet;
        const second = { cards: [h.cards.pop()], bet: h.bet, fromSplit: true, splitAces: aces, surrendered: false, done: false };
        h.fromSplit = true;
        h.splitAces = aces;
        s.hands.splice(s.active + 1, 0, second);
        this.prepare(s, s.active);
      } else if (action === 'surrender') {
        h.surrendered = true;
        h.done = true;
      }
      this.advance();
    }

    /** A split hand gets its second card when its turn comes; it finishes itself if it can't act. */
    prepare(s, i) {
      const h = s.hands[i];
      if (h.cards.length === 1) h.cards.push(this.draw());
      if (h.splitAces && this.rsa && h.cards[1].rank === 'A' && s.hands.length < BJ.MAX_HANDS && s.bankroll >= h.bet) return;
      if (h.splitAces || handValue(h.cards).total >= 21) h.done = true;
    }

    /** Move past finished hands and seats; once every seat is done, the dealer plays. */
    advance() {
      const order = this.playingSeats();
      while (this.turn !== null) {
        const s = this.seats[this.turn];
        while (s.active < s.hands.length && s.hands[s.active].done) {
          s.active++;
          if (s.active < s.hands.length) this.prepare(s, s.active);
        }
        if (s.active < s.hands.length) return;
        const next = order.find((i) => i > this.turn);
        this.turn = next === undefined ? null : next;
      }
      const live = (h) => !h.surrendered && !isBust(h.cards) && !isNatural(h);
      if (order.some((i) => this.seats[i].hands.some(live))) {
        while (dealerShouldHit(this.dealer, this.h17)) this.dealer.push(this.draw(false));
      }
      this.finish();
    }

    finish() {
      this.turn = null;
      const dBJ = isBlackjack(this.dealer);
      for (const i of this.playingSeats()) {
        const s = this.seats[i];
        s.results = s.hands.map((h) => settle(h.cards, this.dealer, h.bet, { ...h, payout: this.payout }));
        if (this.enhc) this.settleENHC(s, dBJ);
        s.hands.forEach((h, k) => { s.bankroll += h.bet + s.results[k].net; });
        s.net = round2(s.results.reduce((a, r) => a + r.net, 0) + (s.insuranceNet || 0));
        s.bankroll = round2(s.bankroll);
      }
      for (const c of this.dealer.slice(1)) this.show(c);
      this.phase = 'done';
    }

    /** ENHC: as Game.settleENHC, for one seat. */
    settleENHC(s, dBJ) {
      if (s.insurance > 0) {
        s.insuranceNet = dBJ ? s.insurance * 2 : -s.insurance;
        if (dBJ) s.bankroll += s.insurance * 3;
      }
      if (!dBJ) return;
      s.hands.forEach((h, k) => { if (h.surrendered) s.results[k] = { outcome: 'lose', net: -h.bet }; });
      if (!this.obo) return;
      let charged = false;
      s.hands.forEach((h, k) => {
        if (isNatural(h)) return;
        s.results[k] = charged ? { outcome: 'push', net: 0 } : { outcome: 'lose', net: -s.bet };
        charged = true;
      });
    }

    // --- The shoe ---

    /** Deal a card. Player cards are face up and count as seen at once; the dealer's show when turned over. */
    draw(faceUp = true) {
      if (!this.shoe.length) this.refill();
      const c = this.shoe.pop();
      if (faceUp) this.show(c);
      return c;
    }

    show(c) { this.seen[rankKey(c.rank)]++; }

    freshShoe() {
      this.finishedShoes.push(`${this.seed}-${this.shoeNo}`);
      this.shoe = seededShoe(this.decks, this.seed, ++this.shoeNo);
      this.seen = emptySeen();
    }

    /** Last resort for tiny shoes at a full table: shuffle the discards, as a dealer would. */
    refill() {
      const onTable = new Map();
      const key = (c) => c.rank + c.suit;
      const cards = [...this.dealer, ...this.seats.flatMap((s) => (s ? s.hands.flatMap((h) => h.cards) : []))];
      for (const c of cards) onTable.set(key(c), (onTable.get(key(c)) || 0) + 1);
      const discards = createShoe(this.decks).filter((c) => {
        const n = onTable.get(key(c)) || 0;
        if (n) onTable.set(key(c), n - 1);
        return !n;
      });
      this.shoe = shuffle(discards, seededRng(hashSeed(`${this.seed}-${this.shoeNo}-refill-${this.round}`)));
    }

    // --- What players see ---

    /**
     * The table as `seat` sees it (or a spectator, with seat null): every
     * seat's player, bet and hands, the dealer's up card (the hole card once
     * the round is over), the cards seen since the shuffle, and for `seat`
     * its bankroll, legal moves and their cost.
     */
    view(seat = null) {
      const live = this.phase === 'insurance' || this.phase === 'player';
      const dealer = live ? this.dealer.slice(0, 1) : this.dealer;
      const seats = this.seats.map((s, i) => (s ? {
        seat: i,
        player: { name: s.player.name, kind: s.player.kind },
        bankroll: s.bankroll,
        bet: s.bet,
        out: s.out,
        insurance: s.insurance,
        hands: s.hands.map((h, k) => {
          const v = handValue(h.cards);
          return {
            cards: h.cards.map(cardText), total: v.total, soft: v.soft, bet: h.bet, fromSplit: h.fromSplit,
            surrendered: h.surrendered, result: this.phase === 'done' && s.results[k] ? { outcome: s.results[k].outcome, net: round2(s.results[k].net) } : null,
          };
        }),
        active: this.phase === 'player' && this.turn === i ? s.active : null,
        net: s.net,
      } : null));
      const out = {
        phase: this.phase,
        round: this.round,
        turn: this.turn,
        rules: this.rules,
        table: { minBet: this.minBet, maxBet: this.maxBet, seats: SEATS, maxHandsPerSeat: BJ.MAX_HANDS },
        shoe: { shoeNo: this.shoeNo, decks: this.decks, cardsLeft: this.shoe.length + (live ? 1 : 0), cutCardReached: this.cutCardReached, seen: { ...this.seen }, finished: this.finishedShoes.slice() },
        dealer: { cards: dealer.map(cardText), total: dealer.length ? handValue(dealer).total : 0, holeCardHidden: live },
        seats,
      };
      if (seat !== null && this.seats[seat]) {
        const s = this.seats[seat];
        const legal = this.legal(seat);
        const cost = {};
        for (const a of legal) {
          if (a === 'double' || a === 'split') cost[a] = s.hands[s.active].bet;
          else if (a === 'insurance') cost[a] = this.insuranceCost(seat);
          else if (a !== 'bet' && a !== 'sit_out') cost[a] = 0;
        }
        out.you = {
          seat, bankroll: round2(s.bankroll), legal, legalCost: cost, yourTurn: this.turn === seat,
          evenMoney: this.phase === 'insurance' && s.inRound ? this.evenMoney(seat) : false,
        };
      }
      return out;
    }
  }

  const api = { Table, TableError, SEATS, cardText };
  if (node) module.exports = api;
  else root.BlackjackTable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
