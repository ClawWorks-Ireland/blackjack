/**
 * Baseline policies for the benchmark (agent/bench.js). A policy sees only
 * what any agent sees: the observation and the hint. Each one is
 *
 *   { name, description, bet(obs, ctx), act(obs, hint, ctx) }
 *
 * where ctx is {seed, rules, table} for the table being played; bet returns
 * a number (or a list for several spots) and act a name from obs.legal. A
 * policy may return a promise.
 */
'use strict';
const Counting = require('../engine/counting.js');

const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
/** "Td" -> the engine's {rank: "10", suit: "♦"}. */
const toCard = (text) => ({ rank: text[0] === 'T' ? '10' : text[0], suit: SUITS[text[1]] });

/** A small seeded generator, so the random policy replays like everything else. */
function rng(seedText) {
  let s = 2166136261;
  for (const ch of seedText) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const flat = (obs, ctx) => ctx.table.minBet;

const random = {
  name: 'random',
  description: 'Flat minimum bet; a uniformly random legal move at every decision.',
  bet(obs, ctx) {
    if (!ctx.random) ctx.random = rng(ctx.seed);
    return flat(obs, ctx);
  },
  act(obs, hint, ctx) {
    return obs.legal[Math.floor(ctx.random() * obs.legal.length)];
  },
};

const neverBust = {
  name: 'never-bust',
  description: 'Flat minimum bet; hits only when it cannot bust (hard 11 or less, soft 17 or less), never insures.',
  bet: flat,
  act(obs) {
    if (obs.phase === 'insurance') return 'decline_insurance';
    const hand = obs.hands[obs.active];
    const safe = hand.total <= 11 || (hand.soft && hand.total <= 17);
    return safe && obs.legal.includes('hit') ? 'hit' : 'stand';
  },
};

const basic = {
  name: 'basic',
  description: 'Flat minimum bet; plays the hint (basic strategy for the table rules) every time.',
  bet: flat,
  act: (obs, hint) => hint.action,
};

/** Hi-Lo running and true count from the cards seen since the shuffle. */
function hiLo(shoe) {
  const s = shoe.seen;
  const running = s['2'] + s['3'] + s['4'] + s['5'] + s['6'] - (s.T + s.J + s.Q + s.K + s.A);
  return { running, trueCount: Counting.trueCount(running, shoe.cardsLeft / 52) };
}

const hilo = {
  name: 'hilo',
  description: 'Hi-Lo counter: 1-2-4-8-12 unit ramp on the true count, Illustrious 18 and Fab 4 index plays, insurance at +3.',
  bet(obs, ctx) {
    // The cut card came out last round, so this deal starts a fresh shoe.
    const tc = obs.shoe.cutCardReached ? 0 : hiLo(obs.shoe).trueCount;
    return Counting.suggestedBet(tc, { min: ctx.table.minBet, max: ctx.table.maxBet, bankroll: obs.bankroll });
  },
  act(obs, hint, ctx) {
    const { trueCount } = hiLo(obs.shoe);
    if (obs.phase === 'insurance') {
      const take = Counting.countInsurance(trueCount, obs.insurance.evenMoney);
      return take && obs.legal.includes('insurance') ? 'insurance' : 'decline_insurance';
    }
    const hand = obs.hands[obs.active];
    const allowed = {
      canHit: obs.legal.includes('hit'), canDouble: obs.legal.includes('double'),
      canSplit: obs.legal.includes('split'), canSurrender: obs.legal.includes('surrender'),
    };
    const play = Counting.countPlay(hand.cards.map(toCard), toCard(obs.dealer.cards[0]), allowed, hint, trueCount, ctx.rules);
    return obs.legal.includes(play.action) ? play.action : hint.action;
  },
};

const BASELINES = { random, 'never-bust': neverBust, basic, hilo };

module.exports = { BASELINES, toCard, hiLo };
