/**
 * Hand records (CLA-128): one format for a finished poker hand, wherever it
 * was played, so an observer learns the same way from all of them.
 *
 *   {
 *     source: 'live' | 'pokerstars' | 'json', id, table, game: "holdem",
 *     smallBlind, bigBlind, button,             // button: a seat number
 *     players: [{seat, name, stack}],           // the players dealt in
 *     actions: [{seat, street, action, amount?, to?, allIn?}],
 *     board: ['Ah', ...], shown: [{seat, cards}],
 *     net: {seat: chips won (+) or lost (-)}, rake?,
 *   }
 *
 * Actions are the engine's log entries (engine/poker.js): street is preflop,
 * flop, turn or river; action is ante, small blind, big blind (amount), fold,
 * check, call (amount: what it added), bet or raise (to: the total in front of
 * the player on that street). Cards are rank then suit, as "Td", "As".
 *
 * Sources:
 *   fromTable(view, meta)   a finished hand at our tables (a view in phase "done")
 *   parsePokerStars(text)   PokerStars-style text hand histories, the format most
 *                           sites and tracking tools export; Hold'em only
 *   parseJsonLines(text)    records written as one JSON object per line
 *   parse(text)             whichever of the last two fits
 *
 * toProfileInput(record) gives Profiles.addHand its (names, log, lastHand).
 */
'use strict';
const crypto = require('crypto');
const { evaluate } = require('../engine/poker.js');

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const round = (x) => Math.round(x * 100) / 100;

/** A finished hand at one of our tables, from any seat's view or the public one. */
function fromTable(view, meta = {}) {
  const h = view.lastHand;
  if (!h) throw new Error('no finished hand in this view');
  const players = [];
  const net = {};
  view.seats.forEach((s, i) => {
    if (!s || h.net[i] === null || h.net[i] === undefined) return;
    players.push({ seat: i, name: s.player.name, kind: s.player.kind, stack: s.stack - h.net[i] });
    net[i] = h.net[i];
  });
  const table = meta.table || view.id || 'table';
  const actions = view.log.map((e) => ({ ...e }));
  // Hand numbers start again when the server does, so the id carries a fingerprint of the hand too.
  const print = crypto.createHash('sha1').update(JSON.stringify([players, actions, h.board, net])).digest('hex').slice(0, 10);
  return {
    source: 'live', id: `${table}-${h.handNo}-${print}`, table, game: 'holdem',
    smallBlind: view.smallBlind, bigBlind: view.bigBlind, button: view.button,
    players, actions, board: [...h.board],
    shown: (h.shown || []).map((x) => ({ seat: x.seat, cards: [...x.cards] })), net,
  };
}

// --- PokerStars-style text ---

const num = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
const cardsOf = (s) => s.trim().split(/\s+/).filter(Boolean).map((c) => c.replace(/^10/, 'T'));

/** Split a file of text histories into one block per hand. */
function splitHands(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^\S.*\bHand #[\w-]+:/.test(line)) { if (cur) out.push(cur); cur = [line]; } else if (cur) cur.push(line);
  }
  if (cur) out.push(cur);
  return out;
}

