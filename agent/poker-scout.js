#!/usr/bin/env node
/**
 * Poker scouting (CLA-127): learn how the players at a game play before
 * sitting down, then join already knowing them.
 *
 *   node agent/poker-scout.js watch --table p1 [--hands 200] [--url ...]   watch a live table from the rail
 *   node agent/poker-scout.js import histories.txt [more files ...]        hand histories from elsewhere
 *   node agent/poker-scout.js report [--table p1] [--json]                 what we know about each player
 *   node agent/poker-scout.js notes [--min 50]                             the local model writes a note on each
 *   node agent/poker-scout.js join --table p1 --name "Gemma (scout)"       sit down with the report and play
 *
 * Every option takes --store FILE (default server/data/poker-scouting.json).
 *
 * Watching uses only what anyone at the rail sees: the actions, and hole cards
 * only when a showdown turns them up (CLA-129). Imports take PokerStars-style
 * text histories or JSON lines of hand records (agent/poker-history.js,
 * CLA-128), so "any game" is any game whose hands we can see: our tables, or
 * histories exported from another site or tool. Nothing here connects to a
 * real-money site.
 *
 * The store holds, per player name: the profile numbers (agent/poker-profile.js)
 * including what their bets turned out to be at showdown, a style read in code
 * with a confidence, and a note from the local model (CLA-130). Every hand
 * seen is also appended to the store's .hands.jsonl as a hand record, so it
 * can be re-read later. Joining hands the store to the LLM player with
 * feedback (agent/poker-player.js), which states each opponent's style as a
 * fact from its first hand there and keeps learning from its seat.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Profiles } = require('./poker-profile.js');
const { fromTable, parse } = require('./poker-history.js');
const { askModel, DEFAULT_LLM } = require('./local-player.js');
const { TableClient } = require('./table-client.js');

const STORE = path.join(__dirname, '..', 'server', 'data', 'poker-scouting.json');
const DEFAULT_URL = process.env.BLACKJACK_SERVER || 'http://192.168.4.43:8787';

const NOTE_SYSTEM = 'You are a poker coach scouting a player before a game. From their statistics, the style the numbers suggest, and the hands they showed, '
  + 'write two short sentences: how this player plays, and how to beat them. Use only what the data shows. No preamble.';

/** The scouting store: profiles, notes, ledger (filled once we play), and the hands already counted. */
class Store {
  constructor(file = STORE) {
    this.file = file;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* a new store */ }
    this.profiles = new Profiles(d.profiles || {});
    this.notes = d.notes || {};
    this.ledger = d.ledger || {};
    this.seen = new Set(d.seen || []);
    this.sources = d.sources || {};
  }

  /** Count a hand record once; false if it was already counted. */
  add(record) {
    const key = record.id ? `${record.source}:${record.id}` : null;
    if (key && this.seen.has(key)) return false;
    this.profiles.addRecord(record);
    if (key) this.seen.add(key);
    this.sources[record.source] = (this.sources[record.source] || 0) + 1;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file.replace(/\.json$/, '') + '.hands.jsonl', JSON.stringify(record) + '\n');
    return true;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ profiles: this.profiles.toJSON(), notes: this.notes, ledger: this.ledger, seen: [...this.seen], sources: this.sources }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /** One player's scouting report. */
  report(name) {
    const s = this.profiles.stats(name);
    return { name, ...this.profiles.style(name), stats: s, line: this.profiles.line(name), note: this.notes[name] || null };
  }

  /** Reports for these names (or everyone seen), most hands first. */
  reports(names = this.profiles.names()) {
    return names.map((n) => this.report(n)).filter((r) => r.stats.hands > 0).sort((a, b) => b.stats.hands - a.stats.hands);
  }
}

/** The local model's note on one player from what was observed. */
async function writeNote(store, name, { llm = DEFAULT_LLM, ask = askModel } = {}) {
  const r = store.report(name);
  const input = `Player: ${name}\nStatistics: ${r.line}\nStyle the numbers suggest: ${r.style} (${r.confidence} confidence): ${r.exploit}`;
  const out = await ask(llm, NOTE_SYSTEM, 'Write the note.', input, { maxTokens: 160, timeoutMs: 60000 });
  if (out.ok && out.text) store.notes[name] = out.text.replace(/\s+/g, ' ').slice(0, 300);
  return out;
}

