#!/usr/bin/env node
/**
 * Can this blackjack build be beaten? Plays the game's own engine
 * (<dir>/blackjack.js) with basic strategy two ways and compares:
 *   flat    - always bet 1 unit
 *   hilo    - Hi-Lo card counting: running count of every card seen since the
 *             last shuffle, true count = running / decks left, bet spread
 *             1-12 units by true count, insurance taken at TC >= 3
 * Reports hand win rate (pushes excluded, like the game's stat), return per
 * unit wagered, and profit per 100 rounds with a 95% interval.
 * Usage: node count_sim.js <snapshotDir> [rounds=2000000] [seed=7]
 */
'use strict';
const path = require('path');

const dir = process.argv[2];
const ROUNDS = Number(process.argv[3] || 2e6);
const SEED = Number(process.argv[4] || 7);
const { Game } = require(path.resolve(dir, 'blackjack.js'));

function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const val = (c) => (c.rank === 'A' ? 11 : ['J', 'Q', 'K'].includes(c.rank) ? 10 : Number(c.rank));
function total(cards) {
  let t = 0, a = 0;
  for (const c of cards) { t += val(c); if (c.rank === 'A') a++; }
  while (t > 21 && a) { t -= 10; a--; }
  return { t, soft: a > 0 };
}
const hiLo = (c) => { const v = val(c); return v <= 6 ? 1 : v >= 10 ? -1 : 0; };

// Basic strategy for 6D S17 DAS LS (same chart as engine_fuzz.js).
function basic(g) {
  const h = g.currentHand;
  const up = val(g.dealer[0]);
  const { t, soft } = total(h.cards);
  const two = h.cards.length === 2;
  if (two && h.cards[0].rank === h.cards[1].rank && g.canSplit()) {
    const r = h.cards[0].rank, pv = val(h.cards[0]);
    const split = r === 'A' || r === '8' || (pv === 9 && ![7, 10, 11].includes(up)) ||
      (pv === 7 && up <= 7) || (pv === 6 && up <= 6) || (pv === 4 && (up === 5 || up === 6)) ||
      ((pv === 2 || pv === 3) && up <= 7);
    if (split) return 'split';
  }
  if (two && g.canSurrender()) {
    if (!soft && t === 16 && [9, 10, 11].includes(up) && !(h.cards[0].rank === '8' && h.cards[1].rank === '8')) return 'surrender';
    if (!soft && t === 15 && up === 10) return 'surrender';
  }
  const canD = two && g.canDouble();
  if (soft) {
    if (t >= 19) return 'stand';
    if (t === 18) { if (up >= 3 && up <= 6) return canD ? 'double' : 'stand'; return up <= 8 ? 'stand' : 'hit'; }
    if (t === 17) return up >= 3 && up <= 6 && canD ? 'double' : 'hit';
    if (t >= 15) return up >= 4 && up <= 6 && canD ? 'double' : 'hit';
    return up >= 5 && up <= 6 && canD ? 'double' : 'hit';
  }
  if (t >= 17) return 'stand';
  if (t >= 13) return up <= 6 ? 'stand' : 'hit';
  if (t === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
  if (t === 11) return up <= 10 && canD ? 'double' : 'hit';
  if (t === 10) return up <= 9 && canD ? 'double' : 'hit';
  if (t === 9) return up >= 3 && up <= 6 && canD ? 'double' : 'hit';
  return 'hit';
}

const RAMP = (tc) => (tc < 2 ? 1 : tc < 3 ? 2 : tc < 4 ? 4 : tc < 5 ? 8 : 12);

function run(mode) {
  const g = new Game({ bankroll: 1e12, rng: rng32(SEED) });
  let rc = 0, shuffles = g.shuffles;
  let wagered = 0, net = 0, sumSq = 0, wins = 0, losses = 0, pushes = 0, maxBetRounds = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const decksLeft = Math.max(g.shoe.length / 52, 0.5);
    const tc = rc / decksLeft;
    const units = mode === 'hilo' ? RAMP(tc) : 1;
    if (units === 12) maxBetRounds++;
    const before = g.bankroll;
    g.deal(units);
    if (g.shuffles !== shuffles) { rc = 0; shuffles = g.shuffles; } // deal() started a new shoe
    if (g.phase === 'insurance') {
      const seen = [g.dealer[0], ...g.hands[0].cards].reduce((s, c) => s + hiLo(c), 0);
      const tcNow = (rc + seen) / decksLeft; // upcard + our two cards are already visible
      (mode === 'hilo' && tcNow >= 3 && g.canInsure()) ? g.takeInsurance() : g.declineInsurance();
    }
    while (g.phase === 'player') g[basic(g)]();
    const delta = g.bankroll - before;
    // every card that left the shoe this round is now face up
    for (const c of [...g.dealer, ...g.hands.flatMap((h) => h.cards)]) rc += hiLo(c);
    const staked = g.hands.reduce((s, h) => s + h.bet, 0) + (g.insurance || 0);
    wagered += staked; net += delta; sumSq += delta * delta;
    for (const r of g.results) {
      if (r.net > 0) wins++; else if (r.net < 0) losses++; else pushes++;
    }
  }
  const mean = net / ROUNDS, sd = Math.sqrt(sumSq / ROUNDS - mean * mean);
  const ci = 1.96 * sd / Math.sqrt(ROUNDS);
  return {
    mode, rounds: ROUNDS,
    handWinRatePct: +(100 * wins / (wins + losses)).toFixed(2),
    handsWonPct: +(100 * wins / (wins + losses + pushes)).toFixed(2),
    returnPct: +(100 + 100 * net / wagered).toFixed(3),
    unitsPer100Rounds: +(100 * mean).toFixed(3),
    ci95UnitsPer100: +(100 * ci).toFixed(3),
    avgBetUnits: +(wagered / ROUNDS).toFixed(2),
    pctRoundsAtMaxBet: +(100 * maxBetRounds / ROUNDS).toFixed(2),
  };
}

const t0 = Date.now();
console.log(JSON.stringify({ engine: path.resolve(dir, 'blackjack.js'), results: [run('flat'), run('hilo')], ms: Date.now() - t0 }, null, 1));
