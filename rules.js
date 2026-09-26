/**
 * Table-rule settings: the options the settings panel offers, validation
 * of saved settings, a plain-English description, and the house edge.
 * Pure and DOM-free (window.BlackjackRules in the browser, module.exports
 * under Node).
 *
 * House edge = expected loss per initial bet playing basic strategy.
 * The base figures (no surrender, 3:2) are Wizard of Odds' total-dependent
 * table for exactly these rules: split to 4 hands, no resplitting aces,
 * one card on split aces, dealer peeks
 * (wizardofodds.com/games/blackjack/appendix/15/). The late-surrender and
 * 6:5 adjustments come from tools/house_edge.js; its 6:5 figure (-1.36%
 * at 6 decks) agrees with Wizard's rule-variation table (-1.39%).
 *
 * The game deals to a cut card at 75% and shuffles only between rounds,
 * which costs the player a little more than a fresh shuffle every hand.
 * CUT_CARD is that extra cost, measured by simulating the game itself
 * (about 60 million rounds per rule set, coach's play, shipped shoe).
 * It is largest with few decks. houseEdge() includes it by default.
 */
(function (root) {
  'use strict';

  const DECKS = [1, 2, 6, 8];
  const DEFAULT_RULES = Object.freeze({ decks: 6, h17: false, payout: 1.5, das: true, lateSurrender: true });

  // Percent, [decks][h17 ? 1 : 0][das ? 1 : 0].
  const BASE = {
    1: [[-0.0026, -0.1442], [0.1881, 0.0438]],
    2: [[0.335, 0.1923], [0.5365, 0.3911]],
    6: [[0.548, 0.4062], [0.7629, 0.6184]],
    8: [[0.5744, 0.4329], [0.7911, 0.6468]],
  };
  // Percentage points the house gives up with late surrender, [decks][h17].
  const SURRENDER = { 1: [0.017, 0.031], 2: [0.048, 0.063], 6: [0.073, 0.088], 8: [0.076, 0.092] };
  // Percentage points 6:5 blackjack adds for the house.
  const SIX_FIVE = { 1: 1.395, 2: 1.373, 6: 1.36, 8: 1.358 };
  // Percentage points the 75% cut card adds for the house (simulated, SE ~0.01-0.02).
  const CUT_CARD = { 1: 0.13, 2: 0.07, 6: 0.03, 8: 0.03 };

  /** Fill in and check saved settings; anything invalid falls back to the default. */
  function normalizeRules(raw) {
    const r = { ...DEFAULT_RULES };
    if (!raw || typeof raw !== 'object') return r;
    if (DECKS.includes(raw.decks)) r.decks = raw.decks;
    if (raw.payout === 1.5 || raw.payout === 1.2) r.payout = raw.payout;
    for (const k of ['h17', 'das', 'lateSurrender']) if (typeof raw[k] === 'boolean') r[k] = raw[k];
    return r;
  }

  /**
   * House edge in percent (negative means the player has the edge), as
   * this game deals it. Pass { cutCard: false } for the fresh-shuffle
   * figure published tables use.
   */
  function houseEdge(rules, { cutCard = true } = {}) {
    const r = normalizeRules(rules);
    let edge = BASE[r.decks][r.h17 ? 1 : 0][r.das ? 1 : 0];
    if (r.lateSurrender) edge -= SURRENDER[r.decks][r.h17 ? 1 : 0];
    if (r.payout === 1.2) edge += SIX_FIVE[r.decks];
    if (cutCard) edge += CUT_CARD[r.decks];
    return Math.round(edge * 100) / 100;
  }

  /** "House edge 0.33%" or "Player edge 0.16%". */
  function edgeText(rules) {
    const e = houseEdge(rules);
    return e < 0 ? `Player edge ${(-e).toFixed(2)}%` : `House edge ${e.toFixed(2)}%`;
  }

  const sameRules = (a, b) => {
    const x = normalizeRules(a);
    const y = normalizeRules(b);
    return Object.keys(DEFAULT_RULES).every((k) => x[k] === y[k]);
  };

  /** Two lines for the table header. */
  function describe(rules) {
    const r = normalizeRules(rules);
    const first = [
      r.decks === 1 ? 'Single deck' : `${r.decks} decks`,
      r.h17 ? 'Dealer hits soft 17' : 'Dealer stands on all 17s',
      `Blackjack pays ${r.payout === 1.5 ? '3:2' : '6:5'}`,
      r.das ? 'Double on any two cards, also after a split' : 'Double on any two cards, not after a split',
      'Split pairs up to 4 hands',
    ];
    const second = [
      'Insurance pays 2:1',
      r.lateSurrender ? 'Late surrender returns half your bet' : 'No surrender',
      edgeText(r),
    ];
    return [first.join(' · '), second.join(' · ')];
  }

  const api = { DECKS, DEFAULT_RULES, normalizeRules, houseEdge, edgeText, describe, sameRules };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
