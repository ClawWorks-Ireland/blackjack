'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parse, parsePokerStars, parseJsonLines, fromTable, toProfileInput } = require('./poker-history.js');
const { Profiles } = require('./poker-profile.js');
const { PokerTable } = require('../engine/poker.js');
const { POLICIES, rngFor } = require('../engine/poker-bots.js');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'pokerstars-sample.txt'), 'utf8');
const total = (r) => Object.values(r.net).reduce((a, b) => a + b, 0);

test('hand history: PokerStars-style text, cash and tournament, Hold\'em only', () => {
  const { records, skipped } = parsePokerStars(SAMPLE);
  assert.equal(records.length, 2);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /not Hold'em: .*Omaha/);
  const [cash, mtt] = records;
  // Cash: an all-in reraise with an uncalled bet back, a sitting-out seat left out, chips balance with the rake.
  assert.deepEqual(cash.players.map((p) => p.name), ['Alice', 'Bob', 'Carol']);
  assert.equal(cash.bigBlind, 0.1);
  assert.equal(cash.button, 3);
  assert.deepEqual(cash.net, { 1: -0.3, 2: 4.4, 3: -4.5 });
  assert.ok(Math.abs(total(cash) + cash.rake) < 1e-9, `${total(cash)} + ${cash.rake}`);
  assert.deepEqual(cash.actions.map((a) => `${a.seat} ${a.action} ${a.to ?? a.amount ?? ''}`.trim()), [
    '1 small blind 0.05', '2 big blind 0.1', '3 raise 0.3', '1 call 0.25', '2 raise 4.5', '3 raise 12.25', '1 fold',
  ]);
  assert.deepEqual(cash.board, ['2c', '7d', '9h', 'Ts', '3c']);
  assert.deepEqual(cash.shown, [{ seat: 2, cards: ['Qh', 'Qc'] }, { seat: 3, cards: ['As', 'Kd'] }]);
  // Tournament: antes, chips; a hand mucked at showdown but listed in the summary counts as shown.
  assert.deepEqual(mtt.net, { 1: -545, 2: -35, 3: 580 });
  assert.equal(total(mtt), 0);
  assert.equal(mtt.actions.filter((a) => a.action === 'ante').length, 3);
  assert.deepEqual(mtt.shown.map((x) => x.seat).sort(), [1, 3]);
  const bets = mtt.actions.filter((a) => a.action === 'bet').map((a) => `${a.street} ${a.to}`);
  assert.deepEqual(bets, ['flop 60', 'turn 150', 'river 300']);
});

test('hand history: profiles learn from records as from a seat, including what bets turned out to be', () => {
  const p = new Profiles();
  for (const r of parse(SAMPLE).records) p.addRecord(r);
  const carol = p.stats('Carol');
  assert.equal(carol.hands, 2);
  assert.equal(carol.vpip, 50); // raised the cash hand; the tournament hand was a free check in the big blind
  assert.equal(carol.pfr, 50);
  // Carol's three tournament bets with 7c 6c: no pair on the flop (a gutshot draw), then a straight on the turn and river.
  assert.equal(carol.betsShown, 3);
  assert.equal(carol.weakBetsShown, 33);
  assert.equal(p.stats('Alice').foldToBet, 0);
  assert.equal(p.stats('Dave').hands, 0, 'sitting out is not playing');
});

test('hand history: a hand at our tables round-trips through a record, and JSON lines read back', () => {
  const direct = new Profiles();
  const viaRecord = new Profiles();
  const lines = [];
  for (let h = 0; h < 40; h++) {
    const t = new PokerTable({ seed: `hist-${h}`, smallBlind: 5, bigBlind: 10, seats: 3 });
    ['calling-station', 'maniac', 'default'].forEach((s, i) => t.sit({ id: s, name: s, kind: 'bot' }, 1000, i));
    t.startHand();
    const rng = rngFor(`hist-${h}`);
    while (t.inPlay) { const s = t.toAct; const d = POLICIES[t.seats[s].player.name].decide(t.view(s), rng); t.act(s, d.action, d.amount); }
    const names = t.seats.map((s) => s.player.name);
    direct.addHand(names, t.log, t.lastHand);
    const r = fromTable({ ...t.view(null), id: 'p9' });
    assert.equal(total(r), 0);
    const back = toProfileInput(r);
    assert.deepEqual(back.lastHand.net, t.lastHand.net);
    lines.push(JSON.stringify(r));
  }
  for (const r of parseJsonLines(lines.join('\n')).records) viaRecord.addRecord(r);
  for (const n of ['calling-station', 'maniac', 'default']) {
    const a = direct.stats(n);
    const b = viaRecord.stats(n);
    for (const k of ['hands', 'vpip', 'pfr', 'aggression', 'foldToBet', 'showdown', 'betsShown']) assert.equal(b[k], a[k], `${n} ${k}`);
  }
  assert.equal(parse(lines.join('\n')).records.length, 40, 'parse() spots JSON lines');
  assert.equal(parseJsonLines('{"nope":1}\n').skipped.length, 1);
});
