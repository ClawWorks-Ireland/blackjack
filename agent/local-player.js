#!/usr/bin/env node
/**
 * A local-model player (CLA-116): sits at a live table as an AI player and
 * plays continuously, asking the household gaming PC's model (through the
 * local-models script, which skips the PC while it's in Gaming Mode or busy)
 * for every move, and queues what it notices for triage into Linear
 * (agent/feedback.js).
 *
 *   node agent/local-player.js --url http://192.168.4.43:8787 --table 2 --name "Gemma (local)"
 *     [--llm "/usr/bin/python3 ~/.claude/skills/local-models/scripts/llm.py"]
 *     [--rounds 0 (forever)] [--reflect-every 25] [--round-pause 4] [--busy-pause 120] [--queue file]
 *
 * - Bets the table minimum. Each move goes to the model with the table as
 *   text and the legal moves; an answer that isn't a legal move, or no answer
 *   in time, falls back to basic strategy (counted, not reported).
 * - While the model is unavailable (PC busy, Gaming Mode, unreachable) it
 *   leaves the table, checks again every --busy-pause seconds, and sits
 *   down again once the model is back.
 * - Findings: what the harness sees for certain (server errors, a stuck
 *   table, a bankroll that doesn't add up) and, every --reflect-every rounds,
 *   the model's own notes on what was missing, unclear or wrong in the
 *   messages it got. Both go to server/data/agent-feedback.jsonl.
 */
'use strict';
const os = require('os');
const { execFile } = require('child_process');
const { TableClient, toObs, yourMove } = require('./table-client.js');
const { liveSummary } = require('./mcp.js');
const { FeedbackQueue } = require('./feedback.js');

const DEFAULT_LLM = `/usr/bin/python3 ${os.homedir()}/.claude/skills/local-models/scripts/llm.py`;
/**
 * Basic strategy as plain rules, for the tables' default rules (6 decks,
 * dealer stands on soft 17, double after split, late surrender). Added after
 * a breakdown of 558 decisions: without them the model hit 12-16 against a
 * weak dealer, stood on 12-16 against a strong one, and split 5s.
 */
const STRATEGY_RULES = [
  'Play by these rules (the dealer stands on soft 17; "dealer" means the dealer\'s up card; A = ace, worth 11):',
  'Pairs, on your first two cards: always split aces and 8s. Never split 5s (play them as hard 10) or 10s (stand).',
  '  Split 2s, 3s and 7s against dealer 2-7. Split 6s against 2-6. Split 9s against 2-6, 8 and 9 (stand on 9s against 7, 10, A). Split 4s against 5-6 only.',
  'Hard totals: 17 or more: stand. 13-16: stand against dealer 2-6, hit against 7-A. 12: stand against 4-6, hit against 2, 3 and 7-A.',
  '  11: double against 2-10, hit against A. 10: double against 2-9, hit against 10 and A. 9: double against 3-6, otherwise hit. 8 or less: hit.',
  '  Surrender (when legal) 16 against 9, 10 and A, and 15 against 10; otherwise do not surrender.',
  'Soft totals (an ace counted as 11): soft 19 or more: stand. Soft 18: double against 3-6 (stand if you can\'t double), stand against 2, 7, 8, hit against 9, 10, A.',
  '  Soft 17: double against 3-6, otherwise hit. Soft 15-16: double against 4-6, otherwise hit. Soft 13-14: double against 5-6, otherwise hit.',
  'If the rule says double but double is not legal, hit (stand on soft 18). Never take insurance.',
].join('\n');
const MOVE_SYSTEM = 'You are an AI playing blackjack against the dealer. Choose the best move.\n'
  + `${STRATEGY_RULES}\n`
  + 'Answer with exactly one of the legal moves, as written, and nothing else.';
const REFLECT_SYSTEM = 'You are an AI player testing a blackjack table web service. You will see the messages the table sent you. '
  + 'Report only problems the messages themselves show: information that was missing, unclear, inconsistent or wrong, or play that broke the rules. '
  + 'These are the rules, so they are not problems: a total over 21 is a bust; a dealer who busts loses to every hand still in play; '
  + 'a player who busts loses even if the dealer busts too; "showing N" is the dealer\'s up card while the hole card is face down; '
  + 'blackjack pays 3:2; a push returns the bet; the bankroll leaves out chips that are on the table. '
  + 'Do not give strategy advice. Reply as JSON: {"items":[{"title":"short summary","detail":"what and why","evidence":"the message text that shows it"}]}, '
  + 'at most 3 items, or {"items":[]} if nothing was wrong.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the local-models script; resolves {ok, text, code}. Exit 3 unreachable, 4 busy, 5 model error. */
