/**
 * Poker bots (CLA-120): equity by simulation, pot odds, and policies built on
 * them. Each policy is decide(view, rng) -> {action, amount}, where `view` is
 * PokerTable.view(seat) for the bot's own seat; bots see exactly what a player
 * at the table sees.
 *
 * - default: sound play from equity and pot odds, value bets, a few bluffs.
 *   The baseline the LLM player bends.
 * - tight-passive: few hands, rarely raises, gives up to aggression.
 * - loose-aggressive: many hands, raises and bluffs a lot.
 * - calling-station: calls almost anything, rarely raises or folds.
 * - maniac: bets and raises nearly every chance.
 *
 * Style switches are rates: maniacRate (chance to bet or raise outright) and
 * stationCalls (chance to play as a calling station); 0 is never, 1 is always.
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const P = node ? require('./poker.js') : root.Poker;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;

  /**
   * Chance to win (ties shared) against `opponents` random hands, by playing
   * the rest of the board out `iterations` times.
   */
  function equity(hole, board, opponents, { iterations = 300, rng = Math.random } = {}) {
    const known = new Set([...hole, ...board]);
    const rest = P.fullDeck().filter((c) => !known.has(c));
    let total = 0;
    for (let it = 0; it < iterations; it++) {
      // Partial shuffle: just the cards needed.
      const need = 5 - board.length + 2 * opponents;
      const d = rest.slice();
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rng() * (d.length - i));
        [d[i], d[j]] = [d[j], d[i]];
      }
      const fullBoard = board.concat(d.slice(0, 5 - board.length));
      const mine = P.evaluate(hole.concat(fullBoard)).score;
      let best = 0;
      let ties = 0;
      let k = 5 - board.length;
      let lost = false;
      for (let o = 0; o < opponents; o++, k += 2) {
        const s = P.evaluate([d[k], d[k + 1], ...fullBoard]).score;
        if (s > mine) { lost = true; break; }
        if (s === mine) ties++;
        best = Math.max(best, s);
      }
      if (!lost) total += 1 / (ties + 1);
    }
    return total / iterations;
  }

  /** What a decision looks like from a view: the numbers every policy uses. */
  function situation(view, rng, iterations = 300) {
    const you = view.you;
    const opponents = view.seats.filter((s, i) => s && i !== you.seat && s.inHand && !s.folded).length;
    const pot = view.pot;
    const toCall = you.toCall;
    const eq = equity(you.cards, view.board, Math.max(1, opponents), { iterations, rng });
    const legal = Object.fromEntries(you.legal.map((l) => [l.action, l]));
    return {
      you, opponents, pot, toCall, eq, legal,
      potOdds: toCall > 0 ? toCall / (pot + toCall) : 0,
      street: view.phase, bb: view.bigBlind, currentBet: view.currentBet,
      facingBet: toCall > 0,
    };
  }

  /**
   * A bet of `fraction` of the pot, or a raise to the current bet plus that
   * fraction of the pot after calling; clamped to what's legal. Null when
   * neither is allowed.
   */
  function sized(s, fraction) {
    if (s.legal.bet) {
      const l = s.legal.bet;
      return { action: 'bet', amount: Math.min(l.max, Math.max(l.min, Math.round(s.pot * fraction))) };
    }
    if (s.legal.raise) {
      const l = s.legal.raise;
      const to = s.currentBet + Math.round((s.pot + s.toCall) * fraction);
      return { action: 'raise', amount: Math.min(l.max, Math.max(l.min, to)) };
    }
    return null;
  }

  const check = (s) => (s.legal.check ? { action: 'check' } : { action: 'fold' });
  const call = (s) => (s.legal.call ? { action: 'call' } : check(s));

  /** The equity a hand needs to be worth playing against n opponents, times a looseness factor. */
  const fair = (n) => 1 / (n + 1);

  function makePolicy({ playMult, raiseMult, bluff, callMargin, aggression, sizeFrac, stationCalls = 0, maniacRate = 0, foldToRaise = 0 }) {
    return function decide(view, rng = Math.random) {
      const s = situation(view, rng);
      const f = fair(s.opponents);
      if (maniacRate > 0 && rng() < maniacRate) return sized(s, 0.8 + rng() * 0.6) || call(s);
      const station = stationCalls >= 1 || (stationCalls > 0 && rng() < stationCalls);
      if (s.street === 'preflop') {
        if (s.eq >= f * raiseMult && rng() < aggression) return sized(s, sizeFrac) || call(s);
        if (s.eq >= f * playMult || station) {
          if (!s.facingBet) return s.legal.check ? (rng() < aggression * 0.5 ? (sized(s, sizeFrac) || check(s)) : check(s)) : call(s);
          if (station || s.toCall <= s.bb * 4 || s.eq > f * raiseMult * 0.9) {
            if (foldToRaise && s.toCall > s.bb * 3 && rng() < foldToRaise && s.eq < f * raiseMult) return { action: 'fold' };
            return call(s);
          }
        }
        return s.legal.check ? check(s) : { action: 'fold' };
      }
      // Postflop.
      const strong = s.eq >= Math.min(0.85, 0.5 + 0.15 * (s.opponents - 1)) * raiseMult / 1.5;
      if (strong && rng() < aggression) return sized(s, sizeFrac) || call(s);
      if (!s.facingBet) {
        if (rng() < bluff) return sized(s, sizeFrac) || check(s);
        return check(s);
      }
      if (station && s.eq > 0.12) return call(s);
      if (foldToRaise && rng() < foldToRaise && !strong) return { action: 'fold' };
      if (s.eq >= s.potOdds + callMargin) return call(s);
      return { action: 'fold' };
    };
  }

  const STYLES = {
    default: { description: 'Sound play from equity and pot odds: plays decent hands, raises strong ones, bets for value, bluffs a little.', params: { playMult: 1.0, raiseMult: 1.45, bluff: 0.1, callMargin: 0.02, aggression: 0.75, sizeFrac: 0.66 } },
    'tight-passive': { description: 'Plays few hands, rarely raises, calls when it plays, and gives up to aggression.', params: { playMult: 1.15, raiseMult: 1.5, bluff: 0.02, callMargin: 0.08, aggression: 0.25, sizeFrac: 0.5, foldToRaise: 0.6 } },
    'loose-aggressive': { description: 'Plays many hands, raises and bluffs a lot, bets big.', params: { playMult: 0.7, raiseMult: 1.1, bluff: 0.35, callMargin: -0.02, aggression: 0.9, sizeFrac: 0.9 } },
    'calling-station': { description: 'Calls almost anything, rarely raises or folds.', params: { playMult: 0.5, raiseMult: 2.6, bluff: 0.0, callMargin: -0.2, aggression: 0.15, sizeFrac: 0.5, stationCalls: 1 } },
    maniac: { description: 'Bets and raises nearly every chance, whatever it holds.', params: { playMult: 0.3, raiseMult: 0.9, bluff: 0.6, callMargin: -0.1, aggression: 0.95, sizeFrac: 1.0, maniacRate: 0.75 } },
  };

  const POLICIES = Object.fromEntries(Object.entries(STYLES).map(([name, s]) => [name, { name, description: s.description, decide: makePolicy(s.params) }]));

  /** A seeded generator for a bot, so a benchmark replays. */
  const rngFor = (text) => BJ.seededRng(BJ.hashSeed(String(text)));

  const api = { equity, situation, sized, POLICIES, STYLES, rngFor };
  if (node) module.exports = api;
  else root.PokerBots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
