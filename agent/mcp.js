#!/usr/bin/env node
/**
 * MCP server for the agent environment, so an MCP client (Claude Code,
 * Claude Desktop, ...) can sit at the table. Speaks JSON-RPC 2.0 over stdio,
 * one message per line, with no dependencies. See agent/README.md.
 *
 *   node agent/mcp.js [--seed S] [--rules '{"h17":true}'] [--bankroll N] [--min-bet N] [--max-bet N]
 *
 * Tools: new_table, deal, act, observe, hint, auto_play for a private table;
 * live_tables, live_join, live_wait, live_bet, live_act, live_leave and
 * live_leaderboard to sit with other agents and people at the live table
 * server (server/server.js), where this session plays as an AI; poker_* the
 * same for its no-limit Hold'em tables. Each returns a one-line table
 * summary followed by the same JSON the CLI sends. Errors come back as tool
 * results with isError set, never as a changed table.
 */
'use strict';
const readline = require('readline');
const { BlackjackEnv, EnvError } = require('./env.js');
const { parseArgs } = require('./cli.js');
const { autoPlay, describe, MAX_ROUNDS } = require('./auto.js');
const { countHint } = require('./count-hint.js');
const { TableClient, yourMove } = require('./table-client.js');

const SERVER_INFO = { name: 'blackjack', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const RULES_SCHEMA = {
  type: 'object',
  description: 'Partial rules: decks (1, 2, 6, 8), h17, payout (1.5 or 1.2), das, lateSurrender, rsa, enhc, obo, '
    + 'doubleOn ("any", "9-11", "10-11"), penetration (0.5 to 0.85 in 0.05 steps). Unset rules take the defaults. '
    + 'The dealer peeks for blackjack under a 10 or an ace unless enhc is set.',
};

const TOOLS = [
  {
    name: 'new_table',
    description: 'Sit at a new table. The same seed and the same actions replay a session exactly; '
      + 'without a seed a random one is chosen and reported in obs.shoe.seed.',
    inputSchema: {
      type: 'object',
      properties: {
        seed: { type: 'string', description: 'Shoe seed; "name-N" starts at shoe N.' },
        rules: RULES_SCHEMA,
        bankroll: { type: 'number', description: 'Starting chips (default 1000).' },
        minBet: { type: 'number', description: 'Table minimum (default 1).' },
        maxBet: { type: 'number', description: 'Table maximum (default 500).' },
        bots: { type: 'integer', minimum: 0, maximum: 6, description: 'Other seats, played by basic-strategy bots with no money (default 0). Their cards count in obs.shoe.seen.' },
        seat: { type: 'integer', minimum: 0, maximum: 6, description: 'How many bots sit on your right and play before you (0 = first base, default 0; at most bots).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'deal',
    description: 'Bet and deal a round. Pass one bet, or a list of up to 3 for several spots. '
      + 'The round can end on the deal itself (a natural, or a dealer blackjack).',
    inputSchema: {
      type: 'object',
      properties: {
        bet: {
          oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 3 }],
          description: 'Bet per spot.',
        },
        side: {
          type: 'object',
          properties: { pairs: { type: 'number' }, t213: { type: 'number' } },
          additionalProperties: false,
          description: 'Side bets on the first spot, each up to table.sideMax: Perfect Pairs (your first two cards) '
            + 'and 21+3 (your first two cards and the dealer up card). They settle on the deal; '
            + 'obs.sideBets gives each outcome, the winning hand and its odds.',
        },
      },
      required: ['bet'],
      additionalProperties: false,
    },
  },
  {
    name: 'act',
    description: 'Play the active hand, or answer the insurance offer. Only actions in obs.legal are accepted. '
      + 'When you hold a blackjack against an ace, obs.insurance.evenMoney is true and "insurance" takes even money '
      + '(a sure 1:1 win); "decline_insurance" plays on for 3:2.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['hit', 'stand', 'double', 'split', 'surrender', 'insurance', 'decline_insurance'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'auto_play',
    description: 'Play many rounds in one call with a built-in policy, then report the result and the table. '
      + 'Use it to move through rounds you do not need to decide yourself, e.g. to the next shuffle or until the count '
      + 'is worth acting on. Only between rounds. Policies: basic (basic strategy, the default), hilo (Hi-Lo counter, '
      + 'bets its own ramp), never-bust, random.',
    inputSchema: {
      type: 'object',
      properties: {
        rounds: { type: 'integer', minimum: 1, maximum: MAX_ROUNDS, description: `Most rounds to play (1 to ${MAX_ROUNDS}).` },
        policy: { type: 'string', enum: ['basic', 'hilo', 'never-bust', 'random'], description: 'Who plays the hands (default basic).' },
        bet: {
          oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 3 }],
          description: 'Flat bet per spot for every round. Omit to let the policy bet (the minimum; hilo follows the count).',
        },
        untilShuffle: { type: 'boolean', description: 'Stop after the round that brings out the cut card.' },
      },
      required: ['rounds'],
      additionalProperties: false,
    },
  },
  {
    name: 'observe',
    description: 'Look at the table, including the rules and table limits. Shows only what a seated player can see.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hint',
    description: 'Basic strategy for the current decision, as a baseline, with ev: the expected value of each legal action '
      + 'per unit of the bet (full-shoe solver values that ignore the count; evBasis says how exact). '
      + 'For insurance, ev is the gain over declining given the cards seen so far.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'boolean',
          description: 'Add what a counter knows: the Hi-Lo running and true count, the counter\'s play (index play, '
            + 'insurance, or the ramp bet between rounds), and evSeen, each legal play priced from the cards left.',
        },
      },
      additionalProperties: false,
    },
  },
];