function askModel(llm, system, instruction, input, { json = false, maxTokens = 8, timeoutMs = 20000 } = {}) {
  const [cmd, ...pre] = llm.split(' ');
  const args = [...pre, '--system', system, '--max-tokens', String(maxTokens), ...(json ? ['--json'] : []), instruction, '-f', '-'];
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve({ ok: !err, text: String(stdout || '').trim(), code: err ? (err.code ?? 'timeout') : 0 });
    });
    child.stdin.end(input);
  });
}

/** The first legal move named in the model's answer, or null. */
function pickMove(answer, legal) {
  const a = answer.toLowerCase().replace(/[^a-z_ ]/g, ' ');
  if (legal.includes('decline_insurance') && /\b(decline|no insurance|no)\b/.test(a)) return 'decline_insurance';
  const names = [...legal].sort((x, y) => y.length - x.length); // decline_insurance before insurance
  for (const word of a.split(/\s+/)) {
    const hit = names.find((n) => n === word || n.replace('_', ' ') === word);
    if (hit) return hit;
  }
  const first = names.find((n) => a.includes(n.replace('_', ' ')) || a.includes(n));
  return first || null;
}

/** What the model sees for a decision: the table line, your hand, the legal moves with costs. */
function decisionPrompt(v) {
  const me = v.seats[v.you.seat];
  const legal = v.you.legal.map((m) => `${m}${v.you.legalCost[m] ? ` (costs ${v.you.legalCost[m]} more)` : ''}`).join(', ');
  const h = me.hands[me.active];
  const hand = v.phase === 'insurance' ? `Your hand: ${me.hands[0].cards.join(' ')} (${me.hands[0].total})` : `Your hand to play: ${h.cards.join(' ')} (${h.soft ? 'soft ' : ''}${h.total})`;
  return `${liveSummary(v)}\n\nDealer shows: ${v.dealer.cards[0]}\n${hand}\nLegal moves: ${legal}`;
}

class LocalPlayer {
  constructor({ url, table, name = 'Gemma (local)', llm = DEFAULT_LLM, rounds = 0, reflectEvery = 25, roundPauseMs = 4000, busyPauseMs = 120000, queue = new FeedbackQueue(), log = console.log, model = 'local' }) {
    Object.assign(this, { url, table, name, llm, rounds, reflectEvery, roundPauseMs, busyPauseMs, queue, log, model });
    this.client = new TableClient(url);
    this.transcript = []; // recent summary lines, for reflection
    this.stats = { rounds: 0, moves: 0, modelMoves: 0, fallbacks: 0, busy: 0, reflections: 0, findings: 0 };
    this.stopped = false;
  }

  report(source, kind, title, detail, evidence = '') {
    if (this.queue.add({ source, kind, title, detail, evidence, agent: this.name, model: this.model, table: this.table, round: this.lastView ? this.lastView.round : null })) {
      this.stats.findings++;
      this.log(`queued ${kind}: ${title}`);
    }
  }

  note(v) {
    this.lastView = v;
    this.transcript.push(liveSummary(v));
    if (this.transcript.length > 60) this.transcript.shift();
  }

