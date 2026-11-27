/**
 * Casino Advisor — Card Engine Tests
 * Uses Node.js built-in test runner (node:test, node:assert).
 * Run: node --test tests/card-engine.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCard,
  handTotal,
  HiLoCounter,
  basicStrategy,
  betSizing,
} from '../src/shared/card-engine.js';

// ---------------------------------------------------------------------------
// parseCard
// ---------------------------------------------------------------------------

describe('parseCard', () => {
  it('parses a valid card', () => {
    const card = parseCard('6D');
    assert.deepEqual(card, { rank: '6', suit: 'D', bjValue: 6, countValue: 1 });
  });

  it('parses face cards correctly', () => {
    assert.equal(parseCard('JC').bjValue, 10);
    assert.equal(parseCard('QH').bjValue, 10);
    assert.equal(parseCard('KS').bjValue, 10);
    assert.equal(parseCard('TS').bjValue, 10);
  });

  it('parses Ace correctly', () => {
    const ace = parseCard('AD');
    assert.equal(ace.bjValue, 11);
    assert.equal(ace.countValue, -1);
  });

  it('Hi-Lo count values', () => {
    assert.equal(parseCard('2H').countValue, 1);
    assert.equal(parseCard('6S').countValue, 1);
    assert.equal(parseCard('7D').countValue, 0);
    assert.equal(parseCard('9C').countValue, 0);
    assert.equal(parseCard('TC').countValue, -1);
    assert.equal(parseCard('AC').countValue, -1);
  });

  it('returns null for invalid input', () => {
    assert.equal(parseCard('XX'), null);
    assert.equal(parseCard('1H'), null);
    assert.equal(parseCard(''), null);
    assert.equal(parseCard('A'), null);
    assert.equal(parseCard('AHH'), null);
    assert.equal(parseCard(null), null);
    assert.equal(parseCard(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// handTotal
// ---------------------------------------------------------------------------

describe('handTotal', () => {
  it('simple hard hand', () => {
    const { total, soft, bust } = handTotal(['6D', '7S']);
    assert.equal(total, 13);
    assert.equal(soft, false);
    assert.equal(bust, false);
  });

  it('blackjack — Ace + King', () => {
    const { total, soft, bust } = handTotal(['AC', 'KH']);
    assert.equal(total, 21);
    assert.equal(soft, true);
    assert.equal(bust, false);
  });

  it('soft 17 — Ace + 6', () => {
    const { total, soft } = handTotal(['AS', '6D']);
    assert.equal(total, 17);
    assert.equal(soft, true);
  });

  it('Ace converts to 1 when needed — Ace + 7 + 8 = 16 hard', () => {
    const { total, soft, bust } = handTotal(['AH', '7C', '8D']);
    assert.equal(total, 16);
    assert.equal(soft, false);
    assert.equal(bust, false);
  });

  it('bust — three high cards', () => {
    const { total, bust } = handTotal(['KH', 'QD', '7C']);
    assert.equal(total, 27);
    assert.equal(bust, true);
  });

  it('Ace + Ace = soft 12', () => {
    const { total, soft } = handTotal(['AC', 'AD']);
    assert.equal(total, 12);
    assert.equal(soft, true);
  });

  it('empty hand', () => {
    const { total, bust } = handTotal([]);
    assert.equal(total, 0);
    assert.equal(bust, false);
  });

  it('four-card hand with Ace — A+2+3+4 = 20 soft', () => {
    const { total, soft } = handTotal(['AH', '2S', '3D', '4C']);
    assert.equal(total, 20);
    assert.equal(soft, true);
  });
});

// ---------------------------------------------------------------------------
// HiLoCounter
// ---------------------------------------------------------------------------

describe('HiLoCounter', () => {
  it('initial state', () => {
    const counter = new HiLoCounter();
    assert.equal(counter.runningCount, 0);
    assert.equal(counter.cardsOut, 0);
    assert.ok(counter.decksRemaining > 0);
  });

  it('addCard updates running count', () => {
    const counter = new HiLoCounter();
    counter.addCard('5H'); // +1
    assert.equal(counter.runningCount, 1);
    counter.addCard('TC'); // -1
    assert.equal(counter.runningCount, 0);
    counter.addCard('2D'); // +1
    assert.equal(counter.runningCount, 1);
  });

  it('addCards processes multiple cards', () => {
    const counter = new HiLoCounter();
    counter.addCards(['2H', '3D', 'TC', 'KS']); // +1 +1 -1 -1 = 0
    assert.equal(counter.runningCount, 0);
    assert.equal(counter.cardsOut, 4);
  });

  it('true count calculation — RC=12 after 2 decks out of 8 → TC≈2', () => {
    const counter = new HiLoCounter();
    counter.cardsOut = 104; // 2 decks dealt
    counter.runningCount = 12;
    // decksRemaining = (8*52 - 104) / 52 = 312/52 = 6
    // trueCount = 12 / 6 = 2
    assert.ok(Math.abs(counter.trueCount - 2.0) < 0.5, `Expected ~2, got ${counter.trueCount}`);
  });

  it('shuffle detection resets count', () => {
    const counter = new HiLoCounter();
    counter.runningCount = 10;
    counter.cardsOut = 200;
    counter.syncShoeCardsOut(5); // drop → shuffle
    assert.equal(counter.runningCount, 0);
    assert.equal(counter.cardsOut, 5);
  });

  it('syncShoeCardsOut normal advance preserves running count', () => {
    const counter = new HiLoCounter();
    counter.syncShoeCardsOut(50);
    assert.equal(counter.cardsOut, 50);
    counter.runningCount = 5;
    counter.syncShoeCardsOut(60);
    assert.equal(counter.runningCount, 5); // not reset
  });

  it('penetration at half shoe', () => {
    const counter = new HiLoCounter();
    counter.cardsOut = 208; // 208/416 = 0.5
    assert.ok(Math.abs(counter.penetration - 0.5) < 0.01, `Expected 0.5, got ${counter.penetration}`);
  });

  it('toJSON includes all fields', () => {
    const counter = new HiLoCounter();
    counter.runningCount = 3;
    counter.cardsOut = 52;
    const json = counter.toJSON();
    assert.ok('runningCount' in json);
    assert.ok('trueCount' in json);
    assert.ok('cardsOut' in json);
    assert.ok('decksRemaining' in json);
    assert.ok('penetration' in json);
    assert.equal(json.runningCount, 3);
    assert.equal(json.cardsOut, 52);
  });
});

// ---------------------------------------------------------------------------
// basicStrategy
// ---------------------------------------------------------------------------

describe('basicStrategy', () => {
  it('hard 16 vs dealer 10 → Hit', () => {
    assert.equal(basicStrategy(['9H', '7D'], 'TC').action, 'H');
  });

  it('hard 16 vs dealer 6 → Stand', () => {
    assert.equal(basicStrategy(['9H', '7D'], '6C').action, 'S');
  });

  it('hard 11 vs dealer 6 → Double', () => {
    assert.equal(basicStrategy(['7H', '4D'], '6C').action, 'D');
  });

  it('hard 11 vs dealer Ace → Hit (8-deck)', () => {
    assert.equal(basicStrategy(['7H', '4D'], 'AH').action, 'H');
  });

  it('hard 17+ always stands', () => {
    assert.equal(basicStrategy(['KH', '7D'], '6C').action, 'S');
    assert.equal(basicStrategy(['KH', '7D'], 'AC').action, 'S');
  });

  it('hard 8 or less always hits', () => {
    assert.equal(basicStrategy(['3H', '4D'], '6C').action, 'H');
    assert.equal(basicStrategy(['2H', '3D'], '7C').action, 'H');
  });

  it('soft 17 (A+6) vs dealer 2 → Hit', () => {
    assert.equal(basicStrategy(['AH', '6D'], '2C').action, 'H');
  });

  it('soft 18 (A+7) vs dealer 6 → Double', () => {
    assert.equal(basicStrategy(['AH', '7D'], '6C').action, 'D');
  });

  it('soft 18 (A+7) vs dealer 2 → Stand', () => {
    assert.equal(basicStrategy(['AH', '7D'], '2C').action, 'S');
  });

  it('pair of Aces → Split', () => {
    assert.equal(basicStrategy(['AC', 'AH'], '7D').action, 'SP');
  });

  it('pair of 8s → Split', () => {
    assert.equal(basicStrategy(['8C', '8H'], 'TC').action, 'SP');
  });

  it('pair of 10s → Stand', () => {
    assert.equal(basicStrategy(['TC', 'TH'], '6D').action, 'S');
  });

  it('natural 21 → Stand with blackjack reason', () => {
    const result = basicStrategy(['AC', 'KH'], '7D');
    assert.equal(result.action, 'S');
    assert.match(result.reason, /blackjack/i);
  });

  it('bust → Stand', () => {
    const result = basicStrategy(['KH', 'QD', '7C'], '6C');
    assert.equal(result.action, 'S');
    assert.match(result.reason, /bust/i);
  });

  it('unknown dealer upcard → defaults to Hit', () => {
    assert.equal(basicStrategy(['8H', '7D'], 'XX').action, 'H');
  });

  it('result includes action, label, reason', () => {
    const result = basicStrategy(['7H', '9D'], '6C');
    assert.ok(result.action);
    assert.ok(result.label);
    assert.ok(result.reason);
  });
});

// ---------------------------------------------------------------------------
// betSizing
// ---------------------------------------------------------------------------

describe('betSizing', () => {
  it('TC ≤ 1 → 1× min bet', () => {
    assert.equal(betSizing(0).multiplier, 1);
    assert.equal(betSizing(-5).multiplier, 1);
    assert.equal(betSizing(1).multiplier, 1);
  });

  it('TC 2 → 2×', () => {
    assert.equal(betSizing(2).multiplier, 2);
  });

  it('TC 3 → 3×', () => {
    assert.equal(betSizing(3).multiplier, 3);
  });

  it('TC 4 → 4×', () => {
    assert.equal(betSizing(4).multiplier, 4);
  });

  it('TC ≥ 5 → 5× max', () => {
    assert.equal(betSizing(5).multiplier, 5);
    assert.equal(betSizing(10).multiplier, 5);
  });

  it('returns label string', () => {
    assert.equal(typeof betSizing(2).label, 'string');
    assert.ok(betSizing(2).label.length > 0);
  });
});
