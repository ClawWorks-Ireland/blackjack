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

test('poker player with feedback: keeps a ledger, states facts, and stops bluffing a calling station', async () => {
  const { facts, kindOf } = require('./poker-player.js');
  assert.deepEqual([kindOf('raise', 0.2), kindOf('bet', 0.5), kindOf('allin', 0.8), kindOf('call', 0.1), kindOf('fold', 0.9), kindOf('check', 0.5)], ['bluff', 'thin', 'value', 'call', 'fold', null]);
  const prompts = [];
  const notesIn = [];
  const brain = makeBrain({
    feedback: true,
    notesEvery: 20,
    ask: async (llm, sys, instr, prompt) => {
      if (/coach/.test(sys)) { notesIn.push(prompt); return { ok: true, text: 'Never folds. Stop bluffing, value bet big.' }; }
      prompts.push(prompt);
      // A small bet or raise when offered (so hands reach the flop), else check or call.
      const line = prompt.split('\n').find((x) => /^[A-H]\) .*\(small\)/.test(x)) || prompt.split('\n').find((x) => /^[A-H]\) (check|call)/.test(x)) || 'A)';
      return { ok: true, text: line[0] };
    },
  });
  await match(brain, { ...POLICIES['calling-station'], name: 'calling-station' }, { hands: 60, seed: 'feedback' });
  const l = brain.ledger.Opponent;
  assert.ok(l && Object.keys(l).length >= 2, JSON.stringify(l));
  assert.ok(Object.values(l).every((e) => e.n > 0 && Number.isFinite(e.bb)));
  assert.ok(facts(brain.profiles, 'Opponent').some((f) => /folds to a bet only/.test(f)), facts(brain.profiles, 'Opponent').join('; '));
  assert.ok(prompts.some((p) => /Fact: folds to a bet only/.test(p)), 'facts reach the decision prompt');
  assert.ok(prompts.some((p) => /Your results against them: /.test(p)), 'its own results reach the decision prompt');
  assert.ok(notesIn.some((p) => /Your results against them: (bluffs|thin bets|value bets|calls|folds) \d+/.test(p)), 'and the note prompt');
  assert.ok(brain.stats.guarded > 0, 'weak-hand bets came off the menu once the station showed it never folds');
  assert.ok(brain.stats.sizedUp > 0, 'and strong hands got only big bets against it');
  const plain = makeBrain({ ask: async () => ({ ok: true, text: 'A' }) });
  assert.equal(plain.feedback, false);
  assert.equal(plain.name, 'llm');
  assert.equal(brain.name, 'llm-feedback');
});

test('brain.lastHand: main move, its equity, guardrail flag', async () => {
  const brain = makeBrain({
    feedback: true,
    ask: async (llm, sys, instr, prompt) => {
      const line = prompt.split('\n').find((x) => /<- default/.test(x));
      return { ok: true, text: line ? line[0] : 'A' };
    },
  });
  assert.equal(brain.lastHand, null);
  const seen = [];
  await match(brain, { ...POLICIES['calling-station'], name: 'calling-station' }, {
    hands: 60, seed: 'lasthand',
    onHand: () => { seen.push({ ...brain.lastHand, guarded: brain.stats.guarded, sizedUp: brain.stats.sizedUp }); },
  });
  assert.equal(seen.length, 120);
  let prev = 0;
  let fired = 0;
  for (const s of seen) {
    assert.ok([null, 'bluff', 'thin', 'value', 'call', 'fold'].includes(s.mainMove), String(s.mainMove));
    if (s.mainMove === null) assert.equal(s.equityAtMainMove, null);
    else assert.ok(s.equityAtMainMove >= 0 && s.equityAtMainMove <= 1);
    const total = s.guarded + s.sizedUp;
    assert.equal(s.guardrailFired, total > prev, 'the flag is true exactly on hands where a guardrail counter went up');
    if (s.guardrailFired) fired++;
    prev = total;
  }
  assert.ok(fired > 0, 'a guardrail fired at least once');
});
