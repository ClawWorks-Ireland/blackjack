#!/usr/bin/env node
/**
 * Scouted vs cold sessions (#10 slice 4). For each style: scout once into a
 * frozen report (saved, never redone for the same seed and watch), then play
 * `--sessions` sessions per hero (cold, scouted) in duplicate, each from a
 * fresh brain. Every hand goes to server/data/poker-scout-sessions.jsonl as it
 * ends. A rerun discards the rows of unfinished sessions and replays them.
 *
 *   node agent/poker-scout-sessions.js run [--styles a,b] [--sessions 40] [--hands 30] [--watch 300] [--seed sessions]
 *   node agent/poker-scout-sessions.js report [--diagnose STYLE]
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

const ROWS = path.join(DATA, 'poker-scout-sessions.jsonl');
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** mean and 95% half-width (1.96 x sample sd / sqrt n) of xs, scaled by `k`. */
const ci = (xs, k = 1) => {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, ci95: null };
  const m = mean(xs);
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: r1(m * k), ci95: n > 1 ? r1((1.96 * sd * k) / Math.sqrt(n)) : null };
};
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Complete sessions of one style: {hero: Map(session -> rows sorted by handIndex)}. A triple is complete when it has as many hands as the fullest one. */
function sessionsOf(rows, style) {
  const triples = new Map();
  for (const r of rows) {
    if (r.style !== style) continue;
    const k = `${r.hero}|${r.session}`;
    if (!triples.has(k)) triples.set(k, new Map());
    triples.get(k).set(`${r.pair}:${r.seat}`, r);
  }
  const full = Math.max(0, ...[...triples.values()].map((m) => m.size));
  const out = { cold: new Map(), scouted: new Map() };
  for (const [k, m] of triples) {
    const [hero, session] = k.split('|');
    if (m.size === full && out[hero]) out[hero].set(Number(session), [...m.values()].sort((a, b) => a.handIndex - b.handIndex));
  }
  return out;
}

/** Per style: each hero's bb/100, scouted minus cold with the session as the unit (overall and by hand bucket), and the scout's read. */
function report(file = ROWS, dataDir = DATA, { bucket = 10, buckets = 3 } = {}) {
  const rows = readRows(file);
  const out = {};
  for (const style of [...new Set(rows.map((r) => r.style))]) {
    const s = sessionsOf(rows, style);
    const o = { heroes: {}, diff: null, buckets: [], read: null };
    for (const hero of ['cold', 'scouted']) {
      const all = [...s[hero].values()].flat().map((r) => r.bb);
      o.heroes[hero] = { ...ci(all, 100), hands: all.length, sessions: s[hero].size };
    }
    const both = [...s.scouted.keys()].filter((k) => s.cold.has(k));
    const per100 = (hands) => (hands.length ? (mean(hands.map((r) => r.bb)) * 100) : null);
    const delta = (lo, hi) => both.map((k) => {
      const part = (hero) => per100(s[hero].get(k).filter((r) => r.handIndex >= lo && r.handIndex < hi));
      const a = part('scouted');
      const b = part('cold');
      return a === null || b === null ? null : a - b;
    }).filter((d) => d !== null);
    o.diff = ci(delta(0, Infinity));
    for (let i = 0; i < buckets; i++) o.buckets.push({ label: `hands ${i * bucket + 1}-${(i + 1) * bucket}`, ...ci(delta(i * bucket, (i + 1) * bucket)) });
    try {
      const read = JSON.parse(fs.readFileSync(path.join(dataDir, `poker-scout-sessions-${style}.json`), 'utf8')).read;
      o.read = { style: read.style, confidence: read.confidence, vpip: read.stats.vpip, pfr: read.stats.pfr, aggression: read.stats.aggression, foldToBet: read.stats.foldToBet };
    } catch (_) { /* no frozen report */ }
    out[style] = o;
  }
  return out;
}

const KINDS = ['bluff', 'thin', 'value', 'call', 'fold'];

