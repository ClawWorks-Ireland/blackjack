/**
 * Bankroll estimates from a seeded simulation of the real engine.
 *
 * simulate() plays `rounds` rounds of Game with the coach's advice: flat
 * betting plays basic strategy; the ramp (1/2/4/8/12 units by true count)
 * plays the count (index plays and insurance at +3). It returns the mean
 * and spread of the result per round in betting units, which summarize()
 * turns into EV and SD per 100 rounds, N0 and risk of ruin.
 *
 * DOM-free: runs under node for tests and in sim-worker.js in the browser.
 */
(function (root) {
  'use strict';

  const load = (name, file) => (typeof require === 'function' ? require(file) : root[name]);
  const BJ = load('Blackjack', './blackjack.js');
  const Strategy = load('BlackjackStrategy', './strategy.js');
  const Counting = load('BlackjackCounting', './counting.js');
  const Rules = load('BlackjackRules', './rules.js');

  /** Small, fast seeded generator (mulberry32). */
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

  /**
   * Play `rounds` rounds and return per-round statistics in units.
   * `ramp`: 'ramp' (bet by the count, play the count) or 'flat' (1 unit, basic strategy).
   * `onProgress(done)` is called every 10,000 rounds.
   */
  function simulate({ rules = {}, ramp = 'ramp', rounds = 200000, seed = 1, onProgress } = {}) {
    const r = Rules.normalizeRules(rules);
    const game = new BJ.Game({ ...r, bankroll: 1e12, minBet: 1, rng: seededRng(seed) });
    const counting = ramp === 'ramp';
    let sum = 0;
    let sumSq = 0;
    let wagered = 0;
    for (let i = 0; i < rounds; i++) {
      const start = Counting.countState(game).trueCount;
      const bet = counting ? Counting.betUnits(start) : 1;
      game.deal(bet);
      if (game.phase === 'insurance') {
        const tc = Counting.countState(game).trueCount;
        if (counting && Counting.countInsurance(tc, game.evenMoneyOffered)) game.takeInsurance();
        else game.declineInsurance();
      }
      while (game.phase === 'player') {
        const h = game.currentHand;
        const allowed = { canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender() };
        const basic = Strategy.recommend(h.cards, game.dealer[0], allowed, r);
        const play = counting
          ? Counting.countPlay(h.cards, game.dealer[0], allowed, basic, Counting.countState(game).trueCount, r)
          : basic;
        game[play.action]();
      }
      const net = game.net;
      sum += net;
      sumSq += net * net;
      wagered += bet;
      if (onProgress && (i + 1) % 10000 === 0) onProgress(i + 1);
    }
    const mean = sum / rounds;
    const variance = sumSq / rounds - mean * mean;
    return { rounds, mean, sd: Math.sqrt(variance), avgBet: wagered / rounds };
  }

  /**
   * Risk of ruin with an infinite horizon, from the diffusion approximation
   * exp(-2 * EV * bankroll / variance), all per round in units. A game with
   * no edge (EV <= 0) is ruined for certain in the long run.
   */
  function riskOfRuin(mean, sd, bankrollUnits) {
    if (!(bankrollUnits > 0)) return 1;
    if (!(mean > 0)) return 1;
    if (!(sd > 0)) return 0;
    return Math.min(1, Math.exp((-2 * mean * bankrollUnits) / (sd * sd)));
  }

  /** Numbers for the Bankroll dialog from a simulate() result. */
  function summarize(sim, { bankroll, unit, handsPerHour = 100 }) {
    const units = bankroll / unit;
    const ev100 = sim.mean * 100;
    const sd100 = sim.sd * 10;
    return {
      ev100, ev100Dollars: ev100 * unit,
      sd100, sd100Dollars: sd100 * unit,
      evHourDollars: (sim.mean * handsPerHour) * unit,
      // Rounds to play before the expected win equals one standard deviation.
      n0: sim.mean > 0 ? (sim.sd / sim.mean) ** 2 : Infinity,
      ror: riskOfRuin(sim.mean, sim.sd, units),
      avgBet: sim.avgBet,
      // Standard error of the EV estimate, per 100 rounds.
      ev100Error: (sim.sd / Math.sqrt(sim.rounds)) * 100,
    };
  }

  const api = { seededRng, simulate, riskOfRuin, summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackBankroll = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
