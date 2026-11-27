'use strict';
/**
 * Money helpers for qa/b109_report_key_check.js (#233). No Playwright.
 * The page prints cents ($127.50, engine/format.js); the engine takes whole-dollar bets only.
 */

/** '$1,382.50' -> 1382.5. Text with no digit gives NaN, not 0. */
function parseMoney(text) {
  const kept = String(text).replace(/[^\d.]/g, '');
  if (!/\d/.test(kept)) return NaN;
  return Number(kept);
}

/** The largest whole-dollar bet within the cap and the bankroll. */
function wholeBet(cap, bank) {
  return Math.min(cap, Math.floor(bank));
}

module.exports = { parseMoney, wholeBet };
