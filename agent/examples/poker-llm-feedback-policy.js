// Benchmark hero: the LLM poker player with the feedback loop (CLA-124): its
// own results by move type and facts about each opponent, in its notes and
// decisions, and no weak-hand bets against players who never fold.
//
//   node agent/poker-bench.js --hero agent/examples/poker-llm-feedback-policy.js --hands 500 --progress
'use strict';
const { makeBrain } = require('../poker-player.js');

module.exports = makeBrain({ feedback: true, log: (m) => console.error(`  ${m}`) });
