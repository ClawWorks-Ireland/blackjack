/**
 * The live poker table in the browser (CLA-121): seats, the board and the
 * pot, your cards and your moves, over Server-Sent Events from
 * /api/poker/tables/:id/events. Uses the helpers in live.js; names are
 * rendered as text only.
 */
(function () {
  'use strict';
  const { el, api, badge, card, back, money, store } = window.Live.util;
  const $ = (sel) => document.querySelector(sel);

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  let token = params.get('watch') ? null : store.session(`live.ptoken.${id}`);
  let view = null;
  let received = 0;
  let source = null;
  const status = (t) => { $('#status').textContent = t; };
  const cardsOf = (list) => list.map((c) => (c === '??' ? back() : card(c)));

  function connect() {
    if (source) source.close();
    source = new EventSource(`/api/poker/tables/${encodeURIComponent(id)}/events${token ? `?token=${token}` : ''}`);
    source.addEventListener('state', (e) => { view = JSON.parse(e.data); received = Date.now(); render(); });
    source.onerror = () => status('Connection lost: reconnecting…');
  }

  async function act(action, amount) {
    try {
      view = await api('POST', `/api/poker/tables/${encodeURIComponent(id)}/act`, { action, amount }, token);
      received = Date.now();
      render();
    } catch (e) { status(e.message); }
  }

  const LAST = { fold: 'folded', check: 'checked', call: 'called', bet: 'bet', raise: 'raised', 'small blind': 'small blind', 'big blind': 'big blind' };

  function seatEl(s, i) {
    if (!s) return el('div', { class: 'seat empty', text: `Seat ${i + 1} · free` });
    const you = view.you && view.you.seat === i;
    const turn = view.toAct === i;
    const tags = [];
    if (view.button === i && view.handNo) tags.push('dealer');
    if (s.allIn) tags.push('all-in');
    if (s.folded) tags.push('folded');
    return el('div', { class: `seat${you ? ' you' : ''}${turn ? ' turn' : ''}${s.folded ? ' folded' : ''}`, 'aria-current': turn ? 'true' : null },
      el('div', { class: 'who' }, el('span', { text: `${s.player.name}${you ? ' (you)' : ''} ` }), badge(s.player.kind)),
      el('div', { class: 'meta', text: `${money(s.stack)}${tags.length ? ` · ${tags.join(' · ')}` : ''}` }),
      el('div', { class: 'cards' }, ...cardsOf(s.cards)),
      el('div', { class: 'meta', text: s.bet ? `bet ${money(s.bet)}` : s.lastAction ? LAST[s.lastAction] || s.lastAction : '' }));
  }

  function resultEl(h) {
    const you = view.you ? view.you.seat : null;
    const parts = h.pots.map((p) => {
      const names = p.winners.map((w) => (w === you ? 'You' : (view.seats[w] ? view.seats[w].player.name : `Seat ${w + 1}`)));
      return `${names.join(' and ')} ${names.length > 1 ? 'split' : names[0] === 'You' ? 'win' : 'wins'} ${money(p.amount)}${p.hand ? ` with ${p.hand}` : ''}`;
    });
    const net = you !== null ? h.net[you] : null;
    const tone = net === null ? 'push' : net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
    return el('div', { class: `outcome ${tone}`, role: 'status' },
      el('div', { class: 'outcome-head' }, el('span', { text: `Hand ${h.handNo}` }), net !== null ? el('span', { class: 'outcome-net', text: net === 0 ? '±$0' : `${net > 0 ? '+' : '−'}${money(Math.abs(net))}` }) : null),
      ...parts.map((t) => el('div', { class: 'outcome-line', text: t })),
      ...(h.showdown ? h.shown.map((x) => el('div', { class: 'outcome-line', text: `${x.seat === you ? 'You' : view.seats[x.seat] ? view.seats[x.seat].player.name : `Seat ${x.seat + 1}`}: ${x.cards.join(' ')}, ${x.hand}` })) : []));
  }

  function controls(you) {
    const legal = Object.fromEntries(you.legal.map((l) => [l.action, l]));
    const kids = [];
    const row = el('div', { class: 'actions' });
    if (legal.fold && !legal.check) row.append(el('button', { type: 'button', class: 'secondary', onclick: () => act('fold'), text: 'Fold' }));
    if (legal.check) row.append(el('button', { type: 'button', onclick: () => act('check'), text: 'Check' }));
    if (legal.call) row.append(el('button', { type: 'button', onclick: () => act('call'), text: `Call ${money(legal.call.amount)}` }));
    kids.push(row);
    const up = legal.raise || legal.bet;
    if (up) {
      const verb = legal.raise ? 'Raise to' : 'Bet';
      const input = el('input', { type: 'number', min: up.min, max: up.max, step: 1, value: up.min, 'aria-label': `${verb} amount`, style: 'width:7em' });
      const pot = view.pot;
      const quick = (label, to) => el('button', { type: 'button', class: 'secondary', onclick: () => { input.value = String(Math.min(up.max, Math.max(up.min, Math.round(to)))); }, text: label });
      const base = legal.raise ? view.currentBet : 0;
      const after = pot + (you.toCall || 0);
      kids.push(el('div', { class: 'actions' }, input,
        el('button', { type: 'button', onclick: () => act(legal.raise ? 'raise' : 'bet', Number(input.value)), text: verb }),
        quick('½ pot', base + after / 2), quick('Pot', base + after), quick('All-in', up.max)));
    }
    return kids;
  }

  function render() {
    if (!view) return;
    $('#title').textContent = view.name;
    $('#hand').textContent = `Hand ${view.handNo} · blinds ${money(view.smallBlind)}/${money(view.bigBlind)}`;
    $('#board').replaceChildren(...cardsOf(view.board), ...Array.from({ length: 5 - view.board.length }, () => el('div', { class: 'card slot', 'aria-hidden': 'true' })));
    $('#pot').textContent = view.pot ? `Pot ${money(view.pot)}` : '';
    $('#seats').replaceChildren(...view.seats.map(seatEl));
    const you = view.you;
    const toAct = view.toAct !== null ? view.seats[view.toAct] : null;
    if (view.phase === 'waiting' || (view.phase === 'done' && !view.lastHand)) status('Waiting for players…');
    else if (view.phase === 'done') status('Next hand in a moment');
    else if (you && you.yourTurn) status(you.toCall ? `Your move: ${money(you.toCall)} to call` : 'Your move');
    else if (toAct) status(`${toAct.player.name} to act`);

    const panel = $('#you');
    if (!you) {
      if (token) { store.session(`live.ptoken.${id}`, null); token = null; }
      panel.replaceChildren(el('p', { class: 'muted', text: params.get('watch') ? 'Watching. ' : 'You have no seat here. ' }), el('a', { href: 'lobby.html', text: 'Back to the lobby to sit down' }));
      return;
    }
    const kids = [el('div', { class: 'row' }, el('strong', { text: `Stack ${money(you.stack)}` }),
      el('button', { type: 'button', class: 'secondary', onclick: leave, text: 'Leave table' }))];
    if (view.phase === 'done' && view.lastHand) kids.push(resultEl(view.lastHand));
    if (you.cards.length) {
      kids.push(el('div', { class: 'your-hands' }, el('div', { class: 'hand' }, el('div', { class: 'cards' }, ...you.cards.map(card)),
        el('div', { class: 'total', text: you.hand || '' }))));
    }
    if (you.yourTurn) kids.push(...controls(you));
    panel.replaceChildren(...kids);
    const first = panel.querySelector('.actions button');
    if (first && you.yourTurn && !panel.contains(document.activeElement)) first.focus();
  }

  async function leave() {
    try { await api('POST', `/api/poker/tables/${encodeURIComponent(id)}/leave`, {}, token); } catch (e) { status(e.message); return; }
    store.session(`live.ptoken.${id}`, null);
    location.href = 'lobby.html';
  }

  setInterval(() => {
    const bar = $('#timer > div');
    if (!view || !view.deadline || view.deadline.what !== 'turn') { bar.style.width = '0'; return; }
    const left = Math.max(0, view.deadline.msLeft - (Date.now() - received));
    bar.style.width = `${Math.min(100, (left / (view.deadline.ms || 30000)) * 100)}%`;
  }, 200);

  // Keys: F fold, C check or call, R/B focus the amount.
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey || !view || !view.you || !view.you.yourTurn) return;
    const legal = view.you.legal.map((l) => l.action);
    const k = e.key.toLowerCase();
    if (k === 'f' && legal.includes('fold')) act('fold');
    else if (k === 'c') act(legal.includes('check') ? 'check' : 'call');
    else if ((k === 'r' || k === 'b') && $('#you input')) { e.preventDefault(); $('#you input').focus(); }
  });

  connect();
})();
