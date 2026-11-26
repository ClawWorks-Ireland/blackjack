'use strict';
/**
 * #189 slice 3: the seeded repro and the verdict of B109 AC6 ("the session report
 * has no grace window"), kept out of qa/b109_report_key_check.js so they can be
 * unit-tested without a browser (qa/lib/ac6.test.js).
 */

/**
 * A seed as web/app.js reads it from localStorage['blackjack.seed'] (Blackjack.parseSeed).
 * On a single-deck table, round 1 at $10 (decline insurance, otherwise stand) leaves
 * round 2 at $20 (Rebet x2) ending at the deal with no player input: a player natural,
 * and the dealer's up card is not an Ace, so there is no insurance prompt. That is the
 * deal where the old AC6 sequence (Enter closes the report, then x deals) saw
 * #stat-rounds go up by one within 150 ms.
 */
const AC6_SEED = 'b109-ac6-85';

/** The pass boolean of the AC6 check, unchanged from qa/b109_report_key_check.js. */
const ac6Verdict = (d) => d.rebet2Usable && d.dealUsable && d.opened && d.openAfterX &&
  d.inHandAfterX === false && d.bankAfterX === d.bankBefore &&
  d.inHandAfterEnter === false && d.bankAfterEnter === d.bankBefore && d.dealt === 0;

module.exports = { AC6_SEED, ac6Verdict };
