/**
 * Write ev-data.js: the solver's expected value of each play for every chart
 * cell under every rule set the game offers, so the browser can price a
 * mistake without running the solver. EVs are per unit bet, rounded to
 * 1/10000 and stored as integers. Peek-game EVs assume the dealer has
 * checked and has no blackjack; ENHC EVs include the dealer's blackjack.
 *
 * Rule sets differ by decks, H17, DAS, peek/ENHC and doubling. Surrender is
 * always -0.5 in the peek game, and the blackjack payout, OBO (plays as the
 * peek game) and resplitting aces don't change a decision's EV here, so none
 * of them is a dimension. Restricted doubling only changes the pair rows
 * (fewer doubles after a split), so those keys store just the pair rows;
 * ev.js takes the other rows from the any-two-cards table.
 *
 * Usage: node --max-old-space-size=6144 tools/make_ev.js   (about 7 minutes)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { charts, ruleKey } = require('./solver.js');

const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1]; // solver's ace is 1
const q = (x) => Math.round(x * 10000);
const data = {};
for (const decks of [1, 2, 6, 8]) {
  for (const h17 of [false, true]) {
    for (const das of [false, true]) {
      // Without DAS, doubling rules can't change a split, so only 'any' is needed.
      for (const doubleOn of das ? ['any', '9-11', '10-11'] : ['any']) {
        const both = charts(decks, { h17, das, doubleOn });
        for (const enhc of [false, true]) {
          const key = ruleKey({ decks, h17, das, enhc, doubleOn });
          data[key] = {};
          for (const [row, cells] of Object.entries(both[enhc ? 'enhc' : 'peek'])) {
            if (doubleOn !== 'any' && !row.startsWith('pair')) continue;
            const name = row === 'pair 1' ? 'pair 11' : row; // the game calls aces 11
            data[key][name] = UPS.map((u) => {
              const ev = cells[u].ev;
              const v = [q(ev.stand), q(ev.hit), ev.double === undefined ? null : q(ev.double)];
              if (ev.split !== undefined) v.push(q(ev.split));
              if (enhc) v.push(q(ev.surrender));
              return v;
            });
          }
          process.stderr.write(`${key}\n`);
        }
      }
    }
  }
}

const out = `/**
 * Expected value of each play per chart cell and rule set, from
 * tools/solver.js via tools/make_ev.js (generated: do not edit).
 * DATA[rules][row][up] = [stand, hit, double, split?, surrender (ENHC only)]
 * x 10000, up in 2..10, A. See tools/make_ev.js for which keys exist.
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
