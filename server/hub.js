/**
 * The live tables behind server.js (CLA-111), with no HTTP in it so it can be
 * tested directly. A hub holds tables (engine/table.js); each live table
 * seats players by token, starts a round once everyone seated has bet or sat
 * out, keeps the clock, plays bots, and tells subscribers whenever anything
 * changes. Settled rounds go to the players leaderboard (leaderboard.js).
 *
 * Player kinds: "ai" and "human" are self-reported by the client that joins
 * (agent clients send "ai", the web page "human" unless the player ticks
 * "I'm an agent"); "bot" is a basic-strategy seat the table itself plays.
 */
'use strict';
const crypto = require('crypto');
const { Table, TableError } = require('../engine/table.js');
const { checkRules, EnvError } = require('../agent/env.js');
const Strategy = require('../engine/strategy.js');

const KINDS = ['ai', 'human'];
const DEFAULTS = { betSeconds: 20, turnSeconds: 30, botDelayMs: 400, nextRoundMs: 2500, idleRounds: 5, bankroll: 1000 };

class HubError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
const token = () => crypto.randomBytes(16).toString('hex');

class LiveTable {
  constructor(hub, id, { name, rules = {}, minBet = 10, maxBet = 500, bots = 0, seed, ...timing }) {
    this.hub = hub;
    this.id = id;
    this.name = cleanName(name) || `Table ${id}`;
    this.timing = { ...DEFAULTS, ...hub.timing, ...timing };
    let full;
    try { full = checkRules(rules); } catch (e) { throw new HubError(e instanceof EnvError ? e.message : 'bad rules'); }
    if (!(minBet > 0) || !(maxBet >= minBet)) throw new HubError('minBet must be positive and at most maxBet');
    if (!Number.isInteger(bots) || bots < 0 || bots > 6) throw new HubError('bots must be 0 to 6');
    this.table = new Table({ seed: seed || token(), ...full, minBet, maxBet });
    this.players = new Map(); // token -> {id, name, kind, seat, idle}
    this.subscribers = new Set(); // {token, send(view)}
    this.version = 0;
    this.deadline = null; // {at, what} for the current timer
    this.timer = null;
    this.waiters = new Set(); // long-poll resolvers
    this.lastRounds = new Map(); // seat -> how that seat's last round went
    for (let i = 0; i < bots; i++) this.seatBot(i);
    this.created = new Date().toISOString();
  }

  seatBot(n) {
    const t = token();
    const seat = this.table.sit({ id: `bot-${this.id}-${n}`, name: `Bot ${n + 1}`, kind: 'bot' }, 1e9);
    this.players.set(t, { id: `bot-${this.id}-${n}`, name: `Bot ${n + 1}`, kind: 'bot', seat, idle: 0 });
  }

  // --- Players ---

  join({ name, kind = 'human', seat, bankroll } = {}) {
    const n = cleanName(name);
    if (!n) throw new HubError('A name is required (up to 24 characters)');
    if (!KINDS.includes(kind)) throw new HubError('kind must be "ai" or "human"');
    const t = token();
    const id = `${kind}:${n.toLowerCase()}:${t.slice(0, 6)}`;
    let at;
    try {
      at = this.table.sit({ id, name: n, kind }, bankroll || this.timing.bankroll, seat === undefined || seat === null ? undefined : seat);
    } catch (e) {
      throw new HubError(e.message, e.message.includes('full') || e.message.includes('taken') ? 409 : 400);
    }
    this.players.set(t, { id, name: n, kind, seat: at, idle: 0 });
    this.changed();
    return { token: t, seat: at, table: this.id };
  }

  player(t) {
    const p = this.players.get(t);
    if (!p || p.kind === 'bot') throw new HubError('Unknown player token', 403);
    return p;
  }

  leave(t) {
    const p = this.player(t);
    try { this.table.leave(p.seat); } catch (e) { throw new HubError(e.message, 409); }
    this.players.delete(t);
    this.lastRounds.delete(p.seat);
    this.changed();
  }

  // --- Moves ---

  bet(t, amount) {
    const p = this.player(t);
    this.engine(() => this.table.bet(p.seat, Number(amount)));
    p.idle = 0;
    this.changed();
  }

  sitOut(t) {
    const p = this.player(t);
    this.engine(() => this.table.sitOut(p.seat));
    this.changed();
  }

