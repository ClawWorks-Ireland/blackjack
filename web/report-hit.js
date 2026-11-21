/**
 * Which deal control a click in the shoe report's grace window was aimed at.
 * Pure and DOM-free (window.BlackjackReportHit in the browser, module.exports under Node).
 */
(function (root) {
  'use strict';

  /**
   * `controls` is [{ id, rect: {left, top, right, bottom}, enabled, visible }] in priority order.
   * Returns the first enabled, visible control whose rect contains (x, y), edges inclusive, else null.
   */
  function dealControlAt(x, y, controls) {
    for (const c of controls) {
      if (!c.enabled || !c.visible) continue;
      const r = c.rect;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return c;
    }
    return null;
  }

  const api = { dealControlAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BlackjackReportHit = api;
}(typeof window !== 'undefined' ? window : globalThis));
