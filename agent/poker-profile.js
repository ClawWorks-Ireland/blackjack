/**
 * Opponent statistics for poker (CLA-120, CLA-122), built from what a player
 * at the table sees: each finished hand's action log and any cards shown at
 * showdown. The standard measures:
 *
 * - VPIP: how often a player puts money in preflop by choice (not blinds)
 * - PFR: how often they raise preflop
 * - aggression: bets and raises per call after the flop
 * - fold to bet: how often they fold after the flop when facing a bet
 * - showdown: how often they reach a showdown when they see a flop
 *
 * A tight player has a low VPIP, a loose one a high VPIP; a passive player a
 * low PFR and aggression; a calling station a high VPIP, a low fold to bet
 * and low aggression; a maniac a high everything except folding.
 */
'use strict';

const blank = () => ({ hands: 0, vpip: 0, pfr: 0, aggr: 0, calls: 0, facedBet: 0, foldedToBet: 0, sawFlop: 0, showdowns: 0, shown: [] });

class Profiles {
  constructor(data = {}) {
    this.players = new Map(Object.entries(data));
  }

  get(name) {
    if (!this.players.has(name)) this.players.set(name, blank());
    return this.players.get(name);
  }

  /** Add one finished hand. `names[seat]` is the player's name; `log` the hand's actions; `lastHand` the result. */
  addHand(names, log, lastHand) {
    const inHand = new Set(lastHand.net.map((x, i) => (x === null ? -1 : i)).filter((i) => i >= 0));
    const seen = { vpip: new Set(), pfr: new Set(), flop: new Set() };
    let street = null;
    let top = 0;
    const put = new Map();
    for (const e of log) {
      if (e.street !== street) { street = e.street; top = 0; put.clear(); }
      const before = put.get(e.seat) || 0;
      const facing = top > before;
      if (e.action === 'small blind' || e.action === 'big blind') {
        put.set(e.seat, before + e.amount);
        top = Math.max(top, before + e.amount);
        continue;
      }
      const p = names[e.seat] !== undefined ? this.get(names[e.seat]) : null;
      if (street !== 'preflop') seen.flop.add(e.seat);
      if (e.action === 'call') put.set(e.seat, before + e.amount);
      if (e.action === 'bet' || e.action === 'raise') { put.set(e.seat, e.to); top = Math.max(top, e.to); }
      if (!p) continue;
      if (street === 'preflop') {
        if (e.action === 'call' || e.action === 'bet' || e.action === 'raise') seen.vpip.add(e.seat);
        if (e.action === 'raise' || e.action === 'bet') seen.pfr.add(e.seat);
      } else {
        if (e.action === 'bet' || e.action === 'raise') p.aggr++;
        if (e.action === 'call') p.calls++;
        if (facing) { p.facedBet++; if (e.action === 'fold') p.foldedToBet++; }
      }
    }
    for (const seat of inHand) {
      const name = names[seat];
      if (name === undefined) continue;
      const p = this.get(name);
      p.hands++;
      if (seen.vpip.has(seat)) p.vpip++;
      if (seen.pfr.has(seat)) p.pfr++;
      if (seen.flop.has(seat) || (lastHand.board.length >= 3 && lastHand.showdown && lastHand.shown.some((x) => x.seat === seat))) p.sawFlop++;
    }
    if (lastHand.showdown) {
      for (const x of lastHand.shown) {
        const name = names[x.seat];
        if (name === undefined) continue;
        const p = this.get(name);
        p.showdowns++;
        p.shown.push(`${x.cards.join(' ')} (${x.hand})`);
        if (p.shown.length > 12) p.shown.shift();
      }
    }
  }

  /** The numbers, as rates. */
  stats(name) {
    const p = this.get(name);
    const rate = (a, b) => (b ? Math.round((100 * a) / b) : null);
    return {
      hands: p.hands,
      vpip: rate(p.vpip, p.hands),
      pfr: rate(p.pfr, p.hands),
      aggression: p.calls ? Math.round((p.aggr / p.calls) * 10) / 10 : p.aggr ? p.aggr : null,
      foldToBet: rate(p.foldedToBet, p.facedBet),
      showdown: rate(p.showdowns, p.sawFlop),
      shown: p.shown.slice(-6),
      facedBets: p.facedBet,
    };
  }

  /** "VPIP 62%, PFR 9%, aggression 0.4, folds to a bet 12%, showdown 58% over 140 hands; showed: ..." */
  line(name) {
    const s = this.stats(name);
    const f = (v, unit = '%') => (v === null ? '?' : `${v}${unit}`);
    return `plays ${f(s.vpip)} of hands (VPIP), raises ${f(s.pfr)} preflop (PFR), aggression ${f(s.aggression, '')}, `
      + `folds to a bet ${f(s.foldToBet)}, goes to showdown ${f(s.showdown)} after the flop, over ${s.hands} hands`
      + (s.shown.length ? `; recently showed ${s.shown.slice(-3).join(', ')}` : '');
  }

  toJSON() { return Object.fromEntries(this.players); }
}

module.exports = { Profiles };
