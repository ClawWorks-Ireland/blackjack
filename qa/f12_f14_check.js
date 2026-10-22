#!/usr/bin/env node
/**
 * Independent checks for F12 (chart viewer), F13 (drills) and F14 (EV cost).
 *  F12: every chart cell for 4 rule sets is consistent with strategy.recommend
 *       (the coach) for that hand.
 *  F13: 5,000 flashcards: check() agrees with the coach; weighting favours
 *       missed cells; countDeal answer = my own Hi-Lo sum.
 *  F14: basic move costs 0 in every cell; for a few hard hands vs 10 the
 *       stand-vs-hit cost agrees with a Monte Carlo of the game's own engine.
 * Usage: node f12_f14_check.js <snapshotDir> [mcTrials=400000]
 */
'use strict';
const path = require('path');
const { engineFile } = require('./lib/layout');
const dir = path.resolve(process.argv[2]);
const TRIALS = Number(process.argv[3] || 4e5);
const req = (f) => require(engineFile(dir, f));
const BJ = req('blackjack.js'), Strategy = req('strategy.js'), Chart = req('chart.js'), Drill = req('drill.js'), EV = req('ev.js');
const out = { checks: {} };
const ok = (n, pass, detail) => { out.checks[n] = { pass, ...(detail !== undefined ? { detail } : {}) }; };

let s = 20260928 >>> 0;
const rng = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const RULESETS = [
  { decks: 6, h17: false, das: true, lateSurrender: true },
  { decks: 6, h17: true, das: true, lateSurrender: true },
  { decks: 1, h17: false, das: false, lateSurrender: false },
  { decks: 8, h17: true, das: false, lateSurrender: true },
];
const LETTER = { hit: 'H', stand: 'S', double: 'D', split: 'P', surrender: 'R' };

// ---- F12: chart vs coach ----
{
  let cells = 0; const bad = [];
  for (const rules of RULESETS) {
    const r = { ...Strategy.DEFAULT_RULES, ...rules };
    for (const g of Chart.buildChart(rules)) for (const row of g.rows) for (const c of row.cells) {
      cells++;
      const hand = Chart.handFor(row.row);
      const up = { rank: c.up === 11 ? 'A' : c.up === 10 ? '10' : String(c.up), suit: '♠' };
      const allowed = { canDouble: true, canSplit: true, canSurrender: !!r.lateSurrender };
      const coach = Strategy.recommend(hand, up, allowed, r).action;
      // Chart code's first letter is the move with everything allowed (Ds/Rh/etc fall back only when not allowed).
      const first = String(c.code)[0].toUpperCase();
      if (first !== LETTER[coach] && bad.length < 8) bad.push({ rules: JSON.stringify(rules), row: row.row, up: c.up, code: c.code, coach });
    }
  }
  ok('F12 every chart cell matches the coach (4 rule sets)', bad.length === 0, { cells, bad });
}

// ---- F13: flashcards and count drill ----
{
  let n = 0, disagree = 0; const ex = [];
  for (const rules of RULESETS.slice(0, 2)) for (let i = 0; i < 2500; i++) {
    const f = Drill.nextCard(rules, { rng, withCount: i % 2 === 1 });
    const want = Drill.expected(f, rules).action;
    for (const a of ['hit', 'stand', 'double', 'split', 'surrender']) {
      const res = Drill.check(f, a, rules);
      if (res.correct !== (a === want)) { disagree++; if (ex.length < 3) ex.push({ f, a, want }); }
    }
    n++;
  }
  ok('F13 flashcard scoring: exactly the coach/count play is correct', disagree === 0, { cards: n, disagree, ex });

  // weighting: a cell with many misses should come up more often
  const rules = RULESETS[0];
  const base = new Map(), weighted = new Map();
  const target = 'hard 16|10';
  const key = (f) => Chart.cellKey ? Chart.cellKey(f.cards, f.upcard) : null;
  let hitsBase = 0, hitsW = 0;
  for (let i = 0; i < 6000; i++) { const f = Drill.nextCard(rules, { rng }); if (f.key === target) hitsBase++; }
  for (let i = 0; i < 6000; i++) { const f = Drill.nextCard(rules, { rng, misses: { [target]: 20 } }); if (f.key === target) hitsW++; }
  ok('F13 missed cells come up more often', hitsW > hitsBase * 2, { target, hitsBase, hitsW });

  const hl = (c) => { const v = c.rank === 'A' ? 11 : ['10', 'J', 'Q', 'K'].includes(c.rank) ? 10 : Number(c.rank); return v <= 6 ? 1 : v >= 10 ? -1 : 0; };
  let cbad = 0;
  for (const n2 of [52, 26, 10]) for (let i = 0; i < 300; i++) { const d = Drill.countDeal(n2, rng); if (d.cards.length !== n2 || d.answer !== d.cards.reduce((a, c) => a + hl(c), 0)) cbad++; }
  const full = Drill.countDeal(52, rng);
  ok('F13 count drill answer = independent Hi-Lo sum; full deck sums to 0', cbad === 0 && full.answer === 0, { cbad, fullDeck: full.answer });
}

