#!/usr/bin/env node
// Example agent: plays basic strategy through the JSON-lines CLI, the same way
// any external agent (another language, a local model) would.
//
//   node agent/examples/basic-strategy.js [rounds=1000] [seed=example]
'use strict';
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const rounds = Number(process.argv[2] || 1000);
const seed = process.argv[3] || 'example';
const cli = spawn(process.execPath, [path.join(__dirname, '..', 'cli.js'), '--seed', seed, '--bankroll', '100000']);
const replies = readline.createInterface({ input: cli.stdout });
const waiting = [];
replies.on('line', (line) => waiting.shift()(JSON.parse(line)));
const next = () => new Promise((resolve) => waiting.push(resolve));
const send = (req) => { cli.stdin.write(JSON.stringify(req) + '\n'); return next(); };

(async () => {
  const ready = await next();
  const start = ready.obs.bankroll;
  for (let r = 0; r < rounds; r++) {
    let res = await send({ action: 'deal', bet: 10 });
    while (!res.done) {
      const { hint } = await send({ cmd: 'hint' });
      res = await send({ action: hint.action });
    }
  }
  const { obs } = await send({ cmd: 'observe' });
  await send({ cmd: 'quit' });
  const net = obs.bankroll - start;
  console.log(`${rounds} rounds at $10 on seed "${seed}": net ${net >= 0 ? '+' : ''}$${net.toFixed(2)} ` +
    `(${((net / (rounds * 10)) * 100).toFixed(2)}% of initial bets)`);
})();
