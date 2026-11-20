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

module.exports = { roundStarted, dealRound };
