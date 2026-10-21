/**
 * Accessibility helpers. Pure and DOM-free (window.BlackjackA11y in the
 * browser, module.exports under Node).
 */
(function (root) {
  'use strict';

  const SUIT_NAME = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };
  const RANK_NAME = { A: 'ace', J: 'jack', Q: 'queen', K: 'king' };

  /** "king of clubs", "10 of hearts", or "a face-down card". */
  function cardName(card) {
    if (!card) return 'a face-down card';
    return `${RANK_NAME[card.rank] || card.rank} of ${SUIT_NAME[card.suit]}`;
  }

  /**
   * One sentence per card, in the order they were placed, for a screen
   * reader's live region. Each placement is {who, card, kind}: `who` is
   * "You", "Hand 2" or "Dealer"; `card` is null while face down; `kind` is
   * 'dealt' or 'flip' (the dealer turning over the hole card).
   */
  function dealAnnouncement(placements) {
    return placements.map(({ who, card, kind }) => (kind === 'flip'
      ? `Dealer turns over ${cardName(card)}.`
      : `${who}: ${cardName(card)}.`)).join(' ');
  }

  /** WCAG relative luminance of a #rrggbb colour. */
  function luminance(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
  function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  /**
   * Where keyboard focus should go after a render. Returns 'actions' (the
   * first action you can take), 'next' (Rebet, else Deal) or null (leave it).
   * Keyed by round, not just phase, so a round that ends on the deal (a
   * blackjack) still moves focus even though the phase was already 'done'.
   *   phase, round        - the game now
   *   focused             - {phase, round} focus was last managed for
   *   focusUsable         - is the focused element still a usable control?
   */
  function focusTarget({ phase, round, focused = {}, focusUsable = false }) {
    if (phase === 'player' || phase === 'insurance') {
      const fresh = focused.phase !== phase || focused.round !== round;
      return fresh || !focusUsable ? 'actions' : null;
    }
    if (phase === 'done') {
      const fresh = focused.phase !== 'done' || focused.round !== round;
      return fresh || !focusUsable ? 'next' : null;
    }
    return null;
  }

  const api = { focusTarget, cardName, dealAnnouncement, luminance, contrastRatio };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackA11y = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
