/**
 * Web Worker for the Bankroll dialog: runs bankroll.js's simulation off the
 * main thread so the table stays responsive.
 *
 * In:  { id, rules, ramp, rounds, seed }
 * Out: { id, progress: done } every 10,000 rounds, then { id, sim }.
 */
'use strict';

importScripts('../engine/sidebets.js', '../engine/blackjack.js', '../engine/strategy.js', '../engine/counting.js', '../engine/rules.js', '../engine/bankroll.js');

self.onmessage = (e) => {
  const { id, rules, ramp, rounds, seed } = e.data;
  try {
    const sim = self.BlackjackBankroll.simulate({
      rules, ramp, rounds, seed, onProgress: (done) => self.postMessage({ id, progress: done }),
    });
    self.postMessage({ id, sim });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
