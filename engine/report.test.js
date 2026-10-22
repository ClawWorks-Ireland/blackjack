const test = require('node:test');
const assert = require('node:assert/strict');
const BJ = require('./blackjack.js');
const K = require('./counting.js');
const S = require('./strategy.js');
const R = require('./rules.js');
const Rep = require('./report.js');
const { seededRng } = require('./bankroll.js');

const UNIT = 10;

/**
 * Play one shoe to the cut card with a scripted player. `betFor(tc)` picks
 * the bet; with `perfect` the player takes every count play, otherwise
 * basic strategy only.
 */
function playShoe(seed, { betFor, perfect = true }) {
  const game = new BJ.Game({ bankroll: 1e9, rng: seededRng(seed) });
  const shoe = Rep.newShoe();
  do {
    const tc = K.countState(game).trueCount;
    const suggested = K.suggestedBet(tc, { min: 1, unit: UNIT });
    const bet = betFor(suggested);
    Rep.recordBet(shoe, { bet, suggested, unit: UNIT, tc });
    game.deal(bet);
    while (game.phase === 'insurance' || game.phase === 'player') {
      const spot = Rep.countSpot(game);
      let move;
      if (game.phase === 'insurance') move = spot && perfect ? 'insurance' : 'no-insurance';
      else if (spot && perfect) move = spot.play;
      else {
        const allowed = { canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender(), canHit: game.canHit() };
        move = S.recommend(game.currentHand.cards, game.dealer[0], allowed, game.rules).action;
      }
      if (spot) Rep.recordSpot(shoe, { ...spot, move });
      if (move === 'insurance') game.takeInsurance();
      else if (move === 'no-insurance') game.declineInsurance();
      else game[move]();
    }
    Rep.recordResult(shoe, { net: game.net, evLost: 0 });
  } while (!game.cutCardReached);
  shoe.endRunning = K.countState(game).running;
  return shoe;
}

const HOUSE = R.houseEdge(R.DEFAULT_RULES);

test('F18: following the ramp and every index exactly grades perfect', () => {
  let tested = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const shoe = playShoe(seed, { betFor: (s) => s });
    const g = Rep.grade(shoe, { houseEdge: HOUSE });
    if (new Set(shoe.rounds.map((r) => r.suggested)).size < 2) continue; // the count never moved the bet
    tested++;
    assert.ok(Math.abs(g.r - 1) < 1e-12, `r = ${g.r}`);
    assert.equal(g.within, 1);
    assert.ok(g.spots > 0, 'index spots came up');
    assert.equal(g.taken, g.spots);
    assert.deepEqual(g.missed, []);
    assert.ok(Math.abs(g.skillGap) < 1e-9, `skill gap ${g.skillGap}`);
    assert.ok(Math.abs(g.luck - (g.net - g.expected)) < 1e-9);
    assert.ok(g.rounds > 30);
  }
  assert.ok(tested >= 3, `${tested} shoes had a changing ramp`);
});

test('F18: flat betting has no correlation to measure, and costs skill when the count rises', () => {
  const shoe = playShoe(2, { betFor: () => UNIT, perfect: false });
  const g = Rep.grade(shoe, { houseEdge: HOUSE });
  assert.equal(g.r, null);
  assert.match(g.betNote, /Flat betting: your bet never changed/);
  assert.ok(g.within < 1 || g.skillGap === 0);
  if (shoe.rounds.some((r) => r.suggested > UNIT)) assert.ok(g.skillGap > 0, 'the ramp would have expected more');
  assert.ok(g.spots > 0 && g.taken === 0, 'basic strategy skips the index plays');
  assert.equal(g.missed.length, g.spots);
  const m = g.missed[0];
  assert.ok(typeof m.hand === 'string' && Number.isInteger(m.tc) && Number.isFinite(m.index) && m.play);
});

