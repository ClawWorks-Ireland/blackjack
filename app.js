/* UI layer: renders Blackjack.Game state, stats, sound and deal animations. */
(function () {
  'use strict';

  const START_BANKROLL = 1000;
  const TABLE_MIN = 1;
  const TABLE_MAX = 500;
  const LAST_BET_KEY = 'blackjack.lastBet';
  const RULES_KEY = 'blackjack.rules';
  const STATS_KEY = 'blackjack.stats';
  const HISTORY_KEY = 'blackjack.history';
  const MUTE_KEY = 'blackjack.muted';
  const COACH_KEY = 'blackjack.coach';
  const COUNT_KEY = 'blackjack.showCount';
  const UNIT_KEY = 'blackjack.unit';
  const SPOTS_KEY = 'blackjack.spots';
  const GAME_KEY = 'blackjack.game'; // bankroll, shoe and any round in progress
  const Blackjack = window.Blackjack;
  const { Game, handValue } = Blackjack;
  const Stats = window.BlackjackStats;
  const Sound = window.BlackjackSound;
  const Strategy = window.BlackjackStrategy;
  const { money, signedMoney } = window.BlackjackFormat;
  const Betting = window.BlackjackBetting;
  const Rules = window.BlackjackRules;
  const Counting = window.BlackjackCounting;
  const Side = window.BlackjackSideBets;
  const A11y = window.BlackjackA11y;
  const Prefs = window.BlackjackPrefs;
  const PREFS_KEY = 'blackjack.prefs';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const newGame = (bankroll, rules) =>
    new Game({ bankroll, minBet: TABLE_MIN, maxBet: TABLE_MAX, ...Rules.normalizeRules(rules) });
  // A saved game carries its own rules; otherwise use the saved settings.
  let game = loadGame() || newGame(START_BANKROLL, Rules.normalizeRules(parseJSON(storage('get', RULES_KEY))));
  // Saves from before table limits load without them; apply today's limits.
  game.minBet = TABLE_MIN;
  game.maxBet = TABLE_MAX;
  let lastBet = Betting.parseBet(storage('get', LAST_BET_KEY)); // initial bet of the last round
  // A restored round counts as round 1; a finished one is already in stats.
  let round = game.phase === 'betting' ? 0 : 1; // increments per deal
  let recordedRound = game.phase === 'done' ? round : 0; // last round folded into stats
  let stats = Stats.parseStats(storage('get', STATS_KEY));
  let history = Stats.parseHistory(storage('get', HISTORY_KEY));
  let session = Stats.emptyStats(); // this page visit only; not saved
  let statsScope = 'session';
  /** Apply a stats update to both the lifetime and the session totals. */
  const both = (fn) => { stats = fn(stats); session = fn(session); };
  Sound.muted = storage('get', MUTE_KEY) === '1';
  let countShown = storage('get', COUNT_KEY) === '1'; // hidden unless turned on
  let spots = [1, 2, 3].includes(Number(storage('get', SPOTS_KEY))) ? Number(storage('get', SPOTS_KEY)) : 1;
  let countNote = null; // result of your last count check, or a new-shoe notice

  // Animation bookkeeping: cards already on the table, and whether the
  // dealer's hole card was face-down on the previous render.
  let shown = new WeakSet();
  let holeWasHidden = false;
  let hintFor = null; // decision point the hint was requested for
  let coachNote = null; // feedback on your last off-chart move
  let coachOn = storage('get', COACH_KEY) !== '0'; // on unless turned off
  let inFlight = false; // dealt cards still animating onto the table
  let pendingAnnouncement = ''; // cards dealt this change, read out once they land
  let userActed = false; // only move focus after the player does something
  let focused = {}; // {phase, round} focus was last managed for
  let revealTimer = null;

  const $ = (id) => document.getElementById(id);
  const els = {
    dealerCards: $('dealer-cards'), dealerTotal: $('dealer-total'),
    playerHands: $('player-hands'),
    message: $('message'), bankroll: $('bankroll'), betDisplay: $('bet-display'),
    betForm: $('bet-form'), betInput: $('bet'), deal: $('deal'), limits: $('limits'), spotsGroup: $('spots'),
    chips: $('chips'), clearBet: $('clear-bet'), rebetRow: $('rebet'), rebet: $('rebet-1'), rebet2: $('rebet-2'),
    hit: $('hit'), stand: $('stand'), double: $('double'), split: $('split'),
    surrender: $('surrender'), insurance: $('insurance'), insure: $('insure'), noInsure: $('no-insure'),
    reset: $('reset'), mute: $('mute'), resetStats: $('reset-stats'), history: $('history'),
    scopeSession: $('scope-session'), scopeAll: $('scope-all'), graph: $('bank-graph'), graphLine: $('bank-line'),
    graphCaption: $('bank-caption'), exportCsv: $('export-csv'),
    hint: $('hint'), hintText: $('hint-text'), coach: $('coach'), coachToggle: $('coach-toggle'),
    countToggle: $('count-toggle'), countPanel: $('count-panel'), countRunning: $('count-running'),
    countTrue: $('count-true'), countDecks: $('count-decks'), countForm: $('count-check'),
    countGuess: $('count-guess'), countResult: $('count-result'),
    suggestRow: $('suggest-row'), suggestText: $('suggest-text'), suggestBet: $('suggest-bet'), unitInput: $('bet-unit'),
    sidePairs: $('side-pairs'), side213: $('side-213'), sideResult: $('side-result'), sideEdge: $('side-edge'),
    announcer: $('announcer'),
    prefsDialog: $('prefs'), prefsOpen: $('prefs-open'), prefsForm: $('prefs-form'), prefSpeed: $('pref-speed'),
    prefVolume: $('pref-volume'), prefVolumeValue: $('pref-volume-value'), prefTable: $('pref-table'),
    prefBack: $('pref-back'), prefsDefault: $('prefs-default'),
    help: $('help'), helpOpen: $('help-open'), helpClose: $('help-close'), helpList: $('help-list'),
    helpRules: $('help-rules'), helpPayouts: $('help-payouts'), helpSides: $('help-sides'), setPayouts: $('set-payouts'),
    rulesText: $('rules-text'), settings: $('settings'), rulesOpen: $('rules-open'),
    settingsForm: $('settings-form'), setDecks: $('set-decks'), setDas: $('set-das'), setLs: $('set-ls'),
    setEdge: $('set-edge'), setNote: $('set-note'), setApply: $('set-apply'), setCancel: $('set-cancel'),
    setDefault: $('set-default'),
    stat: {
      rate: $('stat-rate'), ret: $('stat-return'), record: $('stat-record'), blackjacks: $('stat-blackjacks'),
      accuracy: $('stat-accuracy'), hints: $('stat-hints'), counts: $('stat-counts'), net: $('stat-net'), streak: $('stat-streak'), best: $('stat-best'), rounds: $('stat-rounds'),
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

  function parseJSON(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function loadGame() {
    try {
      return Game.fromJSON(JSON.parse(storage('get', GAME_KEY)));
    } catch (_) {
      return null; // corrupt save: start fresh
    }
  }

  const saveGame = () => storage('set', GAME_KEY, JSON.stringify(game));

  // Display and sound preferences (Settings). 'auto' animation follows reduced motion.
  let prefs = Prefs.normalizePrefs(parseJSON(storage('get', PREFS_KEY)));
  const speed = () => Prefs.effectiveSpeed(prefs, reducedMotion.matches);
  const stepMs = () => Prefs.timing(speed()).step;
  const landMs = () => Prefs.timing(speed()).land; // longest card animation (the hole-card flip)

  function applyPrefs() {
    const body = document.body;
    body.classList.toggle('anim-off', speed() === 'off');
    body.classList.toggle('anim-fast', speed() === 'fast');
    body.dataset.table = prefs.table;
    body.dataset.back = prefs.back;
    Sound.volume = prefs.volume;
  }

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

  /**
   * Name for hand i: "You" with one hand, "Hand 2" when one spot is split,
   * and "Spot 2" / "Spot 2b" when you play more than one spot.
   */
  function handLabel(i) {
    const hands = game.hands;
    if (hands.length <= 1) return 'You';
    const spotCount = new Set(hands.map((h) => h.spot ?? 0)).size;
    if (spotCount <= 1) return `Hand ${i + 1}`;
    const s = hands[i].spot ?? 0;
    const same = hands.filter((h) => (h.spot ?? 0) === s);
    const n = `Spot ${s + 1}`;
    return same.length > 1 ? `${n}${'abcd'[same.indexOf(hands[i])]}` : n;
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
    const owner = new Map();
    game.hands.forEach((h, i) => h.cards.forEach((card) => owner.set(card, handLabel(i))));
    game.dealer.forEach((card) => owner.set(card, 'Dealer'));
    const placements = [];
    const place = (card, kind = 'dealt') => {
      const faceDown = live && card === game.dealer[1] && kind === 'dealt';
      placements.push({ who: owner.get(card), card: faceDown ? null : card, kind });
      plan.set(card, { kind, delay: slot * step });
      Sound.play('card', (slot * step) / 1000);
      slot++;
    };

    const newPlayer = [];
    game.hands.forEach((h) => h.cards.forEach((card) => { if (!shown.has(card)) newPlayer.push(card); }));
    const newDealer = game.dealer.filter((card) => !shown.has(card));

    const freshDeal = newDealer.length === 2 && newPlayer.length === game.hands.length * 2 &&
      game.hands.every((h) => h.cards.length === 2 && !shown.has(h.cards[0]));
    if (freshDeal) {
      // Fresh deal, table order: one card to each spot, the dealer, then again.
      game.hands.forEach((h) => place(h.cards[0]));
      place(newDealer[0]);
      game.hands.forEach((h) => place(h.cards[1]));
      place(newDealer[1]);
    } else {
      newPlayer.forEach((card) => place(card));
      const hole = game.dealer[1];
      if (hole && holeWasHidden && !live && !newDealer.includes(hole)) place(hole, 'flip');
      newDealer.forEach((card) => place(card));
    }

    game.hands.forEach((h) => h.cards.forEach((card) => shown.add(card)));
    game.dealer.forEach((card) => shown.add(card));
    holeWasHidden = live && game.dealer.length > 1;
    return { plan, settleAt: Math.max(0, slot - 1) * step, placements };
  }

  function handEl(hand, i, plan, inFlight) {
    const multi = game.hands.length > 1;
    const isActive = game.phase === 'player' && i === game.active;
    const result = game.phase === 'done' ? game.results[i] : null;

    const wrap = document.createElement('div');
    wrap.className = 'player-hand' + (isActive && multi ? ' active' : '');
    if (result) wrap.dataset.outcome = result.outcome;

    const label = document.createElement('h2');
    const name = handLabel(i);
    // While cards are still flying in, the total and outcome would give them away.
    let text = inFlight ? name : `${name} (${formatTotal(hand.cards)})`;
    if (multi) text += ` · ${money(hand.bet)}`;
    if (result && multi && !inFlight) text += ` · ${SHORT[result.outcome]}`;
    label.textContent = text;
    if (isActive && multi) label.setAttribute('aria-current', 'true');

    const cards = document.createElement('div');
    cards.className = 'cards';
    cards.append(...hand.cards.map((card) => cardEl(card, false, plan.get(card))));

    wrap.append(label, cards);
    return wrap;
  }

  function resultMessage() {
    if (game.tookEvenMoney) return `Even money. You win ${money(game.net)}.`;
    let text;
    if (game.results.length === 1) {
      const r = game.results[0];
      text = MESSAGES[r.outcome](r.net);
    } else {
      const parts = game.results.map((r, i) => `${handLabel(i)}: ${SHORT[r.outcome]}`);
      text = `${parts.join(' · ')}.`;
    }
    if (game.insuranceNet !== null) {
      text += game.insuranceNet > 0 ? ` Insurance pays ${money(game.insuranceNet)}.` : ' Insurance lost.';
    }
    if (game.sideBets.length) text += ` Side bets ${signedMoney(game.sideNet)}.`;
    if (game.results.length > 1 || game.insuranceNet !== null || game.sideBets.length) {
      text += ` Net ${signedMoney(game.net)}.`;
    }
    return text;
  }

  function netOutcome() {
    if (game.tookEvenMoney) return 'win';
    if (game.results.length === 1 && game.insuranceNet === null && !game.sideBets.length) {
      return game.results[0].outcome === 'surrender' ? 'lose' : game.results[0].outcome;
    }
    return game.net > 0 ? 'win' : game.net < 0 ? 'lose' : 'push';
  }

  function renderStats() {
    // Shadows the lifetime totals: the panel shows whichever scope is picked.
    const stats = statsScope === 'session' ? session : lifetimeStats();
    els.scopeSession.setAttribute('aria-pressed', String(statsScope === 'session'));
    els.scopeAll.setAttribute('aria-pressed', String(statsScope === 'all'));
    renderGraph();
    const rate = Stats.winRate(stats);
    els.stat.rate.textContent = rate === null ? '–' : `${Math.round(rate * 100)}%`;
    const ret = Stats.returnRate(stats);
    els.stat.ret.textContent = ret === null ? '–' : `${(ret * 100).toFixed(1)}%`;
    els.stat.ret.dataset.sign = ret === null ? '' : ret > 1 ? 'up' : ret < 1 ? 'down' : '';
    els.stat.record.textContent = `${stats.wins}–${stats.losses}–${stats.pushes}`;
    els.stat.blackjacks.textContent = String(stats.blackjacks);
    const acc = Stats.accuracy(stats);
    els.stat.accuracy.textContent = acc === null ? '–'
      : `${Math.round(acc * 100)}% (${stats.movesCorrect} of ${stats.movesScored})`;
    const cr = Stats.countRate(stats);
    els.stat.counts.textContent = cr === null ? '–'
      : `${stats.countCorrect} of ${stats.countChecks} (${Math.round(cr * 100)}%)`;
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
      evenMoney: game.tookEvenMoney,
      wagered: game.wagered,
      bankroll: game.bankroll,
      sideNet: game.sideNet,
      sideWins: game.sideBets.filter((s) => s.win).map((s) => `${Side.BETS[s.bet].name} ${s.win}`),
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
    els.history.replaceChildren(...history.slice(0, Stats.HISTORY_SHOWN).map((e) => {
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
      if (e.evenMoney) text += ' · even money';
      if (Number.isFinite(e.sideNet) && e.sideNet !== 0) {
        const wins = Array.isArray(e.sideWins) && e.sideWins.length ? ` (${e.sideWins.join(', ')})` : '';
        text += ` · side bets ${signedMoney(e.sideNet)}${wins}`;
      }
      else if (Number.isFinite(e.insurance)) text += e.insurance > 0 ? ' · insurance paid' : ' · insurance lost';
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

  /**
   * The coach's advice for this decision. With the count shown, it plays
   * the count (Illustrious 18, Fab 4, insurance at +3); otherwise basic
   * strategy. Hints, accuracy and coach notes all use this.
   */
  function currentAdvice() {
    const tc = countShown ? Counting.countState(game).trueCount : null;
    if (game.phase === 'insurance') {
      return (tc !== null && Counting.countInsurance(tc, game.evenMoneyOffered))
        || Strategy.insuranceAdvice(game.evenMoneyOffered);
    }
    const h = game.currentHand;
    if (!h) return null;
    const allowed = {
      canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender(),
    };
    const basic = Strategy.recommend(h.cards, game.dealer[0], allowed, game.rules);
    return tc === null ? basic : Counting.countPlay(h.cards, game.dealer[0], allowed, basic, tc, game.rules);
  }

  const ADVICE_BUTTON = {
    hit: 'hit', stand: 'stand', double: 'double', split: 'split', surrender: 'surrender',
    'no-insurance': 'noInsure', insurance: 'insure',
  };

  function renderHint() {
    const advice = hintFor === decisionKey() ? currentAdvice() : null;
    Object.values(ADVICE_BUTTON).forEach((k) => els[k].classList.remove('suggested'));
    els.hintText.hidden = !advice;
    if (!advice) return;
    const source = advice.deviation ? 'Count play' : 'Basic strategy';
    const basicNote = advice.basicLabel ? ` Basic strategy alone says ${advice.basicLabel}.` : '';
    els.hintText.textContent = `${source}: ${advice.label}. ${advice.reason}.${basicNote}`;
    els[ADVICE_BUTTON[advice.action]].classList.add('suggested');
  }

  /** Fold a finished round into stats once, and play its outcome cue. */
  function maybeRecord(settleAt) {
    if (game.phase !== 'done' || recordedRound === round) return;
    recordedRound = round;
    both((s) => Stats.recordRound(s, game.results, game.net, game.wagered));
    storage('set', STATS_KEY, JSON.stringify(stats));
    history = Stats.addHistory(history, historyEntry());
    storage('set', HISTORY_KEY, JSON.stringify(history));
    const outcome = netOutcome();
    const cue = outcome === 'blackjack' ? 'blackjack'
      : outcome === 'win' ? 'win' : outcome === 'push' ? 'push' : 'lose';
    Sound.play(cue, (settleAt + 250) / 1000);
  }

  /** Chips the finished round paid back (stakes, winnings, insurance). */
  function returnedThisRound() {
    // Side bets settle at the deal: take back any winnings until the cards land.
    const side = game.sideBets.reduce((sum, s) => sum + (s.win ? s.stake * (s.odds + 1) : 0), 0);
    if (game.phase !== 'done') return side;
    return side + roundReturn();
  }

  function roundReturn() {
    const hands = game.hands.reduce((sum, h, i) => sum + h.bet + game.results[i].net, 0);
    return hands + (game.insuranceNet > 0 ? game.insurance + game.insuranceNet : 0);
  }

  const ACTION_BUTTONS = [
    'hit', 'stand', 'double', 'split', 'surrender', 'insure', 'noInsure', 'hint', 'deal',
    'clearBet', 'rebet', 'rebet2',
  ];

  // Bets are per spot, so each spot can use its share of the bankroll.
  const limits = () => ({ bankroll: game.bankroll / spots, min: game.minBet, max: game.maxBet });

  /** Chip, clear and rebet controls, which only work between rounds. */
  function renderBetControls() {
    const open = !(game.phase === 'player' || game.phase === 'insurance') && !inFlight && !game.isBroke;
    for (const btn of els.chips.querySelectorAll('[data-chip]')) {
      const chip = Number(btn.dataset.chip);
      btn.disabled = !open || Betting.addChip(els.betInput.value, chip, limits()) === null;
    }
    els.clearBet.disabled = !open || !els.betInput.value;
    const one = Betting.rebetAmount(lastBet, 1, limits());
    const two = Betting.rebetAmount(lastBet, 2, limits());
    els.rebetRow.hidden = !(open && game.phase === 'done' && lastBet > 0);
    els.rebet.disabled = one === null;
    els.rebet2.disabled = two === null;
    const per = spots > 1 ? ` × ${spots} spots` : '';
    els.rebet.firstChild.textContent = `Rebet ${money(lastBet)}${per} `;
    els.rebet2.firstChild.textContent = `Rebet ×2 ${money(lastBet * 2)}${per} `;
    for (const r of els.spotsGroup.querySelectorAll('input')) {
      r.checked = Number(r.value) === spots;
      r.disabled = !open;
    }
  }

  /**
   * Two passes per change. While newly dealt cards are still in flight,
   * show the cards but hold back anything that gives them away (totals,
   * result, payout, stats) and lock the controls. Once the last card has
   * landed, render() runs again and fills everything in.
   */
  function render() {
    clearTimeout(revealTimer);
    const inRound = game.phase === 'player';
    const offering = game.phase === 'insurance';
    const live = inRound || offering;
    const { plan, settleAt, placements } = planAnimations(live);
    if (placements.length) pendingAnnouncement = [pendingAnnouncement, A11y.dealAnnouncement(placements)].filter(Boolean).join(' ');
    // While a hand is in play, betting rows collapse so the actions fit on a phone.
    document.body.classList.toggle('in-hand', live);
    renderRulesText();
    inFlight = plan.size > 0 && stepMs() > 0;

    els.dealerCards.replaceChildren(
      ...game.dealer.map((card, i) => cardEl(card, live && i === 1, plan.get(card)))
    );
    if (game.hands.length) {
      els.playerHands.replaceChildren(...game.hands.map((h, i) => handEl(h, i, plan, inFlight)));
    } else {
      const empty = document.createElement('h2');
      empty.textContent = 'You';
      els.playerHands.replaceChildren(empty);
    }

    const staked = game.hands.reduce((sum, h) => sum + h.bet, 0);
    const inPlay = staked + game.insurance;
    els.betDisplay.textContent = live || inFlight ? `· In play: ${money(inPlay)}` : '';

    maybeRecord(settleAt);
    saveGame();

    if (inFlight) {
      els.dealerTotal.textContent = '';
      els.bankroll.textContent = money(game.bankroll - returnedThisRound());
      ACTION_BUTTONS.forEach((k) => { els[k].disabled = true; });
      els.betInput.disabled = true;
      els.message.textContent = '';
      delete els.message.dataset.outcome;
      els.message.classList.remove('reveal');
      els.hintText.hidden = true;
      els.coach.hidden = true;
      els.reset.hidden = true;
      els.sideResult.hidden = true;
      els.rebetRow.hidden = true;
      els.chips.querySelectorAll('[data-chip]').forEach((b) => { b.disabled = true; });
      revealTimer = setTimeout(render, settleAt + landMs());
      return;
    }

    els.dealerTotal.textContent = !game.dealer.length ? ''
      : live ? `(${game.dealer[0].rank === 'A' ? 'ace' : handValue([game.dealer[0]]).total} showing)`
      : `(${formatTotal(game.dealer)})`;
    els.bankroll.textContent = money(game.bankroll);
    renderCount();
    renderSide();

    els.hit.disabled = !inRound;
    els.stand.disabled = !inRound;
    els.double.disabled = !game.canDouble();
    els.split.disabled = !game.canSplit();
    els.surrender.disabled = !game.canSurrender();
    els.insurance.hidden = !offering;
    els.insure.disabled = !game.canInsure();
    els.noInsure.disabled = !offering;
    const evenMoney = game.evenMoneyOffered;
    els.insure.firstChild.textContent = evenMoney ? 'Even money '
      : `Take insurance (${money(game.insuranceCost)}) `;
    els.noInsure.firstChild.textContent = evenMoney ? 'No even money ' : 'No insurance ';
    els.deal.disabled = live;
    els.betInput.disabled = live;
    els.betInput.max = String(Betting.maxBet(game.bankroll, game.maxBet));
    els.betInput.min = String(game.minBet);
    els.limits.textContent = `Table limits ${money(game.minBet)}–${money(game.maxBet)}`;

    if (game.phase === 'done' && game.results.length) {
      els.message.textContent = resultMessage();
      els.message.dataset.outcome = netOutcome();
      els.message.classList.remove('reveal');
      void els.message.offsetWidth; // restart the animation
      els.message.classList.add('reveal');
    } else if (offering) {
      els.message.textContent = evenMoney
        ? `Blackjack! Dealer shows an ace. Take even money (${money(game.hands[0].bet)} now)?`
        : game.canInsure()
        ? `Dealer shows an ace. Insure for ${money(game.insuranceCost)}?`
        : 'Dealer shows an ace. Not enough chips to insure.';
      const tcNow = Counting.countState(game).trueCount;
      if (countShown && Counting.countInsurance(tcNow) && game.canInsure()) {
        els.message.textContent += ` Count says take it (true count ${Counting.formatTrue(tcNow)}).`;
      }
      delete els.message.dataset.outcome;
      els.message.classList.remove('reveal');
    } else if (inRound) {
      const multi = game.hands.length > 1;
      els.message.textContent = multi
        ? `Playing ${handLabel(game.active)} (${game.active + 1} of ${game.hands.length}).`
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
    renderBetControls();

    renderStats();
    renderHistory();
    announceCards();
    manageFocus();
  }

  /** Read out the cards dealt since the last announcement, once they've landed. */
  function announceCards() {
    if (!userActed) pendingAnnouncement = ''; // don't read out a restored table on load
    if (!pendingAnnouncement) return;
    els.announcer.textContent = '';
    const text = pendingAnnouncement;
    pendingAnnouncement = '';
    // A fresh text node after clearing makes screen readers read it again.
    requestAnimationFrame(() => { els.announcer.textContent = text; });
  }

  const usable = (b) => b && !b.disabled && !b.closest('[hidden]') && b.offsetParent !== null;
  const focusFirst = (list) => {
    const b = list.find(usable);
    if (b && document.activeElement !== b) b.focus();
  };

  /**
   * After a deal, focus the first action you can take; after a round,
   * focus Rebet (or Deal). Only once you've started playing, never while a
   * dialog is open, and not when you're typing in the count box.
   */
  function manageFocus() {
    if (!userActed || els.help.open || els.settings.open || els.prefsDialog.open) return;
    if (document.activeElement === els.countGuess) return;
    const phase = game.phase;
    const target = A11y.focusTarget({ phase, round, focused, focusUsable: usable(document.activeElement) });
    if (target === 'actions') {
      focusFirst(phase === 'insurance' ? [els.insure, els.noInsure]
        : [els.hit, els.stand, els.double, els.split, els.surrender]);
    } else if (target === 'next') {
      focusFirst([els.rebet, els.deal]);
    }
    focused = { phase, round };
  }

  const MOVE_LABEL = {
    hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surrender',
    insurance: 'Take insurance', 'no-insurance': 'No insurance',
  };
  const EVEN_MONEY_LABEL = { insurance: 'Even money', 'no-insurance': 'No even money' };

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
      const chose = (game.evenMoneyOffered && EVEN_MONEY_LABEL[move]) || MOVE_LABEL[move];
      const source = advice.deviation ? 'The count says' : 'Basic strategy says';
      coachNote = `Off chart: you chose ${chose}. ${source} ${advice.label} (${why}).`;
    }
    both((s) => Stats.recordMove(s, correct));
    if (hinted) both((s) => Stats.recordHint(s, correct));
    storage('set', STATS_KEY, JSON.stringify(stats));
  }

  function act(fn, cue, move) {
    if (inFlight) return; // wait for the cards to land
    userActed = true;
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
    const bet = Number(els.betInput.value);
    const sides = { 'Perfect Pairs': els.sidePairs.value.trim(), '21+3': els.side213.value.trim() };
    const error = Betting.betError(bet, limits())
      || Betting.sideError(bet * spots, sides, { bankroll: game.bankroll, sideMax: Blackjack.SIDE_MAX });
    if (error) {
      els.message.textContent = error;
      delete els.message.dataset.outcome;
      return;
    }
    act(() => {
      game.deal(Array(spots).fill(bet), {
        pairs: Number(els.sidePairs.value) || 0,
        t213: Number(els.side213.value) || 0,
      });
      round++;
      coachNote = null;
      countNote = game.newShoe ? 'New shoe shuffled: the count starts again from 0.' : null;
      lastBet = bet;
      storage('set', LAST_BET_KEY, String(bet));
    }, 'chip');
  });

  els.spotsGroup.addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (![1, 2, 3].includes(n)) return;
    spots = n;
    storage('set', SPOTS_KEY, String(n));
    renderBetControls();
  });

  /** Put an amount in the bet box and deal it. */
  function dealAmount(amount) {
    if (amount === null) return;
    els.betInput.value = String(amount);
    els.betForm.requestSubmit();
  }

  els.chips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chip]');
    if (!btn || btn.disabled) return;
    const next = Betting.addChip(els.betInput.value, Number(btn.dataset.chip), limits());
    if (next === null) return;
    els.betInput.value = String(next);
    Sound.play('chip');
    renderBetControls();
  });
  els.clearBet.addEventListener('click', () => {
    els.betInput.value = '';
    renderBetControls();
    els.betInput.focus();
  });
  els.betInput.addEventListener('input', renderBetControls);
  els.rebet.addEventListener('click', () => dealAmount(Betting.rebetAmount(lastBet, 1, limits())));
  els.rebet2.addEventListener('click', () => dealAmount(Betting.rebetAmount(lastBet, 2, limits())));
  els.hit.addEventListener('click', () => act(() => game.hit(), null, 'hit'));
  els.stand.addEventListener('click', () => act(() => game.stand(), null, 'stand'));
  els.double.addEventListener('click', () => act(() => game.double(), 'chip', 'double'));
  els.split.addEventListener('click', () => act(() => game.split(), 'chip', 'split'));
  els.surrender.addEventListener('click', () => act(() => game.surrender(), null, 'surrender'));
  els.insure.addEventListener('click', () => act(() => game.takeInsurance(), 'chip', 'insurance'));
  els.noInsure.addEventListener('click', () => act(() => game.declineInsurance(), null, 'no-insurance'));
  els.reset.addEventListener('click', () => {
    game = newGame(START_BANKROLL, game.rules);
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
  // --- Stats scope, bankroll graph, CSV export ---

  const lifetimeStats = () => stats;

  function renderGraph() {
    const series = Stats.bankrollSeries(history, 100);
    const pts = Stats.sparkPoints(series, 260, 70, 4);
    els.graphLine.setAttribute('points', pts);
    if (series.length < 2) {
      els.graphCaption.textContent = 'The bankroll graph starts after two rounds.';
      els.graph.setAttribute('aria-label', 'Bankroll graph: not enough rounds yet');
      return;
    }
    const first = series[0];
    const last = series[series.length - 1];
    const text = `Bankroll over the last ${series.length} rounds: ${money(first)} to ${money(last)} ` +
      `(high ${money(Math.max(...series))}, low ${money(Math.min(...series))}).`;
    els.graphCaption.textContent = text;
    els.graph.setAttribute('aria-label', text);
    els.graph.dataset.sign = last > first ? 'up' : last < first ? 'down' : '';
  }

  els.scopeSession.addEventListener('click', () => { statsScope = 'session'; renderStats(); });
  els.scopeAll.addEventListener('click', () => { statsScope = 'all'; renderStats(); });

  els.exportCsv.addEventListener('click', () => {
    const blob = new Blob([Stats.historyCSV(history)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blackjack-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // --- Side bets ---

  function renderSide() {
    const bets = game.sideBets;
    els.sideResult.hidden = !bets.length || game.phase === 'betting';
    els.sideResult.textContent = bets.map((s) => (s.win
      ? `${Side.describeWin(s)}: +${money(s.net)}`
      : `${Side.BETS[s.bet].name}: no win, -${money(s.stake)}`)).join(' · ');
    const decks = game.decks;
    els.sideEdge.textContent = `House edge with ${decks} deck${decks > 1 ? 's' : ''}: ` +
      `Perfect Pairs ${Side.houseEdge('pairs', decks).toFixed(2)}%, 21+3 ${Side.houseEdge('t213', decks).toFixed(2)}%`;
  }

  // --- Card-counting trainer (Hi-Lo) ---

  /** Count panel and check result. Only called once dealt cards have landed. */
  function renderCount() {
    const s = Counting.countState(game);
    els.countToggle.setAttribute('aria-pressed', String(countShown));
    els.countToggle.firstChild.textContent = countShown ? 'Count shown ' : 'Count hidden ';
    els.countPanel.hidden = !countShown;
    els.countRunning.textContent = Counting.signed(s.running);
    els.countTrue.textContent = `${Counting.formatTrue(s.trueCount)} (plays as ${Counting.wholeTrue(s.trueCount)})`;
    els.countDecks.textContent = `${s.decksLeft.toFixed(1)} decks unseen`;
    // Suggested bet under the bet box: only while the count is shown, between rounds.
    const betting = !(game.phase === 'player' || game.phase === 'insurance') && !game.isBroke;
    const units = Counting.betUnits(s.trueCount);
    const unit = betUnit();
    const amount = Counting.suggestedBet(s.trueCount, {
      min: game.minBet, unit, max: game.maxBet, bankroll: game.bankroll,
    });
    els.suggestRow.hidden = !(countShown && betting);
    els.suggestText.textContent = `Suggested bet: ${money(amount)} (${units} unit${units > 1 ? 's' : ''} of ` +
      `${money(unit)} at true count ${Counting.formatTrue(s.trueCount)})`;
    els.suggestBet.dataset.amount = String(amount);
    els.suggestBet.disabled = !(amount >= game.minBet);
    els.countResult.hidden = !countNote;
    els.countResult.textContent = countNote || '';
  }

  /** Your base betting unit: saved, whole dollars, never below the table minimum. */
  function betUnit() {
    const n = Math.floor(Number(els.unitInput.value));
    return Number.isFinite(n) && n >= game.minBet ? n : game.minBet;
  }

  els.unitInput.value = storage('get', UNIT_KEY) || '';
  els.unitInput.addEventListener('input', () => {
    storage('set', UNIT_KEY, els.unitInput.value.trim());
    if (!inFlight) renderCount();
  });

  els.suggestBet.addEventListener('click', () => {
    const amount = Number(els.suggestBet.dataset.amount);
    if (!(amount > 0)) return;
    els.betInput.value = String(amount);
    Sound.play('chip');
    renderBetControls();
  });

  els.countToggle.addEventListener('click', () => {
    countShown = !countShown;
    storage('set', COUNT_KEY, countShown ? '1' : '0');
    if (!inFlight) { renderCount(); renderHint(); }
  });

  els.countForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (inFlight) {
      countNote = 'Wait for the cards to land, then check.';
      renderCount();
      return;
    }
    const guess = Counting.parseGuess(els.countGuess.value);
    if (guess === null) {
      countNote = 'Enter the running count as a whole number, like +3 or -2.';
      renderCount();
      return;
    }
    const { running, trueCount } = Counting.countState(game);
    const right = guess === running;
    both((s) => Stats.recordCountCheck(s, right));
    storage('set', STATS_KEY, JSON.stringify(stats));
    countNote = right
      ? `Right: the running count is ${Counting.signed(running)} (true count ${Counting.formatTrue(trueCount)}).`
      : `Not quite: the running count is ${Counting.signed(running)}, you said ${Counting.signed(guess)}.`;
    els.countGuess.value = '';
    els.countGuess.blur();
    renderCount();
    renderStats();
  });

  els.mute.addEventListener('click', () => {
    Sound.muted = !Sound.muted;
    storage('set', MUTE_KEY, Sound.muted ? '1' : '0');
    renderMute();
  });
  els.resetStats.addEventListener('click', () => {
    stats = Stats.emptyStats();
    session = Stats.emptyStats();
    history = [];
    storage('remove', STATS_KEY);
    storage('remove', HISTORY_KEY);
    renderStats();
    renderHistory();
  });

  // --- Table rules settings ---

  function renderRulesText() {
    const [one, two] = Rules.describe(game.rules);
    els.rulesText.replaceChildren(one, document.createElement('br'), two);
  }

  const radio = (name) => els.settingsForm.querySelector(`input[name="${name}"]:checked`);

  function readSettings() {
    return Rules.normalizeRules({
      decks: Number(els.setDecks.value),
      h17: radio('soft17').value === 'h17',
      payout: Number(radio('payout').value),
      das: els.setDas.checked,
      lateSurrender: els.setLs.checked,
    });
  }

  function fillSettings(rules) {
    els.setDecks.value = String(rules.decks);
    els.settingsForm.querySelector(`input[name="soft17"][value="${rules.h17 ? 'h17' : 's17'}"]`).checked = true;
    els.settingsForm.querySelector(`input[name="payout"][value="${rules.payout}"]`).checked = true;
    els.setDas.checked = rules.das;
    els.setLs.checked = rules.lateSurrender;
    renderSettingsPreview();
  }

  /** Live house edge for what's selected, and whether it can be applied now. */
  function renderSettingsPreview() {
    const chosen = readSettings();
    const edge = Rules.edgeText(chosen);
    const now = Rules.edgeText(game.rules);
    els.setEdge.textContent = Rules.sameRules(chosen, game.rules)
      ? `${edge} with basic strategy (current rules).`
      : `${edge} with basic strategy (now ${now.replace(/^(House|Player) edge /, '')}).`;
    const midRound = game.phase === 'player' || game.phase === 'insurance' || inFlight;
    els.setApply.disabled = midRound;
    els.setNote.hidden = !midRound;
  }

  els.rulesOpen.addEventListener('click', () => {
    if (els.settings.open) return;
    fillSettings(game.rules);
    els.settings.showModal();
  });
  els.settingsForm.addEventListener('change', renderSettingsPreview);
  els.setDefault.addEventListener('click', () => fillSettings({ ...Rules.DEFAULT_RULES }));
  els.setCancel.addEventListener('click', () => els.settings.close());
  els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.close(); });
  els.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (els.setApply.disabled) return;
    const chosen = readSettings();
    storage('set', RULES_KEY, JSON.stringify(chosen));
    els.settings.close();
    if (Rules.sameRules(chosen, game.rules)) return;
    // New rules mean a new table: same bankroll, fresh shoe, empty felt.
    game = newGame(game.bankroll, chosen);
    shown = new WeakSet();
    hintFor = null;
    coachNote = null;
    render();
    els.message.textContent = 'New rules are in effect with a fresh shoe. Place your bet.';
  });

  // --- Phone header scroll hint ---
  // On narrow screens the header buttons scroll sideways; fade whichever
  // edge has more buttons past it, and show an arrow until you reach the end.
  const top = document.getElementById('top');
  const moreHint = document.getElementById('more-hint');
  function updateMoreHint() {
    const left = top.scrollLeft > 2;
    const right = top.scrollLeft + top.clientWidth < top.scrollWidth - 2;
    top.dataset.more = [left && 'left', right && 'right'].filter(Boolean).join(' ');
    moreHint.hidden = !right;
  }
  top.addEventListener('scroll', updateMoreHint, { passive: true });
  window.addEventListener('resize', updateMoreHint);
  // Keyboard users tabbing to a hidden button: bring it into view.
  top.addEventListener('focusin', (e) => e.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
  updateMoreHint();

  // --- Settings (display and sound) ---

  function fillPrefs() {
    els.prefSpeed.value = prefs.speed;
    els.prefVolume.value = String(Math.round(prefs.volume * 100));
    els.prefVolumeValue.textContent = `${Math.round(prefs.volume * 100)}%`;
    els.prefTable.value = prefs.table;
    els.prefBack.value = prefs.back;
  }

  function readPrefs() {
    prefs = Prefs.normalizePrefs({
      speed: els.prefSpeed.value, volume: Number(els.prefVolume.value) / 100,
      table: els.prefTable.value, back: els.prefBack.value,
    });
    storage('set', PREFS_KEY, JSON.stringify(prefs));
    applyPrefs();
    els.prefVolumeValue.textContent = `${Math.round(prefs.volume * 100)}%`;
  }

  els.prefsOpen.addEventListener('click', () => {
    if (els.prefsDialog.open) return;
    fillPrefs();
    els.prefsDialog.showModal();
  });
  els.prefsForm.addEventListener('input', readPrefs);
  els.prefsForm.addEventListener('change', readPrefs);
  els.prefVolume.addEventListener('change', () => Sound.play('chip')); // hear the new level
  els.prefsDefault.addEventListener('click', () => {
    prefs = { ...Prefs.DEFAULT_PREFS };
    fillPrefs();
    readPrefs();
  });
  els.prefsDialog.addEventListener('click', (e) => { if (e.target === els.prefsDialog) els.prefsDialog.close(); });
  reducedMotion.addEventListener?.('change', applyPrefs);

  // Single source for key bindings and the help panel, so they can't drift.
  const SHORTCUT_GROUPS = [
    ['Your turn', [
      ['h', 'Hit', els.hit], ['s', 'Stand', els.stand], ['d', 'Double down', els.double],
      ['p', 'Split a pair', els.split], ['r', 'Surrender', els.surrender],
      ['g', 'Basic-strategy hint', els.hint],
    ]],
    ['Betting', [['x', 'Rebet ×2 after a round', els.rebet2]]],
    ['Insurance', [['i', 'Take insurance (even money)', els.insure], ['n', 'No insurance', els.noInsure]]],
    ['Counting', [
      ['k', 'Show or hide the count', els.countToggle], ['q', 'Check your running count', els.countGuess],
      ['b', 'Put the suggested bet in the bet box', els.suggestBet],
    ]],
    ['Settings', [
      ['m', 'Sound on/off', els.mute], ['c', 'Coach notes on/off', els.coachToggle],
      ['t', 'Table rules', els.rulesOpen], ['o', 'Settings: animation, volume, colours', els.prefsOpen],
      ['?', 'Rules, payouts and shortcuts', els.helpOpen],
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
      if (title === 'Betting') dl.prepend(shortcutRow('Enter', 'Deal, or deal again with the same bet'));
      return [h, dl];
    });
    els.helpList.replaceChildren(...sections.flat());
  }

  /** Rules and payouts for the table as it's set right now. */
  function renderPayouts() {
    const [one, two] = Rules.describe(game.rules);
    els.helpRules.replaceChildren(one, document.createElement('br'), two);
    const rows = (tbody, list) => tbody.replaceChildren(...list.map(([what, pays]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = what;
      const td = document.createElement('td');
      td.textContent = pays;
      tr.append(th, td);
      return tr;
    }));
    rows(els.helpPayouts.tBodies[0], Rules.payoutRows(game.rules));
    const sides = [];
    for (const [bet, table] of Object.entries(Side.PAYS)) {
      const edge = Side.houseEdge(bet, game.decks).toFixed(2);
      const pays = Object.entries(table).map(([hand, odds]) => `${hand} ${odds}:1`).join(', ');
      sides.push([`${Side.BETS[bet].name} (house edge ${edge}%)`, pays]);
    }
    rows(els.helpSides.tBodies[0], sides);
  }

  function openHelp() {
    renderPayouts();
    if (!els.help.open) els.help.showModal();
  }

  els.helpOpen.addEventListener('click', openHelp);
  els.setPayouts.addEventListener('click', () => {
    els.settings.close();
    openHelp();
  });
  els.helpClose.addEventListener('click', () => els.help.close());
  // Clicking the backdrop (outside the panel) closes it too.
  els.help.addEventListener('click', (e) => { if (e.target === els.help) els.help.close(); });

  document.addEventListener('keydown', (e) => {
    if (els.help.open || els.settings.open || els.prefsDialog.open) return; // Escape closes dialogs natively
    // Typing in any box (bet, side bets, count guess) isn't a shortcut.
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    // Enter between rounds deals again with the bet in the box (the last bet).
    // Buttons handle their own Enter, so leave those alone.
    if (e.key === 'Enter') {
      if (e.target.closest && e.target.closest('button, input, select, textarea')) return;
      if (!els.deal.disabled) {
        e.preventDefault();
        els.betForm.requestSubmit();
      }
      return;
    }
    const btn = SHORTCUTS[e.key.toLowerCase()];
    if (btn && !btn.disabled && !btn.closest('[hidden]')) {
      e.preventDefault();
      if (btn.tagName === 'INPUT') btn.focus(); // Q jumps to the count box
      else btn.click();
    }
  });

  renderHelp();

  applyPrefs();
  renderMute();
  render();
})();