  act(t, action) {
    const p = this.player(t);
    this.engine(() => this.table.act(p.seat, String(action)));
    p.idle = 0;
    this.changed();
  }

  engine(fn) {
    try { fn(); } catch (e) {
      if (e instanceof TableError) throw new HubError(e.message, 409);
      throw e;
    }
  }

  // --- The clock, bots and rounds ---

  /** Called after every change: settle, deal, play bots, set the next timer, tell everyone. */
  changed() {
    const t = this.table;
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    if (t.phase === 'done') {
      // Every change clears the timer above, so a join or leave between rounds must set it again,
      // or the table never reopens betting (CLA-117).
      if (!this.recorded) this.settle();
      this.after(this.timing.nextRoundMs, 'next round', () => this.openBetting());
    } else if (t.phase === 'betting') {
      this.recorded = false;
      this.betBots();
      if (t.ready) this.after(300, 'deal', () => { this.engine(() => t.deal()); this.changed(); });
      else if (t.seats.some((s) => s && s.bet > 0)) this.after(this.timing.betSeconds * 1000, 'bet', () => this.timeoutBets());
    } else if (t.turn !== null) {
      const s = t.seats[t.turn];
      if (s.player.kind === 'bot') this.after(this.timing.botDelayMs, 'bot', () => this.playBot());
      else this.after(this.timing.turnSeconds * 1000, 'turn', () => this.timeoutTurn());
    }
    this.version++;
    this.broadcast();
  }

  /** A round just ended: record it once, and keep each seat's result for the next views. */
  settle() {
    const t = this.table;
    this.recorded = true;
    this.hub.record(this);
    // Keep each seat's result: a round can settle without asking you anything (a blackjack),
    // and betting for the next one opens before a slow client looks again.
    const v = t.view(null);
    v.seats.forEach((s, i) => { if (s && s.hands.length) this.lastRounds.set(i, { round: v.round, dealer: v.dealer.cards, dealerTotal: v.dealer.total, hands: s.hands, net: s.net }); });
  }

