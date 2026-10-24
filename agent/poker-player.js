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
 *
 * With `feedback: true` (CLA-124) it also learns from its own results: a
 * ledger per opponent of its main move type each hand (bluff, thin bet, value
 * bet, call, fold, by its equity at the time) and what it won or lost in big
 * blinds, plus plain facts from the opponent's numbers ("folds to a bet only
 * 4%: bluffs lose here"), both in its notes and in every decision; and a code
 * guardrail takes weak-hand bets off the menu against players who almost never
 * fold, and takes the small and medium bets off it when it has a strong hand
 * against them (CLA-126: they pay off big bets as readily as small ones).
 * `feedback: false` is the player as first benchmarked (CLA-123).
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
const NOTE_SYSTEM_FEEDBACK = 'You are a poker coach. From an opponent\'s statistics, the facts about them, and the player\'s own results '
  + 'against them by move type (in big blinds), write two or three short sentences: how this opponent plays, which of the player\'s moves '
  + 'are working against them and which are losing, and what to do more and less of. Respect the facts. No preamble.';

const KINDS = ['bluff', 'thin', 'value', 'call', 'fold'];
const KIND_NAME = { bluff: 'bluffs', thin: 'thin bets', value: 'value bets', call: 'calls', fold: 'folds' };

/** What a move was, by the equity the player had when it made it. */
function kindOf(action, eq) {
  if (action === 'fold') return 'fold';
  if (action === 'call') return 'call';
  if (action === 'bet' || action === 'raise' || action === 'allin') return eq < 0.4 ? 'bluff' : eq < 0.6 ? 'thin' : 'value';
  return null; // a check
}

/** Plain facts from an opponent's numbers, stated only with enough evidence. */
function facts(profiles, name) {
  const s = profiles.stats(name);
  const out = [];
  if (s.facedBets >= 15 && s.foldToBet !== null && s.foldToBet < 12) out.push(`folds to a bet only ${s.foldToBet}%: bluffs lose against them; bet big when you have it`);
  if (s.facedBets >= 15 && s.foldToBet !== null && s.foldToBet > 50) out.push(`folds to a bet ${s.foldToBet}%: bets and raises win pots against them even with weak hands`);
  if (s.hands >= 30 && s.pfr !== null && s.pfr > 40) out.push(`raises preflop ${s.pfr}% of hands: often with nothing; call down lighter`);
  if (s.hands >= 30 && s.vpip !== null && s.vpip < 20) out.push(`plays only ${s.vpip}% of hands: their bets and raises usually mean strength`);
  return out;
}

const neverFolds = (profiles, name) => { const s = profiles.stats(name); return s.facedBets >= 15 && s.foldToBet !== null && s.foldToBet < 12; };

/** The menu: concrete legal moves, sizes from the pot. `def` is the default move to mark. */
function menu(view, def) {
  const you = view.you;
  const legal = Object.fromEntries(you.legal.map((l) => [l.action, l]));
  const pot = view.pot;
  const opts = [];
  const add = (label, action, amount, size) => { if (!opts.some((o) => o.action === action && o.amount === amount)) opts.push({ label, action, amount, size }); };
  if (legal.fold && you.toCall > 0) add('fold', 'fold');
  if (legal.check) add('check', 'check');
  if (legal.call) add(`call ${legal.call.amount}`, 'call');
  const up = legal.raise || legal.bet;
  if (up) {
    const clamp = (x) => Math.min(up.max, Math.max(up.min, Math.round(x)));
    const base = legal.raise ? view.currentBet : 0;
    const after = pot + you.toCall;
    const verb = legal.raise ? 'raise to' : 'bet';
    for (const [name, f] of [['small', legal.raise ? 0.5 : 0.33], ['medium', 0.75], ['big', 1.1]]) add(`${verb} ${clamp(base + after * f)} (${name})`, up.action, clamp(base + after * f), name);
    add(`all-in (${up.max})`, up.action, up.max, 'all-in');
  }
  // Mark the default: same action, nearest amount.
  let best = null;
  for (const o of opts) {
    if (o.action !== def.action && !(def.action === 'allin' && o.amount === (up && up.max))) continue;
    if (!best || Math.abs((o.amount || 0) - (def.amount || 0)) < Math.abs((best.amount || 0) - (def.amount || 0))) best = o;
  }
  return opts.map((o, i) => ({ ...o, letter: 'ABCDEFGH'[i], isDefault: o === best }));
}

