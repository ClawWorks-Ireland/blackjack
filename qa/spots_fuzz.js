#!/usr/bin/env node
/**
 * Multi-spot (F5) fuzz against an independent settlement reference, plus a
 * B12 check that the displayed true count never crosses a whole number
 * from Math.floor(tc).
 * Usage: node spots_fuzz.js <snapshotDir> [rounds=100000]
 */
'use strict';
const path = require('path');
const { engineFile } = require('./lib/layout');
const dir = process.argv[2];
const ROUNDS = Number(process.argv[3] || 1e5);
const { Game } = require(engineFile(dir, 'blackjack.js'));
let Counting = null;
try { Counting = require(engineFile(dir, 'counting.js')); } catch (_) { /* optional */ }

let a = 4242 >>> 0;
const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const val = (c) => (c.rank === 'A' ? 11 : ['J', 'Q', 'K'].includes(c.rank) ? 10 : Number(c.rank));
function total(cards) { let t = 0, n = 0; for (const c of cards) { t += val(c); if (c.rank === 'A') n++; } while (t > 21 && n) { t -= 10; n--; } return t; }
const natural = (cards) => cards.length === 2 && total(cards) === 21;

// Independent settlement of one hand (main bet only) given final dealer cards.
function refNet(h, dealer) {
  if (h.surrendered) return -h.bet / 2;
  const pt = total(h.cards), dt = total(dealer);
  const pbj = natural(h.cards) && !h.fromSplit, dbj = natural(dealer);
  if (pbj && dbj) return 0;
  if (pbj) return 1.5 * h.bet;
  if (dbj) return -h.bet;
  if (pt > 21) return -h.bet;
  if (dt > 21) return h.bet;
  return pt > dt ? h.bet : pt < dt ? -h.bet : 0;
}

const bad = {}; const flag = (k, ex) => { bad[k] = bad[k] || { count: 0, ex }; bad[k].count++; };
const g = new Game({ bankroll: 1e9, rng: rnd });
const tally = { rounds: 0, spots: [0, 0, 0, 0], splits: 0, doubles: 0, maxHands: 0 };
for (let i = 0; i < ROUNDS; i++) {
  const n = 1 + Math.floor(rnd() * 3);
  const bets = Array.from({ length: n }, () => [5, 10, 25][Math.floor(rnd() * 3)]);
  const before = g.bankroll;
  try { g.deal(n === 1 && rnd() < 0.5 ? bets[0] : bets); } catch (e) { flag('deal threw: ' + e.message, { bets }); continue; }
  if (g.phase === 'insurance') g.declineInsurance();
  const order = [];
  let guard = 0;
  while (g.phase === 'player' && guard++ < 100) {
    const h = g.currentHand; order.push(h.spot);
    const r = rnd();
    if (g.canSplit() && r < 0.3) { g.split(); tally.splits++; }
    else if (g.canDouble() && r < 0.5) { g.double(); tally.doubles++; }
    else if (g.canSurrender() && r < 0.55) g.surrender();
    else if (total(h.cards) < 17 && r < 0.8) g.hit();
    else g.stand();
  }
  if (g.phase !== 'done') { flag('round did not finish', { phase: g.phase }); continue; }
  tally.rounds++; tally.spots[n]++; tally.maxHands = Math.max(tally.maxHands, g.hands.length);
  // spots are played left to right
  for (let k = 1; k < order.length; k++) if (order[k] < order[k - 1]) { flag('spots played out of order', { order }); break; }
  // each spot got its bet; spot indexes 0..n-1
  const spotsSeen = new Set(g.hands.map((h) => h.spot));
  if (spotsSeen.size !== n) flag('hands do not cover every spot', { n, spots: [...spotsSeen] });
  if (JSON.stringify(g.spotBets) !== JSON.stringify(n === 1 ? [bets[0]] : bets)) flag('spotBets differ from bets placed', { bets, spotBets: g.spotBets });
  for (let s = 0; s < n; s++) if (g.hands.filter((h) => h.spot === s).length > 4) flag('more than 4 hands on a spot', { s });
  // settlement vs reference
  let refSum = 0;
  g.hands.forEach((h, k) => {
    const r = refNet(h, g.dealer); refSum += r;
    if (Math.abs(r - g.results[k].net) > 1e-9) flag('hand settlement differs from reference', { cards: h.cards.map((c) => c.rank), dealer: g.dealer.map((c) => c.rank), bet: h.bet, fromSplit: h.fromSplit, engine: g.results[k].net, ref: r });
  });
  const delta = g.bankroll - before;
  if (Math.abs(delta - g.net) > 1e-9) flag('bankroll delta != game.net', { delta, net: g.net });
  if (Math.abs(refSum + (g.insuranceNet || 0) + (g.sideNet || 0) - delta) > 1e-9) flag('bankroll delta != reference sum', { delta, refSum });
  const staked = g.hands.reduce((s, h) => s + h.bet, 0) + (g.insurance || 0) + (g.sideBets || []).reduce((s, x) => s + x.stake, 0);
  if (g.wagered !== undefined && Math.abs(g.wagered - staked) > 1e-9) flag('wagered != stakes', { wagered: g.wagered, staked });
  // dealer draws only if some hand is live
  // Live = still needs the dealer's total: not surrendered, not bust, not a blackjack already paid 3:2.
  const live = g.hands.some((h) => !h.surrendered && total(h.cards) <= 21 && !(natural(h.cards) && !h.fromSplit));
  const liveInclNaturals = g.hands.some((h) => !h.surrendered && total(h.cards) <= 21);
  if (!live && liveInclNaturals && g.dealer.length > 2) flag('dealer drew when only blackjacks were left', { dealer: g.dealer.map((c) => c.rank) });
  if (!live && g.dealer.length > 2) flag('dealer drew with no live hand', { dealer: g.dealer.map((c) => c.rank) });
  if (live && !natural(g.dealer) && total(g.dealer) < 17) flag('dealer stood below 17', { dealer: g.dealer.map((c) => c.rank) });
}

// B12: formatTrue must not show a value on the other side of an integer from floor(tc).
const b12 = { checked: 0, mismatches: [] };
if (Counting && Counting.formatTrue) {
  for (let x = -8; x <= 8; x += 0.001) {
    const tc = Math.round(x * 1000) / 1000;
    const shown = Number(Counting.formatTrue(tc).replace('+', ''));
    b12.checked++;
    if (Math.floor(shown + 1e-9) !== Math.floor(tc) && b12.mismatches.length < 5) b12.mismatches.push({ tc, shown: Counting.formatTrue(tc), floor: Math.floor(tc) });
  }
  if (Counting.betUnits) b12.samples = [1.97, 2.96, 3.0, -0.05].map((tc) => `${tc} -> ${Counting.formatTrue(tc)} / ${Counting.betUnits(tc)} units`);
}
console.log(JSON.stringify({ tally, problems: bad, b12 }, null, 1));
