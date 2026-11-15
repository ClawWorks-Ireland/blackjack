/**
 * Money formatting. Pure and DOM-free (window.BlackjackFormat in the
 * browser, module.exports under Node). Whole dollars show no cents
 * ($1,000); anything with cents shows two decimals ($1,002.50).
 */
(function (root) {
  'use strict';

  const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** Absolute amount as digits, rounded to the cent. */
  function digits(n) {
    const cents = Math.round(Math.abs(n) * 100);
    return cents % 100 === 0 ? WHOLE.format(cents / 100) : CENTS.format(cents / 100);
  }

  /** $1,002.50 or -$37.50. */
  function money(n) {
    const d = digits(n);
    return n < 0 && d !== '0' ? `-$${d}` : `$${d}`;
  }

  /** Like money() but with an explicit sign on gains: +$15, -$7.50, $0. */
  function signedMoney(n) {
    const d = digits(n);
    if (d === '0') return '$0';
    return n > 0 ? `+$${d}` : `-$${d}`;
  }

  /** percent(x, digits = 1) formats a fraction as a percentage string. */
  function percent(n, digits = 1) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const result = fmt.format(n * 100);
    // Always add % sign
    let out = result + '%';
    // Drop trailing ".0%" when there are no decimals (digits === 1 and value is whole)
    if (digits === 1 && result.endsWith('.0')) {
      out = result.slice(0, -2) + '%';
    }
    return out;
  }

  const api = { money, signedMoney, percent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
