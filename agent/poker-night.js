#!/usr/bin/env node
/**
 * The overnight poker benchmark (CLA-125): the default bot, the LLM player
 * (CLA-122) and the LLM player with feedback (CLA-124), heads-up in duplicate
 * against each style, on the same deals, in chunks until a deadline.
 *
 *   node agent/poker-night.js run [--until 07:30] [--pairs 100]   (Europe/Dublin time)
 *   node agent/poker-night.js report
 *   node agent/poker-night.js retest --style calling-station --chunks 1-8 --as llm-feedback-2
 *
 * `retest` replays chunks already played, against one style, with the LLM
 * player with feedback as the code now stands, recorded under a new hero name,
 * so a change to the player (CLA-126) is compared with the night's players on
 * the same deals.
 *
 * Every pair of hands is appended to server/data/poker-night.jsonl as it
 * finishes, so a run cut short still counts. Chunk k plays deals
 * "night-k-0" ... for every hero and style, so all three heroes meet the same
 * cards and can be compared deal by deal (which cancels most of the luck).
 * Each LLM hero keeps one memory per style for the whole night, so it learns
 * that opponent as the night goes on. While it runs, the live local-model
 * players are paused so they don't compete for the gaming PC; they are
 * started again at the end.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { match } = require('./poker-bench.js');
const { POLICIES } = require('../engine/poker-bots.js');
const { makeBrain } = require('./poker-player.js');

const DATA = path.join(__dirname, '..', 'server', 'data');
const OUT = path.join(DATA, 'poker-night.jsonl');
const STYLES = ['tight-passive', 'loose-aggressive', 'calling-station', 'maniac'];
const HEROES = ['default', 'llm', 'llm-feedback'];
const LIVE = ['com.clawworks.blackjack-agents', 'com.clawworks.poker-agent'];
const domain = `gui/${process.getuid()}`;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

/** Minutes past midnight in Dublin, now. */
function dublinMinutes() {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
  return h * 60 + m;
}

function pauseLive() {
  const paused = [];
  for (const l of LIVE) {
    const plist = path.join(process.env.HOME, 'Library', 'LaunchAgents', `${l}.plist`);
    try { execFileSync('launchctl', ['print', `${domain}/${l}`], { stdio: 'ignore' }); } catch (_) { continue; }
    try { execFileSync('launchctl', ['bootout', `${domain}/${l}`], { stdio: 'ignore' }); paused.push(plist); log(`paused ${l}`); } catch (e) { log(`could not pause ${l}: ${e.message}`); }
  }
  return paused;
}

function resumeLive(plists) {
  for (const p of plists) {
    try { execFileSync('launchctl', ['bootstrap', domain, p], { stdio: 'ignore' }); log(`resumed ${path.basename(p)}`); } catch (e) { log(`could not resume ${p}: ${e.message}`); }
  }
}

async function run(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const [uh, um] = flag('--until', '07:30').split(':').map(Number);
  const until = uh * 60 + um;
  const pairs = Number(flag('--pairs', 100));
  const start = dublinMinutes();
  // Minutes until the deadline, wrapping past midnight.
  const left = () => (until - dublinMinutes() + 1440) % 1440;
  const deadlineIn = left();
  fs.mkdirSync(DATA, { recursive: true });
  const firstChunk = fs.existsSync(OUT) ? Math.max(0, ...fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).chunk)) + 1 : 1;
  const brains = { llm: {}, 'llm-feedback': {} };
  for (const s of STYLES) {
    brains.llm[s] = makeBrain({ feedback: false });
    brains['llm-feedback'][s] = makeBrain({ feedback: true });
  }
  const paused = pauseLive();
  const stop = () => { resumeLive(paused); saveBrains(brains); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(`overnight poker benchmark: ${pairs} pairs per hero and style per chunk, until ${flag('--until', '07:30')} Dublin (${deadlineIn} min), from chunk ${firstChunk}`);
  try {
    for (let chunk = firstChunk; ; chunk++) {
      for (const style of STYLES) {
        for (const hero of HEROES) {
          if (left() > deadlineIn + 5 || left() < 2) { log('deadline reached'); return; } // past the deadline (it wrapped) or about to be
          const h = hero === 'default' ? POLICIES.default : brains[hero][style];
          const t0 = Date.now();
          const r = await match(h, { ...POLICIES[style], name: style }, {
            hands: pairs, seed: `night-${chunk}`,
            onPair: (i, bb) => fs.appendFileSync(OUT, JSON.stringify({ chunk, style, hero, i, bb }) + '\n'),
          });
          log(`chunk ${chunk}: ${hero} v ${style}: ${r.bbPer100 >= 0 ? '+' : ''}${r.bbPer100} bb/100 over ${r.hands} hands in ${Math.round((Date.now() - t0) / 60000)} min`);
        }
      }
      saveBrains(brains);
      log(`chunk ${chunk} done (${Math.round((dublinMinutes() - start + 1440) % 1440)} min in)`);
    }
  } finally {
    saveBrains(brains);
    resumeLive(paused);
  }
}

