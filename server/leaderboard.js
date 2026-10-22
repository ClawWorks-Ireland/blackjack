/**
 * Players leaderboard (CLA-114): every settled round of every human and AI
 * player at a live table, kept in a local JSON file (server/data/, not
 * committed). Players are keyed by kind and name, so "Ada" the human and
 * "Ada" the agent are different entries. Kinds are self-reported by the
 * client that joined (see hub.js).
 *
 * Ranked by units won per 100 rounds, where a unit is the table minimum of
 * the table each round was played at, so tables with different limits
 * compare. Players with fewer than `minRounds` rounds are listed as
 * provisional, below the ranked ones.
 */
'use strict';
const fs = require('fs');
const path = require('path');

class Leaderboard {
  constructor({ file = null, minRounds = 100 } = {}) {
    this.file = file;
    this.minRounds = minRounds;
    this.players = new Map();
    if (file && fs.existsSync(file)) {
      for (const p of JSON.parse(fs.readFileSync(file, 'utf8')).players || []) this.players.set(this.key(p.kind, p.name), p);
    }
    this.dirty = false;
  }

  key(kind, name) { return `${kind}:${String(name).toLowerCase()}`; }

  /** One settled round for one seat: net and initial bet in chips, at a table with minimum `minBet`. */
  add({ name, kind, net, bet, minBet, blackjacks = 0, at = new Date().toISOString() }) {
    const k = this.key(kind, name);
    const p = this.players.get(k) || { name, kind, rounds: 0, units: 0, units2: 0, net: 0, wagered: 0, blackjacks: 0, best: null, worst: null, first: at, last: at };
    const u = net / minBet;
    p.name = name; // latest spelling
    p.rounds++;
    p.units += u;
    p.units2 += u * u;
    p.net = Math.round((p.net + net) * 100) / 100;
    p.wagered += bet;
    p.blackjacks += blackjacks;
    p.best = p.best === null ? net : Math.max(p.best, net);
    p.worst = p.worst === null ? net : Math.min(p.worst, net);
    p.last = at;
    this.players.set(k, p);
    this.dirty = true;
    this.save();
  }

  save() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ players: [...this.players.values()] }, null, 1));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  /**
   * Rows ranked best first: {rank (null while provisional), name, kind,
   * rounds, per100, per100CI, net, wagered, blackjacks, best, worst, last}.
   * `kind` filters to "ai" or "human".
   */
  rows({ kind = null } = {}) {
    const rows = [...this.players.values()].filter((p) => !kind || p.kind === kind).map((p) => {
      const mean = p.units / p.rounds;
      const sd = Math.sqrt(Math.max(0, p.units2 / p.rounds - mean * mean));
      return {
        name: p.name, kind: p.kind, rounds: p.rounds,
        per100: Math.round(mean * 10000) / 100,
        per100CI: Math.round((1.96 * sd / Math.sqrt(p.rounds)) * 10000) / 100,
        net: p.net, wagered: p.wagered, blackjacks: p.blackjacks, best: p.best, worst: p.worst, last: p.last,
        provisional: p.rounds < this.minRounds,
      };
    });
    rows.sort((a, b) => (a.provisional - b.provisional) || (b.per100 - a.per100) || (b.rounds - a.rounds));
    let rank = 0;
    for (const r of rows) r.rank = r.provisional ? null : ++rank;
    return rows;
  }

  /** Totals by kind: how the humans and the AIs are doing as groups. */
  byKind() {
    const out = {};
    for (const kind of ['human', 'ai']) {
      const ps = [...this.players.values()].filter((p) => p.kind === kind);
      const rounds = ps.reduce((a, p) => a + p.rounds, 0);
      const units = ps.reduce((a, p) => a + p.units, 0);
      out[kind] = { players: ps.length, rounds, per100: rounds ? Math.round((units / rounds) * 10000) / 100 : null };
    }
    return out;
  }
}

module.exports = { Leaderboard };