const LIVE_TOOLS = [
  {
    name: 'live_tables',
    description: 'List the live tables on the table server (server/server.js, BLACKJACK_SERVER or http://localhost:8787), '
      + 'where agents and people play the same shoe. Each player plays the dealer; a leaderboard compares AI and human players.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Table server URL.' } }, additionalProperties: false },
  },
  {
    name: 'live_join',
    description: 'Sit down at a live table as an AI player. Then call live_wait, and live_bet / live_act when it is your move. '
      + 'The table has a clock: a seat that doesn\'t move in time stands, and one that keeps missing rounds loses its seat.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table id from live_tables.' },
        name: { type: 'string', description: 'Your player name on the table and leaderboard (up to 24 characters).' },
        seat: { type: 'integer', minimum: 0, maximum: 6, description: 'A free seat (default: the first free one).' },
        url: { type: 'string', description: 'Table server URL.' },
      },
      required: ['table', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'live_wait',
    description: 'Wait (up to `timeout` seconds) until it is your move: a bet between rounds, insurance, or playing your hand. '
      + 'Returns the table with "your move: ...". Call it again if it says waiting.',
    inputSchema: { type: 'object', properties: { timeout: { type: 'integer', minimum: 1, maximum: 55, description: 'Seconds (default 25).' } }, additionalProperties: false },
  },
  {
    name: 'live_bet',
    description: 'Bet for the next round at your live table (or sit_out: true to skip it).',
    inputSchema: { type: 'object', properties: { amount: { type: 'number' }, sit_out: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'live_act',
    description: 'Make your move at the live table: hit, stand, double, split, surrender, insurance or decline_insurance.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['hit', 'stand', 'double', 'split', 'surrender', 'insurance', 'decline_insurance'] } },
      required: ['action'],
      additionalProperties: false,
    },
  },
  { name: 'live_leave', description: 'Leave your live table (between rounds).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'live_leaderboard',
    description: 'The live tables leaderboard: players ranked by units won per 100 rounds, each marked AI or human, and humans vs AI overall.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['ai', 'human'] }, url: { type: 'string' } }, additionalProperties: false },
  },
];
TOOLS.push(...LIVE_TOOLS);

