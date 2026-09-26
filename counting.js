/**
 * Hi-Lo card counting. Pure and DOM-free (window.BlackjackCounting in the
 * browser, module.exports under Node).
 *
 * Hi-Lo tags: 2-6 count +1, 7-9 count 0, tens and aces count -1. A full
 * shoe sums to zero, so the running count of every card seen so far is
 * minus the sum of the cards still unseen. That lets the count be derived
 * from the game state alone: it resets with each new shoe and survives a
 * reload without being saved separately.
 */
(function (root) {
  'use strict';

  const BJ = typeof module !== 'undefined' && module.exports
    ? require('./blackjack.js') : root.Blackjack;

  /** Hi-Lo tag for one card: +1, 0 or -1. */
  function hiLo(card) {
    const v = BJ.cardValue(card);
    if (v >= 2 && v <= 6) return 1;
    if (v >= 7 && v <= 9) return 0;
    return -1;
  }

  const sum = (cards) => cards.reduce((n, c) => n + hiLo(c), 0);

  /**
   * What a counter at the table knows right now. The dealer's hole card is
   * unseen while it's face down, so it counts as still in the shoe.
   * @returns {{running, unseen, decksLeft, trueCount}}
   */
  function countState(game) {
    const live = game.phase === 'player' || game.phase === 'insurance';
    const hole = live && game.dealer.length > 1 ? [game.dealer[1]] : [];
    const unseen = game.shoe.length + hole.length;
    const running = 0 - (sum(game.shoe) + sum(hole)); // 0 - x avoids -0
    const decksLeft = unseen / 52;
    return { running, unseen, decksLeft, trueCount: trueCount(running, decksLeft) };
  }

  /** Running count per deck left. Under half a deck, divide by a half deck. */
  function trueCount(running, decksLeft) {
    return running / Math.max(0.5, decksLeft);
  }

  /** "+3", "0", "-2". */
  const signed = (n) => (n > 0 ? `+${n}` : String(n));

  /** True count to one decimal: "+1.5", "0.0", "-2.3". */
  function formatTrue(tc) {
    const r = Math.round(tc * 10) / 10;
    const s = Math.abs(r).toFixed(1);
    return r > 0 ? `+${s}` : r < 0 ? `-${s}` : '0.0';
  }

  /** Parse a count guess like "+3", "3", "-2", " 0 ". Returns null if not a whole number. */
  function parseGuess(text) {
    const t = String(text).trim();
    if (!/^[+-]?\d+$/.test(t)) return null;
    return Number(t);
  }

  const api = { hiLo, countState, trueCount, signed, formatTrue, parseGuess };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackCounting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
