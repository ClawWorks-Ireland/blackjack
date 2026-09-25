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

  const api = { maxBet, betError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackBetting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
