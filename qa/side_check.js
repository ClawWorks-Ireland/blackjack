#!/usr/bin/env node
/**
 * Independent check of the Perfect Pairs and 21+3 side bets.
 *  1. Exact house edge for a 6-deck shoe from my own paytable + enumeration,
 *     compared with the game's sidebets.houseEdge().
 *  2. Fuzz Game.deal(bet, {pairs, t213}): each side result must match my
 *     reference, and bankroll change must equal main + insurance + side nets.
 * Usage: node side_check.js <snapshotDir> [rounds=100000]
 */
'use strict';
const path = require('path');
const dir = process.argv[2];
const ROUNDS = Number(process.argv[3] || 1e5);
const { Game, SUITS, RANKS } = require(path.resolve(dir, 'blackjack.js'));
const SB = require(path.resolve(dir, 'sidebets.js'));

const RED = (s) => /[♥♦]|heart|diamond/i.test(s);
// Perfect Pairs: perfect 25, coloured (same colour, different suit) 12, mixed 6.
function refPairs([a, b]) {
  if (a.rank !== b.rank) return 0;
  if (a.suit === b.suit) return 25;
  return RED(a.suit) === RED(b.suit) ? 12 : 6;
}
// 21+3 on player's two cards + dealer upcard: suited trips 100, straight flush 40,
// trips 30, straight 10, flush 5. A counts high or low; no wraparound.
const ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function refT213(cards) {
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const trips = cards.every((c) => c.rank === cards[0].rank);
  const idx = cards.map((c) => ORDER.indexOf(c.rank)).sort((x, y) => x - y);
  const run = (v) => v[1] === v[0] + 1 && v[2] === v[1] + 1;
  const straight = run(idx) || (idx[0] === 0 && idx[1] === 11 && idx[2] === 12); // A-2-3 or Q-K-A
  if (trips && flush) return 100;
  if (straight && flush) return 40;
  if (trips) return 30;
  if (straight) return 10;
  if (flush) return 5;
  return 0;
}

// Exact edge by enumerating distinct (rank,suit) draws without replacement.
function exactEdge(which, decks) {
  const types = [];
  for (const s of SUITS) for (const r of RANKS) types.push({ rank: r, suit: s });
  const counts = types.map(() => decks);
  let N = types.length * decks;
  const n = which === 'pairs' ? 2 : 3;
  let ev = 0;
  const walk = (picked, p, left) => {
    if (picked.length === n) {
      const cards = picked.map((i) => types[i]);
      const odds = which === 'pairs' ? refPairs(cards) : refT213(cards);
      ev += p * (odds ? odds : -1);
      return;
    }
    for (let i = 0; i < types.length; i++) {
      if (!counts[i]) continue;
      const q = counts[i] / left;
      counts[i]--; picked.push(i);
      walk(picked, p * q, left - 1);
      picked.pop(); counts[i]++;
    }
  };
  walk([], 1, N);
  return -100 * ev;
}

const out = { edges: {}, fuzz: {} };
for (const b of ['pairs', 't213']) {
  const mine = exactEdge(b, 6);
  let theirs = null;
  try { theirs = SB.houseEdge(b, 6); } catch (e) { theirs = 'error: ' + e.message; }
  if (typeof theirs === 'number' && Math.abs(theirs) < 1) theirs *= 100; // tolerate fraction vs percent
  out.edges[b] = { mine: +mine.toFixed(3), game: typeof theirs === 'number' ? +theirs.toFixed(3) : theirs };
}

// Fuzz settlement through the engine.
let a = 99 >>> 0;
const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const g = new Game({ bankroll: 1e9, rng: rnd });
const bad = {}; const flag = (k, ex) => { bad[k] = bad[k] || { count: 0, ex }; bad[k].count++; };
let hits = { pairs: 0, t213: 0 }, sideNet = 0, sideStake = 0;
for (let i = 0; i < ROUNDS; i++) {
  const before = g.bankroll;
  g.deal(10, { pairs: 5, t213: 5 });
  const up = g.dealer[0], two = g.hands[0].cards.slice(0, 2);
  for (const s of g.sideBets) {
    const name = s.bet || s.name;
    const odds = name === 'pairs' ? refPairs(two) : refT213([...two, up]);
    const want = odds ? odds * s.stake : -s.stake;
    if (s.net !== want) flag(`${name} settled ${s.net}, reference ${want}`, { cards: [...two, up].map((c) => c.rank + c.suit) });
    if (odds) hits[name]++;
    sideNet += s.net; sideStake += s.stake;
  }
  if (g.phase === 'insurance') g.declineInsurance();
  while (g.phase === 'player') g.stand();
  const delta = g.bankroll - before;
  if (Math.abs(delta - g.net) > 1e-9) flag('bankroll delta != game.net', { delta, net: g.net });
  const mainBets = g.hands.reduce((s, h) => s + h.bet, 0);
  const wantWagered = mainBets + (g.insurance || 0) + g.sideBets.reduce((s, x) => s + x.stake, 0);
  if (g.wagered !== undefined && Math.abs(g.wagered - wantWagered) > 1e-9) flag('wagered != stakes', { wagered: g.wagered, wantWagered });
}
out.fuzz = { rounds: ROUNDS, sideReturnPct: +(100 + 100 * sideNet / sideStake).toFixed(2), hits, problems: bad };
console.log(JSON.stringify(out, null, 1));
