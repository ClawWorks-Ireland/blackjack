/**
 * Basic-strategy solver used to derive and check the chart in strategy.js.
 * Not loaded by the game.
 *
 * For each starting hand and dealer upcard it computes the expected value
 * of stand, hit, double, split and surrender with the exact remaining-deck
 * composition (cards removed as they are dealt), assuming the dealer has
 * already peeked and has no blackjack. A total-dependent chart cell is the
 * action with the best EV averaged over every two-card hand with that total,
 * weighted by how likely each hand is to be dealt.
 *
 * The dealer's hole card is unknown but known not to make blackjack; it is
 * handled exactly, and your decisions never depend on it. The one
 * approximation: a split is valued as two independent hands, no resplit.
 *
 * Usage: node tools/solver.js [decks] [s17|h17] [das|nodas]
 */
'use strict';

// Card values 1 (ace) to 10 (any ten-value card).
const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function fullDeck(decks) {
  const c = new Array(11).fill(0);
  for (let v = 1; v <= 9; v++) c[v] = 4 * decks;
  c[10] = 16 * decks;
  return c;
}

const best = (total, hasAce) => (hasAce && total + 10 <= 21 ? total + 10 : total);
const isSoft = (total, hasAce) => hasAce && total + 10 <= 21;
const size = (c) => c.reduce((a, b) => a + b, 0);

function makeSolver({ h17 = false, das = true, decks = 6 } = {}) {
  const deck = fullDeck(decks);
  const dealerMemo = new Map();
  const playMemo = new Map();

  const sorted = (cards) => cards.slice().sort((x, y) => x - y).join('');
  const totalOf = (cards) => cards.reduce((a, b) => a + b, 0);
  const aceIn = (cards) => cards.includes(1);
  const handTotal = (hand) => best(totalOf(hand), aceIn(hand));

  /** Cards not yet seen: the shoe minus the up card and every removed card. */
  const unseen = (up, removed) => {
    const c = deck.slice();
    c[up]--;
    for (const v of removed) c[v]--;
    return c;
  };

  /**
   * Posterior over the dealer's hole card. The dealer peeked and has no
   * blackjack, and every unseen card is equally likely to be the hole card
   * (exchangeability), so P(h) is proportional to its unseen count.
   */
  function holeWeights(up, counts) {
    const banned = up === 1 ? 10 : up === 10 ? 1 : 0;
    let n = 0;
    for (const v of VALUES) if (v !== banned) n += counts[v];
    return VALUES.filter((v) => v !== banned && counts[v]).map((v) => [v, counts[v] / n]);
  }

  /** Dealer final distribution from up + hole with the given remaining cards. */
  function dealerFrom(up, hole, counts, key) {
    const k = `${key}|${hole}`;
    if (dealerMemo.has(k)) return dealerMemo.get(k);
    const out = {};
    const walk = (total, ace, p) => {
      const t = best(total, ace);
      if (t > 21) { out.bust = (out.bust || 0) + p; return; }
      if (t >= 18 || (t === 17 && !(h17 && isSoft(total, ace)))) { out[t] = (out[t] || 0) + p; return; }
      const n = size(counts);
      for (const v of VALUES) {
        if (!counts[v]) continue;
        const q = (p * counts[v]) / n;
        counts[v]--;
        walk(total + v, ace || v === 1, q);
        counts[v]++;
      }
    };
    walk(up + hole, up === 1 || hole === 1, 1);
    dealerMemo.set(k, out);
    return out;
  }

  /** EV of standing on `hand`, with `removed` = every card the player has used. */
  function standEV(up, hand, removed) {
    const pt = handTotal(hand);
    if (pt > 21) return -1;
    const counts = unseen(up, removed);
    const key = `${up}:${sorted(removed)}`;
    let ev = 0;
    for (const [h, ph] of holeWeights(up, counts)) {
      counts[h]--;
      const d = dealerFrom(up, h, counts, key);
      counts[h]++;
      let e = 0;
      for (const k in d) {
        if (k === 'bust' || +k < pt) e += d[k];
        else if (+k > pt) e -= d[k];
      }
      ev += ph * e;
    }
    return ev;
  }

  /** Distribution of the next card you draw, averaged over the hole card. */
  function nextCard(up, removed) {
    const counts = unseen(up, removed);
    const n = size(counts);
    const p = new Array(11).fill(0);
    for (const [h, ph] of holeWeights(up, counts)) {
      for (const v of VALUES) {
        const c = counts[v] - (v === h ? 1 : 0);
        if (c > 0) p[v] += (ph * c) / (n - 1);
      }
    }
    return p;
  }

  function drawEV(up, hand, removed, after) {
    const p = nextCard(up, removed);
    let ev = 0;
    for (const v of VALUES) if (p[v]) ev += p[v] * after([...hand, v], [...removed, v]);
    return ev;
  }

  /** Best of stand or hit from here on. Decisions can't see the hole card. */
  function playEV(up, hand, removed) {
    if (handTotal(hand) > 21) return -1;
    const key = `${up}:${sorted(removed)}|${sorted(hand)}`;
    if (playMemo.has(key)) return playMemo.get(key);
    const ev = Math.max(standEV(up, hand, removed), hitEV(up, hand, removed));
    playMemo.set(key, ev);
    return ev;
  }

  const hitEV = (up, hand, removed) => drawEV(up, hand, removed, (h, r) => playEV(up, h, r));
  const doubleEV = (up, hand, removed) =>
    drawEV(up, hand, removed, (h, r) => (handTotal(h) > 21 ? -2 : 2 * standEV(up, h, r)));

  /**
   * Two hands from a pair, valued as twice one hand that starts with one
   * card of the pair and draws its second; the partner card is out of the
   * shoe. No resplitting.
   */
  function splitEV(up, v) {
    const half = drawEV(up, [v], [v, v], (hand, removed) => {
      if (v === 1) return standEV(up, hand, removed); // split aces: one card
      let ev = Math.max(standEV(up, hand, removed), hitEV(up, hand, removed));
      if (das) ev = Math.max(ev, doubleEV(up, hand, removed));
      return ev;
    });
    return 2 * half;
  }

  /** EV of each action for the two-card hand a,b against upcard. */
  function actions(a, b, up) {
    const cards = [a, b];
    const ev = {
      stand: standEV(up, cards, cards),
      hit: hitEV(up, cards, cards),
      double: doubleEV(up, cards, cards),
      surrender: -0.5,
    };
    if (a === b) ev.split = splitEV(up, a);
    return ev;
  }

  return { actions, standEV };
}

