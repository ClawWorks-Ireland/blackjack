/**
 * Training drills: strategy flashcards and a Hi-Lo count drill. Pure and
 * DOM-free (window.BlackjackDrill in the browser, module.exports under Node).
 * Drills never touch the bankroll or the table's stats.
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;
  const Strategy = node ? require('./strategy.js') : root.BlackjackStrategy;
  const Chart = node ? require('./chart.js') : root.BlackjackChart;
  const Counting = node ? require('./counting.js') : root.BlackjackCounting;

  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const TENS = ['10', 'J', 'Q', 'K'];
  const pick = (list, rng) => list[Math.floor(rng() * list.length)];
  const card = (rank, rng) => ({ rank, suit: pick(BJ.SUITS, rng) });
  const rankOf = (v, rng) => (v === 10 ? pick(TENS, rng) : v === 11 || v === 1 ? 'A' : String(v));

  /** A random two-card hand for a chart row (hard totals use varied pairs of cards). */
  function dealRow(row, rng) {
    const [kind, n] = [row.split(' ')[0], Number(row.split(' ')[1])];
    if (kind === 'pair') {
      const r = n === 10 ? pick(TENS, rng) : rankOf(n, rng);
      const first = card(r, rng);
      const suit = pick(BJ.SUITS.filter((x) => x !== first.suit), rng); // two different cards
      return [first, { rank: r, suit }];
    }
    if (kind === 'soft') return [card('A', rng), card(rankOf(n - 11, rng), rng)];
    // Hard: two different values (not a pair, no ace) that make n.
    const ways = [];
    for (let a = 2; a <= 10; a++) {
      const b = n - a;
      if (b >= 2 && b <= 10 && a < b) ways.push([a, b]);
    }
    if (n === 20) ways.push([10, 10]); // two tens of different rank
    const [a, b] = pick(ways, rng);
    const ra = rankOf(a, rng);
    let rb = rankOf(b, rng);
    while (a === 10 && b === 10 && rb === ra) rb = rankOf(10, rng);
    const hand = [card(ra, rng), card(rb, rng)];
    return rng() < 0.5 ? hand : hand.reverse();
  }

  /** Cells players find hard: soft doubles, splits, and stiff hands vs 2-A. */
  function isTricky(row, code) {
    const [kind, n] = [row.split(' ')[0], Number(row.split(' ')[1])];
    if (kind === 'soft') return code === 'D' || code === 'Ds';
    if (kind === 'pair') return code === 'P';
    return n >= 12 && n <= 16;
  }

  /**
   * Weights for every chart cell: 1, +2 for tricky cells, +3 per miss
   * (capped), so practice goes where it helps. Hard 5-8 are left out.
   */
  function cellWeights(rules, misses = {}) {
    const out = [];
    for (const g of Chart.buildChart(rules)) {
      for (const r of g.rows) {
        if (/^hard [5-8]$/.test(r.row)) continue;
        for (const { up, code } of r.cells) {
          const key = `${r.row}|${up}`;
          const w = 1 + (isTricky(r.row, code) ? 2 : 0) + 3 * Math.min(5, misses[key] || 0);
          out.push({ key, row: r.row, up, code, w });
        }
      }
    }
    return out;
  }

  /** Weighted random cell. */
  function pickCell(weights, rng) {
    const total = weights.reduce((s, c) => s + c.w, 0);
    let x = rng() * total;
    for (const c of weights) {
      x -= c.w;
      if (x < 0) return c;
    }
    return weights[weights.length - 1];
  }

  /**
   * A flashcard: hand, dealer up card, and (with counting on) a true count,
   * biased toward counts where index plays matter.
   */
  function nextCard(rules, { misses = {}, withCount = false, rng = Math.random } = {}) {
    const cell = pickCell(cellWeights(rules, misses), rng);
    const cards = dealRow(cell.row, rng);
    const upcard = card(rankOf(cell.up, rng), rng);
    const tc = withCount ? Math.round((rng() * 12 - 5) * 10) / 10 : null; // -5.0 .. +7.0
    return { key: cell.key, row: cell.row, cards, upcard, tc };
  }

  /** The right answer for a flashcard under the active rules. */
  function expected(flash, rules) {
    const r = { ...Strategy.DEFAULT_RULES, lateSurrender: true, ...rules };
    const allowed = { canDouble: true, canSplit: true, canSurrender: !!r.lateSurrender };
    const basic = Strategy.recommend(flash.cards, flash.upcard, allowed, r);
    if (flash.tc === null || flash.tc === undefined) return basic;
    return Counting.countPlay(flash.cards, flash.upcard, allowed, basic, flash.tc, r);
  }

  /** Score an answer ('hit', 'stand', 'double', 'split', 'surrender'). */
  function check(flash, answer, rules) {
    const want = expected(flash, rules);
    return { correct: want.action === answer, want };
  }

  /** Running tally: {answered, right, streak, best, startedAt}. */
  const emptyTally = (now = 0) => ({ answered: 0, right: 0, streak: 0, best: 0, startedAt: now });
  function tally(t, correct) {
    const streak = correct ? t.streak + 1 : 0;
    return { ...t, answered: t.answered + 1, right: t.right + (correct ? 1 : 0), streak, best: Math.max(t.best, streak) };
  }
  /** Cards answered per minute since the drill started. */
  const perMinute = (t, now) => (now > t.startedAt ? (t.answered * 60000) / (now - t.startedAt) : 0);

  /** Count drill: N cards from a freshly shuffled deck, and their Hi-Lo total. */
  function countDeal(n = 52, rng = Math.random, system = 'hilo') {
    const cards = BJ.shuffle(BJ.createShoe(Math.ceil(n / 52)), rng).slice(0, n);
    return { cards, answer: cards.reduce((s, c) => s + Counting.tagOf(c, system), 0) };
  }

  const COUNT_TARGET_SECONDS = 25; // the usual goal for a full deck

  /**
   * Count-drill clock. Which card is showing comes from the time played so
   * far (card i is due at start + i * every), never from counting timer
   * ticks, so a late or throttled tick can't stretch the drill. Time while
   * paused (the tab was hidden) doesn't count toward the pace.
   *
   *   const clock = countClock(52, 500); clock.start(now);
   *   clock.card(now)    -> index of the card to show (n once all are shown)
   *   clock.nextIn(now)  -> ms until the next card is due
   *   clock.pause(now) / clock.resume(now); clock.elapsed(now) -> ms played
   */
  function countClock(n, every) {
    let startedAt = null;
    let pausedAt = null;
    let pausedTotal = 0;
    const elapsed = (now) => {
      if (startedAt === null) return 0;
      const end = pausedAt === null ? now : pausedAt;
      return Math.max(0, end - startedAt - pausedTotal);
    };
    return {
      start(now) { startedAt = now; pausedAt = null; pausedTotal = 0; },
      pause(now) { if (startedAt !== null && pausedAt === null) pausedAt = now; },
      resume(now) {
        if (pausedAt === null) return;
        pausedTotal += now - pausedAt;
        pausedAt = null;
      },
      get paused() { return pausedAt !== null; },
      elapsed,
      card: (now) => Math.min(n, Math.floor(elapsed(now) / every)),
      nextIn: (now) => every - (elapsed(now) % every),
    };
  }

  const api = {
    dealRow, isTricky, cellWeights, pickCell, nextCard, expected, check,
    emptyTally, tally, perMinute, countDeal, countClock, COUNT_TARGET_SECONDS,
  };
  if (node) module.exports = api;
  else root.BlackjackDrill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
