#!/usr/bin/env node
/**
 * JSON-lines front end to the agent environment: one JSON request per line on
 * stdin, one JSON response per line on stdout. See agent/README.md.
 *
 *   node agent/cli.js [--seed S] [--rules '{"h17":true}'] [--bankroll N] [--min-bet N] [--max-bet N]
 *
 * Requests:  {"action":"deal","bet":10}   {"action":"hit"}   {"cmd":"observe"}
 *            {"cmd":"reset","seed":"s1","rules":{...}}   {"cmd":"hint"}   {"cmd":"hint","count":true}   {"cmd":"quit"}
 *            {"cmd":"auto","rounds":100,"policy":"basic","bet":10,"untilShuffle":false}
 * Responses: {"ok":true,"obs":{...},"reward":0,"done":false}  or  {"ok":false,"error":"..."}
 * Any "id" in a request is echoed back.
 */
'use strict';
const readline = require('readline');
const { BlackjackEnv, EnvError } = require('./env.js');
const { autoPlay } = require('./auto.js');
const { countHint } = require('./count-hint.js');

function parseArgs(argv) {
  const opts = {};
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new EnvError(`${name} must be a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === '--seed') { opts.seed = v; i++; }
    else if (k === '--rules') { opts.rules = JSON.parse(v); i++; }
    else if (k === '--bankroll') { opts.bankroll = num(v, k); i++; }
    else if (k === '--min-bet') { opts.minBet = num(v, k); i++; }
    else if (k === '--max-bet') { opts.maxBet = num(v, k); i++; }
    else if (k === '--help' || k === '-h') {
      process.stdout.write('usage: node agent/cli.js [--seed S] [--rules JSON] [--bankroll N] [--min-bet N] [--max-bet N]\n' +
        'Then send one JSON request per line; see agent/README.md.\n');
      process.exit(0);
    } else throw new EnvError(`unknown option ${k}`);
  }
  return opts;
}

function handle(env, req) {
  const cmd = req.cmd || (req.action !== undefined ? 'step' : null);
  switch (cmd) {
    case 'step': return { ...env.step(req) };
    case 'observe': return { obs: env.observe() };
    case 'legal': return { legal: env.legalActions() };
    case 'hint': return { hint: req.count ? countHint(env) : env.hint() };
    case 'auto': {
      const { obs, ...auto } = autoPlay(env, { rounds: req.rounds, policy: req.policy, bet: req.bet, untilShuffle: req.untilShuffle });
      return { auto, obs };
    }
    case 'reset': {
      const { seed, rules, bankroll, minBet, maxBet } = req;
      return { obs: env.reset({ seed, rules, bankroll, minBet, maxBet }) };
    }
    default: throw new EnvError('request needs "action" or "cmd" (step, observe, legal, hint, auto, reset, quit)');
  }
}

function main() {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let env;
  try {
    env = new BlackjackEnv(parseArgs(process.argv.slice(2)));
  } catch (e) {
    out({ ok: false, error: e.message });
    process.exit(2);
  }
  out({ ok: true, event: 'ready', obs: env.observe() });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch (_) {
      out({ ok: false, error: 'request is not valid JSON' });
      return;
    }
    const id = req && typeof req === 'object' && 'id' in req ? { id: req.id } : {};
    if (req && req.cmd === 'quit') {
      out({ ...id, ok: true, event: 'bye' });
      rl.close();
      process.stdin.destroy(); // let the process exit once stdout drains, even if the caller keeps stdin open
      return;
    }
    try {
      out({ ...id, ok: true, ...handle(env, req) });
    } catch (e) {
      if (!(e instanceof EnvError)) throw e; // a bug, not a bad request: crash loudly
      out({ ...id, ok: false, error: e.message, legal: env.legalActions() });
    }
  });
}

if (require.main === module) main();
module.exports = { handle, parseArgs };