const POKER_TOOLS = [
  {
    name: 'poker_tables',
    description: "List the live no-limit Hold'em tables on the table server (BLACKJACK_SERVER or http://localhost:8787). "
      + 'In poker you play the other players, not the house; bots don\'t say how they play.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'poker_join',
    description: 'Sit down at a poker table as an AI player (play chips; a busted stack rebuys). Then poker_wait and poker_act on your turn. '
      + 'A seat that doesn\'t move in time checks or folds; one that keeps missing hands loses its seat.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, name: { type: 'string' }, seat: { type: 'integer', minimum: 0, maximum: 5 }, url: { type: 'string' } },
      required: ['table', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'poker_wait',
    description: 'Wait (up to `timeout` seconds) until it is your turn, or the table changes. Returns the table: board, pot, every seat, your cards and legal moves.',
    inputSchema: { type: 'object', properties: { timeout: { type: 'integer', minimum: 1, maximum: 55 } }, additionalProperties: false },
  },
  {
    name: 'poker_act',
    description: 'Your move: fold, check, call, bet or raise (amount = the total you put in this street, "to"), or allin.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise', 'allin'] }, amount: { type: 'number' } },
      required: ['action'],
      additionalProperties: false,
    },
  },
  { name: 'poker_leave', description: 'Leave your poker table.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'poker_leaderboard',
    description: 'Poker leaderboard: big blinds won per 100 hands, each player marked AI or human.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['ai', 'human'] }, url: { type: 'string' } }, additionalProperties: false },
  },
];
TOOLS.push(...POKER_TOOLS);

/** One line for a poker view: the board and pot, each seat in order, then what you may do. */
function pokerSummary(v) {
  const parts = [`${v.name}, hand ${v.handNo}, ${v.phase}`, `board ${v.board.length ? cards(v.board) : '-'}`, `pot ${v.pot}`];
  v.seats.forEach((s, i) => {
    if (!s) return;
    const you = v.you && v.you.seat === i;
    const state = s.folded ? 'folded' : s.allIn ? 'all-in' : s.lastAction || '';
    parts.push(`seat ${i}${v.button === i ? ' (dealer)' : ''} ${s.player.name} [${s.player.kind}]${you ? ' (you)' : ''}: stack ${s.stack}${s.bet ? `, bet ${s.bet}` : ''}${state ? `, ${state}` : ''}${s.cards.length && s.cards[0] !== '??' ? `, ${cards(s.cards)}` : ''}`);
  });
  if (v.phase === 'done' && v.lastHand) {
    const h = v.lastHand;
    parts.push(`hand ${h.handNo}: ${h.pots.map((p) => `${p.winners.map((w) => (v.seats[w] ? v.seats[w].player.name : `seat ${w}`)).join(' and ')} won ${p.amount}${p.hand ? ` with ${p.hand}` : ''}`).join('; ')}`);
  }
  if (v.you) {
    const moves = v.you.legal.map((l) => (l.min !== undefined ? `${l.action} ${l.min}-${l.max}` : l.amount !== undefined ? `${l.action} ${l.amount}` : l.action)).join(', ');
    parts.push(`you: ${v.you.cards.join(' ') || 'no cards'}${v.you.hand ? ` (${v.you.hand})` : ''}, stack ${v.you.stack}`);
    parts.push(v.you.yourTurn ? `your move: ${moves}` : 'waiting for other players');
  }
  return parts.join(' · ');
}


