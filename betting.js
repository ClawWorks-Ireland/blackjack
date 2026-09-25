/**
 * Bet validation. Pure and DOM-free (window.BlackjackBetting in the
 * browser, module.exports under Node). Bets are whole dollars, so the
 * largest bet is the bankroll rounded down, capped by the table maximum.
 */
(function (root) {
  'use strict';

  const { money } = typeof module !== 'undefined' && module.exports
    ? require('./format.js') : root.BlackjackFormat;

  /** Largest whole-dollar bet you can place right now. */
  function maxBet(bankroll, tableMax = Infinity) {
    return Math.max(0, Math.min(Math.floor(bankroll + 1e-9), tableMax));
  }

  /**
   * Check a bet before dealing. Returns a message formatted like the rest
   * of the UI, or null when the bet is fine.
   */
  function betError(bet, { bankroll, min = 1, max = Infinity }) {
    if (!Number.isFinite(bet) || bet <= 0) return 'Enter a bet to deal.';
    if (!Number.isInteger(bet)) return 'Bets are in whole dollars.';
    if (bet < min) return `The minimum bet is ${money(min)}.`;
    if (bet > max) return `The table maximum is ${money(max)}.`;
    const most = maxBet(bankroll, max);
    if (bet > most) return `You can bet up to ${money(most)}.`;
    return null;
  }

  const CHIPS = [1, 5, 25, 100, 500];

  /** Current bet box value as a whole-dollar amount (0 when empty/invalid). */
  function parseBet(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** Bet after adding a chip, or null if it would pass what you can bet. */
  function addChip(current, chip, { bankroll, max = Infinity }) {
    const next = parseBet(current) + chip;
    return next <= maxBet(bankroll, max) ? next : null;
  }

  /**
   * Amount for "Rebet" (factor 1) or "Rebet x2" (factor 2), or null when
   * there is no previous bet or the amount isn't allowed right now.
   */
  function rebetAmount(lastBet, factor, limits) {
    if (!(lastBet > 0)) return null;
    const amount = lastBet * factor;
    return betError(amount, limits) ? null : amount;
  }

  const api = { CHIPS, maxBet, betError, parseBet, addChip, rebetAmount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackBetting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