test('F18: pearson, within-one-unit and money arithmetic', () => {
  assert.equal(Rep.pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(Rep.pearson([1, 2, 3], [6, 4, 2]), -1);
  assert.equal(Rep.pearson([5, 5, 5], [1, 2, 3]), null);
  assert.equal(Rep.pearson([1], [1]), null);
  const shoe = Rep.newShoe();
  Rep.recordBet(shoe, { bet: 10, suggested: 10, unit: 10, tc: 0 });
  Rep.recordResult(shoe, { net: 10, evLost: 0.5 });
  Rep.recordBet(shoe, { bet: 10, suggested: 40, unit: 10, tc: 3 });
  Rep.recordResult(shoe, { net: -10 });
  Rep.recordCheck(shoe, true);
  Rep.recordCheck(shoe, false);
  shoe.endRunning = 4;
  shoe.endGuess = 2;
  const g = Rep.grade(shoe, { houseEdge: 0.5 });
  assert.equal(g.within, 0.5);
  assert.deepEqual([g.checks, g.checksRight, g.endError], [2, 1, -2]);
  // expected = 10*(-0.005) - 0.5 + 10*(-0.005 + 0.015); perfect = 10*(-0.005) + 40*0.01
  assert.ok(Math.abs(g.expected - (-0.05 - 0.5 + 0.1)) < 1e-12);
  assert.ok(Math.abs(g.perfect - (-0.05 + 0.4)) < 1e-12);
  assert.ok(Math.abs(g.skillGap - 0.8) < 1e-12);
  assert.equal(g.net, 0);
});

test('F18: shoe reports keep the last 20 and export as CSV', () => {
  const shoe = playShoe(3, { betFor: () => UNIT, perfect: false });
  let reports = [];
  for (let i = 0; i < 25; i++) reports = Rep.addReport(reports, Rep.summary(shoe, { houseEdge: HOUSE }, Date.UTC(2026, 0, 1, 0, i)));
  assert.equal(reports.length, 20);
  assert.deepEqual(Rep.parseReports(JSON.stringify(reports)), reports);
  assert.deepEqual(Rep.parseReports('nope'), []);
  const csv = Rep.reportsCSV(reports, (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines[0], Rep.REPORT_COLUMNS.join(','));
  assert.match(lines[1], /^2026-01-01T00:05:00.000Z,/, 'oldest kept report first');
});

test('B15: an index play is correct even when the coach, with the count hidden, says basic strategy', () => {
  let deviations = 0;
  for (let seed = 1; seed <= 40 && deviations < 5; seed++) {
    const game = new BJ.Game({ bankroll: 1e9, rng: seededRng(seed) });
    do {
      game.deal(UNIT);
      while (game.phase === 'insurance' || game.phase === 'player') {
        const spot = Rep.countSpot(game);
        let basic;
        if (game.phase === 'insurance') basic = S.insuranceAdvice(game.evenMoneyOffered);
        else {
          const allowed = { canDouble: game.canDouble(), canSplit: game.canSplit(), canSurrender: game.canSurrender(), canHit: game.canHit() };
          basic = S.recommend(game.currentHand.cards, game.dealer[0], allowed, game.rules);
        }
        const move = spot ? spot.play : basic.action;
        if (move !== basic.action) deviations++;
        assert.ok(Rep.moveCorrect(basic, spot, move), `${move} at ${spot && spot.hand} v ${spot && spot.up}`);
        if (move === 'insurance') game.takeInsurance();
        else if (move === 'no-insurance') game.declineInsurance();
        else game[move]();
      }
    } while (!game.cutCardReached);
  }
  assert.ok(deviations > 0, 'some index play differed from basic strategy');
});

test('B15: a move that is neither the advice nor the index play is still a mistake', () => {
  const advice = { action: 'hit' };
  assert.equal(Rep.moveCorrect(advice, null, 'hit'), true);
  assert.equal(Rep.moveCorrect(advice, null, 'stand'), false);
  assert.equal(Rep.moveCorrect(advice, { play: 'stand' }, 'stand'), true);
  assert.equal(Rep.moveCorrect(advice, { play: 'stand' }, 'double'), false);
  assert.equal(Rep.moveCorrect(null, null, 'hit'), false);
});