/** Per hero: bb by main-move kind (overall and for the first `early` hands), the call-down rate, and the showdown win rate of river calls. */
function diagnose(file = ROWS, style, { early = 10 } = {}) {
  const s = sessionsOf(readRows(file), style);
  const out = {};
  for (const hero of ['cold', 'scouted']) {
    const rows = [...s[hero].values()].flat();
    const kinds = (rs) => Object.fromEntries(KINDS.map((k) => {
      const m = rs.filter((r) => r.mainMove === k);
      const bb = m.reduce((a, r) => a + r.bb, 0);
      return [k, { n: m.length, bb, perMove: m.length ? r1(bb / m.length) : null }];
    }));
    const faced = rows.filter((r) => r.facedRiverBet).length;
    const called = rows.filter((r) => r.riverCall);
    const shown = called.filter((r) => r.showdown);
    out[hero] = {
      kinds: kinds(rows),
      early: kinds(rows.filter((r) => r.handIndex < early)),
      callDown: faced ? called.length / faced : null,
      showdownWin: shown.length ? shown.filter((r) => r.bb > 0).length / shown.length : null,
    };
  }
  return out;
}

const sign = (x) => (x === null ? '?' : `${x >= 0 ? '+' : ''}${x}`);
const pm = (x) => `${sign(x.mean)} ± ${x.ci95 ?? '?'}`;
const pct = (x) => (x === null ? '?' : `${Math.round(x * 100)}%`);

function printReport(res) {
  for (const [style, v] of Object.entries(res)) {
    console.log(`\n${style}`);
    if (v.read) console.log(`  ${'scout read'.padEnd(36)} ${v.read.style} (${v.read.confidence}); VPIP ${v.read.vpip}, PFR ${v.read.pfr}, aggression ${v.read.aggression}, fold to bet ${v.read.foldToBet}`);
    for (const [hero, x] of Object.entries(v.heroes)) console.log(`  ${hero.padEnd(36)} ${pm(x)} bb/100 (${x.hands} hands, ${x.sessions} sessions)`);
    console.log(`  ${'scouted minus cold, per session'.padEnd(36)} ${pm(v.diff)} bb/100 (${v.diff.n} sessions)`);
    for (const b of v.buckets) console.log(`  ${`  ${b.label}`.padEnd(36)} ${pm(b)} bb/100 (${b.n} sessions)`);
  }
}

function printDiagnose(style, res) {
  console.log(`\n${style}`);
  for (const [hero, x] of Object.entries(res)) {
    console.log(`  ${hero}: call-down ${pct(x.callDown)}, river calls that won at showdown ${pct(x.showdownWin)}`);
    for (const [label, ks] of [['all hands', x.kinds], ['first hands', x.early]]) {
      console.log(`    ${label}: ${KINDS.map((k) => `${k} ${ks[k].n} (${sign(ks[k].bb)} bb, ${ks[k].perMove === null ? '?' : sign(ks[k].perMove)}/move)`).join('; ')}`);
    }
  }
}

if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  const flag = (n, d) => { const i = a.indexOf(n); return i === -1 ? d : a[i + 1]; };
  if (cmd === 'report') {
    if (flag('--diagnose')) printDiagnose(flag('--diagnose'), diagnose(ROWS, flag('--diagnose')));
    else printReport(report());
    process.exit(0);
  }
  if (cmd !== 'run') { console.error('usage: node agent/poker-scout-sessions.js run [--styles a,b] [--sessions 40] [--hands 30] [--watch 300] [--seed sessions] | report [--diagnose STYLE]'); process.exit(1); }
  const opts = { sessions: Number(flag('--sessions', 40)), hands: Number(flag('--hands', 30)), watch: Number(flag('--watch', 300)), seed: flag('--seed', 'sessions') };
  if (flag('--styles')) opts.styles = flag('--styles').split(',');
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  run(opts).then(() => log('finished')).catch((e) => { console.error(e.usage ? `usage: ${e.message}` : e.stack); process.exit(e.usage ? 1 : 2); });
}

module.exports = { run, report, diagnose, ALL };
