/* UI layer: renders Blackjack.Game state and wires up controls. */
(function () {
  'use strict';

  const START_BANKROLL = 1000;
  const { Game, handValue } = window.Blackjack;
  let game = new Game({ bankroll: START_BANKROLL });

  const $ = (id) => document.getElementById(id);
  const els = {
    dealerCards: $('dealer-cards'), dealerTotal: $('dealer-total'),
    playerHands: $('player-hands'),
    message: $('message'), bankroll: $('bankroll'), betDisplay: $('bet-display'),
    betForm: $('bet-form'), betInput: $('bet'), deal: $('deal'),
    hit: $('hit'), stand: $('stand'), double: $('double'), split: $('split'),
    surrender: $('surrender'), insurance: $('insurance'), insure: $('insure'), noInsure: $('no-insure'),
    reset: $('reset'),
  };

  const MESSAGES = {
    blackjack: (net) => `Blackjack! You win $${net}.`,
    win: (net) => `You win $${net}.`,
    lose: () => 'Dealer wins.',
    bust: () => 'Bust. Dealer wins.',
    push: () => 'Push. Your bet is returned.',
    surrender: (net) => `You surrendered. $${-net} is returned.`,
  };
  const SHORT = {
    blackjack: 'Blackjack', win: 'Win', lose: 'Lose', bust: 'Bust', push: 'Push', surrender: 'Surrender',
  };

  const suitName = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };

  function cardEl(card, hidden) {
    const div = document.createElement('div');
    if (hidden) {
      div.className = 'card back';
      div.setAttribute('aria-label', 'Face-down card');
      return div;
    }
    const red = card.suit === '♥' || card.suit === '♦';
    div.className = 'card' + (red ? ' red' : '');
    div.setAttribute('role', 'img');
    div.setAttribute('aria-label', `${card.rank} of ${suitName[card.suit]}`);
    div.innerHTML = `<span class="corner">${card.rank}${card.suit}</span>` +
      `<span class="pip" aria-hidden="true">${card.suit}</span>`;
    return div;
  }

  function formatTotal(cards) {
    const { total, soft } = handValue(cards);
    return soft && total < 21 ? `soft ${total}` : `${total}`;
  }

  const money = (n) => (n < 0 ? `-$${-n}` : `$${n}`);

  function handEl(hand, i) {
    const multi = game.hands.length > 1;
    const isActive = game.phase === 'player' && i === game.active;
    const result = game.phase === 'done' ? game.results[i] : null;

    const wrap = document.createElement('div');
    wrap.className = 'player-hand' + (isActive && multi ? ' active' : '');
    if (result) wrap.dataset.outcome = result.outcome;

    const label = document.createElement('h2');
    const name = multi ? `Hand ${i + 1}` : 'You';
    let text = `${name} (${formatTotal(hand.cards)})`;
    if (multi) text += ` · $${hand.bet}`;
    if (result && multi) text += ` · ${SHORT[result.outcome]}`;
    label.textContent = text;
    if (isActive && multi) label.setAttribute('aria-current', 'true');

    const cards = document.createElement('div');
    cards.className = 'cards';
    cards.append(...hand.cards.map((card) => cardEl(card, false)));

    wrap.append(label, cards);
    return wrap;
  }

  function resultMessage() {
    let text;
    if (game.results.length === 1) {
      const r = game.results[0];
      text = MESSAGES[r.outcome](r.net);
    } else {
      const parts = game.results.map((r, i) => `Hand ${i + 1}: ${SHORT[r.outcome]}`);
      text = `${parts.join(' · ')}.`;
    }
    if (game.insuranceNet !== null) {
      text += game.insuranceNet > 0 ? ` Insurance pays ${money(game.insuranceNet)}.` : ' Insurance lost.';
    }
    if (game.results.length > 1 || game.insuranceNet !== null) text += ` Net ${money(game.net)}.`;
    return text;
  }

  function netOutcome() {
    if (game.results.length === 1 && game.insuranceNet === null) {
      return game.results[0].outcome === 'surrender' ? 'lose' : game.results[0].outcome;
    }
    return game.net > 0 ? 'win' : game.net < 0 ? 'lose' : 'push';
  }

  function render() {
    const inRound = game.phase === 'player';
    const offering = game.phase === 'insurance';
    const live = inRound || offering;

    els.dealerCards.replaceChildren(
      ...game.dealer.map((card, i) => cardEl(card, live && i === 1))
    );
    els.dealerTotal.textContent = !game.dealer.length ? ''
      : live ? `(${game.dealer[0].rank === 'A' ? 'ace' : handValue([game.dealer[0]]).total} showing)`
      : `(${formatTotal(game.dealer)})`;

    if (game.hands.length) {
      els.playerHands.replaceChildren(...game.hands.map(handEl));
    } else {
      const empty = document.createElement('h2');
      empty.textContent = 'You';
      els.playerHands.replaceChildren(empty);
    }

    els.bankroll.textContent = money(game.bankroll);
    const staked = game.hands.reduce((sum, h) => sum + h.bet, 0);
    const inPlay = staked + game.insurance;
    els.betDisplay.textContent = live ? `· In play: $${inPlay}` : '';

    els.hit.disabled = !inRound;
    els.stand.disabled = !inRound;
    els.double.disabled = !game.canDouble();
    els.split.disabled = !game.canSplit();
    els.surrender.disabled = !game.canSurrender();
    els.insurance.hidden = !offering;
    els.insure.disabled = !game.canInsure();
    els.insure.firstChild.textContent = `Take insurance ($${game.insuranceCost}) `;
    els.deal.disabled = live;
    els.betInput.disabled = live;
    els.betInput.max = String(game.bankroll);

    if (game.phase === 'done' && game.results.length) {
      els.message.textContent = resultMessage();
      els.message.dataset.outcome = netOutcome();
    } else if (offering) {
      els.message.textContent = game.canInsure()
        ? `Dealer shows an ace. Insure for $${game.insuranceCost}?`
        : 'Dealer shows an ace. Not enough chips to insure.';
      delete els.message.dataset.outcome;
    } else if (inRound) {
      const multi = game.hands.length > 1;
      els.message.textContent = multi
        ? `Playing hand ${game.active + 1} of ${game.hands.length}.`
        : 'Your move.';
      delete els.message.dataset.outcome;
    }

    const broke = !live && game.bankroll <= 0;
    els.reset.hidden = !broke;
    els.deal.disabled = els.deal.disabled || broke;
  }

  function act(fn) {
    try {
      fn();
    } catch (err) {
      els.message.textContent = err.message;
    }
    render();
  }

  els.betForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const bet = Math.floor(Number(els.betInput.value));
    act(() => game.deal(bet));
  });
  els.hit.addEventListener('click', () => act(() => game.hit()));
  els.stand.addEventListener('click', () => act(() => game.stand()));
  els.double.addEventListener('click', () => act(() => game.double()));
  els.split.addEventListener('click', () => act(() => game.split()));
  els.surrender.addEventListener('click', () => act(() => game.surrender()));
  els.insure.addEventListener('click', () => act(() => game.takeInsurance()));
  els.noInsure.addEventListener('click', () => act(() => game.declineInsurance()));
  els.reset.addEventListener('click', () => {
    game = new Game({ bankroll: START_BANKROLL });
    els.message.textContent = 'Place your bet to start.';
    delete els.message.dataset.outcome;
    render();
  });

  const SHORTCUTS = {
    h: els.hit, s: els.stand, d: els.double, p: els.split, r: els.surrender,
    i: els.insure, n: els.noInsure,
  };
  document.addEventListener('keydown', (e) => {
    if (e.target === els.betInput || e.metaKey || e.ctrlKey) return;
    const btn = SHORTCUTS[e.key.toLowerCase()];
    if (btn && !btn.disabled && !btn.closest('[hidden]')) btn.click();
  });

  render();
})();
