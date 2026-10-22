/**
 * Agent environment over the blackjack engine: reset / step / observe with
 * plain-JSON observations and actions, for programs rather than people.
 *
 * - Deterministic: every table is seeded (a random seed is chosen and
 *   reported when none is given), so any session can be replayed exactly.
 * - Fair: observations show only what a player at the table could see. The
 *   dealer's hole card stays hidden until the round ends, and the shoe's
 *   order is never exposed. `seen` counts every card revealed since the last
 *   shuffle, so counting agents need not track cards themselves.
 * - Strict: an illegal action or an invalid rule is an error, never a
 *   silent fallback.
 *
 * Cards are two-character strings: rank (A 2-9 T J Q K) + suit (s h d c),
 * e.g. "As", "Td", "7h".
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const BJ = node ? require('../engine/blackjack.js') : root.Blackjack;
  const Rules = node ? require('../engine/rules.js') : root.BlackjackRules;
  const Strategy = node ? require('../engine/strategy.js') : root.BlackjackStrategy;

  const SUIT = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
  const RANK_KEYS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
  const rankKey = (rank) => (rank === '10' ? 'T' : rank);
  const cardText = (c) => rankKey(c.rank) + SUIT[c.suit];

  const ACTIONS = ['deal', 'hit', 'stand', 'double', 'split', 'surrender', 'insurance', 'decline_insurance'];
  const PLAY = { hit: 'hit', stand: 'stand', double: 'double', split: 'split', surrender: 'surrender' };
  const RULE_KEYS = ['decks', 'h17', 'payout', 'das', 'lateSurrender', 'rsa', 'enhc', 'obo', 'doubleOn', 'penetration'];

  class EnvError extends Error {}

  /** Full rules from a partial object; any key the engine would ignore or change is an error. */
  function checkRules(raw = {}) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new EnvError('rules must be an object');
    for (const k of Object.keys(raw)) if (!RULE_KEYS.includes(k)) throw new EnvError(`unknown rule "${k}"`);
    const rules = Rules.normalizeRules(raw);
    for (const k of Object.keys(raw)) {
      if (k === 'obo' && raw.obo === true && !rules.enhc) throw new EnvError('rule "obo" needs "enhc": true');
      if (rules[k] !== raw[k]) throw new EnvError(`invalid value for rule "${k}": ${JSON.stringify(raw[k])}`);
    }
    return rules;
  }

  const emptySeen = () => Object.fromEntries(RANK_KEYS.map((r) => [r, 0]));

  class BlackjackEnv {
    constructor(options = {}) {
      this.reset(options);
    }

    /**
     * Start a new table. Options: seed (string, or "seed-N" to start at shoe
     * N), rules (partial rules object), bankroll, minBet, maxBet.
     */
    reset({ seed = null, rules = {}, bankroll = 1000, minBet = 1, maxBet = 500 } = {}) {
      const full = checkRules(rules);
      for (const [name, v] of [['bankroll', bankroll], ['minBet', minBet], ['maxBet', maxBet]]) {
        if (!Number.isFinite(v) || v <= 0) throw new EnvError(`${name} must be a positive number`);
      }
      if (minBet > maxBet) throw new EnvError('minBet must not exceed maxBet');
      const text = seed === null || seed === undefined ? BJ.randomSeed() : String(seed);
      const parsed = BJ.parseSeed(text);
      if (!parsed) throw new EnvError('seed must be 1-40 characters of letters, digits, "_", "." or "-"');
      this.game = new BJ.Game({ bankroll, minBet, maxBet, ...full, ...parsed });
      this.round = 0;
      this.shuffles = this.game.shuffles;
      this.seenBefore = emptySeen(); // revealed in earlier rounds of this shoe
      return this.observe();
    }

    /** Actions allowed now, as names. Empty only when the bankroll is below the minimum bet. */
    legalActions() {
      const g = this.game;
      if (g.phase === 'insurance') return g.canInsure() ? ['insurance', 'decline_insurance'] : ['decline_insurance'];
      if (g.phase === 'player') {
        const out = [];
        if (g.canHit()) out.push('hit');
        out.push('stand');
        if (g.canDouble()) out.push('double');
        if (g.canSplit()) out.push('split');
        if (g.canSurrender()) out.push('surrender');
        return out;
      }
      return g.isBroke ? [] : ['deal'];
    }

    /**
     * Apply one action: a name ("hit") or an object ({action: "deal", bet: 10,
     * side: {pairs: 5}}). `bet` may be an array for up to three spots.
     * Returns {obs, reward, done}: reward is the round's total chip change
     * (insurance and side bets included) on the step that ends the round,
     * otherwise 0; done is true when the round is over.
     */
    step(input) {
      const a = typeof input === 'string' ? { action: input } : input;
      if (!a || typeof a !== 'object' || typeof a.action !== 'string') throw new EnvError('action must be a name or {action: name}');
      if (!ACTIONS.includes(a.action)) throw new EnvError(`unknown action "${a.action}"; one of ${ACTIONS.join(', ')}`);
      const legal = this.legalActions();
      if (!legal.includes(a.action)) {
        throw new EnvError(`"${a.action}" is not legal now (phase ${this.game.phase}); legal: ${legal.join(', ') || 'none (broke)'}`);
      }
      const g = this.game;
      try {
        if (a.action === 'deal') this.deal(a);
        else if (a.action === 'insurance') g.takeInsurance();
        else if (a.action === 'decline_insurance') g.declineInsurance();
        else g[PLAY[a.action]]();
      } catch (e) {
        throw new EnvError(e.message); // the engine's own validation (bet limits, bankroll, ...)
      }
      const done = g.phase === 'done';
      if (done) this.foldRound();
      return { obs: this.observe({ full: false }), reward: done ? round2(g.net) : 0, done };
    }

    deal({ bet, side = {} }) {
      const g = this.game;
      if (bet === undefined) throw new EnvError('deal needs a bet (a number, or an array of up to 3 for several spots)');
      if (!side || typeof side !== 'object') throw new EnvError('side must be an object like {pairs: 5, t213: 5}');
      if (this.game.phase === 'done') this.foldRound(); // idempotent: counted once per round
      g.deal(bet, side);
      this.round++;
      if (g.shuffles !== this.shuffles) { // a new shoe was started at the cut card
        this.shuffles = g.shuffles;
        this.seenBefore = emptySeen();
      }
      this.folded = false;
    }

    /** At the end of a round every card on the table has been seen. */
    foldRound() {
      if (this.folded) return;
      for (const c of this.tableCards(true)) this.seenBefore[rankKey(c.rank)]++;
      this.folded = true;
    }

    tableCards(all) {
      const g = this.game;
      const dealer = all || g.phase === 'done' ? g.dealer : g.dealer.slice(0, 1);
      return [...g.hands.flatMap((h) => h.cards), ...dealer];
    }

    /**
     * What a player at the table can see right now. Step replies pass
     * {full: false} to leave out `rules` and `table`, which never change
     * between resets.
     */
    observe({ full = true } = {}) {
      const g = this.game;
      const live = g.phase === 'player' || g.phase === 'insurance';
      const dealerCards = g.phase === 'done' || !g.dealer.length ? g.dealer : g.dealer.slice(0, 1);
      const seen = { ...this.seenBefore };
      if (!this.folded) for (const c of this.tableCards(false)) seen[rankKey(c.rank)]++;
      const results = g.phase === 'done' ? g.results : [];
      return {
        phase: g.phase,
        round: this.round,
        bankroll: round2(g.bankroll),
        legal: this.legalActions(),
        ...(full ? {
          rules: g.rules,
          table: { minBet: g.minBet, maxBet: g.maxBet, maxSpots: BJ.MAX_SPOTS, maxHandsPerSpot: BJ.MAX_HANDS, sideMax: BJ.SIDE_MAX },
        } : {}),
        shoe: {
          seed: g.shoeSeed, decks: g.decks, cardsLeft: g.shoe.length + (live ? 1 : 0), // the hole card is still unseen
          cutCardReached: g.cutCardReached, seen,
        },
        dealer: {
          cards: dealerCards.map(cardText),
          total: dealerCards.length ? BJ.handValue(dealerCards).total : 0,
          holeCardHidden: live,
        },
        hands: g.hands.map((h, i) => {
          const v = BJ.handValue(h.cards);
          return {
            cards: h.cards.map(cardText), total: v.total, soft: v.soft, bet: h.bet, spot: h.spot,
            fromSplit: h.fromSplit, splitAces: h.splitAces, surrendered: h.surrendered,
            result: results[i] ? { outcome: results[i].outcome, net: round2(results[i].net) } : null,
          };
        }),
        active: g.phase === 'player' ? g.active : null,
        insurance: {
          offered: g.phase === 'insurance', evenMoney: g.evenMoneyOffered,
          cost: g.phase === 'insurance' ? round2(g.insuranceCost) : 0,
          stake: g.insurance, net: g.insuranceNet,
        },
        sideBets: g.sideBets.map((s) => ({
          bet: s.bet, stake: s.stake, outcome: s.win ? 'win' : 'lose', win: s.win, odds: s.odds, net: s.net,
        })),
        net: g.phase === 'done' ? round2(g.net) : null,
        broke: g.isBroke,
      };
    }

    /** The basic-strategy play for the current decision (a baseline, not part of the game). */
    hint() {
      const g = this.game;
      if (g.phase === 'insurance') return { action: 'decline_insurance', reason: 'Basic strategy never takes insurance' };
      if (g.phase !== 'player') return null;
      const allowed = { canDouble: g.canDouble(), canSplit: g.canSplit(), canSurrender: g.canSurrender(), canHit: g.canHit() };
      const r = Strategy.recommend(g.currentHand.cards, g.dealer[0], allowed, g.rules);
      return { action: r.action, reason: r.reason };
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  const api = { BlackjackEnv, EnvError, ACTIONS, RULE_KEYS, checkRules, cardText };
  if (node) module.exports = api;
  else root.BlackjackEnv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
