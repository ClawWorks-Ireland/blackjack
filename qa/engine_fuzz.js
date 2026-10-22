#!/usr/bin/env node
/**
 * Engine playtest for the BlackJack-creator game. Loads <dir>/blackjack.js
 * (a snapshot of one commit) and plays it two ways:
 *   1. random legal play  -> invariant checks against an independent rules reference
 *   2. basic-strategy play -> return-to-player sanity check (house edge)
 * Prints a compact JSON report. Exit code 0 even when findings exist; the
 * report is the product. Usage: node engine_fuzz.js <snapshotDir> [rounds]
 */
'use strict';
const path = require('path');
const { engineFile } = require('./lib/layout');

const dir = process.argv[2];
const ROUNDS = Number(process.argv[3] || 40000);
const BJ = require(engineFile(dir, 'blackjack.js'));
const { Game } = BJ;

// ---------- seeded RNG (mulberry32) ----------
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

// ---------- independent reference ----------
const val = (c) => (c.rank === 'A' ? 11 : ['J', 'Q', 'K'].includes(c.rank) ? 10 : Number(c.rank));
function total(cards) {
  let t = 0, a = 0;
  for (const c of cards) { t += val(c); if (c.rank === 'A') a++; }
  while (t > 21 && a) { t -= 10; a--; }
  return { t, soft: a > 0 };
}
const natural = (cards) => cards.length === 2 && total(cards).t === 21;
function refNet(hand, dealer) {
  const bet = hand.bet;
  if (hand.surrendered) return -bet / 2;
  const pBJ = !hand.fromSplit && natural(hand.cards);
  const dBJ = natural(dealer);
  if (pBJ && dBJ) return 0;
  if (pBJ) return bet * 1.5;
  const p = total(hand.cards).t;
  if (p > 21) return -bet;
  if (dBJ) return -bet;
  const d = total(dealer).t;
  if (d > 21) return bet;
  return p > d ? bet : p < d ? -bet : 0;
}

