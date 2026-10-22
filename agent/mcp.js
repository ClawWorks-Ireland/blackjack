#!/usr/bin/env node
/**
 * MCP server for the agent environment, so an MCP client (Claude Code,
 * Claude Desktop, ...) can sit at the table. Speaks JSON-RPC 2.0 over stdio,
 * one message per line, with no dependencies. See agent/README.md.
 *
 *   node agent/mcp.js [--seed S] [--rules '{"h17":true}'] [--bankroll N] [--min-bet N] [--max-bet N]
 *
 * Tools: new_table, deal, act, observe, hint. Each returns a one-line table
 * summary followed by the same JSON the CLI sends. Errors come back as tool
 * results with isError set, never as a changed table.
 */
'use strict';
const readline = require('readline');
const { BlackjackEnv, EnvError } = require('./env.js');
const { parseArgs } = require('./cli.js');

const SERVER_INFO = { name: 'blackjack', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const RULES_SCHEMA = {
  type: 'object',
  description: 'Partial rules: decks (1, 2, 6, 8), h17, payout (1.5 or 1.2), das, lateSurrender, rsa, enhc, obo, '
    + 'doubleOn ("any", "9-11", "10-11"), penetration (0.5 to 0.85 in 0.05 steps). Unset rules take the defaults.',
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
          description: 'Side bets on the first spot: Perfect Pairs and 21+3.',
        },
      },
      required: ['bet'],
      additionalProperties: false,
    },
  },
  {
    name: 'act',
    description: 'Play the active hand, or answer the insurance offer. Only actions in obs.legal are accepted.',
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
    name: 'observe',
    description: 'Look at the table, including the rules and table limits. Shows only what a seated player can see.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hint',
    description: 'Basic strategy for the current decision, as a baseline. It ignores the count.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const cards = (list) => list.join(' ');

/** One line a model can read at a glance; the JSON below it has everything. */
function summary(obs) {
  const parts = [`Round ${obs.round}, ${obs.phase}`, `bankroll ${obs.bankroll}`];
  if (obs.dealer.cards.length) {
    const d = obs.dealer;
    parts.push(`dealer ${cards(d.cards)}${d.holeCardHidden ? ` + hole card (showing ${d.total})` : ` (${d.total})`}`);
  }
  obs.hands.forEach((h, i) => {
    const mark = obs.phase === 'player' && i === obs.active ? '> ' : '';
    const result = h.result ? `, ${h.result.outcome} ${h.result.net > 0 ? '+' : ''}${h.result.net}` : '';
    parts.push(`${mark}hand ${i + 1}: ${cards(h.cards)} (${h.soft ? 'soft ' : ''}${h.total}), bet ${h.bet}${result}`);
  });
  if (obs.net !== null) parts.push(`net ${obs.net > 0 ? '+' : ''}${obs.net}`);
  if (obs.legal.length) parts.push(`legal: ${obs.legal.join(', ')}`);
  return parts.join(' · ');
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** Run one tool call against `env`; a bad request is an isError result and leaves the table as it was. */
function callTool(env, name, args = {}) {
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
      case 'hint': return text(JSON.stringify({ hint: env.hint() }));
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
          + 'obs.legal lists the moves allowed now; obs.shoe.seen counts the cards revealed since the shuffle.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = msg.params || {};
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool "${name}"`);
      return reply(callTool(env, name, args || {}));
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
    if (res) out(res);
  });
}

if (require.main === module) main();
module.exports = { TOOLS, summary, callTool, handleMessage };