/** One line for a live table view, in seat order (seats numbered from 0, as in the JSON), then what it wants from you. */
function liveSummary(v) {
  const parts = [v.phase === 'betting' ? `${v.name}, betting for round ${v.round + 1}` : `${v.name}, round ${v.round}, ${v.phase}`];
  // A round can settle without asking you anything: say how your last one went.
  const last = v.you && v.you.lastRound;
  if (last && v.phase === 'betting' && last.round === v.round) {
    const hands = last.hands.map((h) => `${cards(h.cards)} (${h.total})${h.result ? ` ${h.result.outcome} ${h.result.net > 0 ? '+' : ''}${h.result.net}` : ''}`).join(' / ');
    parts.push(`your round ${last.round}: ${hands} vs dealer ${cards(last.dealer)} (${last.dealerTotal}), net ${last.net > 0 ? '+' : ''}${last.net}`);
  }
  if (v.dealer.cards.length) parts.push(`dealer ${cards(v.dealer.cards)}${v.dealer.holeCardHidden ? ` + hole card (showing ${v.dealer.total})` : ` (${v.dealer.total})`}`);
  v.seats.forEach((s, i) => {
    if (!s) return;
    const you = v.you && v.you.seat === i;
    const hands = s.hands.map((h, k) => `${s.active === k ? '> ' : ''}${cards(h.cards)} (${h.soft ? 'soft ' : ''}${h.total})${h.result ? ` ${h.result.outcome} ${h.result.net > 0 ? '+' : ''}${h.result.net}` : ''}`).join(' / ');
    parts.push(`seat ${i} ${s.player.name} [${s.player.kind}]${you ? ' (you)' : ''}: ${hands || (s.out ? 'sitting out' : s.bet ? `bet ${s.bet}` : 'no bet yet')}`);
  });
  if (v.you) {
    const move = yourMove(v);
    const cost = (a) => (v.you.legalCost[a] ? ` (+${v.you.legalCost[a]})` : '');
    const legal = v.you.legal.filter((a) => a !== 'bet' && a !== 'sit_out').map((a) => a + cost(a)).join(', ');
    parts.push(`bankroll ${v.you.bankroll}${v.you.onTable ? ` + ${v.you.onTable} on the table` : ''}`);
    parts.push({ bet: `your move: bet (live_bet, ${v.table.minBet}-${v.table.maxBet})`, insurance: `your move: ${v.you.evenMoney ? 'even money' : 'insurance'}? ${legal}`, play: `your move: ${legal}`, wait: 'waiting for other players' }[move] || 'you have no seat');
  }
  return parts.join(' · ');
}

const cards = (list) => list.join(' ');

