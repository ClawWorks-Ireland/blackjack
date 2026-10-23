/**
 * Client for the live table server (server/server.js, CLA-113). Agents join
 * as kind "ai"; that is how the players leaderboard tells them from people.
 *
 *   const c = new TableClient('http://localhost:8787');
 *   await c.join('1', 'my-agent');
 *   let v = await c.wait();             // returns when it's your move (or betting is open)
 *   v = await c.bet(10); v = await c.act('hit'); ...
 *
 * Also `toObs(view)`: a live table view in the shape of the agent env's
 * observation, so the baseline policies (agent/policies.js) can sit at a
 * live table unchanged.
 */
'use strict';
const Strategy = require('../engine/strategy.js');
const { toCard } = require('./policies.js');

const DEFAULT_URL = process.env.BLACKJACK_SERVER || 'http://localhost:8787';

class TableClient {
  /** `game`: "blackjack" (default) or "poker", whose API lives under /api/poker. */
  constructor(url = DEFAULT_URL, { game = 'blackjack' } = {}) {
    this.url = String(url).replace(/\/+$/, '');
    this.base = game === 'poker' ? '/api/poker' : '/api';
    this.table = null;
    this.token = null;
    this.version = undefined;
  }

  async call(method, path, body) {
    let res;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`can't reach the table server at ${this.url} (${e.cause ? e.cause.code || e.cause.message : e.message}); start it with: npm run tables`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  list() { return this.call('GET', `${this.base}/tables`).then((d) => d.tables); }
  create(opts) { return this.call('POST', `${this.base}/tables`, opts); }
  leaderboard(kind) { return this.call('GET', `${this.base}/leaderboard${kind ? `?kind=${kind}` : ''}`); }

  async join(table, name, seat) {
    const j = await this.call('POST', `${this.base}/tables/${encodeURIComponent(table)}/join`, { name, kind: 'ai', seat });
    this.table = String(table);
    this.token = j.token;
    this.version = j.view.version;
    return j;
  }

  need() { if (!this.token) throw new Error('not at a table: join one first'); }
  path(verb) { return `${this.base}/tables/${encodeURIComponent(this.table)}/${verb}`; }
  seen(v) { this.version = v.version; return v; }

  view() { this.need(); return this.call('GET', this.path('')).then((v) => this.seen(v)); }
  bet(amount) { this.need(); return this.call('POST', this.path('bet'), { amount }).then((v) => this.seen(v)); }
  sitOut() { this.need(); return this.call('POST', this.path('sit-out'), {}).then((v) => this.seen(v)); }
  act(action, amount) { this.need(); return this.call('POST', this.path('act'), { action, amount }).then((v) => this.seen(v)); }
  async leave() { this.need(); await this.call('POST', this.path('leave'), {}); this.token = null; this.table = null; }

  /**
   * Wait until it is your move, betting is open for you, or the table moves
   * past what you last saw; at most `timeout` seconds (the server caps at 60).
   */
  wait(timeout = 25, { anyChange = false } = {}) {
    this.need();
    const since = anyChange && this.version !== undefined ? `&since=${this.version}` : '';
    return this.call('GET', `${this.path('wait')}?timeout=${timeout}${since}`).then((v) => this.seen(v));
  }
}

/** What the live view asks of you now: "bet", "insurance", "play" or "wait". */
function yourMove(v) {
  if (!v.you) return 'gone';
  const me = v.seats[v.you.seat];
  if (v.phase === 'betting' && me.bet === 0 && !me.out) return 'bet';
  if (v.phase === 'done') return 'bet';
  if (v.you.yourTurn) return v.phase === 'insurance' ? 'insurance' : 'play';
  return 'wait';
}

/** A live view as an agent-env observation, plus basic strategy as the hint. */
function toObs(v) {
  const me = v.seats[v.you.seat];
  const move = yourMove(v);
  const obs = {
    phase: move === 'bet' ? 'betting' : v.phase,
    round: v.round,
    bankroll: v.you.bankroll,
    legal: move === 'bet' ? ['deal'] : v.you.legal,
    legalCost: v.you.legalCost,
    rules: v.rules,
    table: { minBet: v.table.minBet, maxBet: v.table.maxBet },
    shoe: { cardsLeft: v.shoe.cardsLeft, cutCardReached: v.shoe.cutCardReached, seen: v.shoe.seen },
    dealer: v.dealer,
    hands: me.hands,
    active: me.active,
    insurance: { offered: v.phase === 'insurance', evenMoney: v.you.evenMoney },
  };
  let hint = null;
  if (move === 'insurance') hint = { action: 'decline_insurance', reason: 'Basic strategy never takes insurance' };
  else if (move === 'play') {
    const h = me.hands[me.active];
    const allowed = { canHit: obs.legal.includes('hit'), canDouble: obs.legal.includes('double'), canSplit: obs.legal.includes('split'), canSurrender: obs.legal.includes('surrender') };
    const r = Strategy.recommend(h.cards.map(toCard), toCard(v.dealer.cards[0]), allowed, v.rules);
    hint = { action: r.action, reason: r.reason };
  }
  return { obs, hint, move };
}

module.exports = { TableClient, toObs, yourMove, DEFAULT_URL };
