'use strict';
/**
 * #189 slice 3: the seeded AC6 repro and the AC6 verdict of qa/b109_report_key_check.js.
 * Pure: the engine Game as web/app.js newGame builds it, no browser.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Game, parseSeed, isBlackjack } = require('../../engine/blackjack.js');
const { normalizeRules } = require('../../engine/rules.js');
const { AC6_SEED, ac6Verdict } = require('./ac6.js');

const cards = (cs) => cs.map((c) => c.rank + c.suit).join(' ');

test('AC6_SEED reproduces the old AC6 failure', (t) => {
  // web/app.js newGame(START_BANKROLL, { decks: 1 }) with the seed typed in Table rules.
  const parsed = parseSeed(AC6_SEED);
  assert.ok(parsed, 'AC6_SEED parses as a seed');
  const g = new Game({ bankroll: 1000, minBet: 1, maxBet: 500, ...normalizeRules({ decks: 1 }), ...parsed });
  // Round 1: $10, played as playOut does (decline insurance, otherwise stand).
  g.deal(10);
  for (let i = 0; i < 100 && (g.phase === 'insurance' || g.phase === 'player'); i++) {
    if (g.phase === 'insurance') g.declineInsurance(); else g.stand();
  }
  assert.strictEqual(g.phase, 'done', 'round 1 is finished');
  assert.strictEqual(g.cutCardReached, false, 'no shoe report opens by itself after round 1');
  t.diagnostic(`seed ${AC6_SEED}; round 1: player ${g.hands.map((h) => cards(h.cards)).join(' | ')}; dealer ${cards(g.dealer)}`);
  // Round 2: $20 (Rebet x2), with no player input.
  g.deal(20);
  t.diagnostic(`round 2: player ${g.hands.map((h) => cards(h.cards)).join(' | ')}; dealer ${cards(g.dealer)}`);
  assert.strictEqual(g.phase, 'done', 'round 2 ends at the deal');
  assert.ok(g.hands.some((h) => isBlackjack(h.cards)) || isBlackjack(g.dealer), 'a natural on one side');
  assert.notStrictEqual(g.dealer[0].rank, 'A', 'no insurance or even-money prompt');
});

const clean = () => ({
  rebet2Usable: true, dealUsable: true, opened: true, openAfterX: true,
  inHandAfterX: false, bankBefore: 990, bankAfterX: 990,
  inHandAfterEnter: false, bankAfterEnter: 990, dealt: 0,
});

test('ac6Verdict passes a clean detail', () => {
  assert.strictEqual(ac6Verdict(clean()), true);
});

test('ac6Verdict fails when x deals while the report is open', () => {
  const bad = {
    inHandAfterX: true,
    bankAfterX: 970,
    openAfterX: false,
    inHandAfterEnter: true,
    bankAfterEnter: 970,
    dealt: 1,
    rebet2Usable: false,
    dealUsable: false,
    opened: false,
  };
  for (const [key, value] of Object.entries(bad)) {
    assert.strictEqual(ac6Verdict({ ...clean(), [key]: value }), false, `${key}=${value}`);
  }
});

test('ac6Verdict needs the after-Enter probes to be false, not missing', () => {
  const d = { ...clean(), inHandAfterEnter: null, bankAfterEnter: null };
  assert.strictEqual(ac6Verdict(d), false);
});

test('b109_report_key_check.js compiles', () => {
  const filename = path.join(__dirname, '..', 'b109_report_key_check.js');
  const source = fs.readFileSync(filename, 'utf8');
  assert.doesNotThrow(() => new vm.Script(source, { filename }));
});
