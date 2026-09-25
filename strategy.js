/**
 * Basic strategy for the table's rules: 1, 2, 6 or 8 decks, dealer stands
 * or hits soft 17, double after split on or off, late surrender on or off.
 * Pure and DOM-free (window.BlackjackStrategy in the browser,
 * module.exports under Node).
 *
 * The chart is total-dependent, as printed casino charts are. It was
 * derived with tools/solver.js (exact remaining-deck EVs weighted over
 * every two-card hand), which reproduces Wizard of Odds' published
 * 4-8 deck charts for S17 and H17. strategy.test.js checks every cell for
 * every rule set against tools/charts.json.
 *
 * recommend() returns the best move among those actually available, so a
 * "double" hand falls back to hit (or stand) when doubling isn't allowed,
 * and an unsplittable pair plays as its total.
 */
(function (root) {
  'use strict';

  const BJ = typeof module !== 'undefined' && module.exports
    ? require('./blackjack.js') : root.Blackjack;

  const LABEL = {
    hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surrender',
  };
  const DEFAULT_RULES = { decks: 6, h17: false, das: true };

  /** Dealer upcard as 2-11 (ace = 11, tens and faces = 10). */
  const upValue = (card) => BJ.cardValue(card);
  const upName = (up) => (up === 11 ? 'ace' : String(up));
  const inRange = (up, lo, hi) => up >= lo && up <= hi;

  /** What to do with a splittable pair: 'split', 'stand', or null to play the total. */
  function pairMove(v, up, { decks, h17, das }) {
    const few = decks <= 2; // single and double deck
    switch (v) {
      case 11: case 8: return 'split';
      case 10: return 'stand';
      case 9:
        if (up === 7 || up === 10) return 'stand';
        if (up === 11) return decks === 1 && h17 && das ? 'split' : 'stand';
        return 'split';
      case 7:
        if (up <= 7) return 'split';
        if (up === 8) return das && few ? 'split' : null;
        if (up === 10 && decks === 1) return 'stand'; // surrender first if allowed
        return null;
      case 6:
        if (das) return up <= (few ? 7 : 6) ? 'split' : null;
        return inRange(up, few ? 2 : 3, 6) ? 'split' : null;
      case 4:
        if (!das) return null; // plays as hard 8
        return inRange(up, decks === 1 ? 4 : 5, 6) ? 'split' : null;
      case 3:
        if (!das) return inRange(up, 4, 7) ? 'split' : null;
        return up <= (decks === 1 ? 8 : 7) ? 'split' : null;
      case 2:
        if (!das) return inRange(up, decks === 1 ? 3 : 4, 7) ? 'split' : null;
        return up <= 7 ? 'split' : null;
      default: return null; // 5,5 plays as hard 10
    }
  }

  function softMove(total, up, { decks, h17 }) {
    if (total >= 20) return 'stand';
    if (total === 19) return up === 6 && (h17 || decks === 1) ? 'double-or-stand' : 'stand';
    if (total === 18) {
      if (inRange(up, 3, 6)) return 'double-or-stand';
      if (up === 2) return h17 && decks > 1 ? 'double-or-stand' : 'stand';
      if (up <= 8) return 'stand';
      if (up === 11) return decks === 1 && !h17 ? 'stand' : 'hit';
      return 'hit';
    }
    if (total === 17) return inRange(up, decks === 1 ? 2 : 3, 6) ? 'double' : 'hit';
    if (total >= 15) return inRange(up, 4, 6) ? 'double' : 'hit';
    if (total === 14) return inRange(up, decks === 1 || (decks === 2 && h17) ? 4 : 5, 6) ? 'double' : 'hit';
    if (total === 13) return inRange(up, decks === 1 ? 4 : 5, 6) ? 'double' : 'hit';
    return 'hit'; // soft 12 = an unsplit pair of aces
  }

  function hardMove(total, up, { decks, h17 }) {
    if (total >= 17) return 'stand';
    if (total >= 13) return up <= 6 ? 'stand' : 'hit';
    if (total === 12) return inRange(up, 4, 6) ? 'stand' : 'hit';
    if (total === 11) return up <= 10 || decks <= 2 || h17 ? 'double' : 'hit';
    if (total === 10) return up <= 9 ? 'double' : 'hit';
    if (total === 9) return inRange(up, decks <= 2 ? 2 : 3, 6) ? 'double' : 'hit';
    if (total === 8) return decks === 1 && inRange(up, 5, 6) ? 'double' : 'hit';
    return 'hit';
  }

  /** Late surrender spots. `pairOf` is the pair's value when it could be split. */
  function shouldSurrender(total, soft, up, pairOf, { decks, h17, das }) {
    if (soft) return false;
    if (pairOf === 8) return up === 11 && h17 && (decks > 2 || (decks === 2 && !das));
    if (pairOf === 7) return decks === 1 && (up === 10 || (up === 11 && h17));
    if (pairOf) return false;
    const shoe = decks > 2;
    if (total === 17) return h17 && up === 11;
    if (total === 16) return up === 10 || up === 11 || (up === 9 && shoe);
    if (total === 15) return (up === 10 && decks > 1) || (up === 11 && h17);
    return false;
  }

  /**
   * @param {Array} cards  the player's hand
   * @param {Object} upcard  the dealer's face-up card
   * @param {Object} allowed {canDouble, canSplit, canSurrender}
   * @param {Object} rules {decks, h17, das}
   * @returns {{action, label, reason}}
   */
  function recommend(cards, upcard, { canDouble = false, canSplit = false, canSurrender = false } = {},
    rules = DEFAULT_RULES) {
    const r = { ...DEFAULT_RULES, ...rules };
    const up = upValue(upcard);
    const { total, soft } = BJ.handValue(cards);
    const isPair = cards.length === 2 && cards[0].rank === cards[1].rank;
    const pairOf = isPair && canSplit ? BJ.cardValue(cards[0]) : 0;
    const vs = `vs dealer ${upName(up)}`;
    const done = (action, desc) => ({ action, label: LABEL[action], reason: `${desc} ${vs}` });

    if (canSurrender && shouldSurrender(total, soft, up, pairOf, r)) {
      return done('surrender', pairOf ? `Pair of ${cards[0].rank}s` : `Hard ${total}`);
    }

    if (pairOf) {
      const move = pairMove(pairOf, up, r);
      if (move === 'split') return done('split', `Pair of ${cards[0].rank}s`);
      if (move === 'stand') return done('stand', `Pair of ${cards[0].rank}s`);
    }

    const desc = soft ? `Soft ${total}` : `Hard ${total}`;
    let move = soft ? softMove(total, up, r) : hardMove(total, up, r);
    if (move === 'double-or-stand') move = canDouble ? 'double' : 'stand';
    if (move === 'double' && !canDouble) move = 'hit';
    return done(move, desc);
  }

  /** Basic strategy never takes insurance, including even money. */
  const insuranceAdvice = (evenMoney = false) => (evenMoney ? {
    action: 'no-insurance',
    label: 'No even money',
    reason: 'Even money is insurance on your blackjack: 3:2 is worth more on average',
  } : {
    action: 'no-insurance',
    label: 'No insurance',
    reason: 'Insurance loses money over time unless you count cards',
  });

  const api = { recommend, insuranceAdvice, DEFAULT_RULES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackStrategy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
