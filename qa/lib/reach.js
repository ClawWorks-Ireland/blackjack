'use strict';
/**
 * Reach the shoe report across fresh tables. No Playwright dependency: the
 * page operations are injected (like deal.js), so npm test covers the logic.
 */

const MAX_TABLES = 10;
const NO_REPORT_ROUNDS = 10;

/** 'no-report' only when the last table was not broke and had more than NO_REPORT_ROUNDS rounds. */
function classify({ broke, rounds }) {
  return !broke && rounds > NO_REPORT_ROUNDS ? 'no-report' : 'broke';
}

/**
 * ops (async): freshTable, closeTable(t), reportOpen(t), canDeal(t), isBroke(t),
 *   bankroll(t), deal(t, bet), playOut(t), waitReport(t, ms) -> bool
 * opts: betFor, minBankroll, maxTables, maxRoundsPerTable, waitMs
 * Returns { ok, table, tables, rounds, bankroll, broke, reason }.
 */
async function reachReport(ops, opts = {}) {
  const {
    betFor = () => 10,
    minBankroll = 1,
    maxTables = MAX_TABLES,
    maxRoundsPerTable = 40,
    waitMs = 1000,
  } = opts;
  let tables = 0;
  let rounds = 0;
  let bankroll = 0;
  let broke = false;
  while (tables < maxTables) {
    const table = await ops.freshTable();
    tables++;
    rounds = 0;
    broke = false;
    for (;;) {
      if (await ops.reportOpen(table)) {
        return { ok: true, table, tables, rounds, bankroll: await ops.bankroll(table), broke: false, reason: null };
      }
      bankroll = await ops.bankroll(table);
      if ((await ops.isBroke(table)) || bankroll < minBankroll) { broke = true; break; }
      if (rounds >= maxRoundsPerTable || !(await ops.canDeal(table))) break;
      await ops.deal(table, betFor(bankroll));
      rounds++;
      await ops.playOut(table);
      await ops.waitReport(table, waitMs);
    }
    if (!broke) break; // chips left, no report: another table would not help
    await ops.closeTable(table);
  }
  return { ok: false, table: null, tables, rounds, bankroll, broke, reason: classify({ broke, rounds }) };
}

module.exports = { reachReport, classify, MAX_TABLES, NO_REPORT_ROUNDS };
