#!/usr/bin/env node
/**
 * Engine-level checks for F15 (cut card, sit out), F16 (bankroll tools),
 * F17 (rule variants) and B14 (count-drill clock).
 * Usage: node f15_f17_check.js <snapshotDir>
 */
'use strict';
const path = require('path');
const { engineFile } = require('./lib/layout');
const dir = path.resolve(process.argv[2]);
const req = (f) => require(engineFile(dir, f));
const BJ = req('blackjack.js'), Rules = req('rules.js'), Strategy = req('strategy.js'), Chart = req('chart.js'),
  Bank = req('bankroll.js'), Drill = req('drill.js'), Counting = req('counting.js'), EV = req('ev.js');
const out = { checks: {} };
const ok = (n, pass, detail) => { out.checks[n] = { pass, ...(detail !== undefined ? { detail } : {}) }; };
let s = 777 >>> 0;
const rng = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hl = (c) => { const v = BJ.cardValue(c); return v <= 6 ? 1 : v >= 10 ? -1 : 0; };

// ---- F15: cut card at the chosen penetration ----
{
  const res = [];
  for (const pen of [0.5, 0.65, 0.75, 0.85]) {
    const g = new BJ.Game({ bankroll: 1e9, decks: 6, penetration: pen, rng });
    let dealtAtShuffle = [], dealt = 0, shuffles = g.shuffles;
    for (let i = 0; i < 6000; i++) {
      const before = g.shoe.length;
      g.deal(1);
      if (g.shuffles !== shuffles) { dealtAtShuffle.push(312 - before); shuffles = g.shuffles; }
      if (g.phase === 'insurance') g.declineInsurance();
      while (g.phase === 'player') g.stand();
    }
    const mean = dealtAtShuffle.reduce((a, b) => a + b, 0) / dealtAtShuffle.length;
    const min = Math.min(...dealtAtShuffle), max = Math.max(...dealtAtShuffle);
    res.push({ pen, shoes: dealtAtShuffle.length, meanPctDealt: +(100 * mean / 312).toFixed(1), minCards: min, maxCards: max, cut: Math.round(312 * pen) });
  }
  // A shuffle happens at the first round start after the cut: cards dealt must be >= cut and < cut + one round (<~20 cards).
  const good = res.every((r) => r.minCards >= r.cut && r.maxCards <= r.cut + 20);
  ok('F15 reshuffle happens at the chosen cut card (50/65/75/85%)', good, res);
}

// ---- F15: sit out moves no money, cards still counted ----
{
  const g = new BJ.Game({ bankroll: 1000, rng });
  const decide = (seat, up) => Strategy.recommend(seat, up, { canDouble: true, canSplit: false, canSurrender: false }, Strategy.DEFAULT_RULES).action;
  let bad = 0, countBad = 0;
  for (let i = 0; i < 3000; i++) {
    const bank = g.bankroll, before = Counting.countState(g).running;
    const r = g.watchRound(decide);
    if (g.bankroll !== bank) bad++;
    if (!r.newShoe) {
      const want = before + [...r.seat, ...r.dealer].reduce((a, c) => a + hl(c), 0);
      if (Counting.countState(g).running !== want) countBad++;
    }
    if (i % 5 === 0) { g.deal(1); if (g.phase === 'insurance') g.declineInsurance(); while (g.phase === 'player') g.stand(); }
  }
  ok('F15 sit-out rounds move no money and every card shown is counted', bad === 0 && countBad === 0, { rounds: 3000, moneyMoved: bad, countMismatches: countBad });
}

// ---- F16: bankroll estimates ----
{
  const flat = Bank.simulate({ ramp: 'flat', rounds: 300000, seed: 11 });
  const ramp = Bank.simulate({ ramp: 'ramp', rounds: 1000000, seed: 11 });
  const edge = Rules.houseEdge(Rules.DEFAULT_RULES) / 100;
  const se = (x) => x.sd / Math.sqrt(x.rounds);
  ok('F16 flat EV ≈ −house edge (within 3 SE)', Math.abs(flat.mean + edge) < 3 * se(flat), { flatMeanPct: +(100 * flat.mean).toFixed(3), houseEdgePct: +(100 * edge).toFixed(3), sePct: +(100 * se(flat)).toFixed(3) });
  const r100 = ramp.mean * 100;
  ok('F16 1–12 ramp ≈ +1.2 to +1.5 units per 100 (my count_sim)', r100 > 0.8 && r100 < 1.9, { units100: +r100.toFixed(3), se100: +(100 * se(ramp)).toFixed(3), avgBet: +ramp.avgBet.toFixed(2) });
  let mono = true, prev = 2; const ror = [];
  for (const b of [50, 100, 200, 400, 800, 1600]) { const v = Bank.riskOfRuin(ramp.mean, ramp.sd, b); ror.push([b, +v.toFixed(4)]); if (v > prev + 1e-12) mono = false; prev = v; }
  ok('F16 risk of ruin never rises with a bigger bankroll; flat = 100%', mono && Bank.riskOfRuin(flat.mean, flat.sd, 1e6) === 1, { ror });
  const sum = Bank.summarize(ramp, { bankroll: 10000, unit: 10, handsPerHour: 100 });
  ok('F16 summary: N0 = (sd/mean)², EV/h = mean×hands×unit', Math.abs(sum.n0 - (ramp.sd / ramp.mean) ** 2) < 1e-6 && Math.abs(sum.evHourDollars - ramp.mean * 100 * 10) < 1e-9, { n0: Math.round(sum.n0), evHour: +sum.evHourDollars.toFixed(2), ror: +sum.ror.toFixed(4) });
}

