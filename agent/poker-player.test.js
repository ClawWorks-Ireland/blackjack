const test = require('node:test');
const assert = require('node:assert/strict');
const { PokerTable } = require('../engine/poker.js');
const { POLICIES } = require('../engine/poker-bots.js');
const { makeBrain, menu } = require('./poker-player.js');
const { match } = require('./poker-bench.js');

const player = (id) => ({ id, name: id, kind: 'ai' });

function spot() {
  const t = new PokerTable({ seed: 'menu' });
  t.sit(player('Hero'), 1000, 0); t.sit(player('Opponent'), 1000, 1);
  t.startHand(); // heads-up: hero on the button posts the small blind and acts first
  return t;
}

test('poker player: the menu lists concrete legal moves and marks the default', () => {
  const t = spot();
  const v = t.view(0);
  const m = menu(v, { action: 'call' });
  assert.deepEqual(m.map((o) => o.letter), m.map((_, i) => 'ABCDEFGH'[i]));
  assert.equal(m[0].action, 'fold');
  assert.ok(m.some((o) => o.label === 'call 5'));
  const raises = m.filter((o) => o.action === 'raise');
  assert.ok(raises.length >= 2 && raises.every((o) => o.amount >= 20 && o.amount <= 1000));
  assert.equal(raises[raises.length - 1].amount, 1000, 'the last raise is all-in');
  assert.equal(m.filter((o) => o.isDefault).length, 1);
  assert.equal(m.find((o) => o.isDefault).action, 'call');
});

test('poker player: plays the letter the model picks, falls back to the default otherwise', async () => {
  const t = spot();
  const answers = ['E', 'hmm', 'B'];
  const prompts = [];
  const brain = makeBrain({ ask: async (llm, sys, instr, prompt) => { prompts.push(prompt); return { ok: true, text: answers.shift() }; } });
  const v = t.view(0);
  const m = menu(v, POLICIES.default.decide(v, () => 0.5));
  const first = await brain.decide(v, () => 0.5);
  assert.deepEqual(first, { action: m[4].action, amount: m[4].amount });
  assert.match(prompts[0], /Your cards: \S\S \S\S/);
  assert.match(prompts[0], /Opponent: stack/);
  assert.match(prompts[0], /<- default/);
  await brain.decide(v, () => 0.5); // unreadable: the default
  assert.equal(brain.stats.fallbacks, 1);
  const down = await makeBrain({ ask: async () => ({ ok: false, text: '', code: 4 }) }).decide(v, () => 0.5);
  assert.ok(['fold', 'call', 'raise'].includes(down.action), 'model busy: the default');
});

test('poker player: in a benchmark it profiles the opponent and writes notes on it', async () => {
  let notesAsked = 0;
  const brain = makeBrain({
    notesEvery: 10,
    ask: async (llm, sys, instr, prompt) => {
      if (/coach/.test(sys)) { notesAsked++; assert.match(prompt, /Opponent: Opponent\nStatistics: plays \d+% of hands/); return { ok: true, text: 'Calls a lot. Value bet.' }; }
      const letters = (prompt.match(/^([A-H])\)/gm) || ['A)']).map((x) => x[0]);
      return { ok: true, text: letters[letters.length > 2 ? 2 : 0] };
    },
  });
  brain.name = 'llm';
  const r = await match(brain, { ...POLICIES['calling-station'], name: 'calling-station' }, { hands: 15, seed: 'notes' });
  assert.equal(r.hands, 30);
  assert.ok(brain.profiles.stats('Opponent').hands >= 30);
  assert.ok(notesAsked >= 1);
  assert.equal(brain.notes.Opponent, 'Calls a lot. Value bet.');
  assert.ok(!JSON.stringify(brain.profiles.toJSON()).includes('calling-station'), 'the style name never reaches the player');
});