/** Weighted (total-dependent) EVs for every chart row against every upcard. */
function chart(decks, rules) {
  const s = makeSolver({ ...rules, decks });
  const deck = fullDeck(decks);
  const rows = {};
  for (const up of VALUES) {
    for (let a = 1; a <= 10; a++) {
      for (let b = a; b <= 10; b++) {
        const counts = deck.slice();
        counts[up]--;
        if (counts[a] < 1 || counts[b] < (a === b ? 2 : 1)) continue;
        let w = counts[a] * (a === b ? counts[b] - 1 : counts[b]);
        if (a !== b) w *= 2;
        // Two different ten-value ranks are not a pair in this game, so
        // 10+10 feeds both the pair row (same rank) and hard 20 (mixed).
        const ace = a === 1;
        if (ace && b === 10) continue; // blackjack, no decision
        const ev = s.actions(a, b, up);
        const add = (row, weight, evs) => {
          const r = (rows[row] ||= {});
          const cell = (r[up] ||= { w: 0, ev: {} });
          cell.w += weight;
          for (const k in evs) cell.ev[k] = (cell.ev[k] || 0) + weight * evs[k];
        };
        const { split, ...noSplit } = ev;
        if (a === b) {
          add(`pair ${a}`, w, ev);
          // Unsplittable pairs play as their total (aces as soft 12).
          if (a === 10) add('hard 20', w * 0.75, noSplit); // J-Q etc. differ in rank
        } else if (ace) add(`soft ${b + 11}`, w, noSplit);
        else add(`hard ${a + b}`, w, noSplit);
      }
    }
  }
  for (const r of Object.values(rows)) {
    for (const cell of Object.values(r)) for (const k in cell.ev) cell.ev[k] /= cell.w;
  }
  return rows;
}

/** Best action code for a cell: H S D(h) Ds P R. */
function bestCode(ev) {
  const order = Object.entries(ev).sort((x, y) => y[1] - x[1]);
  const [top] = order[0];
  if (top === 'double') return ev.hit >= ev.stand ? 'Dh' : 'Ds';
  if (top === 'surrender') {
    const next = Math.max(ev.hit, ev.stand, ev.split ?? -Infinity);
    return next === ev.hit ? 'Rh' : next === ev.split ? 'Rp' : 'Rs';
  }
  return { stand: 'S', hit: 'H', split: 'P' }[top];
}

module.exports = { chart, bestCode, makeSolver, fullDeck };

if (require.main === module) {
  const decks = Number(process.argv[2] || 6);
  const h17 = process.argv[3] === 'h17';
  const das = process.argv[4] !== 'nodas';
  const rows = chart(decks, { h17, das });
  const ups = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
  console.log(`${decks} deck(s) ${h17 ? 'H17' : 'S17'} ${das ? 'DAS' : 'no DAS'}`);
  console.log('row        ' + ups.map((u) => (u === 1 ? 'A' : String(u)).padStart(3)).join(''));
  const order = [
    ...Array.from({ length: 16 }, (_, i) => `hard ${i + 5}`),
    ...Array.from({ length: 8 }, (_, i) => `soft ${i + 13}`),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => `pair ${v}`),
  ];
  for (const row of order) {
    if (!rows[row]) continue;
    console.log(row.padEnd(11) + ups.map((u) => bestCode(rows[row][u].ev).padStart(3)).join(''));
  }
}
