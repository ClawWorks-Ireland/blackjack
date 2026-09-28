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

  /**
   * True count to one decimal, rounded DOWN like the bet ramp and index
   * plays, so what you see is on the same side of every index as what is
   * used: 2.96 shows "+2.9" and bets as +2. "0.0", "-2.3".
   */
  function formatTrue(tc) {
    // Tenths come from the fraction above the floor, so the shown value can
    // never land on the other side of a whole number from Math.floor(tc).
    const whole = Math.floor(tc);
    const tenths = Math.min(9, Math.floor((tc - whole) * 10 + 1e-9)); // 1e-9 absorbs 0.3 * 10 = 2.999...
    const r = Math.round((whole + tenths / 10) * 10) / 10;
    const s = Math.abs(r).toFixed(1);
    return r > 0 ? `+${s}` : r < 0 ? `-${s}` : '0.0';
  }

  /** Parse a count guess like "+3", "3", "-2", " 0 ". Returns null if not a whole number. */
  function parseGuess(text) {
    const t = String(text).trim();
    if (!/^[+-]?\d+$/.test(t)) return null;
    return Number(t);
  }

  // --- Count-based advice ---

  /**
   * Index plays for Hi-Lo in a shoe game: the Illustrious 18 and the Fab 4
   * surrenders (Don Schlesinger, Blackjack Attack), S17 values; H17 changes below. Each entry
   * is [total, dealer up (11 = ace), play, index, sense]: make the play when
   * the true count, rounded down, is >= index ('at'), or < index ('below').
   * Otherwise basic strategy stands. Pair rows use the pair's card value.
   */
  const HARD = [
    [16, 10, 'stand', 0, 'at'], [15, 10, 'stand', 4, 'at'], [16, 9, 'stand', 5, 'at'],
    [12, 3, 'stand', 2, 'at'], [12, 2, 'stand', 3, 'at'],
    [11, 11, 'double', 1, 'at'], [10, 10, 'double', 4, 'at'], [10, 11, 'double', 4, 'at'],
    [9, 2, 'double', 1, 'at'], [9, 7, 'double', 3, 'at'],
    [13, 2, 'hit', -1, 'below'], [13, 3, 'hit', -2, 'below'],
    [12, 4, 'hit', 0, 'below'], [12, 5, 'hit', -2, 'below'], [12, 6, 'hit', -1, 'below'],
  ];
  const PAIRS = [[10, 5, 'split', 5, 'at'], [10, 6, 'split', 4, 'at']];
  const SURRENDERS = [
    [14, 10, 3, 'at'], [15, 9, 2, 'at'], [15, 11, 1, 'at'],
    [15, 10, 0, 'below'], // basic says surrender; below 0, don't
  ];
  // Where the dealer hits soft 17 (H17) three indices move (Schlesinger's
  // H17 tables): 11 vs A is a basic-strategy double, so hit only below -1;
  // 10 vs A doubles from +3; 15 vs A is a basic surrender, kept down to -1.
  const HARD_H17 = HARD.filter(([t, u]) => !(u === 11 && (t === 11 || t === 10))).concat([
    [11, 11, 'hit', -1, 'below'], [10, 11, 'double', 3, 'at'],
  ]);
  const SURRENDERS_H17 = SURRENDERS.filter(([t, u]) => !(t === 15 && u === 11)).concat([
    [15, 11, -1, 'below'], // basic H17 surrenders 15 vs A; below -1, don't
  ]);
  const INSURANCE_INDEX = 3;

  const upName = (up) => (up === 11 ? 'ace' : String(up));
  const applies = (tc, index, sense) => (sense === 'at' ? tc >= index : tc < index);
  const LABEL = { hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surrender' };

  /**
   * Count-adjusted play. Takes basic strategy's advice and the true count
   * and returns an index play when one applies, else `basic` unchanged.
   * Only moves you can actually make are suggested.
   */
  function countPlay(cards, upcard, allowed, basic, tc, rules = {}) {
    const h17 = !!rules.h17;
    const HARD_SET = h17 ? HARD_H17 : HARD;
    const SURR_SET = h17 ? SURRENDERS_H17 : SURRENDERS;
    const t = Math.floor(tc);
    const up = BJ.cardValue(upcard);
    const { total, soft } = BJ.handValue(cards);
    const vs = `vs dealer ${upName(up)} at true count ${formatTrue(tc)}`;
    const dev = (action, desc, index) => ({
      action, label: LABEL[action], deviation: true, index, basicLabel: basic.label,
      reason: `${desc} ${vs}, index ${signed(index)}`,
    });
    if (soft) return basic;
    const twoCards = cards.length === 2;
    const isPair = twoCards && cards[0].rank === cards[1].rank;

    if (allowed.canSurrender) {
      for (const [tot, u, index, sense] of SURR_SET) {
        if (tot !== total || u !== up) continue;
        const surrender = applies(t, index, sense) === (sense === 'at');
        if (surrender && basic.action !== 'surrender') return dev('surrender', `Hard ${total}`, index);
        if (!surrender && basic.action === 'surrender') {
          const alt = total >= 13 && up <= 6 ? 'stand' : 'hit';
          return dev(alt, `Hard ${total}`, index);
        }
      }
      if (basic.action === 'surrender') return basic;
    }

    if (isPair && allowed.canSplit) {
      for (const [v, u, play, index, sense] of PAIRS) {
        if (BJ.cardValue(cards[0]) === v && u === up && applies(t, index, sense) && basic.action !== play) {
          return dev(play, `Pair of ${cards[0].rank}s`, index);
        }
      }
    }

    for (const [tot, u, play, index, sense] of HARD_SET) {
      if (tot !== total || u !== up || !applies(t, index, sense)) continue;
      if (play === 'double' && !(allowed.canDouble && twoCards && BJ.canDoubleOn(cards, rules.doubleOn || 'any'))) continue;
      if (play === basic.action) return basic;
      return dev(play, `Hard ${total}`, index);
    }
    return basic;
  }

  /** Take insurance (or even money) once the true count reaches +3. */
  function countInsurance(tc, evenMoney = false) {
    const name = evenMoney ? 'even money' : 'insurance';
    if (Math.floor(tc) >= INSURANCE_INDEX) {
      return {
        action: 'insurance', label: evenMoney ? 'Even money' : 'Take insurance', deviation: true, index: INSURANCE_INDEX,
        reason: `True count ${formatTrue(tc)} is at least ${signed(INSURANCE_INDEX)}: the ${name} bet now pays on average`,
      };
    }
    return null; // basic strategy's "no" stands
  }

  /**
   * Bet ramp in units (1 unit = the table minimum), by true count rounded
   * down: below +2 bet 1 unit, then 2, 4, 8 and 12 units at +2, +3, +4
   * and +5 or more.
   */
  function betUnits(tc) {
    const t = Math.floor(tc);
    if (t < 2) return 1;
    if (t === 2) return 2;
    if (t === 3) return 4;
    if (t === 4) return 8;
    return 12;
  }

  /**
   * Suggested bet in dollars: units x your base unit. The unit is fixed
   * (it does not follow your last bet), defaults to the table minimum and
   * is never below it. Capped at the table maximum and what you can afford.
   */
  function suggestedBet(tc, { min, unit = min, max = Infinity, bankroll = Infinity }) {
    const base = Math.max(min, Math.floor(unit) || min);
    const afford = Math.floor(bankroll + 1e-9);
    return Math.max(0, Math.min(betUnits(tc) * base, max, afford));
  }

  /** The whole-number true count bets and plays use: "+2", "0", "-1". */
  const wholeTrue = (tc) => signed(Math.floor(tc));

  /** Every index play as chart cells: [{row, up, play, index, sense}]. */
  function indexPlays({ h17 = false } = {}) {
    const hard = (h17 ? HARD_H17 : HARD).map(([t, u, play, index, sense]) => ({ row: `hard ${t}`, up: u, play, index, sense }));
    const pairs = PAIRS.map(([v, u, play, index, sense]) => ({ row: `pair ${v}`, up: u, play, index, sense }));
    const surr = (h17 ? SURRENDERS_H17 : SURRENDERS).map(([t, u, index, sense]) => ({
      row: `hard ${t}`, up: u, play: sense === 'at' ? 'surrender' : 'no surrender', index, sense,
    }));
    return [...hard, ...pairs, ...surr];
  }

  const api = {
    indexPlays, wholeTrue, hiLo, countState, trueCount, signed, formatTrue, parseGuess, countPlay, countInsurance, betUnits, suggestedBet,
    INSURANCE_INDEX,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackCounting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