// ---- F14: EV costs ----
{
  let cells = 0, nonzero = []; const r0 = { ...Strategy.DEFAULT_RULES, ...RULESETS[0] };
  for (const rules of RULESETS) {
    const r = { ...Strategy.DEFAULT_RULES, ...rules };
    for (const g of Chart.buildChart(rules)) for (const row of g.rows) for (const c of row.cells) {
      const hand = Chart.handFor(row.row);
      const up = { rank: c.up === 11 ? 'A' : c.up === 10 ? '10' : String(c.up), suit: '♠' };
      const allowed = { canDouble: true, canSplit: true, canSurrender: !!r.lateSurrender };
      const coach = Strategy.recommend(hand, up, allowed, r).action;
      const k = `${row.row}|${c.up}`;
      const m = EV.moveCost(r, k, coach, allowed);
      cells++;
      if (m && m.cost > 1e-4 && nonzero.length < 6) nonzero.push({ rules: JSON.stringify(rules), k, coach, cost: m.cost, best: m.best });
    }
  }
  ok('F14 the coach move costs 0 in every cell', nonzero.length === 0, { cells, nonzero });

  // Monte Carlo: hard totals vs dealer 10, stand vs hit-then-basic, 6D S17.
  const cases = [['10', '6'], ['10', '4'], ['9', '3'], ['7', '5']]; // 16, 14, 12, 12 vs 10
  const mc = [];
  for (const [a, b] of cases) {
    const ev = { stand: 0, hit: 0 };
    for (const move of ['stand', 'hit']) {
      let net = 0, n = 0;
      const g = new BJ.Game({ bankroll: 1e9, rng });
      for (let i = 0; i < TRIALS; i++) {
        // Stack the shoe: player a, dealer 10, player b, dealer hole (random), then random.
        const shoe = BJ.shuffle(BJ.createShoe(6), rng);
        const take = (rank) => { const j = shoe.findIndex((c) => c.rank === rank); return shoe.splice(j, 1)[0]; };
        const pa = take(a), du = take('10'), pb = take(b);
        const hole = shoe.pop();
        shoe.push(hole, du, pb, pa); // draw() pops: both player cards, then dealer up, then hole
        g.shoe = shoe; g.phase = 'done';
        try { g.deal(1); } catch (e) { continue; }
        if (g.phase === 'insurance') g.declineInsurance();
        if (g.phase !== 'player') continue; // dealer blackjack: excluded (EV is conditional on dealer peek)
        const before = g.bankroll + 1; // bet already taken
        g[move]();
        const allowed0 = () => ({ canDouble: false, canSplit: false, canSurrender: false });
        let guard = 0;
        while (g.phase === 'player' && guard++ < 20) g[Strategy.recommend(g.currentHand.cards, g.dealer[0], allowed0(), r0).action]();
        net += g.net; n++;
      }
      ev[move] = net / n;
    }
    const key = `${Number(a) + Number(b)}|10`;
    const e = EV.cellEV(r0, `hard ${Number(a) + Number(b)}|10`);
    mc.push({ hand: `${a},${b} vs 10`, mcStand: +ev.stand.toFixed(4), mcHit: +ev.hit.toFixed(4), mcDiff: +(ev.hit - ev.stand).toFixed(4),
      game: e ? { stand: e.stand, hit: e.hit, diff: +(e.hit - e.stand).toFixed(4) } : 'no cell' });
  }
  // SE of each MC mean ~ 1/sqrt(TRIALS) ≈ 0.0016 at 400k; allow 0.01 on the difference.
  const agree = mc.every((m) => typeof m.game === 'object' && Math.abs(m.mcDiff - m.game.diff) < 0.01);
  ok('F14 stand-vs-hit cost agrees with a Monte Carlo of the engine (±1%)', agree, mc);
}
console.log(JSON.stringify(out, null, 1));
