#!/usr/bin/env node
/**
 * Heads-up poker benchmark (CLA-120, CLA-123). A hero policy plays each
 * opponent style in duplicate: every deal is played twice with the seats
 * swapped, so both players get the same cards once each and most of the luck
 * cancels out. Stacks start at 100 big blinds every hand.
 *
 *   node agent/poker-bench.js [--hero default] [--hands 2000] [--seed bench]
 *   node agent/poker-bench.js --hero ./my-poker-policy.js --styles calling-station,maniac
 *
 * Result: big blinds won per 100 hands for the hero against each style, with
 * a 95% interval, and the style's measured stats (to check it plays like its
 * label). A policy is {name, decide(view, rng)} as in engine/poker-bots.js;
 * decide may return a promise, and may also have onHandEnd(view, names).
 */
'use strict';
const path = require('path');
const { PokerTable } = require('../engine/poker.js');
const { POLICIES, rngFor } = require('../engine/poker-bots.js');
const { Profiles } = require('./poker-profile.js');

const BB = 10;
const STACK = 100 * BB;

/** Play one hand at a fresh table; `players[0]` sits in seat 0 (the button). Returns each seat's net in chips. */
async function playHand(seed, players, profiles, rng) {
  const t = new PokerTable({ seed, smallBlind: BB / 2, bigBlind: BB, seats: 2 });
  players.forEach((p, i) => t.sit({ id: p.name, name: p.name, kind: 'bot' }, STACK, i));
  t.startHand();
  for (let steps = 0; t.inPlay; steps++) {
    if (steps > 200) throw new Error('hand did not end');
    const seat = t.toAct;
    const view = t.view(seat);
    let d = await players[seat].decide(view, rng);
    if (!d || !t.legal(seat).some((l) => l.action === d.action || d.action === 'allin')) d = { action: t.legal(seat).some((l) => l.action === 'check') ? 'check' : 'fold' };
    t.act(seat, d.action, d.amount);
  }
  const names = players.map((p) => p.name);
  profiles.addHand(names, t.log, t.lastHand);
  for (let i = 0; i < players.length; i++) if (players[i].onHandEnd) await players[i].onHandEnd(t.view(i), names);
  return t.lastHand.net;
}

/** Hero against one style for `hands` duplicate pairs. */
async function match(hero, villain, { hands = 1000, seed = 'bench', log = () => {} } = {}) {
  const profiles = new Profiles();
  const rng = rngFor(`${seed}:${hero.name}:${villain.name}`);
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < hands; i++) {
    const deal = `${seed}-${i}`;
    const a = await playHand(deal, [hero, villain], profiles, rng); // hero on the button
    const b = await playHand(deal, [villain, hero], profiles, rng); // same cards, seats swapped
    const pair = (a[0] + b[1]) / BB; // the hero's result over the pair, in big blinds
    n++;
    sum += pair;
    sum2 += pair * pair;
    if (i % 100 === 99) log(`${hero.name} v ${villain.name}: ${i + 1} pairs, ${((sum / n) * 50).toFixed(1)} bb/100`);
  }
  const mean = sum / n; // per pair = per 2 hands
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return {
    hero: hero.name, villain: villain.name, hands: 2 * n,
    bbPer100: Math.round(mean * 50 * 10) / 10,
    ci95: Math.round(1.96 * (sd / Math.sqrt(n)) * 50 * 10) / 10,
    villainStats: profiles.stats(villain.name),
    heroStats: profiles.stats(hero.name),
  };
}

function loadHero(spec) {
  if (POLICIES[spec]) return POLICIES[spec];
  const mod = require(path.resolve(spec));
  return mod.default || mod;
}

async function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const hero = loadHero(flag('--hero', 'default'));
  const styles = (flag('--styles', 'tight-passive,loose-aggressive,calling-station,maniac')).split(',');
  const hands = Number(flag('--hands', 2000));
  const seed = flag('--seed', 'bench');
  for (const s of styles) {
    const villain = { ...POLICIES[s], name: s };
    const r = await match(hero, villain, { hands: Math.ceil(hands / 2), seed, log: argv.includes('--progress') ? console.log : () => {} });
    const v = r.villainStats;
    console.log(`${r.hero.padEnd(16)} v ${s.padEnd(17)} ${r.bbPer100 >= 0 ? '+' : ''}${r.bbPer100} ± ${r.ci95} bb/100 over ${r.hands} hands`
      + `   | ${s}: VPIP ${v.vpip}%, PFR ${v.pfr}%, aggression ${v.aggression}, folds to a bet ${v.foldToBet}%`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { match, playHand, BB, STACK };
