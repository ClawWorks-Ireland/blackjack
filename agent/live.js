#!/usr/bin/env node
/**
 * Sit a policy at a live table (CLA-113): any baseline from agent/policies.js
 * or a JS module {name, bet, act}, playing as an AI player against the same
 * dealer as the people and agents around it.
 *
 *   node agent/live.js --table 1 --name hilo-bot --policy hilo [--rounds 100] [--url http://localhost:8787]
 *   node agent/live.js --list
 *
 * The server URL can also come from BLACKJACK_SERVER.
 */
'use strict';
const path = require('path');
const { TableClient, toObs, DEFAULT_URL } = require('./table-client.js');
const { BASELINES } = require('./policies.js');

/** Play `rounds` rounds at `table` with `policy`; resolves with {rounds, bankroll, net}. */
async function playLive({ url = DEFAULT_URL, table, name, policy, rounds = 100, log = () => {} }) {
  const c = new TableClient(url);
  const j = await c.join(table, name || policy.name);
  log(`seated at table ${table}, seat ${j.seat + 1}, as ${name || policy.name} (AI)`);
  const ctx = { seed: `live-${table}`, rules: j.view.rules, table: j.view.table };
  const start = j.view.you.bankroll;
  let bets = 0;
  let v = j.view;
  for (;;) {
    v = await c.wait(25);
    if (!v.you) throw new Error('lost the seat');
    const { obs, hint, move } = toObs(v);
    if (move === 'bet') {
      if (bets >= rounds) break;
      if (v.phase === 'done') { await c.wait(5, { anyChange: true }); continue; } // betting opens in a moment
      const bet = await policy.bet(obs, ctx);
      v = await c.bet(Array.isArray(bet) ? bet[0] : bet);
      bets++;
    } else if (move === 'insurance' || move === 'play') {
      const a = await policy.act(obs, hint, ctx);
      try { v = await c.act(a); } catch (e) { if (!/turn|not legal/i.test(e.message)) throw e; } // the clock got there first
    }
  }
  const end = v.you.bankroll;
  await c.leave().catch(() => {});
  return { rounds: bets, bankroll: end, net: Math.round((end - start) * 100) / 100 };
}

async function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const url = flag('--url', DEFAULT_URL);
  if (argv.includes('--list')) {
    for (const t of await new TableClient(url).list()) {
      const who = t.seats.filter(Boolean).map((s) => `${s.name} (${s.kind})`).join(', ') || 'empty';
      console.log(`table ${t.id}: ${t.name}, $${t.minBet}-$${t.maxBet}, ${t.free} free seats: ${who}`);
    }
    return;
  }
  const spec = flag('--policy', 'basic');
  const policy = BASELINES[spec] || require(path.resolve(spec));
  const table = flag('--table', '1');
  const res = await playLive({ url, table, name: flag('--name'), policy, rounds: Number(flag('--rounds', 100)), log: console.log });
  console.log(`played ${res.rounds} rounds: bankroll ${res.bankroll}, net ${res.net > 0 ? '+' : ''}${res.net}`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(`live: ${e.message}`); process.exit(1); });
module.exports = { playLive };
