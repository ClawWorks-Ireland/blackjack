/**
 * Live poker tables (CLA-121), alongside the blackjack ones in hub.js and
 * built the same way: players sit by token, the hub deals a hand once two or
 * more can play (at least one of them a person or an agent), keeps the turn
 * clock, plays bots, and tells subscribers about every change. Settled hands
 * go to the poker leaderboard in big blinds per 100 hands.
 *
 * Bots play the styles in engine/poker-bots.js. Their style is not shown:
 * they are "Bot 1", "Bot 2"... so a player has to work out how each plays.
 * Busted players rebuy play chips automatically.
 */
'use strict';
const crypto = require('crypto');
const { PokerTable, PokerError } = require('../engine/poker.js');
const { POLICIES, rngFor } = require('../engine/poker-bots.js');
const { HubError } = require('./hub.js');

const DEFAULTS = { turnSeconds: 30, botDelayMs: 700, nextHandMs: 3000, idleHands: 3 };
const KINDS = ['ai', 'human'];
const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
const token = () => crypto.randomBytes(16).toString('hex');

class LivePokerTable {
  constructor(hub, id, { name, smallBlind = 5, bigBlind = 10, buyIn, bots = [], seed, ...timing }) {
    this.hub = hub;
    this.id = id;
    this.name = cleanName(name) || `Poker ${id}`;
    this.timing = { ...DEFAULTS, ...hub.timing, ...timing };
    if (!(bigBlind > 0) || !(smallBlind > 0) || smallBlind > bigBlind) throw new HubError('Blinds must be positive, small at most big');
    const styles = Array.isArray(bots) ? bots : Array.from({ length: Number(bots) || 0 }, (_, i) => ['tight-passive', 'calling-station', 'loose-aggressive', 'maniac', 'default'][i % 5]);
    if (styles.length > 5) throw new HubError('At most 5 bots');
    for (const s of styles) if (!POLICIES[s]) throw new HubError(`unknown bot style "${s}"`);
    this.buyIn = buyIn || 100 * bigBlind;
    this.table = new PokerTable({ seed: seed || token(), smallBlind, bigBlind, seats: 6 });
    this.players = new Map(); // token -> {id, name, kind, seat, idle, style?}
    this.subscribers = new Set();
    this.waiters = new Set();
    this.version = 0;
    this.timer = null;
    this.deadline = null;
    this.recorded = 0; // last hand number recorded
    this.rng = rngFor(`${this.table.seed}-bots`);
    styles.forEach((style, i) => {
      const t = token();
      const name = `Bot ${i + 1}`;
      const seat = this.table.sit({ id: `pbot-${id}-${i}`, name, kind: 'bot' }, this.buyIn);
      this.players.set(t, { id: `pbot-${id}-${i}`, name, kind: 'bot', seat, idle: 0, style });
    });
  }

  // --- Players ---

  join({ name, kind = 'human', seat } = {}) {
    const n = cleanName(name);
    if (!n) throw new HubError('A name is required (up to 24 characters)');
    if (!KINDS.includes(kind)) throw new HubError('kind must be "ai" or "human"');
    const t = token();
    const id = `${kind}:${n.toLowerCase()}:${t.slice(0, 6)}`;
    let at;
    try { at = this.table.sit({ id, name: n, kind }, this.buyIn, seat === undefined || seat === null ? undefined : seat); } catch (e) { throw new HubError(e.message, 409); }
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
    this.engine(() => this.table.leave(p.seat));
    this.players.delete(t);
    this.changed();
  }

  act(t, action, amount) {
    const p = this.player(t);
    this.engine(() => this.table.act(p.seat, String(action), amount === undefined ? undefined : Number(amount)));
    p.idle = 0;
    this.changed();
  }

  engine(fn) {
    try { fn(); } catch (e) { if (e instanceof PokerError) throw new HubError(e.message, 409); throw e; }
  }

  // --- Hands, the clock and bots ---

  people() { return [...this.players.values()].filter((p) => p.kind !== 'bot' && this.table.seats[p.seat]); }

  changed() {
    const t = this.table;
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    if (t.phase === 'done' && this.recorded !== t.handNo) {
      this.recorded = t.handNo;
      this.hub.record(this);
      this.tidy();
    }
    if (!t.inPlay) {
      // A new hand once two can play and someone real is seated (bots don't play alone).
      if (t.canStart && this.people().length) this.after(t.phase === 'done' ? this.timing.nextHandMs : 1000, 'next hand', () => { this.engine(() => t.startHand()); this.changed(); });
    } else if (t.toAct !== null) {
      const p = [...this.players.values()].find((x) => x.seat === t.toAct);
      if (p && p.kind === 'bot') this.after(this.timing.botDelayMs, 'bot', () => this.playBot(p));
      else this.after(this.timing.turnSeconds * 1000, 'turn', () => this.timeoutTurn());
    }
    this.version++;
    this.broadcast();
  }

