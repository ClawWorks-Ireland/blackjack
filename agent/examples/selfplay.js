#!/usr/bin/env node
// Play basic strategy for N rounds and print a one-line JSON summary. The
// macOS self-play prints the same summary from Swift, so comparing the two for
// one seed shows both run the same engine.
//
//   node agent/examples/selfplay.js [--rounds 1000] [--seed s] [--bet 10] [--bankroll 100000]
'use strict';
const { BlackjackEnv } = require('../env.js');

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
};
const rounds = Number(arg('--rounds', 1000));
const seed = arg('--seed', 'selfplay');
const bet = Number(arg('--bet', 10));
const bankroll = Number(arg('--bankroll', 100000));

const env = new BlackjackEnv({ seed, bankroll });
let played = 0;
for (; played < rounds && !env.observe().broke; played++) {
  let res = env.step({ action: 'deal', bet });
  while (!res.done) res = env.step(env.hint().action);
}
const obs = env.observe();
console.log(JSON.stringify({ seed, rounds: played, bet, bankroll: obs.bankroll, net: Math.round((obs.bankroll - bankroll) * 100) / 100 }));
