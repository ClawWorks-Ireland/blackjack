/**
 * Batch play: let a baseline policy (agent/policies.js) play many rounds in
 * one request, so an agent spends its own calls on the decisions it cares
 * about. Used by the CLI ({"cmd":"auto"}) and the MCP server (auto_play).
 * Each round goes through env.step, so the table, the seed and the
 * observation are exactly as if the agent had played the moves itself.
 */
'use strict';
const { EnvError } = require('./env.js');
const { BASELINES } = require('./policies.js');

const MAX_ROUNDS = 10000;
const OUTCOMES = ['win', 'blackjack', 'push', 'lose', 'bust', 'surrender'];

/**
 * Play up to `rounds` rounds by `policy` ("basic" by default). `bet` fixes a
 * flat bet (a number, or a list for several spots); without it the policy
 * bets (the minimum, or the Hi-Lo ramp for "hilo"). `untilShuffle` stops
 * after the round that brings out the cut card. Play also stops when the
 * bankroll can't cover the next bet.
 *
 * Returns {played, stopped, policy, net, wagered, bankroll: {start, end},
 * hands: {win, blackjack, ...}, best, worst, obs}.
 */
function autoPlay(env, { rounds, policy = 'basic', bet, untilShuffle = false } = {}) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new EnvError(`rounds must be a whole number from 1 to ${MAX_ROUNDS}`);
  }
  const p = BASELINES[policy];
  if (!p) throw new EnvError(`unknown policy "${policy}"; one of ${Object.keys(BASELINES).join(', ')}`);
  if (!env.legalActions().includes('deal')) {
    throw new EnvError(env.observe().broke ? 'the bankroll is below the minimum bet' : 'finish the round in play first');
  }
  const first = env.observe();
  const ctx = { seed: first.shoe.seed, rules: first.rules, table: first.table };
  const start = first.bankroll;
  const hands = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  let obs = first;
  let played = 0;
  let wagered = 0;
  let best = null;
  let worst = null;
  let stopped = 'rounds';
  while (played < rounds) {
    const stake = bet === undefined ? p.bet(obs, ctx) : bet;
    const total = Array.isArray(stake) ? stake.reduce((a, b) => a + b, 0) : stake;
    if (!(total <= obs.bankroll)) { stopped = 'bankroll'; break; }
    let res = env.step({ action: 'deal', bet: stake });
    while (!res.done) res = env.step(p.act(res.obs, env.hint(), ctx));
    played++;
    obs = res.obs;
    for (const h of obs.hands) hands[h.result.outcome]++;
    wagered += obs.hands.reduce((a, h) => a + h.bet, 0) + obs.insurance.stake;
    if (best === null || res.reward > best) best = res.reward;
    if (worst === null || res.reward < worst) worst = res.reward;
    if (obs.broke) { stopped = 'bankroll'; break; }
    if (untilShuffle && obs.shoe.cutCardReached) { stopped = 'shuffle'; break; }
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    played, stopped, policy, bet: bet === undefined ? 'policy' : bet,
    net: round2(obs.bankroll - start), wagered: round2(wagered),
    bankroll: { start, end: obs.bankroll }, hands, best, worst,
    obs: env.observe(),
  };
}

/** "Played 200 rounds by basic: net -35 on 2,010 wagered, bankroll 1000 -> 965 ..." */
function describe(r) {
  const why = { rounds: '', shuffle: ', stopped at the cut card', bankroll: ', stopped: bankroll below the next bet' }[r.stopped];
  const tally = OUTCOMES.filter((o) => r.hands[o]).map((o) => `${r.hands[o]} ${o}`).join(', ');
  return `Played ${r.played} round${r.played === 1 ? '' : 's'} by ${r.policy}${why}: net ${r.net > 0 ? '+' : ''}${r.net} `
    + `on ${r.wagered} wagered, bankroll ${r.bankroll.start} -> ${r.bankroll.end}`
    + (r.played ? ` · hands: ${tally} · best round ${r.best > 0 ? '+' : ''}${r.best}, worst ${r.worst}` : '');
}

module.exports = { autoPlay, describe, MAX_ROUNDS };
