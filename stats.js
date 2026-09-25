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

  const api = { emptyStats, recordRound, winRate, parseStats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
