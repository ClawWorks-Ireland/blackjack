/* UI layer: renders Blackjack.Game state, stats, sound and deal animations. */
(function () {
  'use strict';

  const START_BANKROLL = 1000;
  const STATS_KEY = 'blackjack.stats';
  const HISTORY_KEY = 'blackjack.history';
  const MUTE_KEY = 'blackjack.muted';
  const COACH_KEY = 'blackjack.coach';
  const GAME_KEY = 'blackjack.game'; // bankroll, shoe and any round in progress
  const { Game, handValue } = window.Blackjack;
  const Stats = window.BlackjackStats;
  const Sound = window.BlackjackSound;
  const Strategy = window.BlackjackStrategy;
  const { money, signedMoney } = window.BlackjackFormat;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let game = loadGame() || new Game({ bankroll: START_BANKROLL });
  // A restored round counts as round 1; a finished one is already in stats.
  let round = game.phase === 'betting' ? 0 : 1; // increments per deal
  let recordedRound = game.phase === 'done' ? round : 0; // last round folded into stats
  let stats = Stats.parseStats(storage('get', STATS_KEY));
  let history = Stats.parseHistory(storage('get', HISTORY_KEY));
  Sound.muted = storage('get', MUTE_KEY) === '1';

  // Animation bookkeeping: cards already on the table, and whether the
  // dealer's hole card was face-down on the previous render.
  let shown = new WeakSet();
  let holeWasHidden = false;
  let hintFor = null; // decision point the hint was requested for
  let coachNote = null; // feedback on your last off-chart move
  let coachOn = storage('get', COACH_KEY) !== '0'; // on unless turned off

  const $ = (id) => document.getElementById(id);
  const els = {
    dealerCards: $('dealer-cards'), dealerTotal: $('dealer-total'),
    playerHands: $('player-hands'),
    message: $('message'), bankroll: $('bankroll'), betDisplay: $('bet-display'),
    betForm: $('bet-form'), betInput: $('bet'), deal: $('deal'),
    hit: $('hit'), stand: $('stand'), double: $('double'), split: $('split'),
    surrender: $('surrender'), insurance: $('insurance'), insure: $('insure'), noInsure: $('no-insure'),
    reset: $('reset'), mute: $('mute'), resetStats: $('reset-stats'), history: $('history'),
    hint: $('hint'), hintText: $('hint-text'), coach: $('coach'), coachToggle: $('coach-toggle'),
    help: $('help'), helpOpen: $('help-open'), helpClose: $('help-close'), helpList: $('help-list'),
    stat: {
      rate: $('stat-rate'), record: $('stat-record'), blackjacks: $('stat-blackjacks'),
      accuracy: $('stat-accuracy'), hints: $('stat-hints'), net: $('stat-net'), streak: $('stat-streak'), best: $('stat-best'), rounds: $('stat-rounds'),
    },
  };

  const MESSAGES = {
    blackjack: (net) => `Blackjack! You win ${money(net)}.`,
    win: (net) => `You win ${money(net)}.`,
    lose: () => 'Dealer wins.',
    bust: () => 'Bust. Dealer wins.',
    push: () => 'Push. Your bet is returned.',
    surrender: (net) => `You surrendered. ${money(-net)} is returned.`,
  };
  const SHORT = {
    blackjack: 'Blackjack', win: 'Win', lose: 'Lose', bust: 'Bust', push: 'Push', surrender: 'Surrender',
  };

  const suitName = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };

  /** localStorage wrapper that tolerates private mode / disabled storage. */
  function storage(op, key, value) {
    try {
      if (op === 'get') return window.localStorage.getItem(key);
      if (op === 'set') window.localStorage.setItem(key, value);
      if (op === 'remove') window.localStorage.removeItem(key);
    } catch (_) { /* storage unavailable: session-only */ }
    return null;
  }

  function loadGame() {
    try {
      return Game.fromJSON(JSON.parse(storage('get', GAME_KEY)));
    } catch (_) {
      return null; // corrupt save: start fresh
    }
  }

  const saveGame = () => storage('set', GAME_KEY, JSON.stringify(game));

  const stepMs = () => (reducedMotion.matches ? 0 : 180);

  function cardEl(card, hidden, anim) {
    const div = document.createElement('div');
    if (anim) {
      div.classList.add(anim.kind);
      div.style.animationDelay = `${anim.delay}ms`;
    }
    if (hidden) {
      div.classList.add('card', 'back');
      div.setAttribute('aria-label', 'Face-down card');
      return div;
    }
    const red = card.suit === '♥' || card.suit === '♦';
    div.classList.add('card');
    if (red) div.classList.add('red');
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

  /**
   * Work out which cards are new since the last render and give each a
   * staggered delay in the order a dealer would place them. Returns a Map
   * card -> {kind, delay} plus when the last card lands, and plays a card
   * sound per placement on the same schedule.
   */
  function planAnimations(live) {
    const plan = new Map();
    const step = stepMs();
    let slot = 0;
    const place = (card, kind = 'dealt') => {
      plan.set(card, { kind, delay: slot * step });
      Sound.play('card', (slot * step) / 1000);
      slot++;
    };

    const newPlayer = [];
    game.hands.forEach((h) => h.cards.forEach((card) => { if (!shown.has(card)) newPlayer.push(card); }));
    const newDealer = game.dealer.filter((card) => !shown.has(card));

    if (newPlayer.length === 2 && newDealer.length === 2 && game.hands.length === 1) {
      // Fresh deal: player, dealer, player, dealer.
      [newPlayer[0], newDealer[0], newPlayer[1], newDealer[1]].forEach((card) => place(card));
    } else {
      newPlayer.forEach((card) => place(card));
      const hole = game.dealer[1];
      if (hole && holeWasHidden && !live && !newDealer.includes(hole)) place(hole, 'flip');
      newDealer.forEach((card) => place(card));
    }

    game.hands.forEach((h) => h.cards.forEach((card) => shown.add(card)));
    game.dealer.forEach((card) => shown.add(card));
    holeWasHidden = live && game.dealer.length > 1;
    return { plan, settleAt: Math.max(0, slot - 1) * step };
  }

  function handEl(hand, i, plan) {
    const multi = game.hands.length > 1;
    const isActive = game.phase === 'player' && i === game.active;
    const result = game.phase === 'done' ? game.results[i] : null;

    const wrap = document.createElement('div');
    wrap.className = 'player-hand' + (isActive && multi ? ' active' : '');
    if (result) wrap.dataset.outcome = result.outcome;

    const label = document.createElement('h2');
    const name = multi ? `Hand ${i + 1}` : 'You';
    let text = `${name} (${formatTotal(hand.cards)})`;
    if (multi) text += ` · ${money(hand.bet)}`;
    if (result && multi) text += ` · ${SHORT[result.outcome]}`;
    label.textContent = text;
    if (isActive && multi) label.setAttribute('aria-current', 'true');

    const cards = document.createElement('div');
    cards.className = 'cards';
    cards.append(...hand.cards.map((card) => cardEl(card, false, plan.get(card))));

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

  function renderStats() {
    const rate = Stats.winRate(stats);
    els.stat.rate.textContent = rate === null ? '–' : `${Math.round(rate * 100)}%`;
    els.stat.record.textContent = `${stats.wins}–${stats.losses}–${stats.pushes}`;
    els.stat.blackjacks.textContent = String(stats.blackjacks);
    const acc = Stats.accuracy(stats);
    els.stat.accuracy.textContent = acc === null ? '–'
      : `${Math.round(acc * 100)}% (${stats.movesCorrect} of ${stats.movesScored})`;
    const hr = Stats.hintRate(stats);
    els.stat.hints.textContent = hr === null ? '–'
      : `${stats.hintsFollowed} of ${stats.hintsShown} (${Math.round(hr * 100)}%)`;
    els.stat.net.textContent = money(stats.net);
    els.stat.net.dataset.sign = stats.net > 0 ? 'up' : stats.net < 0 ? 'down' : '';
    els.stat.streak.textContent = stats.streak > 0 ? `${stats.streak} won`
      : stats.streak < 0 ? `${-stats.streak} lost` : '–';
    els.stat.best.textContent = money(stats.bestRound);
    els.stat.rounds.textContent = String(stats.rounds);
  }

  const cardText = (cards) => cards.map((c) => c.rank + c.suit).join(' ');

  function historyEntry() {
    return {
      round: stats.rounds,
      net: game.net,
      insurance: game.insuranceNet,
      dealer: handValue(game.dealer).total,
      dealerCards: cardText(game.dealer),
      hands: game.hands.map((h, i) => ({
        cards: cardText(h.cards), total: handValue(h.cards).total, outcome: game.results[i].outcome,
      })),
    };
  }

  function renderHistory() {
    if (!history.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No hands yet.';
      els.history.replaceChildren(li);
      return;
    }
    els.history.replaceChildren(...history.map((e) => {
      const li = document.createElement('li');
      li.dataset.sign = e.net > 0 ? 'up' : e.net < 0 ? 'down' : '';
      const top = document.createElement('div');
      top.className = 'row';
      const label = document.createElement('span');
      const outcomes = e.hands.map((h) => SHORT[h.outcome]).join(', ');
      label.textContent = `#${e.round} ${outcomes}`;
      const net = document.createElement('span');
      net.className = 'net';
      net.textContent = signedMoney(e.net);
      top.append(label, net);

      const detail = document.createElement('div');
      detail.className = 'detail';
      const yours = e.hands.map((h) => `${h.cards} (${h.total})`).join(' | ');
      let text = `${yours} vs ${e.dealerCards} (${e.dealer})`;
      if (Number.isFinite(e.insurance)) text += e.insurance > 0 ? ' · insurance paid' : ' · insurance lost';
      detail.textContent = text;
      li.append(top, detail);
      return li;
    }));
  }

  /** Identifies the current decision, so a hint expires once you act. */
  function decisionKey() {
    const h = game.currentHand;
    return `${round}:${game.phase}:${game.active}:${h ? h.cards.length : 0}`;
  }

  function currentAdvice() {
    if (game.phase === 'insurance') return Strategy.insuranceAdvice();
    const h = game.currentHand;
    if (!h) return null;
    return Strategy.recommend(h.cards, game.dealer[0], {
      canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender(),
    });
  }

  const ADVICE_BUTTON = {
    hit: 'hit', stand: 'stand', double: 'double', split: 'split', surrender: 'surrender',
    'no-insurance': 'noInsure',
  };

  function renderHint() {
    const advice = hintFor === decisionKey() ? currentAdvice() : null;
    Object.values(ADVICE_BUTTON).forEach((k) => els[k].classList.remove('suggested'));
    els.hintText.hidden = !advice;
    if (!advice) return;
    els.hintText.textContent = `Basic strategy: ${advice.label}. ${advice.reason}.`;
    els[ADVICE_BUTTON[advice.action]].classList.add('suggested');
  }

  /** Fold a finished round into stats once, and play its outcome cue. */
  function maybeRecord(settleAt) {
    if (game.phase !== 'done' || recordedRound === round) return;
    recordedRound = round;
    stats = Stats.recordRound(stats, game.results, game.net);
    storage('set', STATS_KEY, JSON.stringify(stats));
    history = Stats.addHistory(history, historyEntry());
    storage('set', HISTORY_KEY, JSON.stringify(history));
    const outcome = netOutcome();
    const cue = outcome === 'blackjack' ? 'blackjack'
      : outcome === 'win' ? 'win' : outcome === 'push' ? 'push' : 'lose';
    Sound.play(cue, (settleAt + 250) / 1000);
  }

  function render() {
    const inRound = game.phase === 'player';
    const offering = game.phase === 'insurance';
    const live = inRound || offering;
    const { plan, settleAt } = planAnimations(live);

    els.dealerCards.replaceChildren(
      ...game.dealer.map((card, i) => cardEl(card, live && i === 1, plan.get(card)))
    );
    els.dealerTotal.textContent = !game.dealer.length ? ''
      : live ? `(${game.dealer[0].rank === 'A' ? 'ace' : handValue([game.dealer[0]]).total} showing)`
      : `(${formatTotal(game.dealer)})`;

    if (game.hands.length) {
      els.playerHands.replaceChildren(...game.hands.map((h, i) => handEl(h, i, plan)));
    } else {
      const empty = document.createElement('h2');
      empty.textContent = 'You';
      els.playerHands.replaceChildren(empty);
    }

    els.bankroll.textContent = money(game.bankroll);
    const staked = game.hands.reduce((sum, h) => sum + h.bet, 0);
    const inPlay = staked + game.insurance;
    els.betDisplay.textContent = live ? `· In play: ${money(inPlay)}` : '';

    els.hit.disabled = !inRound;
    els.stand.disabled = !inRound;
    els.double.disabled = !game.canDouble();
    els.split.disabled = !game.canSplit();
    els.surrender.disabled = !game.canSurrender();
    els.insurance.hidden = !offering;
    els.insure.disabled = !game.canInsure();
    els.insure.firstChild.textContent = `Take insurance (${money(game.insuranceCost)}) `;
    els.deal.disabled = live;
    els.betInput.disabled = live;
    els.betInput.max = String(game.bankroll);

    if (game.phase === 'done' && game.results.length) {
      els.message.textContent = resultMessage();
      els.message.dataset.outcome = netOutcome();
      // Let the last card land before the result appears.
      els.message.style.animationDelay = `${settleAt}ms`;
      els.message.classList.remove('reveal');
      void els.message.offsetWidth; // restart the animation
      els.message.classList.add('reveal');
    } else if (offering) {
      els.message.textContent = game.canInsure()
        ? `Dealer shows an ace. Insure for ${money(game.insuranceCost)}?`
        : 'Dealer shows an ace. Not enough chips to insure.';
      delete els.message.dataset.outcome;
      els.message.classList.remove('reveal');
    } else if (inRound) {
      const multi = game.hands.length > 1;
      els.message.textContent = multi
        ? `Playing hand ${game.active + 1} of ${game.hands.length}.`
        : 'Your move.';
      delete els.message.dataset.outcome;
      els.message.classList.remove('reveal');
    }

    els.hint.disabled = !live;
    renderHint();
    renderCoach();

    // Broke means below the minimum bet, not just zero: $0.50 can't be bet.
    const broke = game.isBroke;
    els.reset.hidden = !broke;
    els.reset.textContent = game.bankroll > 0
      ? `Not enough for the ${money(game.minBet)} minimum bet. Start over with ${money(START_BANKROLL)}`
      : `Out of chips. Start over with ${money(START_BANKROLL)}`;
    els.deal.disabled = els.deal.disabled || broke;

    maybeRecord(settleAt);
    saveGame();
    renderStats();
    renderHistory();
  }

  const MOVE_LABEL = {
    hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surrender',
    insurance: 'Take insurance', 'no-insurance': 'No insurance',
  };

  function renderCoach() {
    const show = coachOn && !!coachNote;
    els.coach.hidden = !show;
    els.coach.textContent = show ? coachNote : '';
    els.coachToggle.setAttribute('aria-pressed', String(coachOn));
    els.coachToggle.firstChild.textContent = coachOn ? 'Coach notes on ' : 'Coach notes off ';
  }

  /**
   * Score `move` against basic strategy, and against the hint if one is
   * showing. Runs before the move so the advice reflects the state you
   * acted on.
   */
  function scoreMove(move) {
    coachNote = null;
    if (!move) return;
    const advice = currentAdvice();
    const hinted = hintFor === decisionKey();
    hintFor = null;
    if (!advice) return;
    const correct = advice.action === move;
    if (!correct) {
      const why = advice.reason.charAt(0).toLowerCase() + advice.reason.slice(1);
      coachNote = `Off chart: you chose ${MOVE_LABEL[move]}. ` +
        `Basic strategy says ${advice.label} (${why}).`;
    }
    stats = Stats.recordMove(stats, correct);
    if (hinted) stats = Stats.recordHint(stats, correct);
    storage('set', STATS_KEY, JSON.stringify(stats));
  }

  function act(fn, cue, move) {
    try {
      scoreMove(move);
      fn();
      if (cue) Sound.play(cue);
    } catch (err) {
      els.message.textContent = err.message;
    }
    render();
  }

  function renderMute() {
    els.mute.setAttribute('aria-pressed', String(Sound.muted));
    els.mute.firstChild.textContent = Sound.muted ? '🔇 Sound off ' : '🔊 Sound on ';
  }

  els.betForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const bet = Math.floor(Number(els.betInput.value));
    act(() => { game.deal(bet); round++; coachNote = null; }, 'chip');
  });
  els.hit.addEventListener('click', () => act(() => game.hit(), null, 'hit'));
  els.stand.addEventListener('click', () => act(() => game.stand(), null, 'stand'));
  els.double.addEventListener('click', () => act(() => game.double(), 'chip', 'double'));
  els.split.addEventListener('click', () => act(() => game.split(), 'chip', 'split'));
  els.surrender.addEventListener('click', () => act(() => game.surrender(), null, 'surrender'));
  els.insure.addEventListener('click', () => act(() => game.takeInsurance(), 'chip', 'insurance'));
  els.noInsure.addEventListener('click', () => act(() => game.declineInsurance(), null, 'no-insurance'));
  els.reset.addEventListener('click', () => {
    game = new Game({ bankroll: START_BANKROLL });
    shown = new WeakSet();
    els.message.textContent = 'Place your bet to start.';
    delete els.message.dataset.outcome;
    render();
  });
  els.hint.addEventListener('click', () => {
    hintFor = decisionKey();
    renderHint();
  });
  els.coachToggle.addEventListener('click', () => {
    coachOn = !coachOn;
    storage('set', COACH_KEY, coachOn ? '1' : '0');
    renderCoach();
  });
  els.mute.addEventListener('click', () => {
    Sound.muted = !Sound.muted;
    storage('set', MUTE_KEY, Sound.muted ? '1' : '0');
    renderMute();
  });
  els.resetStats.addEventListener('click', () => {
    stats = Stats.emptyStats();
    history = [];
    storage('remove', STATS_KEY);
    storage('remove', HISTORY_KEY);
    renderStats();
    renderHistory();
  });

  // Single source for key bindings and the help panel, so they can't drift.
  const SHORTCUT_GROUPS = [
    ['Your turn', [
      ['h', 'Hit', els.hit], ['s', 'Stand', els.stand], ['d', 'Double down', els.double],
      ['p', 'Split a pair', els.split], ['r', 'Surrender', els.surrender],
      ['g', 'Basic-strategy hint', els.hint],
    ]],
    ['Insurance', [['i', 'Take insurance', els.insure], ['n', 'No insurance', els.noInsure]]],
    ['Settings', [
      ['m', 'Sound on/off', els.mute], ['c', 'Coach notes on/off', els.coachToggle],
      ['?', 'Show this help', els.helpOpen],
    ]],
  ];
  const SHORTCUTS = Object.fromEntries(
    SHORTCUT_GROUPS.flatMap(([, keys]) => keys.map(([key, , btn]) => [key, btn]))
  );

  function shortcutRow(key, label) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    dt.append(kbd);
    const dd = document.createElement('dd');
    dd.textContent = label;
    row.append(dt, dd);
    return row;
  }

  function renderHelp() {
    const sections = SHORTCUT_GROUPS.map(([title, keys]) => {
      const h = document.createElement('h3');
      h.textContent = title;
      const dl = document.createElement('dl');
      dl.append(...keys.map(([key, label]) => shortcutRow(key.toUpperCase(), label)));
      if (title === 'Your turn') dl.append(shortcutRow('Enter', 'Deal (in the bet box)'));
      return [h, dl];
    });
    els.helpList.replaceChildren(...sections.flat());
  }

  els.helpOpen.addEventListener('click', () => {
    if (!els.help.open) els.help.showModal();
  });
  els.helpClose.addEventListener('click', () => els.help.close());
  // Clicking the backdrop (outside the panel) closes it too.
  els.help.addEventListener('click', (e) => { if (e.target === els.help) els.help.close(); });

  document.addEventListener('keydown', (e) => {
    if (els.help.open) return; // Escape closes the dialog natively
    if (e.target === els.betInput || e.metaKey || e.ctrlKey || e.altKey) return;
    const btn = SHORTCUTS[e.key.toLowerCase()];
    if (btn && !btn.disabled && !btn.closest('[hidden]')) {
      e.preventDefault();
      btn.click();
    }
  });

  renderHelp();

  renderMute();
  render();
})();
