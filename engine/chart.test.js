const test = require('node:test');
const assert = require('node:assert/strict');
const Chart = require('./chart.js');
const { recommend } = require('./strategy.js');
const K = require('./counting.js');
const S = require('./stats.js');
const FIXTURE = require('./tools/charts.json');

const ACTION = { H: 'hit', S: 'stand', D: 'double', Ds: 'double', P: 'split', R: 'surrender', Rs: 'surrender', Rp: 'surrender' };
const card = (r) => ({ rank: r, suit: '♠' });
const upCard = (u) => card(u === 11 ? 'A' : String(u));

const RULE_SETS = [
  { decks: 6, h17: false, das: true, lateSurrender: true },
  { decks: 2, h17: true, das: true, lateSurrender: true },
  { decks: 8, h17: true, das: false, lateSurrender: false },
];

for (const rules of RULE_SETS) {
  test(`F12: every chart cell is the coach's advice (${rules.decks}D ${rules.h17 ? 'H17' : 'S17'} ${rules.das ? 'DAS' : 'noDAS'} ${rules.lateSurrender ? 'LS' : 'noLS'})`, () => {
    const wrong = [];
    for (const g of Chart.buildChart(rules)) {
      for (const r of g.rows) {
        for (const { up, code } of r.cells) {
          const coach = recommend(Chart.handFor(r.row), upCard(up),
            { canDouble: true, canSplit: true, canSurrender: rules.lateSurrender }, rules).action;
          if (coach !== ACTION[code]) wrong.push(`${r.label} vs ${up}: chart ${code}, coach ${coach}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });
}

test('F12: the chart matches the solver fixture cell for cell (with surrender)', () => {
  const FIX = { H: 'H', S: 'S', Dh: 'D', Ds: 'Ds', P: 'P', Rh: 'R', Rs: 'Rs', Rp: 'Rp' };
  for (const key of ['6-s17-das', '2-h17-nodas', '1-s17-das']) {
    const [d, s17, das] = key.split('-');
    const rules = { decks: Number(d), h17: s17 === 'h17', das: das === 'das', lateSurrender: true };
    const fixture = FIXTURE[key];
    for (const g of Chart.buildChart(rules)) {
      for (const r of g.rows) {
        const fixRow = r.row === 'pair 11' ? 'pair 1' : r.row;
        if (!fixture[fixRow]) continue;
        const codes = fixture[fixRow].split(' ');
        r.cells.forEach(({ code }, i) => assert.equal(code, FIX[codes[i]], `${key} ${r.row} col ${i}`));
      }
    }
  }
});

test('F12: rows and labels', () => {
  const [hard, soft, pairs] = Chart.buildChart({});
  assert.equal(hard.rows.length, 16);
  assert.deepEqual([hard.rows[0].label, soft.rows[0].label, soft.rows[7].label], ['5', 'A,2', 'A,9']);
  assert.deepEqual([pairs.rows[0].label, pairs.rows[9].label], ['2,2', 'A,A']);
  assert.equal(hard.rows[11].cells[9].code, 'R'); // 16 vs A surrenders
});

test('F12: hands map to their chart cell', () => {
  const up = upCard(3);
  assert.equal(Chart.cellKey([card('10'), card('2')], up), 'hard 12|3');
  assert.equal(Chart.cellKey([card('A'), card('6')], up), 'soft 17|3');
  assert.equal(Chart.cellKey([card('8'), card('8')], up), 'pair 8|3');
  assert.equal(Chart.cellKey([card('8'), card('8')], up, false), 'hard 16|3');
  assert.equal(Chart.cellKey([card('A'), card('A')], upCard(11)), 'pair 11|11');
  assert.equal(Chart.cellKey([card('5'), card('4'), card('3')], up), 'hard 12|3');
});

test('F12: index marks come from the coach\'s index plays', () => {
  const marks = Chart.indexMarks(K.indexPlays());
  assert.equal(marks.get('hard 12|3'), 'Stand at +2 or more');
  assert.equal(marks.get('hard 16|10'), 'Stand at 0 or more');
  assert.equal(marks.get('pair 10|6'), 'Split at +4 or more');
  assert.ok(Chart.indexMarks(K.indexPlays({ h17: true })).get('hard 11|11').startsWith('Hit below -1'));
});

test('F12: misses are counted per cell, saved, and ranked', () => {
  let s = S.recordMiss(S.emptyStats(), 'hard 12|3');
  s = S.recordMiss(s, 'hard 12|3');
  s = S.recordMiss(s, 'soft 18|9');
  const back = S.parseStats(JSON.stringify({ ...s, misses: { ...s.misses, 'evil|x': 5, 'hard 9|2': -1 } }));
  assert.deepEqual(back.misses, { 'hard 12|3': 2, 'soft 18|9': 1 });
  assert.deepEqual(Chart.topMisses(back.misses).map((m) => [m.label, m.count]), [['12 vs 3', 2], ['A,7 vs 9', 1]]);
  assert.deepEqual(S.emptyStats().misses, {});
});

// --- F17: rule variants ---

const VARIANTS = [
  { decks: 6, h17: false, das: true, lateSurrender: true, enhc: true },
  { decks: 6, h17: false, das: true, lateSurrender: true, enhc: true, obo: true },
  { decks: 1, h17: true, das: true, lateSurrender: false, enhc: true },
  { decks: 6, h17: true, das: true, lateSurrender: true, doubleOn: '9-11' },
  { decks: 8, h17: false, das: true, lateSurrender: true, doubleOn: '10-11' },
  { decks: 1, h17: false, das: true, lateSurrender: true, doubleOn: '10-11', enhc: true },
  { decks: 6, h17: false, das: true, lateSurrender: true, rsa: true },
];
const label = (r) => `${r.decks}D ${r.h17 ? 'H17' : 'S17'}${r.enhc ? (r.obo ? ' ENHC+OBO' : ' ENHC') : ''}` +
  `${r.doubleOn ? ` D${r.doubleOn}` : ''}${r.rsa ? ' RSA' : ''}${r.lateSurrender ? ' LS' : ''}`;
const fixKey = (r) => `${r.decks}-${r.h17 ? 'h17' : 's17'}-${r.das ? 'das' : 'nodas'}` +
  `${r.enhc && !r.obo ? '-enhc' : ''}${r.doubleOn && r.doubleOn !== 'any' ? `-d${r.doubleOn.replace('-', '')}` : ''}`;

for (const rules of VARIANTS) {
  test(`F17: chart cells are the coach's advice and the solver's chart (${label(rules)})`, () => {
    const FIX = { H: 'H', S: 'S', Dh: 'D', Ds: 'Ds', P: 'P', Rh: 'R', Rs: 'Rs', Rp: 'Rp' };
    const NO_LS = { Rh: 'H', Rs: 'S', Rp: 'P' };
    const fixture = FIXTURE[fixKey(rules)];
    const wrong = [];
    for (const g of Chart.buildChart(rules)) {
      for (const r of g.rows) {
        const line = fixture[r.row === 'pair 11' ? 'pair 1' : r.row];
        const codes = line && line.split(' ');
        r.cells.forEach(({ up, code }, i) => {
          const coach = recommend(Chart.handFor(r.row), upCard(up),
            { canDouble: true, canSplit: true, canSurrender: rules.lateSurrender }, rules).action;
          if (coach !== ACTION[code]) wrong.push(`${r.label} vs ${up}: chart ${code}, coach ${coach}`);
          if (!codes || (r.row.startsWith('hard') && Number(r.row.split(' ')[1]) < 5)) return;
          const want = rules.lateSurrender ? FIX[codes[i]] : (NO_LS[codes[i]] || FIX[codes[i]]);
          if (code !== want) wrong.push(`${r.label} vs ${up}: chart ${code}, solver ${codes[i]}`);
        });
      }
    }
    assert.deepEqual(wrong, []);
  });
}

test('F17: ENHC changes the chart where a dealer blackjack would take the extra bet', () => {
  const peek = Chart.buildChart({ decks: 6, lateSurrender: true });
  const enhc = Chart.buildChart({ decks: 6, lateSurrender: true, enhc: true });
  const cell = (ch, row, up) => ch.flatMap((g) => g.rows).find((r) => r.row === row).cells.find((x) => x.up === up).code;
  assert.equal(cell(peek, 'hard 11', 10), 'D');
  assert.equal(cell(enhc, 'hard 11', 10), 'H');
  assert.equal(cell(enhc, 'pair 11', 11), 'H');
  assert.equal(cell(enhc, 'pair 8', 10), 'R');
  assert.equal(cell(Chart.buildChart({ decks: 6, lateSurrender: true, enhc: true, obo: true }), 'hard 11', 10), 'D', 'OBO plays like the peek game');
  const d1011 = Chart.buildChart({ decks: 6, lateSurrender: true, doubleOn: '10-11' });
  assert.equal(cell(d1011, 'hard 9', 4), 'H');
  assert.equal(cell(d1011, 'soft 18', 4), 'S');
  assert.equal(cell(d1011, 'hard 10', 4), 'D');
});
