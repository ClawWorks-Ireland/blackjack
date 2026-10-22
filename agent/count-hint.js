/**
 * Count-aware hint (CLA-105): what a counter at the table knows, priced from
 * the cards actually left rather than a full shoe. Used by the CLI
 * ({"cmd":"hint","count":true}) and the MCP hint tool ({count: true}); the
 * plain hint (env.hint) stays the full-shoe baseline the benchmark uses.
 *
 * Fair like everything else: the composition comes from obs.shoe.seen (cards
 * a seated player has seen), never from the shoe's order. The hole card is
 * unseen and handled by the solver as one of the remaining cards.
 */
'use strict';
const Counting = require('../engine/counting.js');
const Solver = require('../engine/tools/solver.js');
const { toCard, hiLo } = require('./policies.js');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
/** "Td" -> solver value 10, "As" -> 1. */
const value = (card) => ('TJQK'.includes(card[0]) ? 10 : card[0] === 'A' ? 1 : Number(card[0]));
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round2 = (n) => Math.round(n * 100) / 100;

/** Unseen cards by solver value (index 1-10), from the seen counts. */
function unseenDeck(decks, seen) {
  const d = Solver.fullDeck(decks);
  for (const r of RANKS) d[value(r + 's')] -= seen[r];
  return d;
}

/**
 * EV of each legal play for the active hand, per unit of its bet, from the
 * unseen cards. The solver takes the shoe before the up card and your hand
 * come out, so those go back in first. A split hand is priced as the hand it
 * is now (its partner's cards stay out); a resplit as two fresh hands.
 */
function seenEV(obs, rules) {
  const hand = obs.hands[obs.active];
  const cards = hand.cards.map(value);
  const up = value(obs.dealer.cards[0]);
  const deck = unseenDeck(rules.decks, obs.shoe.seen);
  deck[up]++;
  for (const v of cards) deck[v]++;
  const s = Solver.makeSolver({ h17: rules.h17, das: rules.das, doubleOn: rules.doubleOn, deck });
  const ev = {};
  for (const a of obs.legal) {
    if (a === 'stand') ev.stand = s.standEV(up, cards, cards);
    else if (a === 'hit') ev.hit = s.hitEV(up, cards, cards);
    else if (a === 'double') ev.double = s.doubleEV(up, cards, cards);
    else if (a === 'surrender') ev.surrender = -0.5;
    else if (a === 'split') ev.split = cards[0] === 1 ? s.splitAcesEV(up, rules.rsa) : s.splitEV(up, cards[0]);
  }
  // European no hole card: the dealer hasn't looked, so a blackjack can still
  // take every chip out (OBO prices as the peek game, like engine/ev.js).
  if (rules.enhc && !rules.obo && (up === 1 || up === 10)) {
    const left = deck.slice();
    left[up]--;
    for (const v of cards) left[v]--;
    const p = left[up === 1 ? 10 : 1] / left.reduce((a, b) => a + b, 0);
    Object.assign(ev, Solver.toENHC(ev, p));
  }
  return Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, round4(v)]));
}

/**
 * The plain hint plus `count`: the Hi-Lo running and true count, decks left,
 * and `play`, what a Hi-Lo counter does here (an index play, the insurance
 * decision, or the ramp's bet between rounds). While playing a hand it adds
 * `evSeen`, each legal play priced from the cards left, and `bestSeen`.
 */
function countHint(env) {
  const obs = env.observe();
  const { running, trueCount } = hiLo(obs.shoe);
  const count = { system: 'hilo', running, trueCount: round2(trueCount), decksLeft: round2(obs.shoe.cardsLeft / 52) };
  if (obs.phase === 'betting' || obs.phase === 'done') {
    if (!obs.legal.includes('deal')) return { action: null, reason: 'The bankroll is below the minimum bet', count };
    // The cut card came out last round: the next deal starts a new shoe at a zero count.
    const tc = obs.shoe.cutCardReached ? 0 : trueCount;
    const bet = Counting.suggestedBet(tc, { min: obs.table.minBet, max: obs.table.maxBet, bankroll: obs.bankroll });
    const units = Counting.betUnits(tc);
    const why = obs.shoe.cutCardReached ? 'a new shoe starts with this deal' : `true count ${Counting.formatTrue(tc)}`;
    return { action: 'deal', bet, reason: `Hi-Lo ramp: ${units} unit${units === 1 ? '' : 's'} at ${why}`, count: { ...count, play: { action: 'deal', bet } } };
  }
  const hint = env.hint();
  if (obs.phase === 'insurance') {
    const take = Counting.countInsurance(trueCount, obs.insurance.evenMoney);
    const play = take && obs.legal.includes('insurance')
      ? { action: 'insurance', reason: take.reason, index: take.index }
      : { action: 'decline_insurance', reason: `True count ${Counting.formatTrue(trueCount)} is below +${Counting.INSURANCE_INDEX}`, index: null };
    return { ...hint, count: { ...count, play } };
  }
  const hand = obs.hands[obs.active];
  const allowed = {
    canHit: obs.legal.includes('hit'), canDouble: obs.legal.includes('double'),
    canSplit: obs.legal.includes('split'), canSurrender: obs.legal.includes('surrender'),
  };
  const dev = Counting.countPlay(hand.cards.map(toCard), toCard(obs.dealer.cards[0]), allowed, hint, trueCount, obs.rules);
  const play = { action: dev.action, reason: dev.reason, index: dev.deviation ? dev.index : null };
  const evSeen = seenEV(obs, obs.rules);
  const bestSeen = Object.keys(evSeen).reduce((a, b) => (evSeen[b] > evSeen[a] ? b : a));
  return { ...hint, count: { ...count, play }, evSeen, bestSeen };
}

module.exports = { countHint, seenEV, unseenDeck };
