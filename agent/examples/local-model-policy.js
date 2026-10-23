// Benchmark policy that asks the gaming PC's local model for every move,
// through the local-models script (the same way agent/local-player.js plays
// live). Flat minimum bet; a move the model doesn't name legally falls back
// to the hint (basic strategy) and is counted in `fallbacks`.
//
//   node agent/bench.js --policy agent/examples/local-model-policy.js --rounds 300 --seeds bench-1
'use strict';
const { askModel, pickMove, MOVE_SYSTEM } = require('../local-player.js');

const LLM = process.env.LOCAL_LLM_CMD || `/usr/bin/python3 ${require('os').homedir()}/.claude/skills/local-models/scripts/llm.py`;
// The same prompt the live player uses (basic strategy as rules); LOCAL_MODEL_BARE=1 asks with no rules.
const SYSTEM = process.env.LOCAL_MODEL_BARE ? 'You are playing blackjack against the dealer. Choose the best move. '
  + 'Answer with exactly one of the legal moves, as written, and nothing else.' : MOVE_SYSTEM;

const stats = { asked: 0, fallbacks: 0 };

module.exports = {
  name: 'local-model',
  description: 'Asks the local model (Gemma 4 12B on the gaming PC) for every move; flat minimum bet.',
  stats,
  bet: (obs) => obs.table ? obs.table.minBet : 10,
  async act(obs, hint) {
    const h = obs.hands[obs.active] || obs.hands[0];
    const legal = obs.legal.map((m) => `${m}${obs.legalCost && obs.legalCost[m] ? ` (costs ${obs.legalCost[m]} more)` : ''}`).join(', ');
    const prompt = obs.phase === 'insurance'
      ? `Dealer shows an ace. Your hand: ${h.cards.join(' ')} (${h.total}). ${obs.insurance.evenMoney ? 'Even money is offered.' : 'Insurance is offered.'}\nLegal moves: ${legal}`
      : `Dealer shows: ${obs.dealer.cards[0]}\nYour hand: ${h.cards.join(' ')} (${h.soft ? 'soft ' : ''}${h.total})\nLegal moves: ${legal}`;
    stats.asked++;
    const r = await askModel(LLM, SYSTEM, 'Which move?', prompt);
    const move = r.ok ? pickMove(r.text, obs.legal) : null;
    if (move) return move;
    stats.fallbacks++;
    return hint.action;
  },
};