async function retest(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const style = flag('--style', 'calling-station');
  const [from, to] = flag('--chunks', '1-8').split('-').map(Number);
  const hero = flag('--as', 'llm-feedback-2');
  const pairs = Number(flag('--pairs', 100));
  if (!POLICIES[style]) throw new Error(`no style ${style}`);
  const brain = makeBrain({ feedback: true });
  const paused = pauseLive();
  const save = () => {
    const file = path.join(DATA, 'poker-night-brains.json');
    let out = {};
    try { out = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    out[hero] = { [style]: { stats: brain.stats, notes: brain.notes, ledger: brain.ledger, opponent: brain.profiles.stats('Opponent') } };
    fs.writeFileSync(file, JSON.stringify(out, null, 1));
  };
  const stop = () => { save(); resumeLive(paused); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(`retest: ${hero} v ${style}, chunks ${from}-${to}, ${pairs} pairs each`);
  try {
    for (let chunk = from; chunk <= to; chunk++) {
      const t0 = Date.now();
      const r = await match(brain, { ...POLICIES[style], name: style }, {
        hands: pairs, seed: `night-${chunk}`,
        onPair: (i, bb) => fs.appendFileSync(OUT, JSON.stringify({ chunk, style, hero, i, bb }) + '\n'),
      });
      save();
      log(`chunk ${chunk}: ${hero} v ${style}: ${r.bbPer100 >= 0 ? '+' : ''}${r.bbPer100} bb/100 over ${r.hands} hands in ${Math.round((Date.now() - t0) / 60000)} min`);
    }
  } finally {
    save();
    resumeLive(paused);
  }
}

function saveBrains(brains) {
  const out = {};
  for (const hero of Object.keys(brains)) {
    out[hero] = {};
    for (const [style, b] of Object.entries(brains[hero])) out[hero][style] = { stats: b.stats, notes: b.notes, ledger: b.ledger, opponent: b.profiles.stats('Opponent') };
  }
  fs.writeFileSync(path.join(DATA, 'poker-night-brains.json'), JSON.stringify(out, null, 1));
}

/** bb/100 per hero and style, and each LLM hero minus the default on the same deals, all with 95% intervals. */
function report(file = OUT) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const key = (r) => `${r.chunk}:${r.style}:${r.i}`;
  const by = {};
  for (const r of rows) ((by[r.style] = by[r.style] || {})[r.hero] = by[r.style][r.hero] || new Map()).set(key(r), r.bb);
  const ci = (xs) => {
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(Math.max(0, xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)));
    return { n, per100: Math.round(mean * 50 * 10) / 10, ci95: Math.round(1.96 * (sd / Math.sqrt(n)) * 50 * 10) / 10 };
  };
  const out = {};
  const diff = (a, b) => [...a.entries()].filter(([k]) => b.has(k)).map(([k, v]) => v - b.get(k));
  for (const style of STYLES) {
    const h = by[style];
    if (!h) continue;
    out[style] = {};
    // The night's heroes, then any retested ones in the order they first appear.
    const heroes = [...HEROES.filter((x) => h[x]), ...Object.keys(h).filter((x) => !HEROES.includes(x))];
    for (const hero of heroes) out[style][hero] = ci([...h[hero].values()]);
    // Each hero minus every one before it, on the deals both played.
    for (let j = 1; j < heroes.length; j++) {
      for (let i = 0; i < j; i++) {
        const d = diff(h[heroes[j]], h[heroes[i]]);
        if (d.length) out[style][`${heroes[j]} minus ${heroes[i]}`] = ci(d);
      }
    }
  }
  return out;
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') run(rest).then(() => log('finished')).catch((e) => { log(`error: ${e.stack}`); process.exit(1); });
  else if (cmd === 'retest') retest(rest).then(() => log('finished')).catch((e) => { log(`error: ${e.stack}`); process.exit(1); });
  else if (cmd === 'report') {
    const r = report();
    for (const [style, v] of Object.entries(r)) {
      console.log(style);
      for (const [k, x] of Object.entries(v)) console.log(`  ${k.padEnd(34)} ${x.per100 >= 0 ? '+' : ''}${x.per100} ± ${x.ci95} bb/100 (${2 * x.n} hands)`);
    }
  } else { console.error('usage: node agent/poker-night.js run [--until 07:30] [--pairs 100] | report | retest [--style s] [--chunks 1-8] [--as name]'); process.exit(1); }
}

module.exports = { report, STYLES, HEROES };
