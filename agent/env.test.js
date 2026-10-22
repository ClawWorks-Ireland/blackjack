const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { BlackjackEnv, EnvError, checkRules } = require('./env.js');

/** Play rounds with `pick(obs, env)` choosing the action; yields after every step. */
function* play(env, rounds, pick, bet = 10) {
  for (let r = 0; r < rounds && !env.observe().broke; r++) {
    let res = env.step({ action: 'deal', bet });
    yield res;
    while (!res.done) {
      res = env.step(pick(res.obs, env));
      yield res;
    }
  }
}

const basic = (obs, env) => env.hint().action;

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('same seed and actions give the same session', () => {
  const run = () => {
    const env = new BlackjackEnv({ seed: 'repeat-me' });
    return [...play(env, 200, basic)].map((r) => JSON.stringify(r));
  };
  assert.deepEqual(run(), run());
  const other = new BlackjackEnv({ seed: 'something-else' });
  assert.notDeepEqual([...play(other, 20, basic)].map((r) => JSON.stringify(r)), run().slice(0, 20));
});

test('a reset without a seed picks one and reports it', () => {
  const obs = new BlackjackEnv().observe();
  assert.match(obs.shoe.seed, /^[0-9a-z]{6}-1$/);
});

test('the hole card stays hidden until the round ends', () => {
  const env = new BlackjackEnv({ seed: 'hole' });
  for (const res of play(env, 300, basic)) {
    const { obs } = res;
    if (obs.phase === 'player' || obs.phase === 'insurance') {
      assert.equal(obs.dealer.cards.length, 1);
      assert.equal(obs.dealer.holeCardHidden, true);
    }
    if (res.done) {
      assert.ok(obs.dealer.cards.length >= 2);
      assert.equal(obs.dealer.holeCardHidden, false);
    }
  }
});

test('reward is the bankroll change for the round', () => {
  const env = new BlackjackEnv({ seed: 'reward', bankroll: 100000 });
  let before = env.observe().bankroll;
  let rounds = 0;
  for (const res of play(env, 2000, basic)) {
    if (!res.done) continue;
    assert.equal(Math.round((res.obs.bankroll - before) * 100) / 100, res.reward);
    assert.equal(res.obs.net, res.reward);
    before = res.obs.bankroll;
    rounds++;
  }
  assert.equal(rounds, 2000);
});

test('random legal play keeps every invariant', () => {
  const rng = lcg(7);
  const rulesets = [{}, { h17: true, payout: 1.2 }, { enhc: true, obo: true }, { rsa: true, doubleOn: '10-11', decks: 1 }];
  for (const rules of rulesets) {
    const env = new BlackjackEnv({ seed: 'fuzz', rules, bankroll: 1e6 });
    let steps = 0;
    const pick = (obs) => obs.legal[Math.floor(rng() * obs.legal.length)];
    for (const res of play(env, 3000, pick, 5)) {
      const { obs } = res;
      steps++;
      assert.ok(obs.legal.length > 0, 'legal actions while not broke');
      const seen = Object.values(obs.shoe.seen).reduce((a, b) => a + b, 0);
      const hidden = obs.dealer.holeCardHidden ? 1 : 0;
      // Every card in the shoe is either seen, still to come, or the hole card (counted in cardsLeft).
      assert.equal(seen + obs.shoe.cardsLeft, obs.shoe.decks * 52, `card conservation (${JSON.stringify(rules)})`);
      assert.ok(hidden === 0 || obs.phase !== 'done');
      if (obs.phase === 'player') assert.ok(obs.active !== null && obs.hands[obs.active].result === null);
      if (res.done) assert.ok(obs.hands.every((h) => h.result));
    }
    assert.ok(steps > 3000);
  }
});

test('basic strategy returns about what the house edge says', () => {
  const env = new BlackjackEnv({ seed: 'rtp', bankroll: 1e9 });
  let wagered = 0;
  let net = 0;
  for (let r = 0; r < 100000; r++) {
    let res = env.step({ action: 'deal', bet: 1 });
    while (!res.done) res = env.step(env.hint().action);
    wagered += 1;
    net += res.reward;
  }
  const ret = net / wagered; // per initial unit; about -0.5% for 6D S17 DAS LS with the cut card
  assert.ok(ret > -0.017 && ret < 0.007, `return ${(ret * 100).toFixed(2)}%`);
});

test('illegal and malformed actions are errors, not fallbacks', () => {
  const env = new BlackjackEnv({ seed: 'strict' });
  assert.throws(() => env.step('hit'), (e) => e instanceof EnvError && /not legal now \(phase betting\); legal: deal/.test(e.message));
  assert.throws(() => env.step('fold'), /unknown action "fold"/);
  assert.throws(() => env.step({ action: 'deal' }), /deal needs a bet/);
  assert.throws(() => env.step({ action: 'deal', bet: 0 }), /Bet must be positive/);
  assert.throws(() => env.step({ action: 'deal', bet: 5000 }), /Maximum bet/);
  assert.throws(() => env.step(42), /action must be/);
  assert.equal(env.observe().phase, 'betting');
});

