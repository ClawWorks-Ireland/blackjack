/**
 * Write ev.js: the solver's expected value of each play for every chart
 * cell under every rule set the game offers, so the browser can price a
 * mistake without running the solver. EVs are per unit bet (the dealer has
 * already peeked), rounded to 1/10000 and stored as integers.
 *
 * Rule sets differ by decks, H17 and DAS; surrender is always -0.5 and the
 * blackjack payout doesn't change any decision, so neither is a dimension.
 *
 * Usage: node --max-old-space-size=4096 tools/make_ev.js   (about 2 minutes)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chart } = require('./solver.js');

const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1]; // solver's ace is 1
const q = (x) => Math.round(x * 10000);
const data = {};
for (const decks of [1, 2, 6, 8]) {
  for (const h17 of [false, true]) {
    for (const das of [false, true]) {
      const key = `${decks}-${h17 ? 'h17' : 's17'}-${das ? 'das' : 'nodas'}`;
      const rows = chart(decks, { h17, das });
      data[key] = {};
      for (const [row, cells] of Object.entries(rows)) {
        const name = row === 'pair 1' ? 'pair 11' : row; // the game calls aces 11
        data[key][name] = UPS.map((u) => {
          const ev = cells[u].ev;
          const v = [q(ev.stand), q(ev.hit), q(ev.double)];
          if (ev.split !== undefined) v.push(q(ev.split));
          return v;
        });
      }
      process.stderr.write(`${key}\n`);
    }
  }
}

const out = `/**
 * Expected value of each play per chart cell and rule set, from
 * tools/solver.js via tools/make_ev.js (generated: do not edit).
 * DATA[rules][row][up] = [stand, hit, double, split?] x 10000, up in 2..10, A.
 */
(function (root) {
  'use strict';
  const DATA = ${JSON.stringify(data)};
  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  else root.BlackjackEVData = DATA;
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
fs.writeFileSync(path.join(__dirname, '..', 'ev-data.js'), out);
console.log(`wrote ev-data.js (${(out.length / 1024).toFixed(0)} KB)`);
