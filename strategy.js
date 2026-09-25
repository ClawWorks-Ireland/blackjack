/**
 * Basic strategy for this table's rules: 6 decks, dealer stands on soft 17,
 * double after split allowed, late surrender. Pure and DOM-free
 * (window.BlackjackStrategy in the browser, module.exports under Node).
 *
 * recommend() returns the best move among those actually available, so a
 * "double" hand falls back to hit (or stand) when doubling isn't allowed.
 */
(function (root) {
  'use strict';

  const BJ = typeof module !== 'undefined' && module.exports
    ? require('./blackjack.js') : root.Blackjack;

  const LABEL = {
    hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surrender',
  };

  /** Dealer upcard as 2-11 (ace = 11, tens and faces = 10). */
  const upValue = (card) => BJ.cardValue(card);
  const upName = (up) => (up === 11 ? 'ace' : String(up));
  const inRange = (up, lo, hi) => up >= lo && up <= hi;

  function pairMove(rank, up) {
    const v = rank === 'A' ? 11 : BJ.cardValue({ rank });
    switch (v) {
      case 11: case 8: return 'split';
      case 10: return 'stand';
      case 9: return up === 7 || up >= 10 ? 'stand' : 'split';
      case 7: return up <= 7 ? 'split' : null;
      case 6: return up <= 6 ? 'split' : null;
      case 4: return up === 5 || up === 6 ? 'split' : null;
      case 3: case 2: return up <= 7 ? 'split' : null;
      default: return null; // 5,5 plays as hard 10
    }
  }

  function softMove(total, up) {
    if (total >= 19) return 'stand';
    if (total === 18) {
      // S17: stand vs 2. (Doubling soft 18 vs 2 is the H17 play.)
      if (inRange(up, 3, 6)) return 'double-or-stand';
      return up <= 8 ? 'stand' : 'hit';
    }
    if (total === 17) return inRange(up, 3, 6) ? 'double' : 'hit';
    if (total >= 15) return inRange(up, 4, 6) ? 'double' : 'hit';
    return inRange(up, 5, 6) ? 'double' : 'hit'; // soft 13-14 (soft 12 = A,A unsplit)
  }

  function hardMove(total, up) {
    if (total >= 17) return 'stand';
    if (total >= 13) return up <= 6 ? 'stand' : 'hit';
    if (total === 12) return inRange(up, 4, 6) ? 'stand' : 'hit';
    if (total === 11) return up <= 10 ? 'double' : 'hit';
    if (total === 10) return up <= 9 ? 'double' : 'hit';
    if (total === 9) return inRange(up, 3, 6) ? 'double' : 'hit';
    return 'hit';
  }

  /**
   * @param {Array} cards  the player's hand
   * @param {Object} upcard  the dealer's face-up card
   * @param {Object} allowed {canDouble, canSplit, canSurrender}
   * @returns {{action, label, reason}}
   */
  function recommend(cards, upcard, { canDouble = false, canSplit = false, canSurrender = false } = {}) {
    const up = upValue(upcard);
    const { total, soft } = BJ.handValue(cards);
    const isPair = cards.length === 2 && cards[0].rank === cards[1].rank;
    const vs = `vs dealer ${upName(up)}`;
    const done = (action, desc) => ({ action, label: LABEL[action], reason: `${desc} ${vs}` });

    // Late surrender: hard 16 vs 9/10/A, hard 15 vs 10. Never 8,8 (always split).
    const eights = isPair && cards[0].rank === '8';
    if (canSurrender && !soft && !eights &&
        ((total === 16 && up >= 9) || (total === 15 && up === 10))) {
      return done('surrender', `Hard ${total}`);
    }

    if (isPair && canSplit) {
      const move = pairMove(cards[0].rank, up);
      if (move === 'split') return done('split', `Pair of ${cards[0].rank}s`);
      if (move === 'stand') return done('stand', `Pair of ${cards[0].rank}s`);
    }

    const desc = soft ? `Soft ${total}` : `Hard ${total}`;
    let move = soft ? softMove(total, up) : hardMove(total, up);
    if (move === 'double-or-stand') move = canDouble ? 'double' : 'stand';
    if (move === 'double' && !canDouble) move = 'hit';
    return done(move, desc);
  }

  /** Basic strategy never takes insurance. */
  const insuranceAdvice = () => ({
    action: 'no-insurance',
    label: 'No insurance',
    reason: 'Insurance loses money over time unless you count cards',
  });

  const api = { recommend, insuranceAdvice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackStrategy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