  /** A server error is a finding; a refused move because the clock got there first is not. */
  async call(fn, what) {
    try {
      return await fn();
    } catch (e) {
      if (/turn|not legal|not in play|in play|exceeds|Nobody/i.test(e.message)) return null; // races with the clock
      if (/can't reach/.test(e.message)) throw e;
      this.report('harness', 'bug', `Server refused ${what}: ${e.message}`.slice(0, 120), `The table server answered an error while the agent tried to ${what}.`, e.message);
      return null;
    }
  }

  async modelReady() {
    const r = await new Promise((resolve) => execFile(this.llm.split(' ')[0], [...this.llm.split(' ').slice(1), 'status'], { timeout: 30000 },
      (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), why: err ? `exit ${err.code ?? err.signal}: ${String(out || '').trim() || String(errOut || '').trim().split('\n').pop()}` : '' })));
    if (r.ok) { try { this.model = JSON.parse(r.out).model || this.model; } catch (_) { /* keep */ } }
    else if (r.why !== this.lastWhy) { this.lastWhy = r.why; this.log(`model status: ${r.why}`); }
    return r.ok;
  }

  async decide(v) {
    const { obs, hint } = toObs(v);
    this.stats.moves++;
    const r = await askModel(this.llm, MOVE_SYSTEM, 'Which move?', decisionPrompt(v));
    const move = r.ok ? pickMove(r.text, obs.legal) : null;
    if (move) { this.stats.modelMoves++; return move; }
    this.stats.fallbacks++;
    if (!r.ok && (r.code === 4 || r.code === 3)) this.paused = true;
    return hint.action;
  }

  async reflect() {
    this.stats.reflections++;
    const r = await askModel(this.llm, REFLECT_SYSTEM, 'What problems do these table messages show?', this.transcript.slice(-40).join('\n'), { json: true, maxTokens: 600, timeoutMs: 120000 });
    if (!r.ok) return;
    let items = [];
    try { items = JSON.parse(r.text).items || []; } catch (_) { return; }
    for (const it of items.slice(0, 3)) {
      if (it && it.title) this.report('model', 'feedback', String(it.title), String(it.detail || ''), String(it.evidence || ''));
    }
  }

  async run() {
    const j = await this.client.join(this.table, this.name);
    this.log(`${this.name} seated at table ${this.table}, seat ${j.seat}`);
    let v = j.view;
    let bankrollBefore = null;
    let netExpectedRound = null;
    let lastChange = Date.now();
    let lastSig = '';
    while (!this.stopped && (!this.rounds || this.stats.rounds < this.rounds)) {
      v = await this.client.wait(25);
      if (!v.you) throw new Error('lost the seat');
      this.note(v);
      const sig = `${v.round}:${v.phase}:${v.turn}:${v.version}`;
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
      if ((v.phase === 'player' || v.phase === 'insurance') && Date.now() - lastChange > 180000) {
        this.report('harness', 'bug', `Table stuck in ${v.phase} with seat ${v.turn} to act`, 'Nothing changed for 3 minutes while a round was in play, though the turn clock should act after 30 s.', liveSummary(v));
        lastChange = Date.now();
      }
      const move = yourMove(v);
      if (move === 'bet') {
        if (v.phase === 'done') { await this.client.wait(5, { anyChange: true }).catch(() => {}); continue; }
        // The bankroll must have moved by exactly the last round's net.
        const last = v.you.lastRound;
        if (bankrollBefore !== null && last && last.round === netExpectedRound) {
          const diff = Math.round((v.you.bankroll - bankrollBefore) * 100) / 100;
          if (diff !== last.net) this.report('harness', 'bug', `Bankroll moved ${diff} but the round's net was ${last.net}`, `Round ${last.round}: bankroll before the bet ${bankrollBefore}, after the round ${v.you.bankroll}.`, JSON.stringify(last));
          this.stats.rounds++;
          if (this.reflectEvery && this.stats.rounds % this.reflectEvery === 0) await this.reflect();
        }
        if (this.paused || this.stats.rounds % 20 === 0) this.paused = !(await this.modelReady());
        if (this.paused) {
          // Give the seat up rather than hold it unused; sit down again once the model is back.
          this.stats.busy++;
          this.log('model unavailable (gaming PC busy, in Gaming Mode or unreachable): leaving the table for now');
          await this.client.leave().catch(() => this.call(() => this.client.sitOut(), 'sit out'));
          while (!this.stopped && !(await this.modelReady())) await sleep(this.busyPauseMs);
          if (this.stopped) break;
          this.paused = false;
          bankrollBefore = null;
          const back = await this.client.join(this.table, this.name);
          this.log(`model back: seated again at seat ${back.seat}`);
          continue;
        }
        if (this.roundPauseMs) await sleep(this.roundPauseMs);
        bankrollBefore = v.you.bankroll;
        const bet = await this.call(() => this.client.bet(v.table.minBet), 'bet');
        if (bet) netExpectedRound = bet.round + 1;
      } else if (move === 'insurance' || move === 'play') {
        if (move === 'play' && (!v.you.legal || !v.you.legal.length)) this.report('harness', 'bug', 'My turn with no legal moves', 'The view said it was my turn but listed no legal moves.', liveSummary(v));
        const a = await this.decide(v);
        await this.call(() => this.client.act(a), `play ${a}`);
      }
    }
    return this.stats;
  }
}

async function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const p = new LocalPlayer({
    url: flag('--url', 'http://192.168.4.43:8787'), table: flag('--table', '2'), name: flag('--name', 'Gemma (local)'),
    llm: flag('--llm', DEFAULT_LLM), rounds: Number(flag('--rounds', 0)), reflectEvery: Number(flag('--reflect-every', 25)),
    roundPauseMs: Number(flag('--round-pause', 4)) * 1000, busyPauseMs: Number(flag('--busy-pause', 120)) * 1000,
    log: (m) => console.log(`${new Date().toISOString()} ${m}`),
    ...(flag('--queue') ? { queue: new FeedbackQueue({ file: flag('--queue') }) } : {}),
  });
  const stop = () => { p.stopped = true; p.client.leave().catch(() => {}).finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => p.log(`stats ${JSON.stringify(p.stats)}`), 600000).unref();
  // The server may not be up yet (at login): keep trying, slowly.
  for (;;) {
    try {
      const s = await p.run();
      p.log(`done: ${JSON.stringify(s)}`);
      await p.client.leave().catch(() => {});
      return;
    } catch (e) {
      p.log(`${e.message}; retrying in 30 s`);
      p.client = new TableClient(p.url);
      await sleep(30000);
    }
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { LocalPlayer, askModel, pickMove, decisionPrompt, MOVE_SYSTEM, STRATEGY_RULES };
