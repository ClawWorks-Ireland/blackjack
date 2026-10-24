#!/usr/bin/env node
/**
 * Scouted vs cold start (CLA-131). For each opponent style:
 *
 * 1. Scouting: the opponent ("Opponent") plays `--watch` hands against a
 *    regular (the default bot), and a scout records every hand from the public
 *    view only (agent/poker-history.js fromTable on view(null)): actions, and
 *    hole cards only at a showdown. The local model writes a note from it.
 * 2. Play: the LLM player with feedback plays the opponent in duplicate
 *    (agent/poker-bench.js), once starting from the scouting report and once
 *    cold, on the same deals.
 *
 *   node agent/poker-scout-bench.js run [--styles a,b] [--watch 300] [--pairs 100] [--seed scout]
 *   node agent/poker-scout-bench.js report
 *
 * Pairs go to server/data/poker-scout-bench.jsonl as they finish; the report
 * gives bb/100 ± 95% for each and scouted minus cold, over all the hands and
 * over the first 100, before the cold player has learned much. The live
 * local-model players are paused while it runs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PokerTable } = require('../engine/poker.js');
const { POLICIES, rngFor } = require('../engine/poker-bots.js');
const { fromTable } = require('./poker-history.js');
const { match, BB, STACK } = require('./poker-bench.js');
const { makeBrain } = require('./poker-player.js');
const { Store, writeNote } = require('./poker-scout.js');
const { pauseLive, resumeLive, STYLES } = require('./poker-night.js');

const DATA = path.join(__dirname, '..', 'server', 'data');
const OUT = path.join(DATA, 'poker-scout-bench.jsonl');
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

/** The opponent plays a regular for `hands` hands; the store learns them from the rail. */
function scout(style, hands, seed, store) {
  for (let h = 0; h < hands; h++) {
    const deal = `${seed}-watch-${style}-${h}`;
    const t = new PokerTable({ seed: deal, smallBlind: BB / 2, bigBlind: BB, seats: 2 });
    const players = h % 2 ? [['Regular', POLICIES.default], ['Opponent', POLICIES[style]]] : [['Opponent', POLICIES[style]], ['Regular', POLICIES.default]];
    players.forEach(([name], i) => t.sit({ id: name, name, kind: 'bot' }, STACK, i));
    const rngs = players.map(([name]) => rngFor(`${deal}:${name}`));
    t.startHand();
    while (t.inPlay) {
      const s = t.toAct;
      let d = players[s][1].decide(t.view(s), rngs[s]);
      if (!t.legal(s).some((l) => l.action === d.action) && d.action !== 'allin') d = { action: t.legal(s).some((l) => l.action === 'check') ? 'check' : 'fold' };
      t.act(s, d.action, d.amount);
    }
    store.profiles.addRecord(fromTable({ ...t.view(null), id: deal })); // the rail's view: no hole cards but the shown ones
  }
}

async function run(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const styles = flag('--styles', STYLES.join(',')).split(',');
  const watchHands = Number(flag('--watch', 300));
  const pairs = Number(flag('--pairs', 100));
  const seed = flag('--seed', 'scout');
  fs.mkdirSync(DATA, { recursive: true });
  const paused = pauseLive();
  const stop = () => { resumeLive(paused); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    for (const style of styles) {
      const file = path.join(DATA, `poker-scout-bench-${style}.json`);
      fs.rmSync(file, { force: true });
      fs.rmSync(file.replace(/\.json$/, '.hands.jsonl'), { force: true });
      const store = new Store(file);
      scout(style, watchHands, seed, store);
      const read = store.report('Opponent');
      const note = await writeNote(store, 'Opponent');
      store.save();
      log(`${style}: scouted ${read.stats.hands} hands: ${read.style} (${read.confidence}); note: ${note.ok ? store.notes.Opponent : `none (${note.error || 'model unavailable'})`}`);
      const heroes = {
        cold: makeBrain({ feedback: true }),
        scouted: makeBrain({ feedback: true, profiles: store.profiles, notes: { ...store.notes } }),
      };
      for (const [hero, brain] of Object.entries(heroes)) {
        const t0 = Date.now();
        const r = await match(brain, { ...POLICIES[style], name: style }, {
          hands: pairs, seed: `${seed}-${style}`,
          onPair: (i, bb) => fs.appendFileSync(OUT, JSON.stringify({ seed, style, hero, i, bb, watched: watchHands }) + '\n'),
        });
        log(`${hero} v ${style}: ${r.bbPer100 >= 0 ? '+' : ''}${r.bbPer100} ± ${r.ci95} bb/100 over ${r.hands} hands in ${Math.round((Date.now() - t0) / 60000)} min; ${JSON.stringify(brain.stats)}`);
      }
    }
  } finally {
    resumeLive(paused);
  }
}

const ci = (xs) => {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(Math.max(0, xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)));
  return { n, per100: Math.round(mean * 50 * 10) / 10, ci95: Math.round(1.96 * (sd / Math.sqrt(n)) * 50 * 10) / 10 };
};

/** Per style: cold, scouted, and scouted minus cold, over all pairs and the first 50 (100 hands). */
function report(file = OUT) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const by = {};
  for (const r of rows) (((by[r.style] = by[r.style] || {})[r.hero] = by[r.style][r.hero] || new Map())).set(`${r.seed}:${r.i}`, r);
  const out = {};
  for (const [style, h] of Object.entries(by)) {
    out[style] = {};
    for (const hero of ['cold', 'scouted']) if (h[hero]) out[style][hero] = ci([...h[hero].values()].map((r) => r.bb));
    if (h.cold && h.scouted) {
      const both = [...h.scouted.entries()].filter(([k]) => h.cold.has(k));
      out[style]['scouted minus cold'] = ci(both.map(([k, r]) => r.bb - h.cold.get(k).bb));
      const early = both.filter(([, r]) => r.i < 50);
      if (early.length) out[style]['scouted minus cold, first 100 hands'] = ci(early.map(([k, r]) => r.bb - h.cold.get(k).bb));
    }
  }
  return out;
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') run(rest).then(() => log('finished')).catch((e) => { log(`error: ${e.stack}`); process.exit(1); });
  else if (cmd === 'report') {
    for (const [style, v] of Object.entries(report())) {
      console.log(style);
      for (const [k, x] of Object.entries(v)) console.log(`  ${k.padEnd(36)} ${x.per100 >= 0 ? '+' : ''}${x.per100} ± ${x.ci95} bb/100 (${2 * x.n} hands)`);
    }
  } else { console.error('usage: node agent/poker-scout-bench.js run [--styles a,b] [--watch 300] [--pairs 100] | report'); process.exit(1); }
}

module.exports = { scout, report };