function makeBrain({ llm = DEFAULT_LLM, profiles = new Profiles(), notes = {}, ledger = {}, feedback = false, notesEvery = 30, log = () => {}, ask = askModel } = {}) {
  const stats = { decisions: 0, modelPicks: 0, followedDefault: 0, fallbacks: 0, notes: 0, hands: 0, guarded: 0, sizedUp: 0 };
  let thisHand = []; // [{kind, opponents}] for the hand in play

  /** "bluffs 14 tries, -38 bb; value bets 22, +140 bb; ..." */
  const ledgerLine = (name) => {
    const l = ledger[name];
    if (!l) return null;
    const parts = KINDS.filter((k) => l[k] && l[k].n).map((k) => `${KIND_NAME[k]} ${l[k].n}, ${l[k].bb >= 0 ? '+' : ''}${Math.round(l[k].bb)} bb`);
    return parts.length ? parts.join('; ') : null;
  };

  const self = {
    name: feedback ? 'llm-feedback' : 'llm', stats, profiles, notes, ledger, feedback,
    description: 'LLM player: profiles opponents and bends the default to exploit them.',

    async decide(view, rng = Math.random) {
      stats.decisions++;
      const def = POLICIES.default.decide(view, rng);
      const s = situation(view, rng, 300);
      const you = view.you;
      const inHand = view.seats.filter((x, i) => x && i !== you.seat && x.inHand && !x.folded).map((x) => x.player.name);
      let opts = menu(view, def);
      // Guardrail: against players who almost never fold, a weak-hand bet is just a donation.
      if (feedback && s.eq < 0.35 && inHand.length && inHand.every((n) => neverFolds(profiles, n))) {
        const kept = opts.filter((o) => o.action !== 'bet' && o.action !== 'raise');
        if (kept.length < opts.length) {
          stats.guarded++;
          if (!kept.some((o) => o.isDefault)) {
            const safe = kept.find((o) => o.action === 'check') || kept.find((o) => o.action === 'fold') || kept[0];
            safe.isDefault = true;
          }
          opts = kept.map((o, i) => ({ ...o, letter: 'ABCDEFGH'[i] }));
        }
      }
      // And with a strong hand against them, small bets leave money behind: they call big ones just as often.
      if (feedback && s.eq >= 0.6 && inHand.length && inHand.every((n) => neverFolds(profiles, n))) {
        const kept = opts.filter((o) => o.size !== 'small' && o.size !== 'medium');
        if (kept.length < opts.length && kept.some((o) => o.size === 'big' || o.size === 'all-in')) {
          stats.sizedUp++;
          const wasBet = opts.some((o) => o.isDefault && (o.size === 'small' || o.size === 'medium'));
          opts = kept.map((o, i) => ({ ...o, letter: 'ABCDEFGH'[i], isDefault: wasBet ? o.size === 'big' || (o.size === 'all-in' && !kept.some((k) => k.size === 'big')) : o.isDefault }));
        }
      }
      const fallback = opts.find((o) => o.isDefault) || opts[0];
      const handName = view.board.length >= 3 ? evaluate([...you.cards, ...view.board]).name : null;
      const opponents = view.seats.filter((x, i) => x && i !== you.seat && x.inHand && !x.folded).map((x) => {
        const n = x.player.name;
        const extra = feedback ? [
          ...facts(profiles, n).map((f) => ` Fact: ${f}.`),
          ledgerLine(n) ? ` Your results against them: ${ledgerLine(n)}.` : '',
        ].join('') : '';
        return `- ${n}: stack ${x.stack}${x.bet ? `, bet ${x.bet} this street` : ''}${x.lastAction ? `, last move ${x.lastAction}` : ''}. Stats: ${profiles.line(n)}.${extra}${notes[n] ? ` Your notes: ${notes[n]}` : ''}`;
      });
      const prompt = [
        `Street: ${view.phase}. Your cards: ${you.cards.join(' ')}. Board: ${view.board.join(' ') || 'none yet'}.${handName ? ` You have ${handName}.` : ''}`,
        `Equity ${Math.round(s.eq * 100)}% against ${s.opponents} opponent${s.opponents === 1 ? '' : 's'}. Pot ${view.pot}. To call ${you.toCall}${you.toCall ? ` (pot odds ${Math.round(s.potOdds * 100)}%)` : ''}. Your stack ${you.stack}. Big blind ${view.bigBlind}.`,
        'Opponents still in:', ...opponents,
        'Moves:', ...opts.map((o) => `${o.letter}) ${o.label}${o.isDefault ? '  <- default' : ''}`),
      ].join('\n');
      const r = await ask(llm, SYSTEM, 'Which move? Answer with the letter only.', prompt, { maxTokens: 4, timeoutMs: 20000 });
      const letter = r.ok ? (r.text.toUpperCase().match(/\b([A-H])\b/) || r.text.toUpperCase().match(/([A-H])/) || [])[1] : null;
      let pick = letter && opts.find((o) => o.letter === letter);
      if (!pick) { stats.fallbacks++; pick = fallback; } else { stats.modelPicks++; if (pick.isDefault) stats.followedDefault++; }
      const kind = kindOf(pick.action, s.eq);
      if (kind) thisHand.push({ kind, opponents: inHand });
      return { action: pick.action, amount: pick.amount };
    },

    async onHandEnd(view, names) {
      if (!view.lastHand) return;
      stats.hands++;
      profiles.addHand(names, view.log, view.lastHand);
      // The ledger: this hand's main move against the opponents it was made against, and the result.
      const moves = thisHand;
      thisHand = [];
      if (view.you && moves.length) {
        const net = view.lastHand.net[view.you.seat];
        const rank = { bluff: 3, value: 3, thin: 3, call: 2, fold: 1 };
        const main = moves.reduce((a, m) => (rank[m.kind] >= rank[a.kind] ? m : a));
        const against = main.opponents.length ? main.opponents : [];
        for (const o of against) {
          const l = (ledger[o] = ledger[o] || {});
          const e = (l[main.kind] = l[main.kind] || { n: 0, bb: 0 });
          e.n++;
          e.bb += net / view.bigBlind / against.length;
        }
      }
      if (stats.hands % notesEvery !== 0) return;
      const me = view.you ? view.seats[view.you.seat].player.name : null;
      for (const n of new Set(names)) {
        if (n === me || profiles.stats(n).hands < 20) continue;
        const input = feedback
          ? `Opponent: ${n}\nStatistics: ${profiles.line(n)}\nFacts: ${facts(profiles, n).join('; ') || 'none yet'}\nYour results against them: ${ledgerLine(n) || 'none yet'}`
          : `Opponent: ${n}\nStatistics: ${profiles.line(n)}`;
        const r = await ask(llm, feedback ? NOTE_SYSTEM_FEEDBACK : NOTE_SYSTEM, 'Write the note.', input, { maxTokens: 160, timeoutMs: 60000 });
        if (r.ok && r.text) { notes[n] = r.text.replace(/\s+/g, ' ').slice(0, 300); stats.notes++; log(`note on ${n}: ${notes[n]}`); }
      }
    },
  };
  return self;
}

function loadData(file = DATA) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { profiles: new Profiles(d.profiles || {}), notes: d.notes || {}, ledger: d.ledger || {} }; } catch (_) { return { profiles: new Profiles(), notes: {}, ledger: {} }; }
}
function saveData(brain, file = DATA) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ profiles: brain.profiles.toJSON(), notes: brain.notes, ledger: brain.ledger }, null, 1));
}

/** Play live at a poker table until stopped. */
async function playLive({ url, table, name, llm = DEFAULT_LLM, log = console.log, hands = 0 }) {
  const data = loadData();
  const brain = makeBrain({ llm, ...data, log, feedback: true });
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
module.exports = { makeBrain, menu, facts, kindOf, SYSTEM };
