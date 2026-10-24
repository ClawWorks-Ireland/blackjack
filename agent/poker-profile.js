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
 * - weak bets shown (CLA-130): of the postflop bets and raises whose cards were
 *   later shown, how many were made with no pair of their own (bluffs, draws)
 *
 * A tight player has a low VPIP, a loose one a high VPIP; a passive player a
 * low PFR and aggression; a calling station a high VPIP, a low fold to bet
 * and low aggression; a maniac a high everything except folding.
 *
 * Hands come from a seat at our tables (addHand) or from any hand record
 * (addRecord, agent/poker-history.js): a watched table, imported histories.
 */
'use strict';
const { evaluate } = require('../engine/poker.js');

const blank = () => ({ hands: 0, vpip: 0, pfr: 0, aggr: 0, calls: 0, facedBet: 0, foldedToBet: 0, sawFlop: 0, showdowns: 0, betsShown: 0, betsShownWeak: 0, shown: [] });
const BOARD_AT = { flop: 3, turn: 4, river: 5 };
const MADE = new Set(['straight', 'flush', 'full house', 'four of a kind', 'straight flush']);

/** Whether a bet with these cards on this board was made with no pair of the player's own (and no straight or flush). */
function weakBet(hole, board) {
  const onBoard = new Set(board.map((c) => c[0]));
  if (hole[0][0] === hole[1][0] || hole.some((c) => onBoard.has(c[0]))) return false;
  return !MADE.has(evaluate([...hole, ...board]).category);
}

/** How to beat each style (CLA-130). */
const EXPLOIT = {
  maniac: 'raises nearly everything and almost never folds: do not bluff; call down with medium hands and let them bet into you; raise strong hands for value',
  'calling station': 'calls almost anything and rarely bets: never bluff; bet big and bet thin for value',
  'loose-aggressive': 'plays many hands and bets a lot: call down lighter with medium hands, re-raise strong ones, bluff less',
  'loose-passive': 'plays many hands but rarely bets: value bet more, bluff less; when they do raise, they have it',
  'tight-passive': 'plays few hands and rarely raises: steal blinds and small pots; fold medium hands to their raises and big bets',
  'tight-aggressive': 'plays few hands but bets them hard: respect their raises; steal when they fold',
  regular: 'no clear leak yet: stay close to the default',
};

/**
 * A style read from the numbers (CLA-130), with how sure it is from the
 * sample size: {style, confidence: low|medium|high, hands, exploit}, or style
 * "unknown" under 20 hands. Thresholds from the styled bots' own numbers,
 * heads-up and five-handed (engine/poker-bots.js).
 */
function classify(s) {
  if (!s || s.hands < 20 || s.vpip === null) return { style: 'unknown', confidence: 'none', hands: s ? s.hands : 0, exploit: 'not enough hands seen' };
  const ag = s.aggression ?? 0;
  const ftb = s.foldToBet ?? 50;
  let style;
  if (s.vpip >= 60 && (s.pfr >= 60 || ag >= 5)) style = 'maniac';
  else if (s.vpip >= 50 && ftb <= 15 && ag < 1) style = 'calling station';
  else if (s.vpip >= 40 && (s.pfr >= 20 || ag >= 1.5)) style = 'loose-aggressive';
  else if (s.vpip >= 40) style = 'loose-passive';
  else if (s.vpip < 30 && s.pfr < 10 && ag < 1) style = 'tight-passive';
  else if (s.vpip < 30) style = 'tight-aggressive';
  else style = 'regular';
  const confidence = s.hands >= 200 ? 'high' : s.hands >= 50 ? 'medium' : 'low';
  return { style, confidence, hands: s.hands, exploit: EXPLOIT[style] };
}

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
      if (e.action === 'ante') continue;
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
        // What their bets turned out to be.
        for (const e of log) {
          if (e.seat !== x.seat || !BOARD_AT[e.street] || (e.action !== 'bet' && e.action !== 'raise')) continue;
          const board = lastHand.board.slice(0, BOARD_AT[e.street]);
          if (board.length < BOARD_AT[e.street]) continue;
          p.betsShown = (p.betsShown || 0) + 1;
          if (weakBet(x.cards, board)) p.betsShownWeak = (p.betsShownWeak || 0) + 1;
        }
        p.showdowns++;
        p.shown.push(`${x.cards.join(' ')} (${x.hand})`);
        if (p.shown.length > 12) p.shown.shift();
      }
    }
  }

  /** Add a hand record from any source (agent/poker-history.js). */
  addRecord(record) {
    const { names, log, lastHand } = require('./poker-history.js').toProfileInput(record);
    this.addHand(names, log, lastHand);
  }

  /** Add everything another set of profiles has seen (a scouting report, say) to this one. */
  merge(other) {
    for (const [name, q] of other.players) {
      const p = this.get(name);
      for (const [k, v] of Object.entries(q)) if (typeof v === 'number') p[k] = (p[k] || 0) + v;
      p.shown = [...(p.shown || []), ...(q.shown || [])].slice(-12);
    }
    return this;
  }

  names() { return [...this.players.keys()]; }

  /** The style read from this player's numbers (classify). */
  style(name) { return classify(this.stats(name)); }

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
      weakBetsShown: rate(p.betsShownWeak || 0, p.betsShown || 0),
      betsShown: p.betsShown || 0,
    };
  }

  /** "VPIP 62%, PFR 9%, aggression 0.4, folds to a bet 12%, showdown 58% over 140 hands; showed: ..." */
  line(name) {
    const s = this.stats(name);
    const f = (v, unit = '%') => (v === null ? '?' : `${v}${unit}`);
    return `plays ${f(s.vpip)} of hands (VPIP), raises ${f(s.pfr)} preflop (PFR), aggression ${f(s.aggression, '')}, `
      + `folds to a bet ${f(s.foldToBet)}, goes to showdown ${f(s.showdown)} after the flop, over ${s.hands} hands`
      + (s.betsShown >= 5 ? `; ${s.weakBetsShown}% of the ${s.betsShown} bets and raises seen at showdown had no pair of their own` : '')
      + (s.shown.length ? `; recently showed ${s.shown.slice(-3).join(', ')}` : '');
  }

  toJSON() { return Object.fromEntries(this.players); }
}

module.exports = { Profiles, classify, EXPLOIT };
