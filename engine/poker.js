/**
 * No-limit Texas Hold'em (CLA-119): a table of 2 to 6 seats that play each
 * other. Pure and DOM-free (window.Poker in the browser, module.exports under
 * Node), like the blackjack engine.
 *
 * A hand: the button moves, the blinds are posted, two hole cards each, then
 * preflop, flop (3), turn (1) and river (1) betting rounds, then showdown. The
 * host (server/) starts hands and keeps the clock; the table checks that only
 * the seat whose turn it is acts, and only legally.
 *
 * Betting: check, call, bet, raise (amounts for bet and raise are the total
 * the seat puts in this street, "raise to"), fold, all-in. A raise must be at
 * least the last full raise; an all-in for less doesn't reopen the betting
 * for players who have already acted. Side pots come from what each seat put
 * in; each pot goes to the best hand among the seats still in that put in at
 * least that much; split pots share equally, odd chips to the first winner
 * left of the button.
 *
 * Cards are "As", "Td", "7h". Every hand is shuffled from (seed, hand
 * number), so a session can be replayed; `view(seat)` shows only that seat's
 * hole cards until a showdown turns them up.
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;

  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const MAX_SEATS = 6;
  const value = (card) => RANKS.indexOf(card[0]) + 2; // 2..14

  class PokerError extends Error {}

  // --- Hand evaluation ---

  const CATEGORY = ['high card', 'pair', 'two pair', 'three of a kind', 'straight', 'flush', 'full house', 'four of a kind', 'straight flush'];
  const NAME = { 14: 'aces', 13: 'kings', 12: 'queens', 11: 'jacks', 10: 'tens', 9: 'nines', 8: 'eights', 7: 'sevens', 6: 'sixes', 5: 'fives', 4: 'fours', 3: 'threes', 2: 'twos' };
  const ONE = { 14: 'ace', 13: 'king', 12: 'queen', 11: 'jack', 10: 'ten', 9: 'nine', 8: 'eight', 7: 'seven', 6: 'six', 5: 'five', 4: 'four', 3: 'three', 2: 'two' };

  /** Category and up to five ranks, best first, packed into one comparable number. */
  const pack = (cat, ranks) => ranks.concat([0, 0, 0, 0, 0]).slice(0, 5).reduce((s, r) => s * 15 + r, cat);

  /** Highest straight in a set of rank values (ace plays low too), or 0. */
  function straightHigh(values) {
    const has = new Set(values);
    if (has.has(14)) has.add(1);
    for (let hi = 14; hi >= 5; hi--) {
      let ok = true;
      for (let k = 0; k < 5; k++) if (!has.has(hi - k)) { ok = false; break; }
      if (ok) return hi;
    }
    return 0;
  }

  /** Best five of five to seven cards: {score, category, name, cards}. Higher score wins. */
  function evaluate(cards) {
    const counts = new Map();
    const bySuit = { s: [], h: [], d: [], c: [] };
    for (const c of cards) {
      const v = value(c);
      counts.set(v, (counts.get(v) || 0) + 1);
      bySuit[c[1]].push(v);
    }
    const flushSuit = SUITS.split('').find((s) => bySuit[s].length >= 5);
    if (flushSuit) {
      const sf = straightHigh(bySuit[flushSuit]);
      if (sf) return result(8, [sf], cards);
    }
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]); // by count, then rank
    const desc = [...counts.keys()].sort((a, b) => b - a);
    const without = (...vs) => desc.filter((v) => !vs.includes(v));
    if (groups[0][1] === 4) return result(7, [groups[0][0], without(groups[0][0])[0]], cards);
    const trips = groups.filter((g) => g[1] === 3).map((g) => g[0]);
    const pairs = groups.filter((g) => g[1] === 2).map((g) => g[0]);
    if (trips.length && (trips.length > 1 || pairs.length)) {
      const t = trips[0];
      const p = Math.max(...trips.slice(1), ...pairs);
      return result(6, [t, p], cards);
    }
    if (flushSuit) return result(5, bySuit[flushSuit].sort((a, b) => b - a).slice(0, 5), cards);
    const st = straightHigh(desc);
    if (st) return result(4, [st], cards);
    if (trips.length) return result(3, [trips[0], ...without(trips[0]).slice(0, 2)], cards);
    if (pairs.length >= 2) return result(2, [pairs[0], pairs[1], without(pairs[0], pairs[1])[0]], cards);
    if (pairs.length) return result(1, [pairs[0], ...without(pairs[0]).slice(0, 3)], cards);
    return result(0, desc.slice(0, 5), cards);
  }

  function result(cat, ranks, cards) {
    return { score: pack(cat, ranks), category: CATEGORY[cat], name: describe(cat, ranks), cards };
  }

  function describe(cat, r) {
    switch (cat) {
      case 8: return r[0] === 14 ? 'royal flush' : `straight flush, ${ONE[r[0]]} high`;
      case 7: return `four of a kind, ${NAME[r[0]]}`;
      case 6: return `full house, ${NAME[r[0]]} full of ${NAME[r[1]]}`;
      case 5: return `flush, ${ONE[r[0]]} high`;
      case 4: return `straight, ${ONE[r[0]]} high`;
      case 3: return `three of a kind, ${NAME[r[0]]}`;
      case 2: return `two pair, ${NAME[r[0]]} and ${NAME[r[1]]}`;
      case 1: return `pair of ${NAME[r[0]]}`;
      default: return `${ONE[r[0]]} high`;
    }
  }

  // --- Deck ---

  const fullDeck = () => SUITS.split('').flatMap((s) => RANKS.split('').map((r) => r + s));

  function shuffled(seed, handNo) {
    const rng = BJ.seededRng(BJ.hashSeed(`${seed}#${handNo}`));
    const d = fullDeck();
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  // --- The table ---

  const STREETS = ['preflop', 'flop', 'turn', 'river'];

  class PokerTable {
    /** Options: seed (required), smallBlind, bigBlind, seats (2-6). */
    constructor({ seed, smallBlind = 5, bigBlind = 10, seats = MAX_SEATS } = {}) {
      if (seed === undefined || seed === null || String(seed) === '') throw new PokerError('A poker table needs a seed');
      if (!Number.isInteger(bigBlind) || !Number.isInteger(smallBlind) || !(bigBlind > 0) || !(smallBlind > 0) || smallBlind > bigBlind) throw new PokerError('Blinds must be positive whole numbers, small at most big');
      if (!Number.isInteger(seats) || seats < 2 || seats > MAX_SEATS) throw new PokerError(`Seats must be 2 to ${MAX_SEATS}`);
      this.seed = String(seed);
      this.sb = smallBlind;
      this.bb = bigBlind;
      this.seats = Array.from({ length: seats }, () => null);
      this.handNo = 0;
      this.button = -1;
      this.phase = 'waiting'; // waiting | preflop | flop | turn | river | done
      this.board = [];
      this.toAct = null;
      this.log = [];
      this.lastHand = null;
    }

    // --- Seating ---

    sit(player, stack, seat = this.seats.indexOf(null)) {
      if (!player || !player.id) throw new PokerError('A player needs an id');
      if (this.seats.some((s) => s && s.player.id === player.id)) throw new PokerError('Already seated');
      if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) throw new PokerError(seat === -1 ? 'The table is full' : `Seats are 0 to ${this.seats.length - 1}`);
      if (this.seats[seat]) throw new PokerError(`Seat ${seat} is taken`);
      if (!(stack > 0)) throw new PokerError('A stack must be positive');
      this.seats[seat] = { player: { ...player }, stack, hole: [], bet: 0, committed: 0, folded: false, allIn: false, inHand: false, acted: false, canRaise: true, out: false, lastAction: null };
      return seat;
    }

    /** Leave: between hands, or (folding first) during one. */
    leave(seat) {
      const s = this.seatOf(seat);
      if (s.inHand && this.inPlay && !s.folded) {
        if (this.toAct === seat) this.act(seat, 'fold');
        else {
          s.folded = true;
          s.lastAction = 'fold';
          this.log.push({ seat, action: 'fold', street: this.phase });
          if (this.live().length === 1) this.finish(false);
        }
      }
      if (s.inHand && this.inPlay) { s.leaving = true; return; } // their chips in the pot stay in play
      this.seats[seat] = null;
    }

    /** Add chips between hands (a rebuy). */
    addChips(seat, amount) {
      const s = this.seatOf(seat);
      if (this.inPlay && s.inHand) throw new PokerError('Add chips between hands');
      if (!(amount > 0)) throw new PokerError('Amount must be positive');
      s.stack += amount;
    }

    /** Sit out future hands (true) or come back (false). */
    setOut(seat, out) { this.seatOf(seat).out = !!out; }

    seatOf(seat) {
      const s = this.seats[seat];
      if (!s) throw new PokerError(`Nobody sits at seat ${seat}`);
      return s;
    }

    get inPlay() { return STREETS.includes(this.phase); }

    /** Seats that can be dealt in: chips, not sitting out. */
    eligible() {
      return this.seats.map((s, i) => (s && !s.out && !s.leaving && s.stack > 0 ? i : -1)).filter((i) => i >= 0);
    }

    get canStart() { return !this.inPlay && this.eligible().length >= 2; }

    // --- A hand ---

    /** Next seat after `i` (clockwise) among `list`. */
    nextOf(i, list) {
      const sorted = [...list].sort((a, b) => a - b);
      return sorted.find((x) => x > i) ?? sorted[0];
    }

    startHand() {
      if (this.inPlay) throw new PokerError('A hand is in play');
      for (let i = 0; i < this.seats.length; i++) if (this.seats[i] && this.seats[i].leaving) this.seats[i] = null;
      const players = this.eligible();
      if (players.length < 2) throw new PokerError('Two players with chips are needed');
      this.handNo++;
      // `nextDeck` stacks the next hand's cards (tests); cards are dealt from the end.
      this.deck = this.nextDeck ? this.nextDeck.slice() : shuffled(this.seed, this.handNo);
      this.nextDeck = null;
      this.board = [];
      this.log = [];
      this.lastHand = null;
      for (const s of this.seats) if (s) Object.assign(s, { hole: [], bet: 0, committed: 0, folded: false, allIn: false, inHand: false, acted: false, canRaise: true, lastAction: null });
      this.button = this.nextOf(this.button, players);
      for (const i of players) this.seats[i].inHand = true;
      const headsUp = players.length === 2;
      const sbSeat = headsUp ? this.button : this.nextOf(this.button, players);
      const bbSeat = this.nextOf(sbSeat, players);
      this.phase = 'preflop';
      this.currentBet = 0;
      this.minRaise = this.bb;
      this.post(sbSeat, this.sb, 'small blind');
      this.post(bbSeat, this.bb, 'big blind');
      this.currentBet = this.bb; // even if the big blind is short, the table plays to a full big blind
      for (let round = 0; round < 2; round++) {
        for (let k = 0, i = this.nextOf(this.button, players); k < players.length; k++, i = this.nextOf(i, players)) this.seats[i].hole.push(this.deck.pop());
      }
      this.toAct = this.nextOf(bbSeat, players);
      this.skipToActor();
    }

    post(seat, amount, what) {
      const s = this.seats[seat];
      const a = Math.min(amount, s.stack);
      s.stack -= a;
      s.bet += a;
      s.committed += a;
      if (s.stack === 0) s.allIn = true;
      this.log.push({ seat, action: what, amount: a, street: 'preflop' });
    }

    /** Seats still able to act this street (in the hand, not folded, not all-in). */
    actors() {
      return this.seats.map((s, i) => (s && s.inHand && !s.folded && !s.allIn ? i : -1)).filter((i) => i >= 0);
    }

    live() {
      return this.seats.map((s, i) => (s && s.inHand && !s.folded ? i : -1)).filter((i) => i >= 0);
    }

    /** What `seat` may do now: [{action, amount} | {action, min, max}]; empty when it isn't its turn. */
    legal(seat) {
      if (!this.inPlay || this.toAct !== seat) return [];
      const s = this.seats[seat];
      const toCall = this.currentBet - s.bet;
      const out = [{ action: 'fold' }];
      if (toCall <= 0) out.push({ action: 'check' });
      else out.push({ action: 'call', amount: Math.min(toCall, s.stack) });
      const most = s.bet + s.stack; // all-in, as a "to" total
      if (most > this.currentBet && s.canRaise) {
        if (this.currentBet === 0) out.push({ action: 'bet', min: Math.min(this.bb, most), max: most });
        else out.push({ action: 'raise', min: Math.min(this.currentBet + this.minRaise, most), max: most });
      }
      return out;
    }

    /** Play `action` for `seat`; `amount` is the "to" total for bet and raise. "allin" bets, raises or calls everything. */
    act(seat, action, amount) {
      if (!this.inPlay) throw new PokerError('No hand in play');
      if (this.toAct !== seat) throw new PokerError(`It is seat ${this.toAct}'s turn`);
      const s = this.seats[seat];
      const legal = this.legal(seat);
      const find = (a) => legal.find((l) => l.action === a);
      if (action === 'allin') {
        const up = find('raise') || find('bet');
        if (up) { action = up.action; amount = up.max; } else action = 'call';
      }
      const move = find(action);
      if (!move) throw new PokerError(`"${action}" is not legal now; legal: ${legal.map((l) => l.action).join(', ')}`);
      if (action === 'fold') {
        s.folded = true;
      } else if (action === 'check') {
        // nothing to put in
      } else if (action === 'call') {
        this.putIn(s, move.amount);
      } else {
        const to = Math.round(Number(amount));
        if (!Number.isFinite(to) || to < move.min || to > move.max) throw new PokerError(`${action} must be to between ${move.min} and ${move.max}`);
        const raiseBy = to - this.currentBet;
        this.putIn(s, to - s.bet);
        const full = raiseBy >= this.minRaise;
        for (const i of this.actors()) {
          if (i === seat) continue;
          const o = this.seats[i];
          if (full) { o.acted = false; o.canRaise = true; }
          else if (o.acted) { o.acted = false; o.canRaise = false; } // a short all-in: call or fold only
        }
        if (full) this.minRaise = raiseBy;
        this.currentBet = to;
        amount = to;
      }
      s.acted = true;
      s.lastAction = action;
      this.log.push({ seat, action, ...(action === 'bet' || action === 'raise' ? { to: amount } : action === 'call' ? { amount: move.amount } : {}), street: this.phase, allIn: s.allIn });
      this.advance();
    }

    putIn(s, chips) {
      const a = Math.min(chips, s.stack);
      s.stack -= a;
      s.bet += a;
      s.committed += a;
      if (s.stack === 0) s.allIn = true;
    }

    /** Next actor, next street, or the end of the hand. */
    advance() {
      if (this.live().length === 1) return this.finish(false);
      const pending = this.actors().filter((i) => !this.seats[i].acted || this.seats[i].bet < this.currentBet);
      if (pending.length && !(this.actors().length === 1 && this.seats[this.actors()[0]].bet >= this.currentBet)) {
        this.toAct = this.nextOf(this.toAct, pending);
        return;
      }
      this.nextStreet();
    }

    skipToActor() {
      // Preflop with everyone all-in from the blinds: nobody can act.
      const pending = this.actors().filter((i) => !this.seats[i].acted || this.seats[i].bet < this.currentBet);
      if (!pending.length || (this.actors().length <= 1 && pending.every((i) => this.seats[i].bet >= this.currentBet))) return this.nextStreet();
      if (!pending.includes(this.toAct)) this.toAct = this.nextOf(this.toAct, pending);
    }

    nextStreet() {
      for (const s of this.seats) if (s) { s.bet = 0; s.acted = false; s.canRaise = true; }
      this.currentBet = 0;
      this.minRaise = this.bb;
      const k = STREETS.indexOf(this.phase);
      if (k === 3) return this.finish(true);
      this.phase = STREETS[k + 1];
      this.deck.pop(); // burn
      const n = this.phase === 'flop' ? 3 : 1;
      for (let i = 0; i < n; i++) this.board.push(this.deck.pop());
      // With fewer than two players able to act, run the board out.
      if (this.actors().length < 2) return this.nextStreet();
      this.toAct = this.nextOf(this.button, this.actors());
    }

    /** Pots from what each seat put in; each to the best hand among the seats still in that reached it. */
    pots() {
      const contrib = this.seats.map((s) => (s ? s.committed : 0));
      const levels = [...new Set(contrib.filter((c) => c > 0))].sort((a, b) => a - b);
      const out = [];
      let prev = 0;
      for (const level of levels) {
        const amount = contrib.reduce((sum, c) => sum + Math.max(0, Math.min(c, level) - prev), 0);
        const eligible = this.seats.map((s, i) => (s && s.inHand && !s.folded && contrib[i] >= level ? i : -1)).filter((i) => i >= 0);
        if (!eligible.length && out.length) out[out.length - 1].amount += amount; // only folded money at this level
        else out.push({ amount, eligible });
        prev = level;
      }
      return out;
    }

    finish(showdown) {
      const live = this.live();
      const shown = showdown && live.length > 1;
      const hands = new Map(live.map((i) => [i, evaluate([...this.seats[i].hole, ...this.board])]));
      const won = new Map();
      const potResults = this.pots().map((p) => {
        let winners = p.eligible.length ? p.eligible : live.slice(0, 1);
        if (winners.length > 1) {
          const best = Math.max(...winners.map((i) => hands.get(i).score));
          winners = winners.filter((i) => hands.get(i).score === best);
        }
        const share = Math.floor(p.amount / winners.length);
        let odd = p.amount - share * winners.length;
        // Odd chips: first winner clockwise from the button.
        const n = this.seats.length;
        const fromButton = (i) => (i - this.button - 1 + n) % n; // the seat left of the button is 0
        const order = [...winners].sort((a, b) => fromButton(a) - fromButton(b));
        for (const i of order) {
          const get = share + (odd > 0 ? 1 : 0);
          if (odd > 0) odd--;
          won.set(i, (won.get(i) || 0) + get);
          this.seats[i].stack += get;
        }
        return { amount: p.amount, winners: order, hand: winners.length && shown ? hands.get(winners[0]).name : null };
      });
      this.lastHand = {
        handNo: this.handNo, board: [...this.board], pots: potResults, showdown: shown,
        shown: shown ? live.map((i) => ({ seat: i, cards: [...this.seats[i].hole], hand: hands.get(i).name })) : [],
        net: this.seats.map((s, i) => (s && s.inHand ? (won.get(i) || 0) - s.committed : null)),
      };
      this.phase = 'done';
      this.toAct = null;
    }

    // --- What a seat sees ---

    view(seat = null) {
      const showdown = this.phase === 'done' && this.lastHand && this.lastHand.showdown;
      const shownSeats = new Set(showdown ? this.lastHand.shown.map((x) => x.seat) : []);
      const v = {
        phase: this.phase, handNo: this.handNo, button: this.button, smallBlind: this.sb, bigBlind: this.bb,
        board: [...this.board], toAct: this.toAct, currentBet: this.inPlay ? this.currentBet : 0,
        pot: this.seats.reduce((a, s) => a + (s ? s.committed : 0), 0) * (this.inPlay ? 1 : 0),
        seats: this.seats.map((s, i) => (s ? {
          seat: i, player: { name: s.player.name, kind: s.player.kind }, stack: s.stack, bet: s.bet, committed: s.committed,
          inHand: s.inHand, folded: s.folded, allIn: s.allIn, out: s.out, lastAction: s.lastAction,
          cards: i === seat || shownSeats.has(i) ? [...s.hole] : s.inHand && !s.folded ? ['??', '??'] : [],
        } : null)),
        log: this.log.map((x) => ({ ...x })),
        lastHand: this.lastHand,
      };
      if (seat !== null && this.seats[seat]) {
        const s = this.seats[seat];
        v.you = {
          seat, stack: s.stack, cards: [...s.hole], legal: this.legal(seat), yourTurn: this.toAct === seat,
          toCall: this.inPlay ? Math.max(0, Math.min(this.currentBet - s.bet, s.stack)) : 0,
          hand: s.hole.length && this.board.length >= 3 ? evaluate([...s.hole, ...this.board]).name : null,
        };
      }
      return v;
    }
  }

  const api = { PokerTable, PokerError, evaluate, fullDeck, shuffled, value, RANKS, SUITS, MAX_SEATS, CATEGORY };
  if (node) module.exports = api;
  else root.Poker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
