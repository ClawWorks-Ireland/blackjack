'use strict';
/**
 * Guarded Deal for the UI playtest. No Playwright dependency: the page
 * operations are injected, so npm test can load this without qa/node_modules.
 */

/** True if a round is under way (or an instant blackjack already settled). */
function roundStarted(before, after) {
  return Boolean(after.inHand || after.hitEnabled || after.noInsureEnabled || after.rounds > before.rounds);
}

/**
 * Deal once, retrying only when the F18 shoe report got in the way.
 * ops: { probe() -> state, closeReport(), clickDeal(), reportOpen() -> boolean }
 */
async function dealRound(page, ops, maxAttempts = 3) {
  const { probe, closeReport, clickDeal, reportOpen } = ops;
  const before = await probe();
  let attempts = 0;
  let reportOpened = false;
  while (attempts < maxAttempts) {
    if (await reportOpen()) reportOpened = true;
    await closeReport();
    attempts++;
    await clickDeal();
    const after = await probe();
    if (await reportOpen()) reportOpened = true;
    if (roundStarted(before, after)) return { started: true, attempts, reportOpened };
    if (!reportOpened) break;
  }
  return { started: false, attempts, reportOpened };
}

/**
 * Per-round cross-check of what the player sees (stats vs bankroll vs hands).
 * before: { bank0, net0, rounds0, rec0 }; after: { bank1, net1, rounds1, rec1, handsN }.
 * Returns [{ issue, detail }]; the conditions are the UI playtest's own.
 */
function crossCheck({ round, before, after, msg, reportOpened }) {
  const { bank0, net0, rounds0, rec0 } = before;
  const { bank1, net1, rounds1, rec1, handsN } = after;
  const delta = bank1 - bank0;
  const out = [];
  if (Math.abs(delta - (net1 - net0)) > 1e-9) out.push({ issue: 'stats Net change != bankroll change', detail: { round, delta, statsDelta: net1 - net0, bank0, bank1, msg, reportOpened } });
  if (rounds1 !== rounds0 + 1) out.push({ issue: 'stats Rounds did not increment by 1', detail: { round, rounds0, rounds1, bank0, bank1, msg, reportOpened } });
  if (rec1 - rec0 !== handsN) out.push({ issue: 'W-L-P did not grow by number of hands', detail: { round, hands: handsN, grew: rec1 - rec0, bank0, bank1, msg, reportOpened } });
  return out;
}

module.exports = { roundStarted, dealRound, crossCheck };
