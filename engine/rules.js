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
 *
 * F17 rule variants, each an adjustment from tools/house_edge.js (the same
 * solver, so they are consistent with the base): European no hole card
 * (ENHC: no peek, a dealer blackjack takes doubles and splits too; OBO
 * limits that to the original bet, which plays exactly like the peek
 * game), doubling on hard 9-11 or 10-11 only, and resplitting aces (RSA,
 * one extra split valued). They agree with Wizard of Odds' rule-variation
 * figures to within a few hundredths of a percent.
 */
(function (root) {
  'use strict';

  const DECKS = [1, 2, 6, 8];
  const DEFAULT_RULES = Object.freeze({
    decks: 6, h17: false, payout: 1.5, das: true, lateSurrender: true, penetration: 0.75,
    rsa: false, enhc: false, obo: false, doubleOn: 'any',
  });
  const DOUBLE_ON = ['any', '9-11', '10-11'];
  const PEN_MIN = 0.5;
  const PEN_MAX = 0.85;

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
  // Percentage points each F17 variant adds for the house, [decks][h17][das].
  const ENHC = {
    1: [[0.105, 0.107], [0.111, 0.112]], 2: [[0.104, 0.105], [0.11, 0.111]],
    6: [[0.108, 0.109], [0.109, 0.11]], 8: [[0.108, 0.11], [0.108, 0.11]],
  };
  const DOUBLE_9_11 = {
    1: [[0.135, 0.144], [0.145, 0.154]], 2: [[0.104, 0.112], [0.114, 0.121]],
    6: [[0.089, 0.095], [0.098, 0.105]], 8: [[0.087, 0.093], [0.097, 0.103]],
  };
  const DOUBLE_10_11 = {
    1: [[0.267, 0.291], [0.276, 0.299]], 2: [[0.206, 0.225], [0.214, 0.234]],
    6: [[0.173, 0.189], [0.181, 0.198]], 8: [[0.17, 0.185], [0.178, 0.194]],
  };
  // Percentage points the house gives up when aces may be resplit, [decks].
  const RSA = { 1: 0.03, 2: 0.049, 6: 0.061, 8: 0.063 };

  /** Fill in and check saved settings; anything invalid falls back to the default. */
  function normalizeRules(raw) {
    const r = { ...DEFAULT_RULES };
    if (!raw || typeof raw !== 'object') return r;
    if (DECKS.includes(raw.decks)) r.decks = raw.decks;
    if (raw.payout === 1.5 || raw.payout === 1.2) r.payout = raw.payout;
    for (const k of ['h17', 'das', 'lateSurrender', 'rsa', 'enhc', 'obo']) if (typeof raw[k] === 'boolean') r[k] = raw[k];
    if (!r.enhc) r.obo = false; // OBO only means something without a hole card
    if (DOUBLE_ON.includes(raw.doubleOn)) r.doubleOn = raw.doubleOn;
    // Cut card from 50% to 85% of the shoe, in 5% steps.
    if (Number.isFinite(raw.penetration) && raw.penetration >= PEN_MIN - 1e-9 && raw.penetration <= PEN_MAX + 1e-9) {
      r.penetration = Math.round(raw.penetration * 20) / 20;
    }
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
    const i = [r.h17 ? 1 : 0, r.das ? 1 : 0];
    if (r.enhc && !r.obo) edge += ENHC[r.decks][i[0]][i[1]];
    if (r.doubleOn === '9-11') edge += DOUBLE_9_11[r.decks][i[0]][i[1]];
    if (r.doubleOn === '10-11') edge += DOUBLE_10_11[r.decks][i[0]][i[1]];
    if (r.rsa) edge -= RSA[r.decks];
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
      `${doubleText(r)}, ${r.das ? 'also after a split' : 'not after a split'}`,
      `Split pairs up to 4 hands${r.rsa ? ', aces too' : ''}`,
      `Cut card at ${Math.round(r.penetration * 100)}%`,
    ];
    const second = [
      ...(r.enhc ? [r.obo
        ? 'No hole card: a dealer blackjack takes only your original bet (OBO)'
        : 'No hole card: a dealer blackjack takes doubles and splits too'] : []),
      'Insurance pays 2:1',
      r.lateSurrender ? 'Late surrender returns half your bet' : 'No surrender',
      edgeText(r),
    ];
    return [first.join(' · '), second.join(' · ')];
  }

  /** "Double on any two cards" / "Double on hard 9, 10 or 11". */
  function doubleText(r) {
    if (r.doubleOn === '9-11') return 'Double on hard 9, 10 or 11';
    if (r.doubleOn === '10-11') return 'Double on hard 10 or 11';
    return 'Double on any two cards';
  }

  /** Main-game payouts for these rules, as [what, pays] rows. */
  function payoutRows(rules) {
    const r = normalizeRules(rules);
    const rows = [
      ['Win', '1:1'],
      ['Blackjack', r.payout === 1.5 ? '3:2' : '6:5'],
      ['21 after a split', '1:1 (not blackjack)'],
      ['Push (tie)', 'Bet returned'],
      ['Insurance (dealer shows an ace)', 'Costs half your bet, pays 2:1'],
    ];
    if (r.payout === 1.5) rows.push(['Even money (your blackjack vs an ace, one spot)', '1:1 now']);
    rows.push(['Late surrender', r.lateSurrender ? 'Half your bet back' : 'Not offered']);
    const dbl = doubleText(r).replace(/^Double on a/, 'A').replace(/^Double on h/, 'H');
    rows.push(['Double down', `${dbl}, ${r.das ? 'also after a split' : 'not after a split'}`]);
    rows.push(['Split aces', r.rsa ? 'One card each; aces may be split again' : 'One card each, no resplit']);
    if (r.enhc) {
      rows.push(['Dealer blackjack (no hole card)', r.obo ? 'You lose only your original bet' : 'You lose doubles and splits too']);
    }
    return rows;
  }

  const api = { DOUBLE_ON, PEN_MIN, PEN_MAX, payoutRows, DECKS, DEFAULT_RULES, normalizeRules, houseEdge, edgeText, describe, sameRules };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