// ---- F17: house edge direction + chart = coach under variants ----
{
  const base = { ...Rules.DEFAULT_RULES };
  const e = (x) => Rules.houseEdge({ ...base, ...x });
  const dirs = [];
  for (const h17 of [false, true]) for (const decks of [1, 6, 8]) {
    const b = e({ h17, decks });
    dirs.push({ h17, decks, base: b, rsa: e({ h17, decks, rsa: true }), enhc: e({ h17, decks, enhc: true }), obo: e({ h17, decks, enhc: true, obo: true }), d911: e({ h17, decks, doubleOn: '9-11' }), d1011: e({ h17, decks, doubleOn: '10-11' }) });
  }
  const dirOk = dirs.every((d) => d.rsa < d.base && d.enhc > d.base && d.obo <= d.enhc && d.d911 > d.base && d.d1011 > d.d911);
  ok('F17 house edge: RSA lowers it; ENHC, 9–11, 10–11 raise it (10–11 > 9–11)', dirOk, dirs);

  const variants = [
    { rsa: true }, { enhc: true }, { enhc: true, obo: true }, { doubleOn: '9-11' }, { doubleOn: '10-11' },
    { h17: true, enhc: true, doubleOn: '10-11', rsa: true }, { decks: 1, doubleOn: '9-11', lateSurrender: false },
  ];
  const LETTER = { hit: 'H', stand: 'S', double: 'D', split: 'P', surrender: 'R' };
  let cells = 0; const bad = []; let costBad = 0; const dblBad = [];
  for (const v of variants) {
    const r = Rules.normalizeRules({ ...base, ...v });
    for (const g of Chart.buildChart(r)) for (const row of g.rows) for (const c of row.cells) {
      cells++;
      const hand = Chart.handFor(row.row);
      const up = { rank: c.up === 11 ? 'A' : c.up === 10 ? '10' : String(c.up), suit: '♠' };
      const canDouble = BJ.canDoubleOn ? BJ.canDoubleOn(hand, r.doubleOn) : true;
      const allowed = { canDouble, canSplit: true, canSurrender: !!r.lateSurrender };
      const coach = Strategy.recommend(hand, up, allowed, r).action;
      const first = String(c.code)[0].toUpperCase();
      if (first !== LETTER[coach] && bad.length < 6) bad.push({ v: JSON.stringify(v), row: row.row, up: c.up, code: c.code, coach });
      if (coach === 'double' && !canDouble && dblBad.length < 4) dblBad.push({ v: JSON.stringify(v), row: row.row, up: c.up });
      const m = EV.moveCost(r, `${row.row}|${c.up}`, coach, allowed);
      if (m && m.cost > 1e-4) costBad++;
    }
  }
  ok('F17 chart = coach under 7 variant rule sets', bad.length === 0, { cells, bad });
  ok('F17 coach never doubles where the rule forbids it (9–11 / 10–11)', dblBad.length === 0, { dblBad });
  ok('F17 coach move costs 0 under every variant', costBad === 0, { costBad });

  // Engine: 10–11 only must refuse a double on hard 9 and on soft hands
  const g = new BJ.Game({ bankroll: 1e6, doubleOn: '10-11', rng });
  let illegal = 0, n = 0;
  for (let i = 0; i < 20000; i++) {
    g.deal(1); if (g.phase === 'insurance') g.declineInsurance();
    if (g.phase === 'player') {
      const hv = BJ.handValue(g.currentHand.cards);
      if (g.canDouble() && (hv.soft || hv.total < 10 || hv.total > 11)) illegal++;
      n++;
    }
    while (g.phase === 'player') g.stand();
  }
  ok('F17 engine: 10–11 only table refuses other doubles', illegal === 0, { hands: n, illegal });

  // Engine ENHC: dealer blackjack takes a double; OBO keeps it to the original bet
  const lossOnDoubleVsBJ = (obo) => {
    let worst = 0, seen = 0;
    const gg = new BJ.Game({ bankroll: 1e6, enhc: true, obo, rng });
    for (let i = 0; i < 60000 && seen < 200; i++) {
      gg.deal(10); if (gg.phase === 'insurance') gg.declineInsurance();
      if (gg.phase === 'player' && gg.canDouble() && BJ.cardValue(gg.dealer[0]) >= 10) {
        gg.double();
        while (gg.phase === 'player') gg.stand();
        if (BJ.isBlackjack(gg.dealer)) { seen++; worst = Math.min(worst, gg.net); }
      }
      while (gg.phase === 'player') gg.stand();
    }
    return { seen, worst };
  };
  const full = lossOnDoubleVsBJ(false), obo = lossOnDoubleVsBJ(true);
  ok('F17 engine ENHC: double vs dealer blackjack loses 2× bet; with OBO only 1×', full.seen > 0 && full.worst === -20 && obo.seen > 0 && obo.worst === -10, { full, obo });
}

// ---- B14: count-drill clock ----
{
  const a = Drill.countClock(52, 500), b = Drill.countClock(52, 500);
  a.start(0); b.start(0);
  // b: hidden for 60 s after card 10
  b.pause(5000); const cardDuringPause = b.card(30000); b.resume(65000);
  const aDone = 26000, bDone = 86000;
  ok('B14 a 60 s hidden gap is not counted in the pace', a.elapsed(aDone) === b.elapsed(bDone) && a.card(aDone) === 52 && b.card(bDone) === 52 && cardDuringPause === 10, { a: a.elapsed(aDone), b: b.elapsed(bDone), cardDuringPause });
  const c = Drill.countClock(52, 500); c.start(0);
  ok('B14 card index comes from elapsed time, not ticks (a 3 s late tick skips ahead, not stretches)', c.card(3000) === 6 && c.nextIn(3100) === 400, { at3000: c.card(3000), nextIn3100: c.nextIn(3100) });
}
console.log(JSON.stringify(out, null, 1));