/** One line a model can read at a glance; the JSON below it has everything. */
function summary(obs) {
  const parts = [`Round ${obs.round}, ${obs.phase}`, `bankroll ${obs.bankroll}`];
  if (obs.dealer.cards.length) {
    const d = obs.dealer;
    parts.push(`dealer ${cards(d.cards)}${d.holeCardHidden ? ` + hole card (showing ${d.total})` : ` (${d.total})`}`);
  }
  // Bot seats in table order: the ones on your right, your hands, then the rest.
  const botHand = (h) => `${cards(h.cards)} (${h.soft ? 'soft ' : ''}${h.total}${h.result ? `, ${h.result}` : ''})`;
  const bots = (right) => obs.others.filter((o) => (o.seat < obs.seat) === right)
    .forEach((o) => parts.push(`seat ${o.seat} bot: ${o.hands.map(botHand).join(' / ')}`));
  bots(true);
  obs.hands.forEach((h, i) => {
    const mark = obs.phase === 'player' && i === obs.active ? '> ' : '';
    const result = h.result ? `, ${h.result.outcome} ${h.result.net > 0 ? '+' : ''}${h.result.net}` : '';
    parts.push(`${mark}hand ${i + 1}: ${cards(h.cards)} (${h.soft ? 'soft ' : ''}${h.total}), bet ${h.bet}${result}`);
  });
  bots(false);
  if (obs.insurance.offered) parts.push(`${obs.insurance.evenMoney ? 'even money' : 'insurance'} offered (cost ${obs.insurance.cost})`);
  obs.sideBets.forEach((s) => {
    parts.push(`${s.bet === 'pairs' ? 'Perfect Pairs' : '21+3'} ${s.stake}: ${s.win ? `${s.win} ${s.odds}:1, +${s.net}` : `lose ${s.net}`}`);
  });
  if (obs.net !== null) parts.push(`net ${obs.net > 0 ? '+' : ''}${obs.net}`);
  if (obs.legal.length) {
    const cost = (a) => (obs.legalCost && obs.legalCost[a] ? ` (+${obs.legalCost[a]})` : '');
    parts.push(`legal: ${obs.legal.map((a) => a + cost(a)).join(', ')}`);
  }
  return parts.join(' · ');
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

const live = { client: null, poker: null };
const errorResult = (message) => ({ ...text(JSON.stringify({ error: message })), isError: true });

/** Live table tools: async, against the table server. Errors are tool errors. */
async function callLive(name, args) {
  try {
    if (name.startsWith('poker_')) return await callPoker(name, args);
    if (name === 'live_tables') {
      const tables = await new TableClient(args.url || (live.client && live.client.url) || undefined).list();
      const lines = tables.map((t) => `table ${t.id}: ${t.name}, $${t.minBet}-$${t.maxBet}, ${t.free} free: ${t.seats.filter(Boolean).map((s) => `${s.name} [${s.kind}]`).join(', ') || 'nobody yet'}`);
      return text(`${lines.join('\n') || 'No tables.'}\n${JSON.stringify({ tables })}`);
    }
    if (name === 'live_leaderboard') {
      const lb = await new TableClient(args.url || (live.client && live.client.url) || undefined).leaderboard(args.kind);
      const k = lb.byKind;
      const head = `humans ${k.human && k.human.per100 !== null ? k.human.per100 : '-'} vs AI ${k.ai && k.ai.per100 !== null ? k.ai.per100 : '-'} units/100 rounds`;
      const rows = lb.players.map((p) => `${p.rank === null ? '-' : p.rank}. ${p.name} [${p.kind}] ${p.per100} units/100 over ${p.rounds} rounds${p.provisional ? ' (provisional)' : ''}`);
      return text(`${head}\n${rows.join('\n')}\n${JSON.stringify(lb)}`);
    }
    if (name === 'live_join') {
      if (live.client && live.client.token) throw new Error('already at a table: live_leave first');
      const c = new TableClient(args.url || undefined);
      const j = await c.join(args.table, args.name, args.seat);
      live.client = c;
      return text(`${liveSummary(j.view)}\n${JSON.stringify({ seat: j.seat, view: j.view })}`);
    }
    const c = live.client;
    if (!c || !c.token) throw new Error('not at a live table: live_join first');
    let v;
    if (name === 'live_wait') v = await c.wait(args.timeout || 25);
    else if (name === 'live_bet') v = args.sit_out ? await c.sitOut() : await c.bet(Number(args.amount));
    else if (name === 'live_act') v = await c.act(args.action);
    else if (name === 'live_leave') { await c.leave(); live.client = null; return text('Left the table.'); }
    return text(`${liveSummary(v)}\n${JSON.stringify({ view: v })}`);
  } catch (e) {
    return errorResult(e.message);
  }
}

async function callPoker(name, args) {
  const urlOf = () => args.url || (live.poker && live.poker.url) || undefined;
  if (name === 'poker_tables') {
    const tables = await new TableClient(urlOf(), { game: 'poker' }).list();
    const lines = tables.map((t) => `table ${t.id}: ${t.name}, blinds ${t.smallBlind}/${t.bigBlind}, ${t.free} free: ${t.seats.filter(Boolean).map((s) => `${s.name} [${s.kind}]`).join(', ') || 'nobody yet'}`);
    return text(`${lines.join('\n') || 'No poker tables.'}\n${JSON.stringify({ tables })}`);
  }
  if (name === 'poker_leaderboard') {
    const lb = await new TableClient(urlOf(), { game: 'poker' }).leaderboard(args.kind);
    const rows = lb.players.map((p) => `${p.rank === null ? '-' : p.rank}. ${p.name} [${p.kind}] ${p.per100} bb/100 over ${p.rounds} hands${p.provisional ? ' (provisional)' : ''}`);
    return text(`${rows.join('\n') || 'Nobody has played poker yet.'}\n${JSON.stringify(lb)}`);
  }
  if (name === 'poker_join') {
    if (live.poker && live.poker.token) throw new Error('already at a poker table: poker_leave first');
    const c = new TableClient(args.url || undefined, { game: 'poker' });
    const j = await c.join(args.table, args.name, args.seat);
    live.poker = c;
    return text(`${pokerSummary(j.view)}\n${JSON.stringify({ seat: j.seat, view: j.view })}`);
  }
  const c = live.poker;
  if (!c || !c.token) throw new Error('not at a poker table: poker_join first');
  let v;
  if (name === 'poker_wait') v = await c.wait(args.timeout || 25);
  else if (name === 'poker_act') v = await c.act(args.action, args.amount);
  else if (name === 'poker_leave') { await c.leave(); live.poker = null; return text('Left the poker table.'); }
  return text(`${pokerSummary(v)}\n${JSON.stringify({ view: v })}`);
}

/** Run one tool call against `env`; a bad request is an isError result and leaves the table as it was. */
function callTool(env, name, args = {}) {
  if (name.startsWith('live_') || name.startsWith('poker_')) return callLive(name, args);
  try {
    switch (name) {
      case 'new_table': {
        const obs = env.reset(args);
        return text(`${summary(obs)}\n${JSON.stringify({ obs })}`);
      }
      case 'deal':
      case 'act': {
        const res = env.step(name === 'deal' ? { action: 'deal', bet: args.bet, side: args.side } : { action: args.action });
        return text(`${summary(res.obs)}\n${JSON.stringify(res)}`);
      }
      case 'observe': {
        const obs = env.observe();
        return text(`${summary(obs)}\n${JSON.stringify({ obs })}`);
      }
      case 'hint': return text(JSON.stringify({ hint: args.count ? countHint(env) : env.hint() }));
      case 'auto_play': {
        const { obs, ...auto } = autoPlay(env, args);
        return text(`${describe(auto)}\n${summary(obs)}\n${JSON.stringify({ auto, obs })}`);
      }
      default: throw new EnvError(`unknown tool "${name}"`);
    }
  } catch (e) {
    if (!(e instanceof EnvError)) throw e;
    return { ...text(JSON.stringify({ error: e.message, legal: env.legalActions() })), isError: true };
  }
}

/** Answer one JSON-RPC message; null for notifications, which get no reply. */
function handleMessage(env, msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  if (!('id' in msg)) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A blackjack table. Call deal to bet, then act until the round is done. '
          + 'obs.legal lists the moves allowed now and obs.legalCost the chips each one takes; '
          + 'obs.shoe.seen counts the cards revealed since the shuffle. '
          + 'To play with other agents and people at a live table instead, use live_tables, live_join and live_wait.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = msg.params || {};
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool "${name}"`);
      const result = callTool(env, name, args || {});
      return typeof result.then === 'function' ? result.then(reply) : reply(result);
    }
    default: return fail(-32601, `method not found: ${msg.method}`);
  }
}

function main() {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let env;
  try {
    env = new BlackjackEnv(parseArgs(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`blackjack mcp: ${e.message}\n`);
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const res = handleMessage(env, msg);
    if (res && typeof res.then === 'function') res.then(out);
    else if (res) out(res);
  });
}

if (require.main === module) main();
module.exports = { TOOLS, summary, liveSummary, pokerSummary, callTool, handleMessage };
