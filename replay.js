/**
 * Hand replay (F19): rebuild a finished round from its record and step
 * through it card by card. Pure and DOM-free (window.BlackjackReplay in
 * the browser, module.exports under Node).
 *
 * A record is what the engine logged: the rules, the bankroll and bets at
 * the deal, the side bets, every card drawn in order and every decision in
 * order, plus the Hi-Lo running count and unseen cards just before the
 * deal. Replaying stacks those cards on a shoe and runs the same engine
 * again, so every hand, total and result comes out exactly as it was
 * played. Each decision is annotated with the coach's move (basic and
 * count), the count at that moment and the EV cost of a mistake.
 */
(function (root) {
  'use strict';

  const node = typeof module !== 'undefined' && module.exports;
  const BJ = node ? require('./blackjack.js') : root.Blackjack;
  const Strategy = node ? require('./strategy.js') : root.BlackjackStrategy;
  const Counting = node ? require('./counting.js') : root.BlackjackCounting;
  const EV = node ? require('./ev.js') : root.BlackjackEV;
  const Chart = node ? require('./chart.js') : root.BlackjackChart;

  const cardCode = (c) => `${c.rank}${c.suit}`;
  const parseCard = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });
  const METHOD = {
    insurance: 'takeInsurance', 'no-insurance': 'declineInsurance',
    hit: 'hit', stand: 'stand', double: 'double', split: 'split', surrender: 'surrender',
  };
  const PAST = {
    insurance: 'took insurance', 'no-insurance': 'declined insurance', hit: 'hit', stand: 'stood',
    double: 'doubled', split: 'split', surrender: 'surrendered',
  };

  /**
   * The record for the round `game` just finished. `before` is what the
   * app saw at the deal: {bankroll, running, unseen}.
   */
  function recordOf(game, before) {
    const side = {};
    for (const s of game.sideBets) side[s.bet] = s.stake;
    return {
      rules: game.rules, bets: game.spotBets.slice(), side, bankroll: before.bankroll,
      running: before.running, unseen: before.unseen,
      cards: game.drawLog.map(cardCode), actions: game.actionLog.slice(),
    };
  }

  const handTotal = (cards) => {
    const { total, soft } = BJ.handValue(cards);
    return soft && total < 21 ? `soft ${total}` : String(total);
  };

  /** What the table looks like: dealer cards (null = face down) and your hands. */
  function view(g, { hideHole, dealerUpTo = Infinity, handCards = null } = {}) {
    const dealer = g.dealer.slice(0, dealerUpTo).map((c, i) => (hideHole && i === 1 ? null : c));
    const hands = g.hands.map((h, i) => {
      const cards = handCards ? handCards[i] : h.cards.slice();
      return { cards, total: cards.length ? handTotal(cards) : '', bet: h.bet };
    });
    return { dealer, hands };
  }

  /** Running and true count of what a player at the table could see. */
  function visibleCount(rec, g, hideHole) {
    const seen = [...g.hands.flatMap((h) => h.cards), ...g.dealer.filter((_, i) => !(hideHole && i === 1))];
    const running = rec.running + seen.reduce((s, c) => s + Counting.hiLo(c), 0);
    const unseen = rec.unseen - seen.length;
    return { running, tc: Counting.trueCount(running, unseen / 52) };
  }

  /** The coach's view of the decision about to be made. */
  function annotate(rec, g, move) {
    const { running, tc } = visibleCount(rec, g, true);
    const d = { move, running, tc, basic: null, count: null, cost: null };
    if (g.phase === 'insurance') {
      d.basic = Strategy.insuranceAdvice(g.evenMoneyOffered).action;
      const ins = Counting.countInsurance(tc, g.evenMoneyOffered);
      d.count = ins ? ins.action : d.basic;
      return d;
    }
    const h = g.currentHand;
    const allowed = { canDouble: g.canDouble(), canSplit: g.canSplit(), canSurrender: g.canSurrender(), canHit: g.canHit() };
    const basic = Strategy.recommend(h.cards, g.dealer[0], allowed, g.rules);
    d.basic = basic.action;
    d.count = Counting.countPlay(h.cards, g.dealer[0], allowed, basic, tc, g.rules).action;
    d.hand = h.cards.slice();
    if (move !== basic.action) {
      const priced = EV.moveCost(g.rules, Chart.cellKey(h.cards, g.dealer[0], allowed.canSplit), move, allowed);
      if (priced) d.cost = { fraction: priced.cost, dollars: Math.round(priced.cost * h.bet * 100) / 100 };
    }
    return d;
  }

  /**
   * Every step of the round: [{dealer, hands, text, decision?}] and the
   * final state {hands: [{cards, total, outcome, net}], dealer, net}.
   */
  function replayRound(rec) {
    const cards = rec.cards.map(parseCard);
    const g = new BJ.Game({ ...rec.rules, bankroll: rec.bankroll, minBet: 1 });
    // The logged cards on top of a full shoe, so the cut card can't interrupt.
    g.shoe = [...BJ.createShoe(g.decks), ...cards.slice().reverse()];
    g.deal(rec.bets.length === 1 ? rec.bets[0] : rec.bets, rec.side || {});
    const steps = [];
    const live = () => g.phase === 'player' || g.phase === 'insurance';

    // The deal, one card at a time in draw order: each spot's two cards, then the dealer's.
    const order = [...g.hands.flatMap((h, i) => [[i, 0], [i, 1]]), ['d', 0], ['d', 1]];
    for (let k = 1; k <= order.length; k++) {
      const shown = order.slice(0, k);
      const handCards = g.hands.map((h, i) => h.cards.slice(0, 2).filter((_, j) => shown.some(([a, b]) => a === i && b === j)));
      const dealerN = shown.filter(([a]) => a === 'd').length;
      const v = view(g, { hideHole: true, dealerUpTo: dealerN, handCards });
      steps.push({ ...v, text: `Deal: card ${k} of ${order.length}` });
    }
    if (!live()) steps.push({ ...view(g, { hideHole: false }), text: 'The dealer checks the hole card.' });

    for (const move of rec.actions) {
      if (!live()) break;
      const decision = annotate(rec, g, move);
      const handIndex = g.phase === 'player' ? g.active : null;
      const dealerBefore = g.dealer.length;
      g[METHOD[move]]();
      const who = handIndex !== null && g.hands.length > 1 ? `Hand ${handIndex + 1}: you` : 'You';
      steps.push({ ...view(g, { hideHole: true, dealerUpTo: live() ? Infinity : dealerBefore }), decision, text: `${who} ${PAST[move]}.` });
      if (!live()) {
        // The dealer's turn, card by card: the hole card, then each draw.
        steps.push({ ...view(g, { hideHole: false, dealerUpTo: dealerBefore }), text: 'The dealer turns over the hole card.' });
        for (let n = dealerBefore + 1; n <= g.dealer.length; n++) {
          const t = BJ.handValue(g.dealer.slice(0, n)).total;
          const now = t > 21 ? `busts with ${t}` : `has ${handTotal(g.dealer.slice(0, n))}`;
          steps.push({ ...view(g, { hideHole: false, dealerUpTo: n }), text: `The dealer draws and ${now}.` });
        }
      }
    }
    const final = {
      dealer: g.dealer.slice(), net: g.net,
      hands: g.hands.map((h, i) => ({ cards: h.cards.slice(), total: BJ.handValue(h.cards).total, outcome: g.results[i].outcome, net: g.results[i].net })),
    };
    steps.push({ ...view(g, { hideHole: false }), text: `Result: ${final.hands.map((h) => h.outcome).join(', ')}.`, final: true });
    return { steps, final, complete: g.phase === 'done' };
  }

  const api = { recordOf, replayRound, cardCode, parseCard };
  if (node) module.exports = api;
  else root.BlackjackReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
