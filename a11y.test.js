const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('./a11y.js');

const c = (rank, suit) => ({ rank, suit });

test('cards are named in words', () => {
  assert.equal(A.cardName(c('K', '♣')), 'king of clubs');
  assert.equal(A.cardName(c('A', '♥')), 'ace of hearts');
  assert.equal(A.cardName(c('10', '♦')), '10 of diamonds');
  assert.equal(A.cardName(null), 'a face-down card');
});

test('a deal is announced card by card in table order', () => {
  const text = A.dealAnnouncement([
    { who: 'You', card: c('8', '♠'), kind: 'dealt' },
    { who: 'Dealer', card: c('4', '♥'), kind: 'dealt' },
    { who: 'You', card: c('9', '♣'), kind: 'dealt' },
    { who: 'Dealer', card: null, kind: 'dealt' },
  ]);
  assert.equal(text, 'You: 8 of spades. Dealer: 4 of hearts. You: 9 of clubs. Dealer: a face-down card.');
  assert.equal(A.dealAnnouncement([{ who: 'Dealer', card: c('K', '♦'), kind: 'flip' }]),
    'Dealer turns over king of diamonds.');
  assert.equal(A.dealAnnouncement([]), '');
});

test('contrast ratio matches WCAG reference values', () => {
  assert.equal(Math.round(A.contrastRatio('#000000', '#ffffff') * 10) / 10, 21);
  assert.equal(A.contrastRatio('#777777', '#777777'), 1);
});

test('F10: disabled buttons have at least 3:1 contrast', () => {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const v = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(m, `--${name} is defined`);
    return m[1];
  };
  const bg = v('disabled-bg');
  const fg = v('disabled-fg');
  const border = v('disabled-border');
  // Label against the button, and the button's edge against the felt (both ends of the gradient).
  assert.ok(A.contrastRatio(fg, bg) >= 3, 'text on a disabled button');
  for (const felt of [v('felt'), v('felt-dark')]) {
    assert.ok(A.contrastRatio(border, felt) >= 3, `disabled button border on ${felt}`);
  }
  assert.match(css, /button:disabled[^{]*\{[^}]*var\(--disabled-bg\)/, 'disabled rule uses the tokens');
  assert.doesNotMatch(css, /button:disabled\s*\{[^}]*opacity:\s*0\.[0-5]/, 'no low-opacity fade');
});
