/**
 * Side bets: Perfect Pairs (your first two cards) and 21+3 (your first two
 * cards plus the dealer's up card). Pure and DOM-free
 * (window.BlackjackSideBets in the browser, module.exports under Node).
 *
 * Pay tables are the common ones:
 *   Perfect Pairs  perfect pair 25:1 · colored pair 12:1 · mixed pair 6:1
 *   21+3           suited trips 100:1 · straight flush 40:1 ·
 *                  three of a kind 30:1 · straight 10:1 · flush 5:1
 * houseEdge() computes the exact edge for a fresh shoe by enumeration.
 */
(function (root) {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const RED = new Set(['♥', '♦']);

  const BETS = {
    pairs: { name: 'Perfect Pairs' },
    t213: { name: '21+3' },
  };
  const PAYS = {
    pairs: { 'perfect pair': 25, 'colored pair': 12, 'mixed pair': 6 },
    t213: { 'suited trips': 100, 'straight flush': 40, 'three of a kind': 30, straight: 10, flush: 5 },
  };

  /** Winning Perfect Pairs hand for two cards, or null. */
  function pairsHand([a, b]) {
    if (a.rank !== b.rank) return null;
    if (a.suit === b.suit) return 'perfect pair';
    if (RED.has(a.suit) === RED.has(b.suit)) return 'colored pair';
    return 'mixed pair';
  }

  /** Ranks in order; an ace can be low (A-2-3) or high (Q-K-A). */
  function isStraight(cards) {
    const idx = cards.map((c) => RANKS.indexOf(c.rank)).sort((x, y) => x - y);
    if (new Set(idx).size !== 3) return false;
    if (idx[2] - idx[0] === 2) return true;
    return idx[0] === 0 && idx[1] === 11 && idx[2] === 12; // Q-K-A
  }

  /** Winning 21+3 hand for your two cards and the dealer's up card, or null. */
  function t213Hand(cards) {
    const flush = cards.every((c) => c.suit === cards[0].suit);
    const trips = cards.every((c) => c.rank === cards[0].rank);
    if (trips && flush) return 'suited trips';
    const straight = isStraight(cards);
    if (straight && flush) return 'straight flush';
    if (trips) return 'three of a kind';
    if (straight) return 'straight';
    if (flush) return 'flush';
    return null;
  }

  /**
   * Settle a side bet. `cards` is your first two cards (+ the up card for
   * 21+3). Returns {bet, stake, win, odds, net}.
   */
  function settleSide(bet, stake, cards) {
    const win = bet === 'pairs' ? pairsHand(cards.slice(0, 2)) : t213Hand(cards.slice(0, 3));
    const odds = win ? PAYS[bet][win] : 0;
    return { bet, stake, win, odds, net: win ? stake * odds : -stake };
  }

  const houseEdgeCache = new Map();

  /** Exact house edge in percent for a fresh shoe of `decks` decks. */
  function houseEdge(bet, decks) {
    const key = `${bet}:${decks}`;
    if (houseEdgeCache.has(key)) return houseEdgeCache.get(key);
    const types = [];
    for (const suit of SUITS) for (const rank of RANKS) types.push({ rank, suit });
    const count = new Array(types.length).fill(decks);
    const n = decks * 52;
    let ev = 0;
    const take = bet === 'pairs' ? 2 : 3;
    const walk = (picked, p) => {
      if (picked.length === take) {
        const r = settleSide(bet, 1, picked.map((i) => types[i]));
        ev += p * r.net;
        return;
      }
      const left = n - picked.length;
      for (let i = 0; i < types.length; i++) {
        if (!count[i]) continue;
        const q = (p * count[i]) / left;
        count[i]--;
        picked.push(i);
        walk(picked, q);
        picked.pop();
        count[i]++;
      }
    };
    walk([], 1);
    const edge = Math.round(-ev * 10000) / 100;
    houseEdgeCache.set(key, edge);
    return edge;
  }

  const describeWin = (r) => `${BETS[r.bet].name}: ${r.win} pays ${r.odds}:1`;

  const api = { BETS, PAYS, pairsHand, t213Hand, settleSide, houseEdge, describeWin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackSideBets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
