/**
 * Write tools/charts.json: the solver's basic-strategy chart for every
 * rule set the settings panel offers. strategy.test.js checks strategy.js
 * against this file cell by cell.
 *
 * Rule sets: decks x S17/H17 x DAS x peek/ENHC x doubling (any two cards,
 * hard 9-11, hard 10-11). Resplitting aces and OBO don't change the chart
 * (aces are always split; with OBO a dealer blackjack costs only the
 * original bet, exactly as in the peek game), so they are not dimensions.
 * Takes about seven minutes.
 *
 * Usage: node --max-old-space-size=6144 tools/make_charts.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { charts, bestCode, ruleKey } = require('./solver.js');

const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
const out = {};
for (const decks of [1, 2, 6, 8]) {
  for (const h17 of [false, true]) {
    for (const das of [false, true]) {
      for (const doubleOn of ['any', '9-11', '10-11']) {
        const both = charts(decks, { h17, das, doubleOn });
        for (const enhc of [false, true]) {
          const key = ruleKey({ decks, h17, das, enhc, doubleOn });
          out[key] = {};
          for (const [row, cells] of Object.entries(both[enhc ? 'enhc' : 'peek'])) {
            out[key][row] = UPS.map((u) => bestCode(cells[u].ev)).join(' ');
          }
          process.stderr.write(`${key}\n`);
        }
      }
    }
  }
}
const file = path.join(__dirname, 'charts.json');
fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${file}`);
