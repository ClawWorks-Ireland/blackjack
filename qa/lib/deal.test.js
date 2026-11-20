'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { roundStarted, dealRound } = require('./deal');

const idle = { inHand: false, hitEnabled: false, noInsureEnabled: false, rounds: 5 };

test('roundStarted: in-hand after deal -> true', () => {
  assert.equal(roundStarted(idle, { ...idle, inHand: true }), true);
});
test('roundStarted: instant blackjack, rounds grew, not in hand -> true', () => {
  assert.equal(roundStarted(idle, { ...idle, rounds: 6 }), true);
});
test('roundStarted: nothing changed -> false', () => {
  assert.equal(roundStarted(idle, { ...idle }), false);
});

// Fake page: per click, the script says whether the click deals and whether the report is open.
function fake(script) {
  let clicks = 0;
  let state = { ...idle };
  let open = false;
  return {
    get clicks() { return clicks; },
    ops: {
      probe: async () => ({ ...state }),
      closeReport: async () => { open = false; },
      clickDeal: async () => {
        const s = script[clicks++] || {};
        open = Boolean(s.report);
        if (s.deals) state = { ...state, inHand: true };
      },
      reportOpen: async () => open,
    },
  };
}

test('dealRound: first click deals -> started, attempts 1', async () => {
  const f = fake([{ deals: true }]);
  assert.deepEqual(await dealRound(null, f.ops), { started: true, attempts: 1, reportOpened: false });
});
test('dealRound: report opened over the first click, second click deals -> started, attempts 2, reportOpened true', async () => {
  const f = fake([{ report: true }, { deals: true }]);
  assert.deepEqual(await dealRound(null, f.ops), { started: true, attempts: 2, reportOpened: true });
});
test('dealRound: report reopens on every attempt -> started false, attempts 3, never more than 3 clicks', async () => {
  const f = fake([{ report: true }, { report: true }, { report: true }, { report: true }]);
  assert.deepEqual(await dealRound(null, f.ops), { started: false, attempts: 3, reportOpened: true });
  assert.equal(f.clicks, 3);
});
test('dealRound: no round and no report -> started false after 1 attempt (no blind retry)', async () => {
  const f = fake([{}, { deals: true }]);
  assert.deepEqual(await dealRound(null, f.ops), { started: false, attempts: 1, reportOpened: false });
  assert.equal(f.clicks, 1);
});
test('dealRound: stops after the first started round (never deals twice)', async () => {
  const f = fake([{ deals: true }, { deals: true }]);
  await dealRound(null, f.ops);
  assert.equal(f.clicks, 1);
});

const { crossCheck } = require('./deal');
const base = { round: 3, before: { bank0: 100, net0: 0, rounds0: 4, rec0: 4 }, after: { bank1: 110, net1: 10, rounds1: 5, rec1: 5, handsN: 1 }, msg: 'You win', reportOpened: false };

test('crossCheck: dealt round with matching stats -> no findings', () => {
  assert.deepEqual(crossCheck(base), []);
});
test("crossCheck: rounds unchanged -> 'stats Rounds did not increment by 1' with round/bank0/bank1/msg/reportOpened", () => {
  const r = crossCheck({ ...base, after: { ...base.after, rounds1: 4 }, reportOpened: true });
  assert.equal(r.length, 1);
  assert.equal(r[0].issue, 'stats Rounds did not increment by 1');
  assert.deepEqual(r[0].detail, { round: 3, rounds0: 4, rounds1: 4, bank0: 100, bank1: 110, msg: 'You win', reportOpened: true });
});
test('crossCheck: W-L-P short by one hand -> W-L-P finding', () => {
  const r = crossCheck({ ...base, after: { ...base.after, rec1: 4 } });
  assert.deepEqual(r.map((f) => f.issue), ['W-L-P did not grow by number of hands']);
});
