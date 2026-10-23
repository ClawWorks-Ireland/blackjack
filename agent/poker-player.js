#!/usr/bin/env node
/**
 * An LLM poker player that profiles its opponents and bends a sound default
 * to exploit them (CLA-122). It runs on the household gaming PC's model
 * through the local-models script, like the blackjack player.
 *
 * Code does the arithmetic: equity, pot odds, the default bot's move
 * (engine/poker-bots.js), and each opponent's numbers from every hand it sees
 * (agent/poker-profile.js). The model does the judgement: every
 * `notesEvery` hands it writes a short note on each opponent, and for each
 * decision it picks from a menu of concrete moves, with the default marked,
 * given the opponents' numbers and its notes. An answer it can't read falls
 * back to the default.
 *
 *   node agent/poker-player.js --url http://192.168.4.43:8787 --table p1 --name "Gemma (poker)"
 *
 * As a benchmark policy: makeBrain({...}) has decide(view, rng) and
 * onHandEnd(view, names), as agent/poker-bench.js expects.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { situation, POLICIES, rngFor } = require('../engine/poker-bots.js');
const { evaluate } = require('../engine/poker.js');
const { Profiles } = require('./poker-profile.js');
const { askModel, DEFAULT_LLM } = require('./local-player.js');
const { TableClient } = require('./table-client.js');

const DATA = path.join(__dirname, '..', 'server', 'data', 'poker-profiles.json');

const SYSTEM = [
  "You are a strong no-limit Hold'em player at a table of other players. Win chips by exploiting how each opponent plays.",
  'You get the situation, the numbers (equity is your chance to win against random hands of the players still in), each opponent\'s statistics and your notes on them, and a menu of moves with the default (sound, unexploitative) move marked.',
  'How to exploit:',
  '- Against players who call too much (high VPIP, low fold to a bet, low aggression): bet bigger with good hands, bet thinner for value, and do not bluff them.',
  '- Against players who fold too much (high fold to a bet): bet and raise more often to take the pot, even with weak hands.',
  '- Against very aggressive players (high PFR and aggression): call down more with medium hands, let them bluff, raise your strong hands.',
  '- Against tight, passive players (low VPIP and PFR): steal blinds and small pots, but respect their bets and raises: they have it.',
  '- With little information about an opponent, stay close to the default.',
  'Answer with only the letter of your move.',
].join('\n');

const NOTE_SYSTEM = 'You are a poker coach. From an opponent\'s statistics and the hands they showed, write two short sentences: '
  + 'how this player plays, and how to beat them. Use only what the numbers and hands show. No preamble.';

/** The menu: concrete legal moves, sizes from the pot. `def` is the default move to mark. */
function menu(view, def) {
  const you = view.you;
  const legal = Object.fromEntries(you.legal.map((l) => [l.action, l]));
  const pot = view.pot;
  const opts = [];
  const add = (label, action, amount) => { if (!opts.some((o) => o.action === action && o.amount === amount)) opts.push({ label, action, amount }); };
  if (legal.fold && you.toCall > 0) add('fold', 'fold');
  if (legal.check) add('check', 'check');
  if (legal.call) add(`call ${legal.call.amount}`, 'call');
  const up = legal.raise || legal.bet;
  if (up) {
    const clamp = (x) => Math.min(up.max, Math.max(up.min, Math.round(x)));
    const base = legal.raise ? view.currentBet : 0;
    const after = pot + you.toCall;
    const verb = legal.raise ? 'raise to' : 'bet';
    for (const [name, f] of [['small', legal.raise ? 0.5 : 0.33], ['medium', 0.75], ['big', 1.1]]) add(`${verb} ${clamp(base + after * f)} (${name})`, up.action, clamp(base + after * f));
    add(`all-in (${up.max})`, up.action, up.max);
  }
  // Mark the default: same action, nearest amount.
  let best = null;
  for (const o of opts) {
    if (o.action !== def.action && !(def.action === 'allin' && o.amount === (up && up.max))) continue;
    if (!best || Math.abs((o.amount || 0) - (def.amount || 0)) < Math.abs((best.amount || 0) - (def.amount || 0))) best = o;
  }
  return opts.map((o, i) => ({ ...o, letter: 'ABCDEFGH'[i], isDefault: o === best }));
}

