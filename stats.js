/**
 * Session statistics. Pure and DOM-free (window.BlackjackStats in the
 * browser, module.exports under Node). Each hand counts separately, so a
 * split round adds one entry per hand. Win rate excludes pushes.
 */
(function (root) {
  'use strict';

  const WIN = new Set(['win', 'blackjack']);
  const LOSS = new Set(['lose', 'bust', 'surrender']);

  function emptyStats() {
    return {
      rounds: 0, hands: 0, wins: 0, losses: 0, pushes: 0, blackjacks: 0,
      net: 0, bestRound: 0, worstRound: 0, streak: 0, bestStreak: 0,
      hintsShown: 0, hintsFollowed: 0, movesScored: 0, movesCorrect: 0,
      countChecks: 0, countCorrect: 0,
    };
  }

  /** Return new stats after a finished round (does not mutate input). */
  function recordRound(stats, results, net) {
    const s = { ...stats };
    s.rounds++;
    for (const r of results) {
      s.hands++;
      if (WIN.has(r.outcome)) s.wins++;
      else if (LOSS.has(r.outcome)) s.losses++;
      else s.pushes++;
      if (r.outcome === 'blackjack') s.blackjacks++;
    }
    s.net += net;
    s.bestRound = Math.max(s.bestRound, net);
    s.worstRound = Math.min(s.worstRound, net);
    // Streak follows the round's net: positive extends a win streak,
    // negative extends a losing streak (stored as a negative number).
    if (net > 0) s.streak = s.streak > 0 ? s.streak + 1 : 1;
    else if (net < 0) s.streak = s.streak < 0 ? s.streak - 1 : -1;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    return s;
  }

  /** Record your move after a hint was shown (does not mutate input). */
  function recordHint(stats, followed) {
    return {
      ...stats,
      hintsShown: stats.hintsShown + 1,
      hintsFollowed: stats.hintsFollowed + (followed ? 1 : 0),
    };
  }

  /** Fraction of shown hints you followed, or null before any were shown. */
  function hintRate(stats) {
    return stats.hintsShown ? stats.hintsFollowed / stats.hintsShown : null;
  }

  /** Record one decision scored against basic strategy (does not mutate). */
  function recordMove(stats, correct) {
    return {
      ...stats,
      movesScored: stats.movesScored + 1,
      movesCorrect: stats.movesCorrect + (correct ? 1 : 0),
    };
  }

  /** Record one running-count check (does not mutate). */
  function recordCountCheck(stats, correct) {
    return {
      ...stats,
      countChecks: stats.countChecks + 1,
      countCorrect: stats.countCorrect + (correct ? 1 : 0),
    };
  }

  /** Fraction of count checks you got right, or null before any. */
  function countRate(stats) {
    return stats.countChecks ? stats.countCorrect / stats.countChecks : null;
  }

  /** Fraction of decisions matching basic strategy, or null before any. */
  function accuracy(stats) {
    return stats.movesScored ? stats.movesCorrect / stats.movesScored : null;
  }

  /** Wins as a fraction of decided hands, or null before any are decided. */
  function winRate(stats) {
    const decided = stats.wins + stats.losses;
    return decided ? stats.wins / decided : null;
  }

  /** Parse stored stats, falling back to empty on missing or bad data. */
  function parseStats(json) {
    const base = emptyStats();
    try {
      const data = JSON.parse(json);
      if (!data || typeof data !== 'object') return base;
      for (const key of Object.keys(base)) {
        if (Number.isFinite(data[key])) base[key] = data[key];
      }
    } catch (_) { /* corrupt storage: start fresh */ }
    return base;
  }

  const HISTORY_MAX = 20;
  const OUTCOMES = new Set([...WIN, ...LOSS, 'push']);

  /** Prepend a round summary, keeping only the newest `max` entries. */
  function addHistory(history, entry, max = HISTORY_MAX) {
    return [entry, ...history].slice(0, max);
  }

  const validHand = (h) => h && typeof h === 'object' && OUTCOMES.has(h.outcome) &&
    Number.isFinite(h.total) && typeof h.cards === 'string';
  const validEntry = (e) => e && typeof e === 'object' && Number.isFinite(e.round) &&
    Number.isFinite(e.net) && Number.isFinite(e.dealer) && typeof e.dealerCards === 'string' &&
    Array.isArray(e.hands) && e.hands.length > 0 && e.hands.every(validHand);

  /** Parse stored history, dropping malformed entries. */
  function parseHistory(json) {
    try {
      const data = JSON.parse(json);
      return Array.isArray(data) ? data.filter(validEntry).slice(0, HISTORY_MAX) : [];
    } catch (_) {
      return [];
    }
  }

  const api = {
    emptyStats, recordRound, winRate, parseStats, recordHint, hintRate, recordMove, accuracy, recordCountCheck, countRate, HISTORY_MAX, addHistory, parseHistory,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