  after(ms, what, fn) {
    this.deadline = { at: Date.now() + ms, ms, what };
    this.timer = setTimeout(() => {
      this.timer = null;
      try { fn(); } catch (e) { this.hub.log(`table ${this.id}: ${e.message}`); }
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  /** After a round, betting reopens; bots bet at once, people get the bet timer once someone bets. */
  openBetting() {
    const t = this.table;
    if (t.phase !== 'done') return;
    t.toBetting();
    // Players who keep missing rounds give their seat up.
    for (const [tok, p] of this.players) {
      if (p.kind === 'bot') continue;
      if (p.idle >= this.timing.idleRounds) { try { t.leave(p.seat); } catch (_) { /* in a round */ } this.players.delete(tok); }
    }
    this.changed();
  }

  betBots() {
    const t = this.table;
    const people = [...this.players.values()].some((p) => p.kind !== 'bot');
    for (const p of this.players.values()) {
      if (p.kind !== 'bot') continue;
      const s = t.seats[p.seat];
      // Bots only play while someone real is at the table.
      if (people && s.bet === 0 && !s.out) t.bet(p.seat, t.minBet);
    }
  }

  timeoutBets() {
    const t = this.table;
    for (const p of this.players.values()) {
      const s = t.seats[p.seat];
      if (s && s.bet === 0 && !s.out) { t.sitOut(p.seat); p.idle++; }
    }
    this.changed();
  }

  /** A player who doesn't move in time stands (or declines insurance). */
  timeoutTurn() {
    const t = this.table;
    const seat = t.turn;
    if (seat === null) return;
    const p = [...this.players.values()].find((x) => x.seat === seat);
    if (p) p.idle++;
    t.act(seat, t.phase === 'insurance' ? 'decline_insurance' : 'stand');
    this.changed();
  }

  playBot() {
    const t = this.table;
    const seat = t.turn;
    if (seat === null) return;
    if (t.phase === 'insurance') t.act(seat, 'decline_insurance');
    else {
      const s = t.seats[seat];
      const legal = t.legal(seat);
      const allowed = { canHit: legal.includes('hit'), canDouble: legal.includes('double'), canSplit: legal.includes('split'), canSurrender: legal.includes('surrender') };
      const a = Strategy.recommend(s.hands[s.active].cards, t.dealer[0], allowed, t.rules).action;
      t.act(seat, legal.includes(a) ? a : 'stand');
    }
    this.changed();
  }

  // --- What players see ---

  view(t = null) {
    const p = t ? this.players.get(t) : null;
    const v = this.table.view(p ? p.seat : null);
    if (v.you) {
      v.you.lastRound = this.lastRounds.get(p.seat) || null;
      // Chips out on the table this round (bets, doubles, splits, insurance), not in your bankroll.
      const s = this.table.seats[p.seat];
      v.you.onTable = s.inRound && v.phase !== 'done' ? s.hands.reduce((a, h) => a + h.bet, 0) + s.insurance : 0;
    }
    return {
      id: this.id, name: this.name, version: this.version,
      deadline: this.deadline ? { what: this.deadline.what, ms: this.deadline.ms, msLeft: Math.max(0, this.deadline.at - Date.now()) } : null,
      ...v,
    };
  }

  summary() {
    const t = this.table;
    return {
      id: this.id, name: this.name, phase: t.phase, round: t.round, rules: t.rules,
      minBet: t.minBet, maxBet: t.maxBet,
      seats: t.seats.map((s, i) => (s ? { seat: i, name: s.player.name, kind: s.player.kind } : null)),
      free: t.seats.filter((s) => !s).length,
    };
  }

  subscribe(t, send) {
    const sub = { token: t, send };
    this.subscribers.add(sub);
    send(this.view(t));
    return () => this.subscribers.delete(sub);
  }

  broadcast() {
    for (const sub of this.subscribers) {
      try { sub.send(this.view(sub.token)); } catch (_) { this.subscribers.delete(sub); }
    }
    for (const w of [...this.waiters]) w();
  }

  /**
   * Resolve when it is `t`'s move (or betting is open for it), or the table
   * has changed past `since`, or after `timeoutMs`. For agents that poll.
   */
  wait(t, since, timeoutMs = 25000) {
    const p = this.player(t);
    const ready = () => {
      const v = this.table;
      const yours = v.turn === p.seat || ((v.phase === 'betting' || v.phase === 'done') && v.seats[p.seat] && v.seats[p.seat].bet === 0 && !v.seats[p.seat].out);
      return yours || (since !== undefined && this.version > since);
    };
    if (ready()) return Promise.resolve(this.view(t));
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(check); resolve(this.view(t)); };
      const check = () => { if (ready()) done(); };
      const timer = setTimeout(done, Math.min(timeoutMs, 60000));
      if (timer.unref) timer.unref();
      this.waiters.add(check);
    });
  }

  close() {
    clearTimeout(this.timer);
    for (const w of [...this.waiters]) w();
  }
}

class Hub {
  constructor({ leaderboard = null, timing = {}, log = () => {}, maxTables = 20 } = {}) {
    this.tables = new Map();
    this.maxTables = maxTables;
    this.playerTables = 0;
    this.leaderboard = leaderboard;
    this.timing = timing;
    this.log = log;
    this.next = 1;
  }

  create(opts = {}, { seeded = false } = {}) {
    if (!seeded && this.playerTables >= this.maxTables) {
      throw new HubError(`Table limit reached: ${this.maxTables} player tables are open. Join one of them instead.`, 409);
    }
    const id = String(this.next++);
    const lt = new LiveTable(this, id, opts);
    if (!seeded) this.playerTables++;
    this.tables.set(id, lt);
    return lt;
  }

  get(id) {
    const lt = this.tables.get(String(id));
    if (!lt) throw new HubError(`No table ${id}`, 404);
    return lt;
  }

  list() { return [...this.tables.values()].map((t) => t.summary()); }

  /** A settled round: every human and AI seat that played goes on the leaderboard. */
  record(lt) {
    if (!this.leaderboard) return;
    const t = lt.table;
    for (const s of t.seats) {
      if (!s || !s.inRound || s.player.kind === 'bot') continue;
      this.leaderboard.add({
        name: s.player.name, kind: s.player.kind, net: s.net, bet: s.bet, minBet: t.minBet,
        blackjacks: s.results.filter((r) => r.outcome === 'blackjack').length,
      });
    }
  }

  close() { for (const t of this.tables.values()) t.close(); }
}

module.exports = { Hub, LiveTable, HubError, DEFAULTS };