function makeBrain({ llm = DEFAULT_LLM, profiles = new Profiles(), notes = {}, notesEvery = 30, log = () => {}, ask = askModel } = {}) {
  const stats = { decisions: 0, modelPicks: 0, followedDefault: 0, fallbacks: 0, notes: 0, hands: 0 };
  const self = {
    name: 'llm', stats, profiles, notes,
    description: 'LLM player: profiles opponents and bends the default to exploit them.',

    async decide(view, rng = Math.random) {
      stats.decisions++;
      const def = POLICIES.default.decide(view, rng);
      const s = situation(view, rng, 300);
      const opts = menu(view, def);
      const fallback = opts.find((o) => o.isDefault) || opts[0];
      const you = view.you;
      const handName = view.board.length >= 3 ? evaluate([...you.cards, ...view.board]).name : null;
      const opponents = view.seats.filter((x, i) => x && i !== you.seat && x.inHand && !x.folded).map((x) => {
        const n = x.player.name;
        return `- ${n}: stack ${x.stack}${x.bet ? `, bet ${x.bet} this street` : ''}${x.lastAction ? `, last move ${x.lastAction}` : ''}. Stats: ${profiles.line(n)}.${notes[n] ? ` Your notes: ${notes[n]}` : ''}`;
      });
      const prompt = [
        `Street: ${view.phase}. Your cards: ${you.cards.join(' ')}. Board: ${view.board.join(' ') || 'none yet'}.${handName ? ` You have ${handName}.` : ''}`,
        `Equity ${Math.round(s.eq * 100)}% against ${s.opponents} opponent${s.opponents === 1 ? '' : 's'}. Pot ${view.pot}. To call ${you.toCall}${you.toCall ? ` (pot odds ${Math.round(s.potOdds * 100)}%)` : ''}. Your stack ${you.stack}. Big blind ${view.bigBlind}.`,
        'Opponents still in:', ...opponents,
        'Moves:', ...opts.map((o) => `${o.letter}) ${o.label}${o.isDefault ? '  <- default' : ''}`),
      ].join('\n');
      const r = await ask(llm, SYSTEM, 'Which move? Answer with the letter only.', prompt, { maxTokens: 4, timeoutMs: 20000 });
      const letter = r.ok ? (r.text.toUpperCase().match(/\b([A-H])\b/) || r.text.toUpperCase().match(/([A-H])/) || [])[1] : null;
      const pick = letter && opts.find((o) => o.letter === letter);
      if (!pick) { stats.fallbacks++; return { action: fallback.action, amount: fallback.amount }; }
      stats.modelPicks++;
      if (pick.isDefault) stats.followedDefault++;
      return { action: pick.action, amount: pick.amount };
    },

    async onHandEnd(view, names) {
      if (!view.lastHand) return;
      stats.hands++;
      profiles.addHand(names, view.log, view.lastHand);
      if (stats.hands % notesEvery !== 0) return;
      const me = view.you ? view.seats[view.you.seat].player.name : null;
      for (const n of new Set(names)) {
        if (n === me || profiles.stats(n).hands < 20) continue;
        const r = await ask(llm, NOTE_SYSTEM, 'Write the note.', `Opponent: ${n}\nStatistics: ${profiles.line(n)}`, { maxTokens: 120, timeoutMs: 60000 });
        if (r.ok && r.text) { notes[n] = r.text.replace(/\s+/g, ' ').slice(0, 300); stats.notes++; log(`note on ${n}: ${notes[n]}`); }
      }
    },
  };
  return self;
}

function loadData(file = DATA) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { profiles: new Profiles(d.profiles || {}), notes: d.notes || {} }; } catch (_) { return { profiles: new Profiles(), notes: {} }; }
}
function saveData(brain, file = DATA) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ profiles: brain.profiles.toJSON(), notes: brain.notes }, null, 1));
}

/** Play live at a poker table until stopped. */
async function playLive({ url, table, name, llm = DEFAULT_LLM, log = console.log, hands = 0 }) {
  const data = loadData();
  const brain = makeBrain({ llm, ...data, log });
  const c = new TableClient(url, { game: 'poker' });
  const j = await c.join(table, name);
  log(`${name} seated at poker table ${table}, seat ${j.seat}`);
  const rng = rngFor(`${name}-${Date.now()}`);
  let lastHand = 0;
  for (;;) {
    const v = await c.wait(25, { anyChange: true });
    if (!v.you) throw new Error('lost the seat');
    if (v.phase === 'done' && v.lastHand && v.lastHand.handNo !== lastHand) {
      lastHand = v.lastHand.handNo;
      await brain.onHandEnd(v, v.seats.map((s) => (s ? s.player.name : undefined)));
      saveData(brain);
      if (lastHand % 25 === 0) log(`stats ${JSON.stringify(brain.stats)}`);
      if (hands && brain.stats.hands >= hands) break;
    }
    if (v.you.yourTurn) {
      const d = await brain.decide(v, rng);
      await c.act(d.action, d.amount).catch((e) => { if (!/turn|not legal|No hand/i.test(e.message)) throw e; });
    }
  }
  await c.leave().catch(() => {});
  return brain.stats;
}

async function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const opts = { url: flag('--url', 'http://192.168.4.43:8787'), table: flag('--table', 'p1'), name: flag('--name', 'Gemma (poker)'), llm: flag('--llm', DEFAULT_LLM), hands: Number(flag('--hands', 0)), log: (m) => console.log(`${new Date().toISOString()} ${m}`) };
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  for (;;) {
    try { const s = await playLive(opts); opts.log(`done: ${JSON.stringify(s)}`); return; } catch (e) { opts.log(`${e.message}; retrying in 30 s`); await new Promise((r) => setTimeout(r, 30000)); }
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { makeBrain, menu, SYSTEM };