test('rules are checked strictly', () => {
  assert.equal(checkRules({ h17: true }).h17, true);
  assert.throws(() => checkRules({ decks: 3 }), /invalid value for rule "decks"/);
  assert.throws(() => checkRules({ payout: 2 }), /invalid value for rule "payout"/);
  assert.throws(() => checkRules({ obo: true }), /needs "enhc"/);
  assert.throws(() => checkRules({ hitSoft17: true }), /unknown rule "hitSoft17"/);
  assert.throws(() => new BlackjackEnv({ seed: 'bad seed!' }), /seed must be/);
});

test('seen counts reset when a new shoe starts', () => {
  const env = new BlackjackEnv({ seed: 'shoes', rules: { decks: 1, penetration: 0.5 } });
  let shoe = env.observe().shoe.seed;
  let changed = 0;
  for (const res of play(env, 60, basic)) {
    if (res.obs.shoe.seed !== shoe) {
      shoe = res.obs.shoe.seed;
      changed++;
      const seen = Object.values(res.obs.shoe.seen).reduce((a, b) => a + b, 0);
      assert.ok(seen <= 30, 'only this round\'s cards are seen in a fresh shoe');
    }
  }
  assert.ok(changed >= 3);
});

test('CLI speaks JSON lines and echoes ids', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), '--seed', 'cli', '--rules', '{"h17":true}']);
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...String(d).trim().split('\n')));
  const send = (o) => child.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
  send({ id: 1, action: 'deal', bet: 10 });
  send({ id: 2, cmd: 'hint' });
  send({ id: 3, action: 'fold' });
  send('not json');
  send({ id: 4, cmd: 'quit' });
  await new Promise((r) => child.on('close', r));
  const msgs = lines.map((l) => JSON.parse(l));
  assert.equal(msgs[0].event, 'ready');
  assert.equal(msgs[0].obs.rules.h17, true);
  assert.equal(msgs[0].obs.shoe.seed, 'cli-1');
  assert.equal(msgs[1].id, 1);
  assert.equal(msgs[1].ok, true);
  assert.equal(msgs[1].obs.round, 1);
  assert.equal(msgs[1].obs.rules, undefined, 'step replies leave out the fixed rules');
  assert.equal(msgs[2].id, 2);
  assert.ok(msgs[2].hint === null || typeof msgs[2].hint.action === 'string');
  assert.deepEqual([msgs[3].id, msgs[3].ok], [3, false]);
  assert.match(msgs[3].error, /unknown action/);
  assert.equal(msgs[4].ok, false);
  assert.deepEqual([msgs[5].id, msgs[5].event], [4, 'bye']);
});

test('hint prices every legal action, and basic strategy is the best two-card play', () => {
  for (const rules of [{}, { h17: true, payout: 1.2 }, { enhc: true }, { doubleOn: '10-11', decks: 2 }]) {
    const env = new BlackjackEnv({ seed: 'hint-ev', rules, bankroll: 1e6 });
    let exact = 0;
    for (const res of play(env, 1500, basic)) {
      if (res.done) continue;
      const h = env.hint();
      const legal = res.obs.legal;
      if (h.ev === null) continue;
      for (const a of Object.keys(h.ev)) assert.ok(legal.includes(a), `${a} priced but not legal`);
      if (res.obs.phase === 'insurance') {
        assert.equal(h.evBasis, 'seen-cards');
        continue;
      }
      assert.ok('hit' in h.ev || !legal.includes('hit'));
      assert.ok('stand' in h.ev);
      if (h.evBasis !== 'two-card') continue;
      exact++;
      const best = Math.max(...Object.values(h.ev));
      assert.ok(h.ev[h.action] >= best - 0.002, `${JSON.stringify(rules)}: ${h.reason} ${JSON.stringify(h.ev)}`);
    }
    assert.ok(exact > 1000);
  }
});

test('insurance EV comes from the cards seen, never the shoe', () => {
  const env = new BlackjackEnv({ seed: 'hint-ins', bankroll: 1e6 });
  let checked = 0;
  for (const res of play(env, 3000, basic)) {
    if (res.obs.phase !== 'insurance' || !res.obs.legal.includes('insurance')) continue;
    const { seen, cardsLeft } = res.obs.shoe;
    const p = (16 * 6 - seen.T - seen.J - seen.Q - seen.K) / cardsLeft;
    const { ev } = env.hint();
    if (res.obs.insurance.evenMoney) {
      assert.deepEqual(ev, { insurance: 1, decline_insurance: Math.round(1.5 * (1 - p) * 1e4) / 1e4 });
    } else {
      assert.deepEqual(ev, { insurance: Math.round(((3 * p - 1) / 2) * 1e4) / 1e4, decline_insurance: 0 });
    }
    checked++;
  }
  assert.ok(checked > 50);
});
