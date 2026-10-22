/**
 * Live tables in the browser (CLA-112, CLA-114): the lobby, the table and
 * the players leaderboard, served by server/server.js. Player names come
 * from other people, so everything is built with textContent, never HTML.
 */
(function (root) {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    session: (k, v) => {
      try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (_) { /* private mode */ }
      return null;
    },
  };

  async function api(method, path, body, token) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const KIND = { ai: 'AI', human: 'Human', bot: 'Bot' };
  const badge = (kind) => el('span', { class: `badge ${kind}`, text: KIND[kind] || kind });
  const money = (n) => (n === null || n === undefined ? '' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en', { maximumFractionDigits: 2 })}`);
  const signed = (n) => `${n > 0 ? '+' : ''}${n}`;

  // --- Cards ---
  const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const RANK = { T: '10' };
  const NAMES = { A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: '10' };
  const SUIT_NAMES = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
  function card(text) {
    const red = text[1] === 'h' || text[1] === 'd';
    const rank = RANK[text[0]] || text[0];
    return el('div', { class: `card${red ? ' red' : ''}`, role: 'img', 'aria-label': `${NAMES[text[0]] || text[0]} of ${SUIT_NAMES[text[1]]}` },
      el('span', { class: 'corner', text: `${rank}${SUITS[text[1]]}` }), el('span', { class: 'pip', text: SUITS[text[1]] }));
  }
  const back = () => el('div', { class: 'card back', role: 'img', 'aria-label': 'face-down card' });

  // --- Lobby ---

  function lobby() {
    const name = $('#name');
    const agent = $('#agent');
    name.value = store.get('live.name') || '';
    agent.checked = store.get('live.agent') === '1';
    name.addEventListener('change', () => store.set('live.name', name.value.trim()));
    agent.addEventListener('change', () => store.set('live.agent', agent.checked ? '1' : '0'));

    async function join(id) {
      const n = name.value.trim();
      if (!n) { $('#lobby-msg').textContent = 'Enter a name first.'; name.focus(); return; }
      store.set('live.name', n);
      try {
        const j = await api('POST', `/api/tables/${id}/join`, { name: n, kind: agent.checked ? 'ai' : 'human' });
        store.session(`live.token.${id}`, j.token);
        location.href = `table.html?id=${encodeURIComponent(id)}`;
      } catch (e) { $('#lobby-msg').textContent = e.message; }
    }

    let shown = '';
    async function refresh() {
      try {
        const { tables } = await api('GET', '/api/tables');
        // Only redraw when something changed, so buttons and focus stay put.
        const key = JSON.stringify(tables.map((x) => [x.id, x.seats])) + agent.checked;
        if (key === shown) return;
        shown = key;
        const box = $('#tables');
        box.replaceChildren(...tables.map((t) => {
          const seated = t.seats.filter(Boolean);
          const mine = store.session(`live.token.${t.id}`);
          return el('article', { class: 'panel table-card' },
            el('h3', { text: t.name }),
            el('div', { class: 'muted', text: `$${t.minBet}–$${t.maxBet} · ${t.rules.decks} decks · ${t.rules.h17 ? 'H17' : 'S17'} · ${t.rules.payout === 1.5 ? '3:2' : '6:5'}` }),
            el('ul', {}, ...(seated.length ? seated.map((s) => el('li', {}, el('span', { text: `Seat ${s.seat + 1}: ${s.name} ` }), badge(s.kind)))
              : [el('li', { class: 'seat-free', text: 'Nobody seated yet' })])),
            el('div', { class: 'row' },
              mine ? el('a', { href: `table.html?id=${encodeURIComponent(t.id)}`, text: 'Back to your seat' })
                : el('button', { type: 'button', disabled: t.free === 0, onclick: () => join(t.id), text: t.free ? `Sit down (${t.free} free)` : 'Full' }),
              el('a', { href: `table.html?id=${encodeURIComponent(t.id)}&watch=1`, text: 'Watch' })));
        }));
        $('#lobby-msg').textContent = tables.length ? '' : 'No tables yet: create one below.';
      } catch (e) { $('#lobby-msg').textContent = `Can't reach the table server: ${e.message}`; }
    }

    $('#new').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('POST', '/api/tables', { name: f.get('name'), minBet: Number(f.get('minBet')), maxBet: Math.max(500, Number(f.get('minBet')) * 50), bots: Number(f.get('bots')), turnSeconds: Number(f.get('turnSeconds')) });
        e.target.reset();
        refresh();
      } catch (err) { $('#lobby-msg').textContent = err.message; }
    });
    refresh();
    setInterval(refresh, 3000);
  }

  // --- Table ---

  function table() {
    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    let token = params.get('watch') ? null : store.session(`live.token.${id}`);
    let view = null;
    let received = 0;
    let lastBet = Number(store.get('live.lastBet')) || null;
    let source = null;

    const status = (t) => { $('#status').textContent = t; };

    function connect() {
      if (source) source.close();
      source = new EventSource(`/api/tables/${encodeURIComponent(id)}/events${token ? `?token=${token}` : ''}`);
      source.addEventListener('state', (e) => { view = JSON.parse(e.data); received = Date.now(); render(); });
      source.onerror = () => status('Connection lost: reconnecting…');
    }

    async function send(path, body) {
      try {
        view = await api('POST', `/api/tables/${encodeURIComponent(id)}/${path}`, body, token);
        received = Date.now();
        render();
      } catch (e) { status(e.message); }
    }

    function seatEl(s, i) {
      if (!s) return el('div', { class: 'seat empty', text: `Seat ${i + 1} · free` });
      const you = view.you && view.you.seat === i;
      const turn = view.turn === i;
      const kids = [
        el('div', { class: 'who' }, el('span', { text: `${s.player.name}${you ? ' (you)' : ''} ` }), badge(s.player.kind)),
        el('div', { class: 'meta', text: `Seat ${i + 1}${s.player.kind === 'bot' ? '' : ` · ${money(s.bankroll)}`}${s.out ? ' · sitting out' : s.bet ? ` · bet ${money(s.bet)}` : ''}` }), // bots play without money
      ];
      s.hands.forEach((h, k) => {
        kids.push(el('div', { class: `hand${s.active === k ? ' active' : ''}` },
          el('div', { class: 'cards' }, ...h.cards.map(card)),
          el('div', { class: 'meta', text: `${h.soft ? 'soft ' : ''}${h.total}${h.bet !== s.bet ? ` · ${money(h.bet)}` : ''}` }),
          h.result ? el('div', { class: `result ${h.result.outcome}`, text: `${h.result.outcome} ${signed(h.result.net)}` }) : null));
      });
      return el('div', { class: `seat${you ? ' you' : ''}${turn ? ' turn' : ''}`, 'aria-current': turn ? 'true' : null }, ...kids);
    }

    const LABEL = { hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surrender', insurance: 'Insurance', decline_insurance: 'No insurance' };

    function render() {
      if (!view) return;
      $('#title').textContent = view.name;
      $('#round').textContent = `Round ${view.round} · $${view.table.minBet}–$${view.table.maxBet}`;
      const d = view.dealer;
      $('#dealer').replaceChildren(...d.cards.map(card), ...(d.holeCardHidden ? [back()] : []));
      $('#dealer-total').textContent = d.cards.length ? `${d.total}${d.holeCardHidden ? ' showing' : ''}` : '';
      $('#seats').replaceChildren(...view.seats.map(seatEl));

      const turnSeat = view.turn !== null ? view.seats[view.turn] : null;
      const you = view.you;
      if (view.phase === 'betting' || view.phase === 'done') {
        const waiting = view.seats.filter((s) => s && s.bet === 0 && !s.out && s.player.kind !== 'bot').map((s) => s.player.name);
        status(view.phase === 'done' ? 'Round over. Bet to play the next one.' : waiting.length ? `Waiting for bets from ${waiting.join(', ')}` : 'Dealing…');
      } else if (turnSeat) {
        status(you && you.yourTurn ? (view.phase === 'insurance' ? (you.evenMoney ? 'Even money?' : 'Insurance?') : 'Your move') : `${turnSeat.player.name} to play`);
      }

      const panel = $('#you');
      if (!you) {
        if (token) { store.session(`live.token.${id}`, null); token = null; } // the server let the seat go
        panel.replaceChildren(el('p', { class: 'muted', text: params.get('watch') ? 'Watching. ' : 'You have no seat here (you left, or missed too many rounds). ' }),
          el('a', { href: 'lobby.html', text: 'Back to the lobby to sit down' }));
        return;
      }
      const me = view.seats[you.seat];
      const kids = [el('div', { class: 'row' }, el('strong', { text: `Bankroll ${money(you.bankroll)}` }),
        el('button', { type: 'button', class: 'secondary', onclick: leave, text: 'Leave table' }))];
      const last = you.lastRound;
      if (last && view.phase === 'betting' && last.round === view.round) {
        kids.push(el('p', { class: 'muted', text: `Last round: ${last.hands.map((h) => `${h.total}${h.result ? ` ${h.result.outcome}` : ''}`).join(' / ')} against the dealer's ${last.dealerTotal}, ${last.net >= 0 ? 'won' : 'lost'} ${money(Math.abs(last.net))}` }));
      }
      if (you.onTable) kids[0].append(el('span', { class: 'muted', text: ` + ${money(you.onTable)} on the table` }));
      if (you.legal.includes('bet') && (view.phase === 'done' || (me.bet === 0 && !me.out))) {
        const input = el('input', { type: 'number', min: view.table.minBet, max: Math.min(view.table.maxBet, you.bankroll), step: 1, value: lastBet || view.table.minBet, 'aria-label': 'Bet', style: 'width:7em' });
        const bet = () => { lastBet = Number(input.value); store.set('live.lastBet', String(lastBet)); send('bet', { amount: lastBet }); };
        kids.push(el('div', { class: 'actions' }, input,
          el('button', { type: 'button', onclick: bet, text: 'Bet' }),
          el('button', { type: 'button', class: 'secondary', onclick: () => send('sit-out', {}), text: 'Sit out' })));
      } else if (you.yourTurn) {
        kids.push(el('div', { class: 'actions' }, ...you.legal.map((a) => el('button', {
          type: 'button', onclick: () => send('act', { action: a }), 'data-key': a,
          text: `${LABEL[a] || a}${you.legalCost[a] ? ` (+${money(you.legalCost[a])})` : ''}`,
        }))));
      } else if (me.bet && view.phase !== 'betting') {
        kids.push(el('p', { class: 'muted', text: 'Waiting for your turn…' }));
      }
      panel.replaceChildren(...kids);
      const first = panel.querySelector('.actions button');
      if (first && you.yourTurn && !panel.contains(document.activeElement)) first.focus();
    }

    async function leave() {
      try { await api('POST', `/api/tables/${encodeURIComponent(id)}/leave`, {}, token); } catch (e) { status(e.message); return; }
      store.session(`live.token.${id}`, null);
      location.href = 'lobby.html';
    }

    // The turn clock: the server sends the time left with every state.
    setInterval(() => {
      const bar = $('#timer > div');
      if (!view || !view.deadline || (view.deadline.what !== 'turn' && view.deadline.what !== 'bet')) { bar.style.width = '0'; return; }
      const left = Math.max(0, view.deadline.msLeft - (Date.now() - received));
      const total = view.deadline.ms || 30000;
      bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
      $('#timer').setAttribute('aria-valuenow', String(Math.round(left / 1000)));
    }, 200);

    // Keyboard: H S D P R for the moves, I / N for insurance, B to bet.
    const KEYS = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender', i: 'insurance', n: 'decline_insurance' };
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const a = KEYS[e.key.toLowerCase()];
      if (a && view && view.you && view.you.yourTurn && view.you.legal.includes(a)) send('act', { action: a });
    });

    connect();
  }

  // --- Players leaderboard ---

  function players() {
    let kind = null;
    async function refresh() {
      try {
        const data = await api('GET', `/api/leaderboard${kind ? `?kind=${kind}` : ''}`);
        const v = data.byKind;
        const box = (k, title) => el('div', { class: 'panel' }, el('div', {}, badge(k), el('span', { text: ` ${title}` })),
          el('div', { class: 'big', text: v[k] && v[k].per100 !== null ? `${signed(v[k].per100)} units / 100 rounds` : '–' }),
          el('div', { class: 'muted', text: v[k] ? `${v[k].players} player${v[k].players === 1 ? '' : 's'} · ${v[k].rounds.toLocaleString('en')} rounds` : '' }));
        $('#versus').replaceChildren(box('human', 'Humans'), box('ai', 'AI'));
        const rows = data.players.map((p) => el('tr', { class: p.provisional ? 'provisional' : '' },
          el('td', { class: 'num', text: p.rank === null ? '–' : String(p.rank) }),
          el('td', {}, el('span', { text: `${p.name} ` }), badge(p.kind)),
          el('td', { class: 'num', text: p.rounds.toLocaleString('en') }),
          el('td', { class: 'num', text: `${signed(p.per100)} ± ${p.per100CI}` }),
          el('td', { class: 'num', text: money(p.net) }),
          el('td', { class: 'num', text: String(p.blackjacks) }),
          el('td', { text: new Date(p.last).toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short' }) })));
        $('#rows').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 7, class: 'muted', text: 'Nobody has played a live table yet.' }))]));
        $('#min-rounds').textContent = String(data.minRounds);
      } catch (e) { $('#board-msg').textContent = `Can't reach the table server: ${e.message}`; }
    }
    for (const b of document.querySelectorAll('.tabs button')) {
      b.addEventListener('click', () => {
        kind = b.dataset.kind || null;
        for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-pressed', String(x === b));
        refresh();
      });
    }
    refresh();
    setInterval(refresh, 10000);
  }

  root.Live = { lobby, table, players };
})(window);
