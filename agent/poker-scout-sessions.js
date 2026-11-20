#!/usr/bin/env node
/**
 * Scouted vs cold sessions (#10 slice 4). For each style: scout once into a
 * frozen report (saved, never redone for the same seed and watch), then play
 * `--sessions` sessions per hero (cold, scouted) in duplicate, each from a
 * fresh brain. Every hand goes to server/data/poker-scout-sessions.jsonl as it
 * ends. A rerun discards the rows of unfinished sessions and replays them.
 *
 *   node agent/poker-scout-sessions.js run [--styles a,b] [--sessions 40] [--hands 30] [--watch 300] [--seed sessions]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { POLICIES, MILD_POLICIES } = require('../engine/poker-bots.js');
const { match } = require('./poker-bench.js');
const { makeBrain: realMakeBrain } = require('./poker-player.js');
const { Profiles } = require('./poker-profile.js');
const { Store, writeNote } = require('./poker-scout.js');
const { scout } = require('./poker-scout-bench.js');
const { pauseLive, resumeLive, STYLES } = require('./poker-night.js');

const DATA = path.join(__dirname, '..', 'server', 'data');
const ALL = [...STYLES, ...STYLES.map((s) => `${s}-mild`)];
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const copy = (x) => JSON.parse(JSON.stringify(x));
const policyOf = (style) => POLICIES[style] || MILD_POLICIES[style];

class Stop extends Error {}

function usage(msg) {
  const e = new Error(msg);
  e.usage = true;
  return e;
}

async function run(opts = {}) {
  const {
    styles = ALL, sessions = 40, hands = 30, watch = 300, seed = 'sessions',
    dataDir = DATA, ask, pause = true, stopAfterHands = null, makeBrain = realMakeBrain,
  } = opts;
  for (const s of styles) if (!ALL.includes(s)) throw usage(`unknown style ${s}; use ${ALL.join(', ')}`);
  if (!Number.isInteger(hands) || hands < 2 || hands % 2) throw usage('--hands must be even');
  const pairs = hands / 2;
  const rowsFile = path.join(dataDir, 'poker-scout-sessions.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });

  // Resume: keep only the rows of complete (style, hero, session) triples.
  const key = (r) => `${r.style}|${r.hero}|${r.session}`;
  let rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const seen = new Map();
  for (const r of rows) {
    if (r.seed !== seed) continue;
    if (!seen.has(key(r))) seen.set(key(r), new Set());
    seen.get(key(r)).add(`${r.pair}:${r.seat}`);
  }
  const done = (k) => (seen.has(k) ? seen.get(k).size >= hands : false);
  rows = rows.filter((r) => r.seed !== seed || done(key(r)));
  fs.writeFileSync(rowsFile, rows.map((r) => JSON.stringify(r) + '\n').join(''));

  let written = 0;
  const paused = pause ? pauseLive() : [];
  try {
    for (const style of styles) {
      const reportFile = path.join(dataDir, `poker-scout-sessions-${style}.json`);
      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch (_) { /* none yet */ }
      if (!report || report.seed !== seed || report.watch !== watch) {
        const store = new Store(path.join(dataDir, `poker-scout-sessions-${style}.store.json`));
        fs.rmSync(store.file, { force: true });
        fs.rmSync(store.file.replace(/\.json$/, '.hands.jsonl'), { force: true });
        scout(style, watch, seed, store);
        const read = store.report('Opponent');
        await writeNote(store, 'Opponent', { ask });
        report = { seed, watch, style, profiles: store.profiles.toJSON(), notes: store.notes, read: { style: read.style, confidence: read.confidence, stats: read.stats } };
        fs.writeFileSync(`${reportFile}.tmp`, JSON.stringify(report, null, 1));
        fs.renameSync(`${reportFile}.tmp`, reportFile);
        log(`${style}: scouted ${read.stats.hands} hands: ${read.style} (${read.confidence})`);
      }
      for (let k = 0; k < sessions; k++) {
        for (const hero of ['cold', 'scouted']) {
          if (done(`${style}|${hero}|${k}`)) continue;
          const brain = hero === 'cold'
            ? makeBrain({ feedback: true, ask })
            : makeBrain({ feedback: true, ask, profiles: new Profiles(copy(report.profiles)), notes: copy(report.notes) });
          const onHand = (h) => {
            const b = brain.lastHand || {};
            const row = {
              seed, style, hero, session: k, pair: h.pair, seat: h.seat, handIndex: h.handIndex, deal: h.deal, bb: h.bb,
              mainMove: b.mainMove ?? null, equityAtMainMove: b.equityAtMainMove ?? null, streetReached: h.streetReached,
              showdown: h.showdown, guardrailFired: b.guardrailFired ?? false, facedRiverBet: h.facedRiverBet, riverCall: h.riverCall,
            };
            fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
            if (stopAfterHands != null && ++written >= stopAfterHands) throw new Stop();
          };
          await match(brain, { ...policyOf(style), name: style }, { hands: pairs, seed: `${seed}-${style}-s${k}`, onHand });
          log(`${style} ${hero} session ${k + 1}/${sessions} done`);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    return { stopped: true };
  } finally {
    if (pause) resumeLive(paused);
  }
  return { stopped: false };
}

if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  const flag = (n, d) => { const i = a.indexOf(n); return i === -1 ? d : a[i + 1]; };
  if (cmd !== 'run') { console.error('usage: node agent/poker-scout-sessions.js run [--styles a,b] [--sessions 40] [--hands 30] [--watch 300] [--seed sessions]'); process.exit(1); }
  const opts = { sessions: Number(flag('--sessions', 40)), hands: Number(flag('--hands', 30)), watch: Number(flag('--watch', 300)), seed: flag('--seed', 'sessions') };
  if (flag('--styles')) opts.styles = flag('--styles').split(',');
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  run(opts).then(() => log('finished')).catch((e) => { console.error(e.usage ? `usage: ${e.message}` : e.stack); process.exit(e.usage ? 1 : 2); });
}

module.exports = { run, ALL };