// ---------- basic strategy (6D, S17, DAS, late surrender) ----------
function basic(g) {
  const h = g.currentHand;
  const up = val(g.dealer[0]);
  const { t, soft } = total(h.cards);
  const two = h.cards.length === 2;
  if (two && h.cards[0].rank === h.cards[1].rank && g.canSplit()) {
    const r = h.cards[0].rank;
    const pv = val(h.cards[0]);
    const split =
      r === 'A' || r === '8' ||
      (pv === 9 && ![7, 10, 11].includes(up)) ||
      (pv === 7 && up <= 7) || (pv === 6 && up <= 6) ||
      (pv === 4 && (up === 5 || up === 6)) ||
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

// ---------- runner ----------
const findings = new Map(); // key -> {count, example}
function flag(key, example) {
  const f = findings.get(key) || { count: 0, example };
  f.count++;
  findings.set(key, f);
}

function playRound(g, rnd, bet, strategy) {
  const before = g.bankroll;
  const shoeBefore = g.shoe.length;
  let reshuffledMid = false;
  let lastShoe = g.shoe.length;
  const watchShoe = () => { if (g.shoe.length > lastShoe) reshuffledMid = true; lastShoe = g.shoe.length; };
  const doubled = new Set();
  const emerg0 = g.emergencyShuffles;
  g.deal(bet);
  if (emerg0 !== undefined) lastShoe = g.shoe.length; // shoe swap inside deal() is between rounds
  else watchShoe();
  if (g.phase === 'insurance') {
    const take = strategy === 'random' ? rnd() < 0.3 && g.canInsure() : false;
    take ? g.takeInsurance() : g.declineInsurance();
    watchShoe();
  }
  let guard = 0;
  while (g.phase === 'player') {
    if (++guard > 200) { flag('stuck: player phase never ends', { hands: g.hands.length }); break; }
    let move;
    if (strategy === 'random') {
      const opts = ['hit', 'stand', 'hit'];
      if (g.canDouble()) opts.push('double');
      if (g.canSplit()) opts.push('split', 'split');
      if (g.canSurrender()) opts.push('surrender');
      move = opts[Math.floor(rnd() * opts.length)];
    } else move = basic(g);
    const h = g.currentHand;
    try {
      if (move === 'double') doubled.add(h);
      g[move]();
    } catch (e) {
      flag(`exception on legal ${move}: ${e.message}`, { cards: h && h.cards.map((c) => c.rank) });
      break;
    }
    watchShoe();
  }
  if (g.phase !== 'done') { flag('round did not reach done', { phase: g.phase }); return null; }

  // ---- invariants ----
  const delta = g.bankroll - before;
  if (Math.abs(delta - g.net) > 1e-9) flag('bankroll delta != game.net', { delta, net: g.net });
  let refSum = 0;
  g.hands.forEach((h, i) => {
    const r = refNet(h, g.dealer);
    refSum += r;
    if (Math.abs(r - g.results[i].net) > 1e-9) {
      flag('settlement differs from reference', {
        player: h.cards.map((c) => c.rank), dealer: g.dealer.map((c) => c.rank),
        bet: h.bet, fromSplit: h.fromSplit, engine: g.results[i], ref: r,
      });
    }
    const pt = total(h.cards).t;
    if (pt > 21 && total(h.cards.slice(0, -1)).t > 21) flag('card dealt to an already-bust hand', { cards: h.cards.map((c) => c.rank) });
    if (h.splitAces && h.cards.length !== 2) flag('split ace hand has != 2 cards', { cards: h.cards.map((c) => c.rank) });
    if (doubled.has(h) && h.cards.length !== 3) flag('doubled hand has != 3 cards', { cards: h.cards.map((c) => c.rank) });
  });
  if (g.hands.length > (BJ.MAX_HANDS || 4)) flag('more hands than MAX_HANDS', { n: g.hands.length });
  const ins = g.insuranceNet || 0;
  if (Math.abs(refSum + ins - delta) > 1e-9) flag('bankroll delta != reference sum', { delta, refSum, ins });
  if (g.insurance > 0) {
    const want = natural(g.dealer) ? g.insurance * 2 : -g.insurance;
    if (g.insuranceNet !== want) flag('insurance settlement wrong', { stake: g.insurance, got: g.insuranceNet, want });
  }
  // dealer drawing rule (S17) when any live hand remained and no natural ended it
  const live = g.hands.some((h) => !h.surrendered && total(h.cards).t <= 21);
  const endedByNatural = natural(g.dealer) || (g.hands.length === 1 && !g.hands[0].fromSplit && natural(g.hands[0].cards));
  const dt = total(g.dealer).t;
  if (live && !endedByNatural && dt < 17) flag('dealer stood below 17', { dealer: g.dealer.map((c) => c.rank) });
  if (g.dealer.length > 2 && total(g.dealer.slice(0, -1)).t >= 17) flag('dealer hit on 17+', { dealer: g.dealer.map((c) => c.rank) });
  if (!live && g.dealer.length > 2) flag('dealer drew with no live player hand', { dealer: g.dealer.map((c) => c.rank) });
  // duplicate card objects / impossible composition within one round
  const all = [...g.dealer, ...g.hands.flatMap((h) => h.cards)];
  if (new Set(all).size !== all.length) flag('same card object dealt twice in a round', {});
  if (g.bankroll < 0) flag('negative bankroll', { bankroll: g.bankroll });
  if (!Number.isInteger(delta * 2)) flag('non half-dollar payout', { delta });
  if (emerg0 !== undefined) reshuffledMid = g.emergencyShuffles > emerg0;
  return { delta, reshuffledMid, shoeBefore };
}

function run(strategy, rounds, seed) {
  const rnd = rng32(seed);
  let g = new Game({ bankroll: 1e9, rng: rng32(seed + 1) });
  let wagered = 0, won = 0, mid = 0, fractional = 0;
  const outcomes = {};
  for (let i = 0; i < rounds; i++) {
    const bet = strategy === 'random' ? [1, 3, 5, 7, 10, 25, 50][Math.floor(rnd() * 7)] : 10;
    const r = playRound(g, rnd, bet, strategy);
    if (!r) { g = new Game({ bankroll: 1e9, rng: rng32(seed + i) }); continue; }
    wagered += bet;
    won += r.delta;
    if (r.reshuffledMid) mid++;
    if (!Number.isInteger(r.delta)) fractional++;
    g.results.forEach((x) => { outcomes[x.outcome] = (outcomes[x.outcome] || 0) + 1; });
  }
  return { rounds, rtpPct: +(100 + (100 * won) / wagered).toFixed(3), midRoundReshuffles: mid, fractionalPayoutRounds: fractional, outcomes };
}

// Input validation probes
function probes() {
  const out = [];
  const tryDeal = (bet) => { const g = new Game({ bankroll: 100 }); try { g.deal(bet); return 'accepted'; } catch (e) { return 'rejected: ' + e.message; } };
  for (const b of [0, -5, 0.5, 2.5, NaN, Infinity, 101, '50']) out.push({ bet: String(b), result: tryDeal(b) });
  // action out of phase
  const g = new Game({ bankroll: 100 });
  for (const m of ['hit', 'stand', 'double', 'split', 'surrender', 'takeInsurance', 'declineInsurance']) {
    try { g[m](); out.push({ action: m + ' before deal', result: 'accepted (BUG?)' }); } catch (e) { out.push({ action: m + ' before deal', result: 'rejected' }); }
  }
  return out;
}

const t0 = Date.now();
const random = run('random', ROUNDS, 12345);
const basicRun = run('basic', ROUNDS * 5, 777);
const report = {
  engine: engineFile(dir, 'blackjack.js'),
  exports: Object.keys(BJ),
  randomPlay: random,
  basicStrategy: basicRun,
  expectedBasicRtpPct: '≈99.4–99.7 for 6D S17 DAS LS 3:2 (house edge ~0.3–0.6%)',
  invariantViolations: [...findings].map(([k, v]) => ({ issue: k, count: v.count, example: v.example })),
  probes: probes(),
  ms: Date.now() - t0,
};
console.log(JSON.stringify(report, null, 1));