/**
 * Watch a live table from the rail and count every finished hand. Stops after
 * `hands` hands (0: until stopped). `client` is a TableClient; `onHand` sees
 * each record.
 */
async function watch({ client, table, store, hands = 0, onHand = () => {}, log = () => {}, saveEvery = 10 }) {
  let v = await client.watch(table);
  let last = v.phase === 'done' && v.lastHand ? v.lastHand.handNo : null; // a hand already over when we arrived may be half-seen elsewhere; count it anyway
  let counted = 0;
  const count = (view) => {
    const r = fromTable(view, { table });
    if (store.add(r)) { counted++; onHand(r); }
    if (counted % saveEvery === 0) store.save();
  };
  if (last !== null) count(v);
  log(`watching poker table ${table} (${v.name}) from the rail`);
  while (!hands || counted < hands) {
    v = await client.watch(table, v.version, 25);
    if (v.phase === 'done' && v.lastHand && v.lastHand.handNo !== last) {
      last = v.lastHand.handNo;
      count(v);
    }
  }
  store.save();
  return counted;
}

/** Text lines for reports. */
function format(reports) {
  return reports.map((r) => `${r.name}: ${r.style}${r.style === 'unknown' ? '' : ` (${r.confidence} confidence)`}, ${r.stats.hands} hands. ${r.line}.`
    + (r.style !== 'unknown' ? `\n    How to beat them: ${r.exploit}.` : '') + (r.note ? `\n    Note: ${r.note}` : ''));
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n, d) => { const i = rest.indexOf(n); return i === -1 ? d : rest[i + 1]; };
  const store = new Store(path.resolve(flag('--store', STORE)));
  const url = flag('--url', DEFAULT_URL);
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  if (cmd === 'watch') {
    const table = flag('--table', 'p1');
    const client = new TableClient(url, { game: 'poker' });
    const stop = () => { store.save(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    const n = await watch({ client, table, store, hands: Number(flag('--hands', 0)), log, onHand: (r) => log(`hand ${r.id}: ${r.players.map((p) => `${p.name} ${r.net[p.seat] >= 0 ? '+' : ''}${r.net[p.seat]}`).join(', ')}`) });
    log(`watched ${n} hands`);
    console.log(format(store.reports(table ? (await client.watch(table)).seats.filter(Boolean).map((s) => s.player.name) : undefined)).join('\n'));
  } else if (cmd === 'import') {
    const files = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
    if (!files.length) throw new Error('usage: poker-scout.js import FILE [FILE ...]');
    for (const f of files) {
      const { records, skipped } = parse(fs.readFileSync(f, 'utf8'));
      let added = 0;
      for (const r of records) if (store.add(r)) added++;
      console.log(`${f}: ${added} new hands, ${records.length - added} already counted, ${skipped.length} skipped${skipped.length ? ` (${[...new Set(skipped.map((s) => s.split(':')[0]))].join(', ')})` : ''}`);
    }
    store.save();
  } else if (cmd === 'report') {
    const table = flag('--table', null);
    const names = table ? (await new TableClient(url, { game: 'poker' }).watch(table)).seats.filter(Boolean).map((s) => s.player.name) : undefined;
    const reports = store.reports(names);
    if (rest.includes('--json')) console.log(JSON.stringify(reports, null, 1));
    else console.log(format(reports).join('\n') || 'Nobody scouted yet.');
  } else if (cmd === 'notes') {
    const min = Number(flag('--min', 50));
    for (const r of store.reports()) {
      if (r.stats.hands < min) continue;
      const out = await writeNote(store, r.name, { llm: flag('--llm', DEFAULT_LLM) });
      console.log(out.ok ? `${r.name}: ${store.notes[r.name]}` : `${r.name}: no note (${out.error || 'model unavailable'})`);
      if (!out.ok) break;
    }
    store.save();
  } else if (cmd === 'join') {
    const { playLive } = require('./poker-player.js');
    const stats = await playLive({ url, table: flag('--table', 'p1'), name: flag('--name', 'Gemma (scout)'), llm: flag('--llm', DEFAULT_LLM), hands: Number(flag('--hands', 0)), log, scouting: store });
    log(`done: ${JSON.stringify(stats)}`);
  } else {
    console.error('usage: node agent/poker-scout.js watch|import|report|notes|join [options]; see the top of this file');
    process.exit(1);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { Store, watch, writeNote, format, STORE, NOTE_SYSTEM };