  /** After a hand: rebuy busted players, drop people who keep timing out. */
  tidy() {
    const t = this.table;
    for (const [tok, p] of this.players) {
      const s = t.seats[p.seat];
      if (!s) { this.players.delete(tok); continue; }
      if (s.stack === 0) s.stack = this.buyIn; // play chips: rebuy
      if (p.kind !== 'bot' && p.idle >= this.timing.idleHands) { try { t.leave(p.seat); } catch (_) { /* in a hand */ } this.players.delete(tok); }
    }
  }

  after(ms, what, fn) {
    this.deadline = { at: Date.now() + ms, ms, what };
    this.timer = setTimeout(() => { this.timer = null; try { fn(); } catch (e) { this.hub.log(`poker ${this.id}: ${e.message}`); } }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  playBot(p) {
    const t = this.table;
    if (t.toAct !== p.seat) return;
    let d = POLICIES[p.style].decide(t.view(p.seat), this.rng);
    if (!t.legal(p.seat).some((l) => l.action === d.action) && d.action !== 'allin') d = { action: t.legal(p.seat).some((l) => l.action === 'check') ? 'check' : 'fold' };
    t.act(p.seat, d.action, d.amount);
    this.changed();
  }

  /** A player who doesn't move in time checks if they can, else folds. */
  timeoutTurn() {
    const t = this.table;
    const seat = t.toAct;
    if (seat === null) return;
    const p = [...this.players.values()].find((x) => x.seat === seat);
    // Count missed hands, not missed turns: one slow hand can time out preflop and again on the flop.
    if (p && p.idleHand !== t.handNo) { p.idle++; p.idleHand = t.handNo; }
    t.act(seat, t.legal(seat).some((l) => l.action === 'check') ? 'check' : 'fold');
    this.changed();
  }

  // --- Views ---

  view(t = null) {
    const p = t ? this.players.get(t) : null;
    const v = this.table.view(p && p.kind !== 'bot' ? p.seat : null);
    return {
      id: this.id, name: this.name, game: 'poker', version: this.version, buyIn: this.buyIn,
      deadline: this.deadline ? { what: this.deadline.what, ms: this.deadline.ms, msLeft: Math.max(0, this.deadline.at - Date.now()) } : null,
      ...v,
    };
  }

  summary() {
    const t = this.table;
    return {
      id: this.id, name: this.name, game: 'poker', phase: t.phase, handNo: t.handNo,
      smallBlind: t.sb, bigBlind: t.bb, buyIn: this.buyIn,
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
    for (const sub of this.subscribers) { try { sub.send(this.view(sub.token)); } catch (_) { this.subscribers.delete(sub); } }
    for (const w of [...this.waiters]) w();
  }

  /** Resolve when it is `t`'s move, or the table moves past `since`, or after `timeoutMs`. */
  wait(t, since, timeoutMs = 25000) {
    const p = this.player(t);
    const ready = () => this.table.toAct === p.seat || (since !== undefined && this.version > since);
    if (ready()) return Promise.resolve(this.view(t));
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(check); resolve(this.view(t)); };
      const check = () => { if (ready()) done(); };
      const timer = setTimeout(done, Math.min(timeoutMs, 60000));
      if (timer.unref) timer.unref();
      this.waiters.add(check);
    });
  }

  close() { clearTimeout(this.timer); for (const w of [...this.waiters]) w(); }
}

class PokerHub {
  constructor({ leaderboard = null, timing = {}, log = () => {} } = {}) {
    this.tables = new Map();
    this.leaderboard = leaderboard;
    this.timing = timing;
    this.log = log;
    this.next = 1;
  }

  create(opts = {}) {
    const id = `p${this.next++}`;
    const lt = new LivePokerTable(this, id, opts);
    this.tables.set(id, lt);
    return lt;
  }

  get(id) {
    const lt = this.tables.get(String(id));
    if (!lt) throw new HubError(`No poker table ${id}`, 404);
    return lt;
  }

  list() { return [...this.tables.values()].map((t) => t.summary()); }

  /** A finished hand: every person's and agent's result, in big blinds, to the leaderboard. */
  record(lt) {
    if (!this.leaderboard) return;
    const t = lt.table;
    const h = t.lastHand;
    if (!h) return;
    t.seats.forEach((s, i) => {
      if (!s || h.net[i] === null || s.player.kind === 'bot') return;
      this.leaderboard.add({ name: s.player.name, kind: s.player.kind, net: h.net[i], bet: s.committed, minBet: t.bb, blackjacks: 0 });
    });
  }

  close() { for (const t of this.tables.values()) t.close(); }
}

module.exports = { PokerHub, LivePokerTable, DEFAULTS };
