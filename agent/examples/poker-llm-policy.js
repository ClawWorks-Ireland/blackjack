// Benchmark hero: the LLM poker player (agent/poker-player.js) on the local
// model, writing opponent notes every 30 hands.
//
//   node agent/poker-bench.js --hero agent/examples/poker-llm-policy.js --hands 500 --progress
'use strict';
const { makeBrain } = require('../poker-player.js');

module.exports = makeBrain({ log: (m) => console.error(`  ${m}`) });
module.exports.name = 'llm';