/** One text hand to a record, or null if it isn't Hold'em (with the reason). */
function parseHand(lines) {
  const head = lines[0];
  const id = (head.match(/Hand #([\w-]+):/) || [])[1];
  if (!/Hold'?em/i.test(head)) return { skipped: `not Hold'em: ${head.slice(0, 80)}` };
  const blinds = head.match(/\(([^()]*?)\/([^()]*?)(?:\s+[A-Z]{3})?\)/);
  const tableLine = lines.find((l) => /^Table '/.test(l)) || '';
  const table = (tableLine.match(/^Table '([^']+)'/) || [])[1] || null;
  const button = Number((tableLine.match(/Seat #(\d+) is the button/) || [])[1]);
  const players = [];
  const bySeatName = new Map();
  for (const l of lines) {
    const m = l.match(/^Seat (\d+): (.+?) \(([^)]*?) in chips(?:, [^)]*)?\)(.*)$/);
    if (!m) continue;
    if (/sitting out/i.test(m[4])) continue;
    const p = { seat: Number(m[1]), name: m[2], stack: num(m[3]) };
    players.push(p);
    bySeatName.set(p.name, p.seat);
  }
  // Longest names first, so "Bob" doesn't match a line by "Bobby".
  const names = [...bySeatName.keys()].sort((a, b) => b.length - a.length);
  const who = (l) => names.find((n) => l.startsWith(`${n}: `) || l.startsWith(`${n} `));
  const actions = [];
  const board = [];
  const shown = [];
  const put = new Map(); // seat -> chips in this hand
  const collected = new Map();
  let street = 'preflop';
  let onStreet = new Map(); // seat -> chips in this street
  let showdown = false;
  let summary = false;
  let rake = 0;
  const add = (seat, x) => put.set(seat, round((put.get(seat) || 0) + x));
  const addStreet = (seat, x) => onStreet.set(seat, round((onStreet.get(seat) || 0) + x));
  for (const l of lines.slice(1)) {
    const st = l.match(/^\*\*\* (FLOP|TURN|RIVER) \*\*\* (.*)$/);
    if (st) {
      street = st[1].toLowerCase();
      onStreet = new Map();
      const groups = [...st[2].matchAll(/\[([^\]]*)\]/g)].map((g) => cardsOf(g[1]));
      board.splice(0, board.length, ...groups.flat());
      continue;
    }
    if (/^\*\*\* SHOW ?DOWN \*\*\*/.test(l)) { showdown = true; continue; }
    if (/^\*\*\* SUMMARY \*\*\*/.test(l)) { summary = true; continue; }
    if (summary) {
      const rk = l.match(/Rake (\S+)/);
      if (rk) rake = num(rk[1]);
      const m = l.match(/^Seat \d+: (.+?)(?: \([^)]*\))* (?:showed|mucked) \[([^\]]+)\]/);
      if (m && bySeatName.has(m[1]) && !shown.some((x) => x.name === m[1])) shown.push({ name: m[1], cards: cardsOf(m[2]) });
      continue;
    }
    const ret = l.match(/^Uncalled bet \(([^)]+)\) returned to (.+)$/);
    if (ret && bySeatName.has(ret[2])) { const s = bySeatName.get(ret[2]); add(s, -num(ret[1])); addStreet(s, -num(ret[1])); continue; }
    const n = who(l);
    if (!n) continue;
    const seat = bySeatName.get(n);
    const rest = l.slice(n.length).replace(/^:?\s*/, '');
    const allIn = /all-in/.test(rest) || undefined;
    let m;
    if ((m = rest.match(/^collected (\S+) from/))) { collected.set(seat, round((collected.get(seat) || 0) + num(m[1]))); continue; }
    if ((m = rest.match(/^shows \[([^\]]+)\]/))) { shown.push({ name: n, cards: cardsOf(m[1]) }); continue; }
    if ((m = rest.match(/^posts the ante (\S+)/))) { add(seat, num(m[1])); actions.push({ seat, street: 'preflop', action: 'ante', amount: num(m[1]) }); continue; }
    if ((m = rest.match(/^posts small & big blinds (\S+)/))) { add(seat, num(m[1])); addStreet(seat, num(m[1])); actions.push({ seat, street: 'preflop', action: 'big blind', amount: num(m[1]) }); continue; }
    if ((m = rest.match(/^posts (small|big) blind (\S+)/))) { add(seat, num(m[2])); addStreet(seat, num(m[2])); actions.push({ seat, street: 'preflop', action: `${m[1]} blind`, amount: num(m[2]) }); continue; }
    if (/^folds/.test(rest)) { actions.push({ seat, street, action: 'fold' }); continue; }
    if (/^checks/.test(rest)) { actions.push({ seat, street, action: 'check' }); continue; }
    if ((m = rest.match(/^calls (\S+)/))) { add(seat, num(m[1])); addStreet(seat, num(m[1])); actions.push({ seat, street, action: 'call', amount: num(m[1]), ...(allIn ? { allIn } : {}) }); continue; }
    if ((m = rest.match(/^bets (\S+)/))) { add(seat, num(m[1])); addStreet(seat, num(m[1])); actions.push({ seat, street, action: 'bet', to: onStreet.get(seat), ...(allIn ? { allIn } : {}) }); continue; }
    if ((m = rest.match(/^raises \S+ to (\S+)/))) {
      const to = num(m[1]);
      add(seat, to - (onStreet.get(seat) || 0));
      onStreet.set(seat, to);
      actions.push({ seat, street, action: 'raise', to, ...(allIn ? { allIn } : {}) });
    }
  }
  const net = {};
  for (const p of players) net[p.seat] = round((collected.get(p.seat) || 0) - (put.get(p.seat) || 0));
  return {
    source: 'pokerstars', id: id || null, table, game: 'holdem', limit: /No Limit/i.test(head) ? 'no limit' : /Pot Limit/i.test(head) ? 'pot limit' : 'limit',
    smallBlind: blinds ? num(blinds[1]) : null, bigBlind: blinds ? num(blinds[2]) : null, button: Number.isFinite(button) ? button : null,
    players, actions, board, rake,
    shown: showdown || shown.length ? shown.map((x) => ({ seat: bySeatName.get(x.name), cards: x.cards })) : [],
    net,
  };
}

/** Every Hold'em hand in a text file of histories: {records, skipped}. */
function parsePokerStars(text) {
  const records = [];
  const skipped = [];
  for (const block of splitHands(text)) {
    let r;
    try { r = parseHand(block); } catch (e) { r = { skipped: `unreadable hand: ${e.message}` }; }
    if (r.skipped) skipped.push(r.skipped); else records.push(r);
  }
  return { records, skipped };
}

function parseJsonLines(text) {
  const records = [];
  const skipped = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!Array.isArray(r.players) || !Array.isArray(r.actions)) throw new Error('needs players and actions');
      records.push({ source: 'json', board: [], shown: [], net: {}, ...r });
    } catch (e) { skipped.push(`bad line: ${e.message}`); }
  }
  return { records, skipped };
}

/** JSON lines if the text starts with "{", text histories otherwise. */
function parse(text) {
  return /^\s*\{/.test(String(text).replace(/^﻿/, '')) ? parseJsonLines(text) : parsePokerStars(text);
}

/** What Profiles.addHand takes: names by seat, the action log, and the result. */
function toProfileInput(r) {
  const names = [];
  const net = [];
  for (const p of r.players) { names[p.seat] = p.name; net[p.seat] = r.net[p.seat] ?? 0; }
  for (let i = 0; i < net.length; i++) if (net[i] === undefined) net[i] = null;
  const board = r.board || [];
  const shown = (r.shown || []).filter((x) => x.seat !== undefined && x.cards && x.cards.length === 2).map((x) => ({
    seat: x.seat, cards: x.cards, hand: board.length >= 3 ? evaluate([...x.cards, ...board]).name : 'shown',
  }));
  return { names, log: r.actions, lastHand: { board, showdown: shown.length > 0, shown, net } };
}

module.exports = { fromTable, parsePokerStars, parseJsonLines, parse, toProfileInput, splitHands, STREETS };
