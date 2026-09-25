/**
 * Write tools/charts.json: the solver's basic-strategy chart for every
 * rule set the settings panel offers. strategy.test.js checks strategy.js
 * against this file cell by cell. Takes about two minutes.
 *
 * Usage: node --max-old-space-size=4096 tools/make_charts.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chart, bestCode } = require('./solver.js');

const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
const out = {};
for (const decks of [1, 2, 6, 8]) {
  for (const h17 of [false, true]) {
    for (const das of [false, true]) {
      const key = `${decks}-${h17 ? 'h17' : 's17'}-${das ? 'das' : 'nodas'}`;
      const rows = chart(decks, { h17, das });
      out[key] = {};
      for (const [row, cells] of Object.entries(rows)) {
        out[key][row] = UPS.map((u) => bestCode(cells[u].ev));
      }
      process.stderr.write(`${key}\n`);
    }
  }
}
const file = path.join(__dirname, 'charts.json');
fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${file}`);
