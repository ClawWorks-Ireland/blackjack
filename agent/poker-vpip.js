#!/usr/bin/env node
/**
 * Preflop VPIP measurement (#111, part of #10 AC3). Plays duplicate pairs of
 * heads-up hands, stopping each hand as soon as the preflop street is over, and
 * counts how often a style puts money in by choice (as agent/poker-profile.js
 * counts VPIP). Measure only: it makes no claim about how the styles compare.
 *
 *   node agent/poker-vpip.js [--pairs 1000] [--seed mild]
 */
'use strict';
const { PokerTable } = require('../engine/poker.js');
const { POLICIES, MILD_POLICIES, rngFor } = require('../engine/poker-bots.js');
const { BB, STACK } = require('./poker-bench.js');

const STYLES = [
  ...['default', 'tight-passive', 'loose-aggressive', 'calling-station', 'maniac'].map((k) => [k, POLICIES[k]]),
  ...Object.keys(MILD_POLICIES).map((k) => [k, MILD_POLICIES[k]]),
];

/** Play one hand preflop only; true if the villain seat voluntarily put money in. */
function preflopHand(deal, players, rngs, villainSeat) {
  const t = new PokerTable({ seed: deal, smallBlind: BB / 2, bigBlind: BB, seats: 2 });
  players.forEach((p, i) => t.sit({ id: p.name, name: p.name, kind: 'bot' }, STACK, i));
  t.startHand();
  for (let steps = 0; t.inPlay && t.phase === 'preflop'; steps++) {
    if (steps > 200) throw new Error('hand did not end');
    const seat = t.toAct;
    let d = players[seat].decide(t.view(seat), rngs[seat]);
    if (!d || !t.legal(seat).some((l) => l.action === d.action || d.action === 'allin')) d = { action: t.legal(seat).some((l) => l.action === 'check') ? 'check' : 'fold' };
    t.act(seat, d.action, d.amount);
  }
  return t.log.some((e) => e.seat === villainSeat && e.street === 'preflop' && (e.action === 'call' || e.action === 'bet' || e.action === 'raise'));
}

/** VPIP of `policy` (played as `styleName`) over 2 x pairs preflop-only hands against the default hero. */
function preflopVpip(policy, styleName, { pairs = 1000, seed = 'mild' } = {}) {
  const hero = { ...POLICIES.default, name: 'Hero', decide: POLICIES.default.decide.bind(POLICIES.default) };
  const villain = { ...policy, name: 'Opponent', decide: policy.decide.bind(policy) };
  let vpipHands = 0;
  for (let i = 0; i < pairs; i++) {
    const deal = `${seed}-${i}`;
    const hr = (k) => rngFor(`${deal}:hero:${k}`);
    const vr = (k) => rngFor(`${deal}:${styleName}:${k}`);
    if (preflopHand(deal, [hero, villain], [hr(0), vr(0)], 1)) vpipHands++;
    if (preflopHand(deal, [villain, hero], [vr(1), hr(1)], 0)) vpipHands++;
  }
  const hands = 2 * pairs;
  return { vpipHands, hands, pct: (100 * vpipHands) / hands };
}

function vpipTable({ pairs = 1000, seed = 'mild' } = {}) {
  return STYLES.map(([style, policy]) => {
    const t0 = Date.now();
    const r = preflopVpip(policy, style, { pairs, seed });
    return { style, pct: r.pct, vpipHands: r.vpipHands, hands: r.hands, ms: Date.now() - t0 };
  });
}

function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const pairs = Number(flag('--pairs', 1000));
  const seed = flag('--seed', 'mild');
  const t0 = Date.now();
  for (const r of vpipTable({ pairs, seed })) {
    console.log(`${r.style.padEnd(24)} VPIP ${r.pct.toFixed(1).padStart(5)}%  (${r.vpipHands}/${r.hands})  ${r.ms} ms`);
  }
  console.log(`total wall time ${Date.now() - t0} ms (${pairs} pairs, seed ${seed})`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { preflopVpip, vpipTable };
