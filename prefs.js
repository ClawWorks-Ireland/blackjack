/**
 * Display and sound preferences. Pure and DOM-free (window.BlackjackPrefs
 * in the browser, module.exports under Node).
 */
(function (root) {
  'use strict';

  const SPEEDS = ['auto', 'off', 'normal', 'fast'];
  const TABLES = ['green', 'blue', 'red', 'charcoal'];
  const BACKS = ['blue', 'red', 'green', 'black'];
  const DEFAULT_PREFS = Object.freeze({
    speed: 'auto', volume: 0.8, table: 'green', back: 'blue',
    wongOut: -1, wongIn: 1, // count trainer: sit out below wongOut, sit in at wongIn or more
  });

  /** Fill in and check saved preferences; anything invalid uses the default. */
  function normalizePrefs(raw) {
    const p = { ...DEFAULT_PREFS };
    if (!raw || typeof raw !== 'object') return p;
    if (SPEEDS.includes(raw.speed)) p.speed = raw.speed;
    if (TABLES.includes(raw.table)) p.table = raw.table;
    if (BACKS.includes(raw.back)) p.back = raw.back;
    if (Number.isFinite(raw.volume)) p.volume = Math.min(1, Math.max(0, raw.volume));
    if (Number.isInteger(raw.wongOut) && raw.wongOut >= -5 && raw.wongOut <= 2) p.wongOut = raw.wongOut;
    if (Number.isInteger(raw.wongIn) && raw.wongIn >= -2 && raw.wongIn <= 5) p.wongIn = raw.wongIn;
    if (p.wongIn < p.wongOut) { p.wongOut = DEFAULT_PREFS.wongOut; p.wongIn = DEFAULT_PREFS.wongIn; }
    return p;
  }

  /** 'auto' follows the system: no animation when it asks for reduced motion. */
  function effectiveSpeed(prefs, reducedMotion) {
    const s = normalizePrefs(prefs).speed;
    if (s === 'auto') return reducedMotion ? 'off' : 'normal';
    return s;
  }

  /** Deal stagger and the longest card animation, in milliseconds. */
  function timing(speed) {
    if (speed === 'off') return { step: 0, land: 0 };
    if (speed === 'fast') return { step: 90, land: 200 };
    return { step: 180, land: 400 };
  }

  const api = { SPEEDS, TABLES, BACKS, DEFAULT_PREFS, normalizePrefs, effectiveSpeed, timing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackPrefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
