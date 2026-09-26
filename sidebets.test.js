const test = require('node:test');
const assert = require('node:assert/strict');
const SB = require('./sidebets.js');

const c = (rank, suit) => ({ rank, suit });

test('Perfect Pairs hands', () => {
  assert.equal(SB.pairsHand([c('8', '♠'), c('8', '♠')]), 'perfect pair');
  assert.equal(SB.pairsHand([c('8', '♥'), c('8', '♦')]), 'colored pair');
  assert.equal(SB.pairsHand([c('8', '♠'), c('8', '♣')]), 'colored pair');
  assert.equal(SB.pairsHand([c('8', '♠'), c('8', '♥')]), 'mixed pair');
  assert.equal(SB.pairsHand([c('K', '♠'), c('Q', '♠')]), null); // tens of different rank
});

test('21+3 hands', () => {
  assert.equal(SB.t213Hand([c('7', '♥'), c('7', '♥'), c('7', '♥')]), 'suited trips');
  assert.equal(SB.t213Hand([c('9', '♣'), c('10', '♣'), c('J', '♣')]), 'straight flush');
  assert.equal(SB.t213Hand([c('7', '♥'), c('7', '♠'), c('7', '♦')]), 'three of a kind');
  assert.equal(SB.t213Hand([c('A', '♥'), c('2', '♠'), c('3', '♦')]), 'straight');
  assert.equal(SB.t213Hand([c('Q', '♥'), c('K', '♠'), c('A', '♦')]), 'straight');
  assert.equal(SB.t213Hand([c('K', '♥'), c('A', '♠'), c('2', '♦')]), null); // no wrap-around
  assert.equal(SB.t213Hand([c('2', '♦'), c('9', '♦'), c('K', '♦')]), 'flush');
  assert.equal(SB.t213Hand([c('2', '♦'), c('9', '♠'), c('K', '♦')]), null);
});

test('settleSide pays odds on a win and loses the stake otherwise', () => {
  assert.deepEqual(SB.settleSide('pairs', 5, [c('8', '♥'), c('8', '♦')]),
    { bet: 'pairs', stake: 5, win: 'colored pair', odds: 12, net: 60 });
  assert.deepEqual(SB.settleSide('t213', 5, [c('2', '♦'), c('9', '♠'), c('K', '♦')]),
    { bet: 't213', stake: 5, win: null, odds: 0, net: -5 });
});

test('house edge: exact enumeration for a fresh shoe', () => {
  // Perfect Pairs 25/12/6: 4.10% at 8 decks, 6.11% at 6 (the published figures).
  assert.equal(SB.houseEdge('pairs', 8), 4.1);
  assert.equal(SB.houseEdge('pairs', 6), 6.11);
  // 21+3 5/10/30/40/100; cross-checked by a 3M-hand Monte Carlo within 2 SE.
  assert.equal(SB.houseEdge('t213', 8), 3.7);
  assert.equal(SB.houseEdge('t213', 6), 4.62);
});

test('fewer decks change the side-bet edge', () => {
  // Single deck: no perfect pairs or suited trips are possible.
  assert.notEqual(SB.houseEdge('pairs', 1), SB.houseEdge('pairs', 6));
  assert.notEqual(SB.houseEdge('t213', 1), SB.houseEdge('t213', 8));
});
