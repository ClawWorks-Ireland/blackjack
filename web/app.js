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
  const REPORTS_KEY = 'blackjack.shoeReports';
  const SEED_KEY = 'blackjack.seed'; // the seed typed in Table rules; blank = random
  const MUTE_KEY = 'blackjack.muted';
  const COACH_KEY = 'blackjack.coach';
  const COUNT_KEY = 'blackjack.showCount';
  const SIT_KEY = 'blackjack.sitOut';
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
  const ReportHit = window.BlackjackReportHit;
  const Prefs = window.BlackjackPrefs;
  const Chart = window.BlackjackChart;
  const Drill = window.BlackjackDrill;
  const EV = window.BlackjackEV;
  let roundMistakes = []; // this round's off-chart plays with their cost
  const Report = window.BlackjackReport;
  const Replay = window.BlackjackReplay;
  let shoeTracker = Report.newShoe(); // F18: this shoe's bets, index spots and count checks
  let sessionShoes = []; // finished shoes this session
  let reports = [];      // saved shoe summaries, newest first (set after storage is ready)
  let pendingReport = null; // a shoe report held back because a hand was dealt before it opened (B16)
  const REPORT_GRACE_MS = 500; // a click on a deal control this soon after a report opens by itself still deals (#99)
  let reportGraceUntil = 0; // performance.now() when that grace window ends
  let reportFocusBefore = null; // the element focused just before the report opened by itself (#109)
  let reportShown = null; // the shoe the report dialog is showing (for the end-count check)
  let roundBefore = null; // F19: bankroll and count at this round's deal, for its replay record
  const REPLAY_KEEP = 20; // rounds that keep a replay record
  const PREFS_KEY = 'blackjack.prefs';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** A new table. Every game is seeded (a random seed unless you typed one), so any shoe can be replayed. */
  const newGame = (bankroll, rules, seedText = storage('get', SEED_KEY)) => {
    const parsed = Blackjack.parseSeed(seedText) || { seed: Blackjack.randomSeed(), shoeNo: 1 };
    return new Game({ bankroll, minBet: TABLE_MIN, maxBet: TABLE_MAX, ...Rules.normalizeRules(rules), ...parsed });
  };
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
  let sitOut = storage('get', SIT_KEY) === '1'; // Wonged out: rounds are watched, not played
  let watched = null; // the last sat-out round {seat, dealer}
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
    review: $('review'), hint: $('hint'), hintText: $('hint-text'), coach: $('coach'), coachToggle: $('coach-toggle'),
    countToggle: $('count-toggle'), countPanel: $('count-panel'), countRunning: $('count-running'),
    countTrue: $('count-true'), countDecks: $('count-decks'), countForm: $('count-check'),
    countGuess: $('count-guess'), countResult: $('count-result'),
    suggestRow: $('suggest-row'), suggestText: $('suggest-text'), suggestBet: $('suggest-bet'), unitInput: $('bet-unit'),
    sidePairs: $('side-pairs'), side213: $('side-213'), sideResult: $('side-result'), sideEdge: $('side-edge'),
    announcer: $('announcer'),
    prefsDialog: $('prefs'), prefsOpen: $('prefs-open'), prefsForm: $('prefs-form'), prefSpeed: $('pref-speed'),
    prefVolume: $('pref-volume'), prefVolumeValue: $('pref-volume-value'), prefTable: $('pref-table'),
    prefBack: $('pref-back'), prefsDefault: $('prefs-default'),
    chartDialog: $('chart'), chartRules: $('chart-rules'), chartLegend: $('chart-legend'),
    chartTables: $('chart-tables'), chartMisses: $('chart-misses'), chartCountNote: $('chart-count-note'),
    chartClose: $('chart-close'), chartOpenHelp: $('chart-open-help'),
    drillDialog: $('drill'), drillOpen: $('drill-open'), drillClose: $('drill-close'),
    reportDialog: $('report'), reportOpen: $('report-open'), reportClose: $('report-close'),
    reportTitle: $('report-title'), reportSub: $('report-sub'), repR: $('rep-r'), repNote: $('rep-note'),
    repWithin: $('rep-within'), repIndex: $('rep-index'), repChecks: $('rep-checks'), repNet: $('rep-net'),
    repExpected: $('rep-expected'), repLuck: $('rep-luck'), repPerfect: $('rep-perfect'), repGap: $('rep-gap'),
    repEv: $('rep-ev'), repMissedLabel: $('rep-missed-label'), repMissed: $('rep-missed'), repCount: $('rep-count'),
    repGuess: $('rep-guess'), repCountResult: $('rep-count-result'), prefShoeReport: $('pref-shoe-report'),
    bankDialog: $('bank'), bankOpen: $('bank-open'), bankClose: $('bank-close'), bankForm: $('bank-form'),
    bankRoll: $('bank-roll'), bankUnit: $('bank-unit'), bankHph: $('bank-hph'), bankDecks: $('bank-decks'),
    bankH17: $('bank-h17'), bank65: $('bank-65'), bankDas: $('bank-das'), bankLs: $('bank-ls'),
    bankPen: $('bank-pen'), bankPenValue: $('bank-pen-value'), bankRun: $('bank-run'), bankProgress: $('bank-progress'),
    bankResults: $('bank-results'), bankStatus: $('bank-status'), bankEv: $('bank-ev'), bankEvHour: $('bank-ev-hour'),
    bankSd: $('bank-sd'), bankAvg: $('bank-avg'), bankN0: $('bank-n0'), bankRor: $('bank-ror'),
    tabFlash: $('tab-flash'), tabCount: $('tab-count'), panelFlash: $('panel-flash'), panelCount: $('panel-count'),
    flashCount: $('flash-count'), flashUp: $('flash-up'), flashHand: $('flash-hand'), flashTotal: $('flash-total'),
    flashTc: $('flash-tc'), flashAnswers: $('flash-answers'), flashFeedback: $('flash-feedback'),
    flashNext: $('flash-next'), flashScore: $('flash-score'),
    cdSize: $('cd-size'), cdSpeed: $('cd-speed'), cdStart: $('cd-start'), cdCard: $('cd-card'),
    cdProgress: $('cd-progress'), cdForm: $('cd-form'), cdGuess: $('cd-guess'), cdResult: $('cd-result'),
    sitToggle: $('sit-toggle'), countPen: $('count-pen'), countWong: $('count-wong'),
    setPen: $('set-pen'), setPenValue: $('set-pen-value'), prefWongOut: $('pref-wong-out'), prefWongIn: $('pref-wong-in'),
    help: $('help'), helpOpen: $('help-open'), helpClose: $('help-close'), helpList: $('help-list'),
    helpRules: $('help-rules'), helpPayouts: $('help-payouts'), helpSides: $('help-sides'), setPayouts: $('set-payouts'),
    rulesText: $('rules-text'), settings: $('settings'), rulesOpen: $('rules-open'),
    countSystemName: $('count-system'), countTrueLabel: $('count-true-label'), countNoteText: $('count-note'),
    prefSystem: $('pref-system'), helpTags: $('help-tags'), helpTagsNote: $('help-tags-note'),
    seedText: $('seed-text'), seedCopy: $('seed-copy'), seedCopied: $('seed-copied'), setSeed: $('set-seed'),
    reportAgain: $('report-again'), replayDialog: $('replay'), replayOpen: $('replay-open'), replayClose: $('replay-close'),
    replayPick: $('replay-pick'), replayEmpty: $('replay-empty'), replayStage: $('replay-stage'),
    replayDealer: $('replay-dealer'), replayDealerTotal: $('replay-dealer-total'), replayHands: $('replay-hands'),
    replayText: $('replay-text'), replayCoach: $('replay-coach'), replayPrev: $('replay-prev'), replayNext: $('replay-next'),
    replayStep: $('replay-step'),
    settingsForm: $('settings-form'), setDecks: $('set-decks'), setDas: $('set-das'), setLs: $('set-ls'),
    setDouble: $('set-double'), setRsa: $('set-rsa'), setEnhc: $('set-enhc'), setObo: $('set-obo'),
    setEdge: $('set-edge'), setNote: $('set-note'), setApply: $('set-apply'), setCancel: $('set-cancel'),
    setDefault: $('set-default'),
    stat: {
      rate: $('stat-rate'), ret: $('stat-return'), record: $('stat-record'), blackjacks: $('stat-blackjacks'),
      evlost: $('stat-evlost'), accuracy: $('stat-accuracy'), hints: $('stat-hints'), counts: $('stat-counts'), net: $('stat-net'), streak: $('stat-streak'), best: $('stat-best'), rounds: $('stat-rounds'),
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
    const lostRate = Stats.evLostRate(stats);
    els.stat.evlost.textContent = stats.evLost > 0 || lostRate !== null
      ? `${money(Math.round(stats.evLost * 100) / 100)}${lostRate === null ? '' : ` (${(lostRate * 100).toFixed(2)}% of bets)`}`
      : '–';
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
      mistakes: roundMistakes.map((m) => m.text),
      evLost: roundMistakes.reduce((s, m) => s + m.dollars, 0),
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
      if (Array.isArray(e.mistakes) && e.mistakes.length) {
        text += ` · mistakes: ${e.mistakes.join('; ')}`;
      }
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
    // Index plays are Hi-Lo's, so only a Hi-Lo counter gets deviations; insurance follows any system.
    const tc = countShown && countSystem() === 'hilo' ? Counting.countState(game).trueCount : null;
    if (game.phase === 'insurance') {
      return (countShown && Counting.systemInsurance(Counting.systemState(game, countSystem()), game.evenMoneyOffered))
        || Strategy.insuranceAdvice(game.evenMoneyOffered);
    }
    const h = game.currentHand;
    if (!h) return null;
    const allowed = {
      canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender(), canHit: game.canHit(),
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

  const inReportGrace = () => els.reportDialog.open && performance.now() < reportGraceUntil;

  /** Close the held report, let the dealt hand settle, then reopen it; `act` (default control.click) deals. */
  function forwardGraceClick(control, act) {
    const held = reportShown;
    els.reportDialog.close();
    pendingReport = held; // reopens after the dealt hand settles
    if (act) act(); else control.click();
  }

  /** Open a report by itself: remember where focus was, then start the grace window (#99, #109). */
  function openReportWithGrace(shoe) {
    reportFocusBefore = document.activeElement;
    showReport(shoe);
    reportGraceUntil = performance.now() + REPORT_GRACE_MS;
  }

  /**
   * Open a shoe report after `delay` ms, but only between rounds: if a new
   * hand was dealt meanwhile, hold it, and render() opens it once that hand
   * has settled and its cards have landed, before Deal unlocks. It never
   * covers Hit and Stand (B16).
   */
  function queueReport(shoe, delay) {
    setTimeout(() => {
      if (!inFlight && game.phase !== 'player' && game.phase !== 'insurance') openReportWithGrace(shoe);
      else pendingReport = shoe;
    }, delay);
  }

  /** Fold a finished round into stats once, and play its outcome cue. */
  function maybeRecord(settleAt) {
    if (game.phase !== 'done' || recordedRound === round) return;
    recordedRound = round;
    both((s) => Stats.recordRound(s, game.results, game.net, game.wagered));
    storage('set', STATS_KEY, JSON.stringify(stats));
    const entry = historyEntry();
    if (roundBefore) entry.replay = Replay.recordOf(game, roundBefore);
    history = Stats.addHistory(history, entry);
    for (const old of history.slice(REPLAY_KEEP)) delete old.replay;
    storage('set', HISTORY_KEY, JSON.stringify(history));
    Report.recordResult(shoeTracker, { net: game.net, evLost: roundMistakes.reduce((s, m) => s + m.dollars, 0) });
    if (game.cutCardReached) {
      const done = finishShoe(true);
      pendingReport = null; // a newer shoe's report replaces one still waiting
      if (done && prefs.shoeReport) queueReport(done, settleAt + 700);
    }
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
    els.rebetRow.hidden = sitOut || !(open && game.phase === 'done' && lastBet > 0);
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
      els.review.hidden = true;
      els.reset.hidden = true;
      els.sideResult.hidden = true;
      els.rebetRow.hidden = true;
      els.chips.querySelectorAll('[data-chip]').forEach((b) => { b.disabled = true; });
      revealTimer = setTimeout(render, settleAt + landMs());
      return;
    }

    if (pendingReport && game.phase !== 'player' && game.phase !== 'insurance') {
      const held = pendingReport;
      pendingReport = null;
      openReportWithGrace(held);
    }

    els.dealerTotal.textContent = !game.dealer.length ? ''
      : live ? `(${game.dealer[0].rank === 'A' ? 'ace' : handValue([game.dealer[0]]).total} showing)`
      : `(${formatTotal(game.dealer)})`;
    els.bankroll.textContent = money(game.bankroll);
    renderCount();
    renderSide();

    els.hit.disabled = !inRound || !game.canHit();
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
      const now = Counting.systemState(game, countSystem());
      if (countShown && now.insurance && game.canInsure()) {
        const at = now.system === 'ko' ? `running count ${Counting.signed(now.running)}`
          : `${systemName()} true count ${Counting.formatTrue(now.trueCount)}`;
        els.message.textContent += ` Count says take it (${at}).`;
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
    renderReview();

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
    renderWatch();
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
    if (!userActed || els.help.open || els.settings.open || els.prefsDialog.open || els.chartDialog.open || els.drillDialog.open) return;
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

  /** After a round: each off-chart play and what it cost. */
  function renderReview() {
    const show = game.phase === 'done' && roundMistakes.length > 0;
    els.review.hidden = !show;
    if (!show) return;
    const total = roundMistakes.reduce((s, m) => s + m.dollars, 0);
    els.review.textContent = `Round review: ${roundMistakes.map((m) => m.text).join('; ')}. ` +
      `That's ${money(Math.round(total * 100) / 100)} of expected value given away.`;
  }

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
    const spot = Report.countSpot(game, countSystem()); // graded with the count hidden too
    if (spot) Report.recordSpot(shoeTracker, { ...spot, move });
    const advice = currentAdvice();
    const hinted = hintFor === decisionKey();
    hintFor = null;
    if (!advice) return;
    const correct = Report.moveCorrect(advice, spot, move);
    const hand = game.currentHand;
    if (!correct && hand && !advice.deviation && game.phase === 'player') {
      const key = Chart.cellKey(hand.cards, game.dealer[0], game.canSplit());
      both((s) => Stats.recordMiss(s, key));
      const priced = EV.moveCost(game.rules, key, move, {
        canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender(),
      });
      if (priced && priced.cost > 0) {
        const dollars = priced.cost * hand.bet;
        both((s) => Stats.recordEvLost(s, dollars));
        const [row, up] = key.split('|');
        let text = EV.describe(move, Chart.rowLabel(row), Chart.upLabel(Number(up)), priced.cost);
        if (hand.cards.length > 2) text += ' (estimated)';
        roundMistakes.push({ text, cost: Math.round(priced.cost * 10000) / 10000, dollars: Math.round(dollars * 100) / 100 });
      }
    }
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
    if (sitOut) {
      watchRound();
      return;
    }
    const bet = Number(els.betInput.value);
    const sides = { 'Perfect Pairs': els.sidePairs.value.trim(), '21+3': els.side213.value.trim() };
    const error = Betting.betError(bet, limits())
      || Betting.sideError(bet * spots, sides, { bankroll: game.bankroll, sideMax: Blackjack.SIDE_MAX });
    if (error) {
      els.message.textContent = error;
      delete els.message.dataset.outcome;
      return;
    }
    // F18: what the ramp says for this round (a shoe that is due to be replaced starts at 0).
    if (game.cutCardReached && shoeTracker.rounds.length) finishShoe(false);
    const tcAtBet = game.cutCardReached
      ? Counting.systemState(new Game({ decks: game.decks }), countSystem()).betCount
      : Counting.systemState(game, countSystem()).betCount;
    const seenAtBet = game.cutCardReached ? { running: 0, unseen: game.decks * 52 } : Counting.countState(game);
    const beforeDeal = { bankroll: game.bankroll, running: seenAtBet.running, unseen: seenAtBet.unseen };
    const unitAtBet = betUnit();
    const suggestedAtBet = Counting.suggestedBet(tcAtBet, {
      min: game.minBet, unit: unitAtBet, max: game.maxBet, bankroll: game.bankroll / spots,
    });
    act(() => {
      game.deal(Array(spots).fill(bet), {
        pairs: Number(els.sidePairs.value) || 0,
        t213: Number(els.side213.value) || 0,
      });
      round++;
      coachNote = null;
      roundMistakes = [];
      Report.recordBet(shoeTracker, { bet, suggested: suggestedAtBet, unit: unitAtBet, spots, tc: tcAtBet });
      roundBefore = beforeDeal;
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
    finishShoe(false);
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
    const csv = `${Stats.historyCSV(history)}\nShoe reports\n${Report.reportsCSV(reports, Stats.csvField)}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
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
  const countSystem = () => prefs.countSystem;
  const systemName = () => Counting.SYSTEMS[countSystem()].name;
  const INDEX_NOTE = 'Index plays use Hi-Lo; switch to Hi-Lo (Settings) for count-based deviations. Bets and insurance follow your system.';

  function renderCount() {
    const s = Counting.systemState(game, countSystem());
    els.countToggle.setAttribute('aria-pressed', String(countShown));
    els.countToggle.firstChild.textContent = countShown ? 'Count shown ' : 'Count hidden ';
    els.countPanel.hidden = !countShown;
    els.countSystemName.textContent = systemName();
    els.countRunning.textContent = Counting.signed(s.running);
    if (s.system === 'ko') {
      els.countTrueLabel.textContent = 'Key';
      els.countTrue.textContent = `${Counting.signed(s.key)}, pivot ${Counting.signed(s.pivot)}`;
    } else {
      els.countTrueLabel.textContent = 'True count';
      els.countTrue.textContent = `${Counting.formatTrue(s.trueCount)} (plays as ${Counting.wholeTrue(s.trueCount)})`;
    }
    const aceText = s.aceSurplus === null ? ''
      : ` · aces left ${s.aces} (${s.aceSurplus >= 0 ? '+' : '-'}${Math.abs(s.aceSurplus).toFixed(1)} vs normal)`;
    els.countDecks.textContent = `${s.decksLeft.toFixed(1)} decks unseen${aceText}`;
    els.countNoteText.textContent = s.system === 'hilo'
      ? 'Bets and plays use the true count rounded down to a whole number. With the count shown, hints and scoring use count plays.'
      : `${s.system === 'ko' ? 'KO bets on the running count: 1 unit below the key, more toward the pivot. '
        : 'Bets use the true count halved (level 2) plus the ace side count. '}${INDEX_NOTE}`;
    const shoeSize = game.decks * 52;
    const dealtPct = Math.round(((shoeSize - game.shoe.length) / shoeSize) * 100);
    els.countPen.textContent = `${dealtPct}% dealt, cut at ${Math.round(game.penetration * 100)}%`;
    const betweenHands = !(game.phase === 'player' || game.phase === 'insurance');
    const t = Math.floor(s.betCount);
    const at = s.system === 'hilo' ? 'true count' : 'betting count';
    let wong = '';
    if (sitOut) {
      wong = t >= prefs.wongIn ? `Watching. Count says sit back in (${at} ${Counting.signed(t)}, J).`
        : 'Watching: rounds are dealt to an empty seat and counted; no money moves.';
    } else if (betweenHands && t < prefs.wongOut) {
      wong = `Count says sit out (${at} ${Counting.signed(t)} is below ${Counting.signed(prefs.wongOut)}, J).`;
    }
    els.countWong.hidden = !wong;
    els.countWong.textContent = wong;
    // Suggested bet under the bet box: only while the count is shown, between rounds.
    const betting = !(game.phase === 'player' || game.phase === 'insurance') && !game.isBroke;
    const units = Counting.betUnits(s.betCount);
    const unit = betUnit();
    const amount = Counting.suggestedBet(s.betCount, {
      min: game.minBet, unit, max: game.maxBet, bankroll: game.bankroll,
    });
    els.suggestRow.hidden = !(countShown && betting);
    els.suggestText.textContent = `Suggested bet: ${money(amount)} (${units} unit${units > 1 ? 's' : ''} of ` +
      `${money(unit)} at ${s.system === 'ko' ? `running count ${Counting.signed(s.running)}` : `${at} ${Counting.formatTrue(s.betCount)}`})`;
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
    const st = Counting.systemState(game, countSystem());
    const { running } = st;
    const right = guess === running;
    both((s) => Stats.recordCountCheck(s, right));
    Report.recordCheck(shoeTracker, right);
    storage('set', STATS_KEY, JSON.stringify(stats));
    countNote = right
      ? `Right: the ${systemName()} running count is ${Counting.signed(running)}` +
        `${st.trueCount === null ? '' : ` (true count ${Counting.formatTrue(st.trueCount)})`}.`
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
    els.seedText.textContent = game.shoeSeed ? `Shoe seed ${game.shoeSeed}` : 'Shoe seed: random (older save)';
    els.seedCopy.hidden = !game.shoeSeed;
  }

  els.seedCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(game.shoeSeed);
      els.seedCopied.textContent = 'Copied';
    } catch {
      els.seedCopied.textContent = `Copy failed: the seed is ${game.shoeSeed}`;
    }
    setTimeout(() => { els.seedCopied.textContent = ''; }, 2000);
  });

  const radio = (name) => els.settingsForm.querySelector(`input[name="${name}"]:checked`);

  function readSettings() {
    return Rules.normalizeRules({
      decks: Number(els.setDecks.value),
      h17: radio('soft17').value === 'h17',
      payout: Number(radio('payout').value),
      das: els.setDas.checked,
      lateSurrender: els.setLs.checked,
      penetration: Number(els.setPen.value) / 100,
      doubleOn: els.setDouble.value, rsa: els.setRsa.checked, enhc: els.setEnhc.checked,
      obo: els.setEnhc.checked && els.setObo.checked,
    });
  }

  function fillSettings(rules) {
    els.setDecks.value = String(rules.decks);
    els.settingsForm.querySelector(`input[name="soft17"][value="${rules.h17 ? 'h17' : 's17'}"]`).checked = true;
    els.settingsForm.querySelector(`input[name="payout"][value="${rules.payout}"]`).checked = true;
    els.setDas.checked = rules.das;
    els.setLs.checked = rules.lateSurrender;
    els.setPen.value = String(Math.round(rules.penetration * 100));
    els.setDouble.value = rules.doubleOn;
    els.setRsa.checked = rules.rsa;
    els.setEnhc.checked = rules.enhc;
    els.setObo.checked = rules.obo;
    els.setSeed.value = storage('get', SEED_KEY) || '';
    renderSettingsPreview();
  }

  /** Live house edge for what's selected, and whether it can be applied now. */
  function renderSettingsPreview() {
    const chosen = readSettings();
    els.setPenValue.textContent = `${Math.round(chosen.penetration * 100)}%`;
    els.setObo.disabled = !els.setEnhc.checked;
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
  els.settingsForm.addEventListener('input', renderSettingsPreview);
  els.setDefault.addEventListener('click', () => fillSettings({ ...Rules.DEFAULT_RULES }));
  els.setCancel.addEventListener('click', () => els.settings.close());
  els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.close(); });
  els.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (els.setApply.disabled) return;
    const chosen = readSettings();
    const seedText = els.setSeed.value.trim();
    if (seedText && !Blackjack.parseSeed(seedText)) {
      els.setSeed.setCustomValidity('Letters, digits, dots, dashes and underscores only, up to 40.');
      els.setSeed.reportValidity();
      return;
    }
    els.setSeed.setCustomValidity('');
    const seedChanged = seedText !== (storage('get', SEED_KEY) || '');
    storage('set', SEED_KEY, seedText);
    storage('set', RULES_KEY, JSON.stringify(chosen));
    els.settings.close();
    if (Rules.sameRules(chosen, game.rules) && !seedChanged) return;
    // New rules mean a new table: same bankroll, fresh shoe, empty felt.
    finishShoe(false);
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

  // --- Strategy chart viewer ---

  function renderChart() {
    const rules = game.rules;
    els.chartRules.textContent = Rules.describe(rules)[0];
    els.chartLegend.replaceChildren(...Chart.LEGEND.map(([code, text]) => {
      const li = document.createElement('li');
      const b = document.createElement('span');
      b.className = `cc cc-${code}`;
      b.textContent = code;
      li.append(b, ` ${text}`);
      return li;
    }));
    const marks = countShown ? Chart.indexMarks(Counting.indexPlays(rules)) : new Map();
    els.chartCountNote.hidden = !countShown;
    const misses = stats.misses || {};
    const LONG = Object.fromEntries(Chart.LEGEND);
    els.chartTables.replaceChildren(...Chart.buildChart(rules).map((g) => {
      const table = document.createElement('table');
      table.className = 'strategy';
      const cap = document.createElement('caption');
      cap.textContent = g.title;
      const head = document.createElement('tr');
      const corner = document.createElement('th');
      corner.scope = 'col';
      corner.innerHTML = '<span class="sr-only">Your hand</span>';
      head.append(corner, ...Chart.UPS.map((u) => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = Chart.upLabel(u);
        th.setAttribute('aria-label', `Dealer ${u === 11 ? 'ace' : u}`);
        return th;
      }));
      const thead = document.createElement('thead');
      thead.append(head);
      const tbody = document.createElement('tbody');
      for (const r of g.rows) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.scope = 'row';
        th.textContent = r.label;
        tr.append(th);
        for (const { up, code } of r.cells) {
          const td = document.createElement('td');
          td.className = `cc cc-${code}`;
          td.textContent = code;
          const key = `${r.row}|${up}`;
          const notes = [LONG[code]];
          const idx = marks.get(key);
          if (idx) { td.classList.add('has-index'); notes.push(`count play: ${idx}`); }
          const miss = misses[key];
          if (miss) { td.classList.add('missed'); td.dataset.miss = String(miss); notes.push(`${miss} miss${miss > 1 ? 'es' : ''}`); }
          td.title = notes.join('. ');
          td.setAttribute('aria-label', `${r.label} vs ${Chart.upLabel(up)}: ${notes.join('. ')}`);
          if (idx || miss) td.tabIndex = 0;
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(cap, thead, tbody);
      return table;
    }));
    const top = Chart.topMisses(misses);
    els.chartMisses.replaceChildren(...(top.length ? top.map((m) => {
      const li = document.createElement('li');
      li.textContent = `${m.label}: ${m.count} miss${m.count > 1 ? 'es' : ''}`;
      return li;
    }) : [Object.assign(document.createElement('li'), { textContent: 'No off-chart moves yet.', className: 'empty' })]));
  }

  function openChart() {
    renderChart();
    if (els.help.open) els.help.close();
    if (!els.chartDialog.open) els.chartDialog.showModal();
  }
  els.chartOpenHelp.addEventListener('click', openChart);
  els.chartClose.addEventListener('click', () => els.chartDialog.close());
  els.chartDialog.addEventListener('click', (e) => { if (e.target === els.chartDialog) els.chartDialog.close(); });

  // --- Training drills (never touch bankroll or stats) ---

  let flash = null; // current flashcard
  let flashAnswered = false;
  let flashTally = Drill.emptyTally(Date.now());
  let advanceTimer = null;

  function drillTab(which) {
    const f = which === 'flash';
    els.tabFlash.setAttribute('aria-selected', String(f));
    els.tabCount.setAttribute('aria-selected', String(!f));
    els.tabFlash.setAttribute('aria-pressed', String(f));
    els.tabCount.setAttribute('aria-pressed', String(!f));
    els.panelFlash.hidden = !f;
    els.panelCount.hidden = f;
  }

  function renderFlashScore() {
    const t = flashTally;
    const acc = t.answered ? Math.round((t.right / t.answered) * 100) : 0;
    els.flashScore.textContent = t.answered
      ? `Streak ${t.streak} (best ${t.best}) · ${t.right} of ${t.answered} right (${acc}%) · ` +
        `${Drill.perMinute(t, Date.now()).toFixed(1)} cards a minute`
      : 'Answer with the buttons or H, S, D, P, R.';
  }

  function dealFlash() {
    clearTimeout(advanceTimer);
    flash = Drill.nextCard(game.rules, { misses: stats.misses, withCount: els.flashCount.checked });
    flashAnswered = false;
    els.flashUp.replaceChildren(cardEl(flash.upcard, false));
    els.flashHand.replaceChildren(...flash.cards.map((c) => cardEl(c, false)));
    els.flashTotal.textContent = `(${formatTotal(flash.cards)})`;
    els.flashTc.hidden = flash.tc === null;
    els.flashTc.textContent = flash.tc === null ? '' : `True count ${Counting.formatTrue(flash.tc)} (plays as ${Counting.wholeTrue(flash.tc)})`;
    const pair = flash.cards[0].rank === flash.cards[1].rank;
    for (const b of els.flashAnswers.querySelectorAll('button')) {
      const a = b.dataset.answer;
      b.disabled = (a === 'split' && !pair) || (a === 'surrender' && !game.rules.lateSurrender);
      b.classList.remove('suggested');
    }
    els.flashFeedback.textContent = '';
    delete els.flashFeedback.dataset.outcome;
    els.flashNext.hidden = true;
    renderFlashScore();
    els.flashAnswers.querySelector('button:not(:disabled)').focus();
  }

  function answerFlash(answer) {
    if (!flash || flashAnswered) return;
    const btn = els.flashAnswers.querySelector(`[data-answer="${answer}"]`);
    if (!btn || btn.disabled) return;
    flashAnswered = true;
    const { correct, want } = Drill.check(flash, answer, game.rules);
    flashTally = Drill.tally(flashTally, correct);
    const source = want.deviation ? 'Count play' : 'Basic strategy';
    els.flashFeedback.dataset.outcome = correct ? 'win' : 'lose';
    els.flashFeedback.textContent = correct
      ? `Right: ${want.label}. ${want.reason}.`
      : `Not quite. ${source}: ${want.label}. ${want.reason}.`;
    els.flashAnswers.querySelector(`[data-answer="${want.action}"]`)?.classList.add('suggested');
    renderFlashScore();
    if (correct) advanceTimer = setTimeout(dealFlash, 900);
    else { els.flashNext.hidden = false; els.flashNext.focus(); }
  }

  els.flashAnswers.addEventListener('click', (e) => {
    const b = e.target.closest('[data-answer]');
    if (b) answerFlash(b.dataset.answer);
  });
  els.flashNext.addEventListener('click', dealFlash);
  els.flashCount.addEventListener('change', dealFlash);

  // Count drill. Timing comes from Drill.countClock: a hidden tab pauses
  // the drill (browsers throttle timers there), and the pause isn't scored.
  let cdTimer = null;
  let cdDeck = null;
  let cdClock = null;
  let cdShown = -1; // index of the card on screen
  let cdAsking = false; // all cards shown, waiting for the answer

  function stopCountDrill() {
    clearTimeout(cdTimer);
    cdTimer = null;
  }

  /** Show whichever card is due now, then sleep until the next one. */
  function countTick() {
    stopCountDrill();
    if (!cdDeck || cdAsking || cdClock.paused) return;
    const now = Date.now();
    const i = cdClock.card(now);
    if (i >= cdDeck.cards.length) {
      cdAsking = true;
      els.cdCard.replaceChildren();
      els.cdProgress.textContent = `All ${cdDeck.cards.length} cards shown. What's the running count?`;
      els.cdForm.hidden = false;
      els.cdGuess.value = '';
      els.cdGuess.focus();
      return;
    }
    if (i !== cdShown) {
      cdShown = i;
      els.cdCard.replaceChildren(cardEl(cdDeck.cards[i], false));
      els.cdProgress.textContent = `Card ${i + 1} of ${cdDeck.cards.length}`;
    }
    cdTimer = setTimeout(countTick, cdClock.nextIn(now));
  }

  els.cdStart.addEventListener('click', () => {
    stopCountDrill();
    cdDeck = Drill.countDeal(Number(els.cdSize.value), Math.random, countSystem());
    cdClock = Drill.countClock(cdDeck.cards.length, Number(els.cdSpeed.value));
    cdShown = -1;
    cdAsking = false;
    els.cdForm.hidden = true;
    els.cdResult.textContent = '';
    delete els.cdResult.dataset.outcome;
    cdClock.start(Date.now());
    countTick();
  });

  document.addEventListener('visibilitychange', () => {
    if (!cdDeck || !cdClock || !els.drillDialog.open) return;
    if (document.hidden) {
      cdClock.pause(Date.now());
      stopCountDrill();
      if (!cdAsking) els.cdProgress.textContent = `Paused at card ${cdShown + 1} of ${cdDeck.cards.length}: come back to continue.`;
    } else if (cdClock.paused) {
      cdClock.resume(Date.now());
      if (!cdAsking && cdShown >= 0) els.cdProgress.textContent = `Card ${cdShown + 1} of ${cdDeck.cards.length}`;
      countTick();
    }
  });

  els.cdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!cdDeck) return;
    const guess = Counting.parseGuess(els.cdGuess.value);
    if (guess === null) {
      els.cdResult.textContent = 'Enter the running count as a whole number, like +3 or -2.';
      return;
    }
    const secs = cdClock.elapsed(Date.now()) / 1000; // time away from the tab isn't counted
    const right = guess === cdDeck.answer;
    const perDeck = (secs * 52) / cdDeck.cards.length;
    const target = Drill.COUNT_TARGET_SECONDS;
    els.cdResult.dataset.outcome = right ? 'win' : 'lose';
    els.cdResult.textContent = `${right ? 'Right' : 'Not quite'}: the count is ${Counting.signed(cdDeck.answer)}` +
      `${right ? '' : `, you said ${Counting.signed(guess)}`}. ${secs.toFixed(1)} s, a pace of ${perDeck.toFixed(1)} s ` +
      `per deck (target: under ${target} s).`;
    els.cdForm.hidden = true;
    els.cdStart.textContent = 'Go again';
    els.cdStart.focus();
  });

  function openDrill() {
    if (els.drillDialog.open) return;
    flashTally = Drill.emptyTally(Date.now());
    els.flashCount.checked = countShown;
    els.drillDialog.showModal();
    drillTab('flash');
    dealFlash();
  }

  els.drillOpen.addEventListener('click', openDrill);
  els.drillClose.addEventListener('click', () => els.drillDialog.close());
  els.drillDialog.addEventListener('close', () => { stopCountDrill(); clearTimeout(advanceTimer); });
  els.tabFlash.addEventListener('click', () => { stopCountDrill(); drillTab('flash'); dealFlash(); });
  els.tabCount.addEventListener('click', () => { clearTimeout(advanceTimer); drillTab('count'); els.cdStart.focus(); });
  const ANSWER_KEYS = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender' };
  els.drillDialog.addEventListener('keydown', (e) => {
    if (els.panelFlash.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (['INPUT', 'SELECT'].includes(e.target.tagName)) return;
    const a = ANSWER_KEYS[e.key.toLowerCase()];
    if (a) { e.preventDefault(); answerFlash(a); }
    else if (e.key === 'Enter' && flashAnswered && e.target !== els.flashNext) { e.preventDefault(); dealFlash(); }
  });

  // --- Counter's report card (F18) ---

  reports = Report.parseReports(storage('get', REPORTS_KEY));
  const houseEdgeNow = () => Rules.houseEdge(game.rules);

  /** Close out the current shoe: save its summary and start a new tracker. */
  function finishShoe(atCut) {
    const shoe = shoeTracker;
    shoeTracker = Report.newShoe();
    if (!shoe.rounds.length) return null;
    if (atCut) shoe.endRunning = Counting.systemState(game, countSystem()).running;
    shoe.shoeSeed = game.shoeSeed;
    shoe.houseEdge = houseEdgeNow();
    shoe.summary = Report.summary(shoe, { houseEdge: shoe.houseEdge });
    sessionShoes.push(shoe);
    reports = Report.addReport(reports, shoe.summary);
    storage('set', REPORTS_KEY, JSON.stringify(reports));
    return shoe;
  }

  const moneyDelta = (n) => signedMoney(Math.round(n * 100) / 100);

  /** Fill the report dialog: one shoe (with the end-count check) or the session so far. */
  function showReport(shoe) {
    const session = !shoe;
    const shoes = session ? [...sessionShoes, shoeTracker].filter((s) => s.rounds.length) : [shoe];
    reportShown = shoe || null;
    const g = Report.grade(shoes, { houseEdge: houseEdgeNow() });
    els.reportTitle.textContent = session ? "Counter's report: this session" : 'Shoe report';
    els.reportSub.textContent = g.rounds
      ? `${g.rounds} round${g.rounds === 1 ? '' : 's'}${session ? ` over ${g.shoes} shoe${g.shoes === 1 ? '' : 's'}` : ' in this shoe'}, graded against a perfect ${systemName()} counter.`
      : 'No rounds yet this session. Play a few, then check back.';
    els.repR.textContent = g.r === null ? 'Not measurable' : g.r.toFixed(2);
    els.repNote.hidden = !g.betNote;
    els.repNote.textContent = g.betNote || '';
    els.repWithin.textContent = g.within === null ? '–' : `${Math.round(g.within * 100)}%`;
    els.repIndex.textContent = g.spots ? `${g.taken} of ${g.spots}` : 'None came up';
    els.repChecks.textContent = g.checks ? `${g.checksRight} of ${g.checks}` : 'None (Q checks your count)';
    els.repNet.textContent = moneyDelta(g.net);
    els.repExpected.textContent = moneyDelta(g.expected);
    els.repLuck.textContent = moneyDelta(g.luck);
    els.repPerfect.textContent = moneyDelta(g.perfect);
    els.repGap.textContent = moneyDelta(g.skillGap);
    els.repEv.textContent = money(Math.round(g.evLost * 100) / 100);
    const missed = g.missed.slice(0, 12);
    els.repMissedLabel.hidden = !missed.length;
    els.repMissed.hidden = !missed.length;
    els.repMissed.replaceChildren(...missed.map((m) => {
      const li = document.createElement('li');
      const verb = { insurance: 'take insurance', surrender: 'surrender' }[m.play] || m.play;
      li.textContent = `${m.hand} vs ${m.up} at true count ${Counting.signed(m.tc)}: the index (${Counting.signed(m.index)}) says ${verb}`;
      return li;
    }));
    els.repCount.hidden = session || !shoe || shoe.endRunning === null || shoe.endGuess !== null;
    els.repCountResult.textContent = shoe && shoe.endGuess !== null
      ? endCountText(shoe) : '';
    els.repGuess.value = '';
    els.reportAgain.hidden = !(shoe && shoe.shoeSeed);
    if (!els.reportDialog.open) els.reportDialog.showModal();
    if (!els.repCount.hidden) els.repGuess.focus();
  }

  function endCountText(shoe) {
    const err = shoe.endGuess - shoe.endRunning;
    return err === 0
      ? `Right: the running count at the cut card was ${Counting.signed(shoe.endRunning)}.`
      : `The running count at the cut card was ${Counting.signed(shoe.endRunning)}; you were off by ${Counting.signed(err)}.`;
  }

  els.repCount.addEventListener('submit', (e) => {
    e.preventDefault();
    const shoe = reportShown;
    const guess = Counting.parseGuess(els.repGuess.value);
    if (!shoe || guess === null) {
      els.repCountResult.textContent = 'Enter the running count as a whole number, like +3 or -2.';
      return;
    }
    shoe.endGuess = guess;
    shoe.summary = Report.summary(shoe, { houseEdge: shoe.houseEdge }, shoe.summary.when);
    const i = reports.findIndex((r) => r.when === shoe.summary.when);
    if (i >= 0) reports[i] = shoe.summary;
    storage('set', REPORTS_KEY, JSON.stringify(reports));
    els.repCount.hidden = true;
    els.repCountResult.textContent = endCountText(shoe);
  });
  els.reportOpen.addEventListener('click', () => showReport(null));
  // Re-run the reported shoe from its first card: same seed, rules and bankroll.
  els.reportAgain.addEventListener('click', () => {
    const shoe = reportShown;
    if (!shoe || !shoe.shoeSeed || game.phase === 'player' || game.phase === 'insurance') return;
    els.reportDialog.close();
    finishShoe(false);
    game = newGame(game.bankroll, game.rules, shoe.shoeSeed);
    shown = new WeakSet();
    hintFor = null;
    coachNote = null;
    render();
    els.message.textContent = `Shoe ${shoe.shoeSeed} again, from the first card. Place your bet.`;
  });

  // --- Hand replay (F19) ---

  let replaySteps = [];
  let replayAt = 0;
  const replayable = () => history.filter((e) => e.replay).slice(0, REPLAY_KEEP);

  function renderReplayStep() {
    const step = replaySteps[replayAt];
    if (!step) return;
    const card = (c) => (c ? cardEl(c, false) : cardEl({ rank: 'A', suit: '♠' }, true));
    els.replayDealer.replaceChildren(...step.dealer.map(card));
    const up = step.dealer.filter(Boolean);
    els.replayDealerTotal.textContent = up.length ? `(${formatTotal(up)}${step.dealer.includes(null) ? ' showing' : ''})` : '';
    els.replayHands.replaceChildren(...step.hands.map((h, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'player-hand';
      const h2 = document.createElement('h2');
      h2.textContent = `${step.hands.length > 1 ? `Hand ${i + 1}` : 'You'}${h.total ? ` (${h.total})` : ''} · ${money(h.bet)}`;
      const cards = document.createElement('div');
      cards.className = 'cards';
      cards.append(...h.cards.map((c) => cardEl(c, false)));
      wrap.append(h2, cards);
      return wrap;
    }));
    els.replayText.textContent = step.text;
    const d = step.decision;
    if (d) {
      const name = (a) => MOVE_LABEL[a] || a;
      let text = `Count: running ${Counting.signed(d.running)}, true ${Counting.formatTrue(d.tc)}. ` +
        `Basic strategy: ${name(d.basic)}.${d.count !== d.basic ? ` Count play: ${name(d.count)}.` : ''}`;
      if (d.move === d.basic || d.move === d.count) text += ' You followed it.';
      else text += d.cost ? ` Mistake: it cost ${money(d.cost.dollars)} (${(d.cost.fraction * 100).toFixed(1)}% of the bet).` : ' Off the chart.';
      els.replayCoach.textContent = text;
    } else els.replayCoach.textContent = '';
    els.replayStep.textContent = `Step ${replayAt + 1} of ${replaySteps.length}`;
    els.replayPrev.disabled = replayAt === 0;
    els.replayNext.disabled = replayAt === replaySteps.length - 1;
  }

  function loadReplay() {
    const e = replayable().find((x) => String(x.round) === els.replayPick.value);
    replaySteps = e ? Replay.replayRound(e.replay).steps : [];
    replayAt = 0;
    renderReplayStep();
  }

  function openReplay() {
    if (els.replayDialog.open) return;
    const list = replayable();
    els.replayEmpty.hidden = list.length > 0;
    els.replayStage.hidden = !list.length;
    els.replayPick.disabled = !list.length;
    els.replayPick.replaceChildren(...list.map((e) => {
      const o = document.createElement('option');
      o.value = String(e.round);
      o.textContent = `Round ${e.round}: ${e.hands.map((h) => `${h.cards} (${h.total})`).join(' | ')} vs ${e.dealerCards} · ${signedMoney(e.net)}`;
      return o;
    }));
    els.replayDialog.showModal();
    if (list.length) { loadReplay(); els.replayNext.focus(); }
  }

  els.replayOpen.addEventListener('click', openReplay);
  els.replayPick.addEventListener('change', loadReplay);
  els.replayPrev.addEventListener('click', () => { if (replayAt > 0) { replayAt--; renderReplayStep(); } });
  els.replayNext.addEventListener('click', () => { if (replayAt < replaySteps.length - 1) { replayAt++; renderReplayStep(); } });
  els.replayClose.addEventListener('click', () => els.replayDialog.close());
  els.replayDialog.addEventListener('click', (e) => { if (e.target === els.replayDialog) els.replayDialog.close(); });
  // ← and → always step, even from the round picker (↑ and ↓ still change rounds there).
  els.replayDialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); els.replayNext.click(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); els.replayPrev.click(); }
  });
  els.reportClose.addEventListener('click', () => els.reportDialog.close());
  els.reportDialog.addEventListener('close', () => { reportGraceUntil = 0; reportFocusBefore = null; gracePress = false; });
  // Grace window: Enter meant for Deal or Rebet, which the report covered, still deals (#109).
  els.reportDialog.addEventListener('keydown', (e) => {
    if (!inReportGrace() || e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target === els.repGuess && els.repGuess.value.trim() !== '') return; // submits the guess
    e.preventDefault();
    if (e.repeat) return;
    const usable = (c) => !!c && !c.disabled && !c.hidden && !c.closest('[hidden]') && c.offsetParent !== null;
    const before = [els.deal, els.rebet, els.rebet2].find((c) => c === reportFocusBefore);
    const target = usable(before) ? before : (usable(els.deal) ? els.deal : null);
    if (!target) return; // nothing to deal: stay open
    if (target === before) forwardGraceClick(target);
    else forwardGraceClick(null, () => els.betForm.requestSubmit());
  });
  els.reportDialog.addEventListener('click', (e) => {
    if (e.target === els.reportDialog) els.reportDialog.close(); // the grace window is handled in the capture listener below
  });
  // Grace window: a click meant for Deal or Rebet, which the report covered, still deals (#99, #139),
  // whether it lands on the backdrop or on the report's panel. Decided on the press, not the release.
  let gracePress = false;
  const swallowGracePress = (e) => { if (gracePress) e.preventDefault(); };
  els.reportDialog.addEventListener('pointerdown', (e) => {
    gracePress = inReportGrace();
    swallowGracePress(e); // no panel element takes focus
  }, true);
  els.reportDialog.addEventListener('mousedown', swallowGracePress, true);
  els.reportDialog.addEventListener('click', (e) => {
    if (!gracePress) return;
    gracePress = false;
    if (e.detail === 0) return; // a keyboard-made click has no press: let the button act
    e.stopImmediatePropagation(); // no panel button acts, no form submits, and the backdrop-close listener doesn't run
    e.preventDefault();
    const visible = (c) => !c.hidden && c.offsetParent !== null;
    const controls = [['deal', els.deal], ['rebet-1', els.rebet], ['rebet-2', els.rebet2]].map(([id, el]) => {
      const r = el.getBoundingClientRect();
      return { id, el, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, enabled: !el.disabled, visible: visible(el) };
    });
    const hit = ReportHit.dealControlAt(e.clientX, e.clientY, controls);
    if (hit) forwardGraceClick(hit.el); // not on a deal control: stay open
  }, true);

  // --- Bankroll estimates (F16) ---

  const Bankroll = window.BlackjackBankroll;
  const SIM_ROUNDS = 1000000;
  const SIM_SEED = 1;
  let simWorker = null;
  let simId = 0;
  let lastSim = null; // { key, sim } so changing only the money inputs doesn't re-simulate

  /** The dialog's rules; resplitting aces, ENHC and doubling come from the table. */
  function bankRules() {
    return Rules.normalizeRules({
      rsa: game.rules.rsa, enhc: game.rules.enhc, obo: game.rules.obo, doubleOn: game.rules.doubleOn,
      decks: Number(els.bankDecks.value), h17: els.bankH17.checked, payout: els.bank65.checked ? 1.2 : 1.5,
      das: els.bankDas.checked, lateSurrender: els.bankLs.checked, penetration: Number(els.bankPen.value) / 100,
    });
  }
  const bankRamp = () => els.bankForm.querySelector('input[name="bank-ramp"]:checked').value;
  const whole = (n) => Math.max(1, Math.floor(Number(n)) || 1);

  function fillBankRules(r) {
    els.bankDecks.value = String(r.decks);
    els.bankH17.checked = r.h17;
    els.bank65.checked = r.payout === 1.2;
    els.bankDas.checked = r.das;
    els.bankLs.checked = r.lateSurrender;
    els.bankPen.value = String(Math.round(r.penetration * 100));
    els.bankPenValue.textContent = `${els.bankPen.value}%`;
  }

  const signedNum = (n, digits) => `${n < 0 ? '-' : n > 0 ? '+' : ''}${Math.abs(n).toFixed(digits)}`;

  function showBankResults(sim) {
    const unit = whole(els.bankUnit.value);
    const m = Bankroll.summarize(sim, {
      bankroll: whole(els.bankRoll.value), unit, handsPerHour: whole(els.bankHph.value),
    });
    els.bankEv.textContent = `${signedNum(m.ev100, 2)} ± ${m.ev100Error.toFixed(2)} units (${signedMoney(m.ev100Dollars)})`;
    els.bankEvHour.textContent = signedMoney(m.evHourDollars);
    els.bankSd.textContent = `${m.sd100.toFixed(1)} units (${money(Math.round(m.sd100Dollars))})`;
    els.bankAvg.textContent = `${m.avgBet.toFixed(2)} units (${money(Math.round(m.avgBet * unit))})`;
    els.bankN0.textContent = Number.isFinite(m.n0)
      ? `${Math.round(m.n0).toLocaleString('en-US')} rounds (${Math.round(m.n0 / whole(els.bankHph.value)).toLocaleString('en-US')} hours)`
      : 'Never: this game has no edge for you';
    els.bankRor.textContent = m.ror >= 0.9995 ? '100%'
      : m.ror < 0.0005 ? 'under 0.1%' : `${(m.ror * 100).toFixed(m.ror < 0.1 ? 1 : 0)}%`;
    els.bankResults.hidden = false;
    els.bankStatus.textContent = `From ${sim.rounds.toLocaleString('en-US')} simulated rounds (seed ${SIM_SEED}).` +
      (m.ev100 <= 0 ? ' With no edge, any bankroll is lost in the long run.' : '');
  }

  function runSim() {
    const rules = bankRules();
    const ramp = bankRamp();
    const key = JSON.stringify({ rules, ramp });
    if (lastSim && lastSim.key === key) { showBankResults(lastSim.sim); return; }
    const id = ++simId;
    els.bankRun.disabled = true;
    els.bankProgress.hidden = false;
    els.bankProgress.value = 0;
    els.bankStatus.textContent = 'Simulating…';
    const done = (sim) => {
      if (id !== simId) return;
      els.bankRun.disabled = false;
      els.bankProgress.hidden = true;
      lastSim = { key, sim };
      showBankResults(sim);
    };
    try {
      if (!simWorker) simWorker = new Worker('sim-worker.js');
      simWorker.onmessage = (e) => {
        if (e.data.id !== simId) return;
        if (e.data.progress) els.bankProgress.value = e.data.progress / SIM_ROUNDS;
        else if (e.data.sim) done(e.data.sim);
        else if (e.data.error) { els.bankRun.disabled = false; els.bankProgress.hidden = true; els.bankStatus.textContent = `Simulation failed: ${e.data.error}`; }
      };
      simWorker.postMessage({ id, rules, ramp, rounds: SIM_ROUNDS, seed: SIM_SEED });
    } catch {
      // No workers (a page opened from disk): a smaller run on the page itself.
      simWorker = null;
      setTimeout(() => done(Bankroll.simulate({ rules, ramp, rounds: 200000, seed: SIM_SEED })), 30);
    }
  }

  function stopSim() {
    simId++;
    if (simWorker) { simWorker.terminate(); simWorker = null; }
    els.bankRun.disabled = false;
    els.bankProgress.hidden = true;
  }

  els.bankOpen.addEventListener('click', () => {
    if (els.bankDialog.open) return;
    fillBankRules(game.rules);
    if (!els.bankRoll.dataset.touched) els.bankRoll.value = String(Math.max(1, Math.round(game.bankroll)));
    els.bankDialog.showModal();
    runSim();
  });
  els.bankRoll.addEventListener('input', () => { els.bankRoll.dataset.touched = '1'; });
  els.bankPen.addEventListener('input', () => { els.bankPenValue.textContent = `${els.bankPen.value}%`; });
  // Money inputs only rescale the last simulation; rules and betting need a rerun.
  for (const el of [els.bankRoll, els.bankUnit, els.bankHph]) {
    el.addEventListener('input', () => { if (lastSim && !els.bankResults.hidden) showBankResults(lastSim.sim); });
  }
  els.bankForm.addEventListener('change', (e) => {
    if ([els.bankRoll, els.bankUnit, els.bankHph].includes(e.target)) return;
    els.bankResults.hidden = true;
    els.bankStatus.textContent = 'Rules or betting changed: press Recalculate.';
  });
  els.bankForm.addEventListener('submit', (e) => { e.preventDefault(); runSim(); });
  els.bankClose.addEventListener('click', () => els.bankDialog.close());
  els.bankDialog.addEventListener('close', stopSim);
  els.bankDialog.addEventListener('click', (e) => { if (e.target === els.bankDialog) els.bankDialog.close(); });

  // --- Sitting out (Wonging) ---

  const seatDecide = (cards, up) => Strategy.recommend(cards, up, {
    canDouble: cards.length === 2, canSplit: cards.length === 2 && cards[0].rank === cards[1].rank, canSurrender: false,
  }, game.rules).action;

  /** Deal one round to an empty seat: counted, no money, no stats. */
  function watchRound() {
    if (inFlight || game.phase === 'player' || game.phase === 'insurance') return;
    watched = game.watchRound(seatDecide);
    countNote = watched.newShoe ? 'New shoe shuffled: the count starts again from 0.' : null;
    const who = (cards) => cards.map((c) => A11y.cardName(c)).join(', ');
    pendingAnnouncement = `Watching. Empty seat: ${watched.seats.map(who).join('; ')}. Dealer: ${who(watched.dealer)}.`;
    userActed = true;
    render();
  }

  /** While sitting out, the table shows the watched round instead of your last hand. */
  function renderWatch() {
    els.sitToggle.setAttribute('aria-pressed', String(sitOut));
    els.sitToggle.firstChild.textContent = sitOut ? 'Sitting out ' : 'Sit out ';
    els.sitToggle.disabled = game.phase === 'player' || game.phase === 'insurance' || inFlight;
    els.deal.firstChild.textContent = sitOut ? 'Watch a round ' : 'Deal ';
    if (!sitOut) return;
    els.rebetRow.hidden = true;
    if (!watched) {
      els.message.textContent = 'Sitting out. Watch rounds to keep the count, then sit back in (J).';
      delete els.message.dataset.outcome;
      return;
    }
    els.dealerCards.replaceChildren(...watched.dealer.map((c) => cardEl(c, false)));
    els.dealerTotal.textContent = `(${formatTotal(watched.dealer)})`;
    els.playerHands.replaceChildren(...watched.seats.map((seat, i) => {
      const h2 = document.createElement('h2');
      h2.textContent = `Empty seat${watched.seats.length > 1 ? `, hand ${i + 1}` : ''} (${formatTotal(seat)})`;
      const cards = document.createElement('div');
      cards.className = 'cards';
      cards.append(...seat.map((c) => cardEl(c, false)));
      const wrap = document.createElement('div');
      wrap.className = 'player-hand';
      wrap.append(h2, cards);
      return wrap;
    }));
    els.message.textContent = 'Watching: no money moved. Watch another round, or sit back in (J).';
    delete els.message.dataset.outcome;
    els.message.classList.remove('reveal');
  }

  els.sitToggle.addEventListener('click', () => {
    if (els.sitToggle.disabled) return;
    sitOut = !sitOut;
    storage('set', SIT_KEY, sitOut ? '1' : '0');
    watched = null;
    shown = new WeakSet(); // redraw the table cleanly
    render();
    if (!sitOut) els.message.textContent = 'Back in. Place your bet.';
  });

  // --- Settings (display and sound) ---

  function fillPrefs() {
    els.prefSpeed.value = prefs.speed;
    els.prefVolume.value = String(Math.round(prefs.volume * 100));
    els.prefVolumeValue.textContent = `${Math.round(prefs.volume * 100)}%`;
    els.prefTable.value = prefs.table;
    els.prefBack.value = prefs.back;
    els.prefWongOut.value = String(prefs.wongOut);
    els.prefWongIn.value = String(prefs.wongIn);
    els.prefShoeReport.checked = prefs.shoeReport;
    els.prefSystem.value = prefs.countSystem;
  }

  function readPrefs() {
    prefs = Prefs.normalizePrefs({
      speed: els.prefSpeed.value, volume: Number(els.prefVolume.value) / 100,
      table: els.prefTable.value, back: els.prefBack.value,
      wongOut: Number(els.prefWongOut.value), wongIn: Number(els.prefWongIn.value),
      shoeReport: els.prefShoeReport.checked, countSystem: els.prefSystem.value,
    });
    storage('set', PREFS_KEY, JSON.stringify(prefs));
    applyPrefs();
    if (!inFlight) { renderCount(); renderHint(); }
    renderTags();
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
      ['b', 'Put the suggested bet in the bet box', els.suggestBet], ['j', 'Sit out / sit back in', els.sitToggle],
      ['e', 'Counter\'s report card', els.reportOpen], ['l', 'Replay one of the last 20 hands', els.replayOpen],
    ]],
    ['Settings', [
      ['m', 'Sound on/off', els.mute], ['c', 'Coach notes on/off', els.coachToggle],
      ['w', 'Training drills', els.drillOpen], ['u', 'Bankroll and risk of ruin', els.bankOpen], ['t', 'Table rules', els.rulesOpen], ['o', 'Settings: animation, volume, colours', els.prefsOpen],
      ['?', 'Rules, payouts and shortcuts', els.helpOpen], ['v', 'Strategy chart', els.chartOpenHelp],
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

  /** Every system's tags, with yours highlighted. */
  function renderTags() {
    const VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const head = document.createElement('tr');
    head.append(...['System', ...VALUES.map((v) => (v === 11 ? 'A' : v === 10 ? '10-K' : String(v)))].map((t) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = t;
      return th;
    }));
    els.helpTags.tHead.replaceChildren(head);
    els.helpTags.tBodies[0].replaceChildren(...Object.values(Counting.SYSTEMS).map((sys) => {
      const tr = document.createElement('tr');
      if (sys.id === countSystem()) tr.className = 'mine';
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = sys.name;
      tr.append(th, ...VALUES.map((v) => {
        const td = document.createElement('td');
        td.textContent = Counting.signed(sys.tags[v]);
        return td;
      }));
      return tr;
    }));
    els.helpTagsNote.textContent = `Your system: ${systemName()} (change it in Settings). KO starts each shoe at ` +
      `${Counting.signed(Counting.koStart(game.decks))} with this table's ${game.decks} deck${game.decks > 1 ? 's' : ''}; ` +
      'Hi-Opt II and Omega II keep a separate count of aces seen, used for betting only. ' + INDEX_NOTE;
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
    renderTags();
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
    if (els.help.open || els.settings.open || els.prefsDialog.open || els.chartDialog.open || els.drillDialog.open || els.bankDialog.open || els.reportDialog.open || els.replayDialog.open) return; // Escape closes dialogs natively
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
    if (e.key.toLowerCase() === 'v') { e.preventDefault(); openChart(); return; }
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

  // Offline support and install (PWA). Service workers need http(s), so
  // opening index.html straight from disk just skips this.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode unavailable */ });
  }
})();
