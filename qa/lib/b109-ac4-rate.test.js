'use strict';
/**
 * #178 slice 5 (AC7): how often did the old B109 AC4 strategy end broke, or
 * stall on a bet the table rejects? No browser: the same engine Game the page
 * builds (web/app.js newGame: $1,000, table $1-$500, one deck) behind the
 * injected page operations of qa/lib/reach.js. A measuring test: it asserts the
 * shape of the tallies and passes whatever the numbers are.
 */
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../../engine/blackjack.js');
const { normalizeRules } = require('../../engine/rules.js');
const { money } = require('../../engine/format.js');
const { betError } = require('../../engine/betting.js');
const { reachReport } = require('./reach.js');

const TRIALS = 200;
const MIN = 1;
const MAX = 500;

/** The script's reading: digits only, so $127.50 reads as 12750. */
const misread = (bankroll) => Number(money(bankroll).replace(/[^\d]/g, ''));

/** Engine page operations for one trial. `read` turns the real bankroll into what the script sees. */
function engineOps(trial, read) {
  const state = { tables: 0, stalls: 0, notDone: 0, rounds: 0 };
  const newTable = () => {
    state.tables++;
    const game = new Game({
      bankroll: 1000, minBet: MIN, maxBet: MAX, ...normalizeRules({ decks: 1 }),
      seed: `b109-ac7-${trial}-t${state.tables}`, shoeNo: 1,
    });
    return { game, report: false, dealt: false };
  };
  const ops = {
    freshTable: () => newTable(),
    closeTable: () => {},
    reportOpen: (t) => t.report,
    waitReport: (t) => t.report,
    isBroke: (t) => t.game.isBroke,
    canDeal: (t) => !t.game.isBroke,
    bankroll: (t) => read(t.game.bankroll),
    deal(t, bet) {
      t.dealt = false;
      // The page rejects a bad bet and deals nothing (web/app.js:856-864).
      if (betError(bet, { bankroll: t.game.bankroll, min: MIN, max: MAX })) { state.stalls++; return; }
      t.game.deal(bet);
      t.dealt = true;
      state.rounds++;
    },
    playOut(t) {
      if (!t.dealt) return;
      const g = t.game;
      for (let guard = 0; guard < 100 && (g.phase === 'insurance' || g.phase === 'player'); guard++) {
        if (g.phase === 'insurance') g.declineInsurance(); else g.stand();
      }
      if (g.phase !== 'done') state.notDone++;
      // The page opens the shoe report by itself when the round ends past the cut card (web/app.js:540-543).
      else if (g.cutCardReached) t.report = true;
    },
  };
  return { ops, state };
}

async function measure(variant, read, opts) {
  const tally = { variant, trials: TRIALS, ok: 0, broke: 0, noReport: 0, stalled: 0 };
  let notDone = 0;
  let okTables = 0;
  for (let i = 1; i <= TRIALS; i++) {
    const { ops, state } = engineOps(i, read);
    const res = await reachReport(ops, opts);
    if (res.ok) { tally.ok++; okTables += res.tables; }
    else if (res.reason === 'broke') tally.broke++;
    else tally.noReport++;
    if (state.stalls > 0) tally.stalled++;
    notDone += state.notDone;
  }
  return { tally, notDone, meanTablesOk: tally.ok ? okTables / tally.ok : null };
}

test('b109 AC4 rate: old-ac4 / old-ac4-exact / ac4-as-merged tallies add up to 200 trials', async (t) => {
  const variants = [
    // e66916e: bankroll misread, bet min(255, bankroll), one table of up to 80 rounds.
    ['old-ac4', misread, { betFor: (b) => Math.min(255, b), maxTables: 1, minBankroll: 1, maxRoundsPerTable: 80 }],
    // Same strategy, exact bankroll and whole-dollar bets: plain chip loss only.
    ['old-ac4-exact', (b) => b, { betFor: (b) => Math.min(255, Math.floor(b)), maxTables: 1, minBankroll: 1, maxRoundsPerTable: 80 }],
    // The merged script (qa/b109_report_key_check.js:190): misread, default tables and rounds.
    ['ac4-as-merged', misread, { betFor: (b) => Math.min(255, b), minBankroll: 251 }],
  ];
  for (const [variant, read, opts] of variants) {
    const { tally, notDone, meanTablesOk } = await measure(variant, read, opts);
    const line = { ...tally };
    if (variant === 'ac4-as-merged') line.meanTablesOk = meanTablesOk;
    t.diagnostic(JSON.stringify({ ...line, node: process.version }));
    for (const k of ['ok', 'broke', 'noReport', 'stalled']) {
      assert.ok(Number.isInteger(tally[k]) && tally[k] >= 0, `${variant}: ${k} is a count`);
    }
    assert.strictEqual(tally.ok + tally.broke + tally.noReport, tally.trials, `${variant}: every trial has one end state`);
    assert.strictEqual(notDone, 0, `${variant}: every round ends in phase done`);
  }
});
