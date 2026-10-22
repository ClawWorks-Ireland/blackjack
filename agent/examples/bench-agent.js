#!/usr/bin/env node
// Example agent for `node agent/bench.js --cmd`: reads one JSON message per
// line and answers each one. Any language works the same way. This one bets
// the table minimum and plays the hint, so it should score like the "basic"
// baseline.
//
//   node agent/bench.js --cmd "node agent/examples/bench-agent.js" --name example
'use strict';
const readline = require('readline');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const reply = msg.type === 'bet' ? { bet: msg.obs.table.minBet } : { action: msg.hint.action };
  process.stdout.write(JSON.stringify(reply) + '\n');
});
