const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./rules.js');

const base = R.DEFAULT_RULES;

test('default rules are the classic table', () => {
  assert.deepEqual({ ...base }, { decks: 6, h17: false, payout: 1.5, das: true, lateSurrender: true, penetration: 0.75, rsa: false, enhc: false, obo: false, doubleOn: 'any' });
});

test('house edge for the default rules includes the cut card', () => {
  assert.equal(R.houseEdge(base, { cutCard: false }), 0.33);
  assert.equal(R.houseEdge(base), 0.36);
  assert.equal(R.edgeText(base), 'House edge 0.36%');
});

test('the cut card costs most with few decks (matches the simulation)', () => {
  const cost = (decks) => R.houseEdge({ ...base, decks }) - R.houseEdge({ ...base, decks }, { cutCard: false });
  assert.ok(Math.abs(cost(1) - 0.13) < 0.005);
  assert.ok(Math.abs(cost(2) - 0.07) < 0.005);
  assert.ok(Math.abs(cost(6) - 0.03) < 0.005);
  assert.ok(cost(1) > cost(2) && cost(2) > cost(8));
});

test('house edge matches the published figures with no surrender', () => {
  const noLS = { ...base, lateSurrender: false };
  const fresh = { cutCard: false };
  assert.equal(R.houseEdge({ ...noLS, decks: 8, h17: true }, fresh), 0.65);
  assert.equal(R.houseEdge({ ...noLS, decks: 2, das: false }, fresh), 0.34);
  assert.equal(R.houseEdge({ ...noLS, decks: 1, h17: true, das: false }, fresh), 0.19);
});

test('each worse rule raises the house edge', () => {
  const e = R.houseEdge(base);
  assert.ok(R.houseEdge({ ...base, h17: true }) > e);
  assert.ok(R.houseEdge({ ...base, das: false }) > e);
  assert.ok(R.houseEdge({ ...base, lateSurrender: false }) > e);
  assert.ok(R.houseEdge({ ...base, decks: 8 }) > e);
  assert.ok(R.houseEdge({ ...base, decks: 2 }) < e);
  assert.ok(R.houseEdge({ ...base, payout: 1.2 }) - e > 1.3);
});

test('single deck S17 with DAS still favours the player, barely, with the cut card', () => {
  assert.equal(R.edgeText({ ...base, decks: 1 }), 'Player edge 0.03%');
  assert.equal(R.houseEdge({ ...base, decks: 1 }, { cutCard: false }), -0.16);
});

test('saved settings are validated field by field', () => {
  assert.deepEqual(R.normalizeRules(null), { ...base });
  assert.deepEqual(R.normalizeRules({ decks: 4, payout: 2, h17: 'yes' }), { ...base });
  assert.deepEqual(R.normalizeRules({ decks: 2, h17: true, payout: 1.2, das: false, lateSurrender: false, penetration: 0.6 }),
    { decks: 2, h17: true, payout: 1.2, das: false, lateSurrender: false, penetration: 0.6, rsa: false, enhc: false, obo: false, doubleOn: 'any' });
});

test('sameRules compares every setting', () => {
  assert.ok(R.sameRules(base, { ...base }));
  assert.ok(!R.sameRules(base, { ...base, das: false }));
});

test('describe spells out the rules and the edge', () => {
  const [one, two] = R.describe({ decks: 1, h17: true, payout: 1.2, das: false, lateSurrender: false });
  assert.match(one, /Single deck · Dealer hits soft 17 · Blackjack pays 6:5 · .*not after a split/);
  assert.match(two, /No surrender · House edge 1\.71%/);
});

test('F9: payout rows follow the rules', () => {
  const rows = Object.fromEntries(R.payoutRows(base));
  assert.equal(rows.Blackjack, '3:2');
  assert.equal(rows['Late surrender'], 'Half your bet back');
  assert.ok('Even money (your blackjack vs an ace, one spot)' in rows);
  const six5 = Object.fromEntries(R.payoutRows({ ...base, payout: 1.2, lateSurrender: false, das: false }));
  assert.equal(six5.Blackjack, '6:5');
  assert.equal(six5['Late surrender'], 'Not offered');
  assert.equal(six5['Double down'], 'Any two cards, not after a split');
  assert.ok(!Object.keys(six5).some((k) => k.startsWith('Even money')));
});

test('F15: penetration is a rule from 50% to 85%, in 5% steps', () => {
  assert.equal(R.normalizeRules({ penetration: 0.5 }).penetration, 0.5);
  assert.equal(R.normalizeRules({ penetration: 0.83 }).penetration, 0.85);
  assert.equal(R.normalizeRules({ penetration: 0.9 }).penetration, 0.75);
  assert.equal(R.normalizeRules({ penetration: 0.2 }).penetration, 0.75);
  assert.ok(!R.sameRules(base, { ...base, penetration: 0.6 }));
  assert.match(R.describe({ ...base, penetration: 0.6 })[0], /Cut card at 60%/);
});

// --- F17: rule variants ---

test('F17: new rules are validated; OBO needs ENHC', () => {
  assert.deepEqual(
    [R.normalizeRules({ rsa: true }).rsa, R.normalizeRules({ enhc: true, obo: true }).obo, R.normalizeRules({ obo: true }).obo],
    [true, true, false]);
  assert.equal(R.normalizeRules({ doubleOn: '9-11' }).doubleOn, '9-11');
  assert.equal(R.normalizeRules({ doubleOn: '8-11' }).doubleOn, 'any');
  assert.equal(R.normalizeRules({ rsa: 'yes' }).rsa, false);
  assert.ok(!R.sameRules(base, { ...base, enhc: true }));
  assert.ok(!R.sameRules(base, { ...base, doubleOn: '10-11' }));
});

test('F17: the house edge moves the right way for each rule, at every deck count', () => {
  for (const decks of R.DECKS) {
    for (const h17 of [false, true]) {
      const r = { ...base, decks, h17 };
      const e = R.houseEdge(r, { cutCard: false });
      const at = (x) => R.houseEdge({ ...r, ...x }, { cutCard: false });
      assert.ok(at({ rsa: true }) < e, `${decks}D RSA lowers the edge`);
      assert.ok(at({ enhc: true }) > e, `${decks}D ENHC raises it`);
      assert.equal(at({ enhc: true, obo: true }), e, 'OBO plays like the peek game');
      assert.ok(at({ doubleOn: '9-11' }) > e, `${decks}D 9-11 raises it`);
      assert.ok(at({ doubleOn: '10-11' }) > at({ doubleOn: '9-11' }), `${decks}D 10-11 raises it more`);
    }
  }
  // Sizes line up with published rule-variation tables (6 decks).
  const six = R.houseEdge(base, { cutCard: false });
  const d = (x) => Math.round((R.houseEdge({ ...base, ...x }, { cutCard: false }) - six) * 100) / 100;
  assert.equal(d({ enhc: true }), 0.11);
  assert.equal(d({ doubleOn: '10-11' }), 0.19);
  assert.equal(d({ doubleOn: '9-11' }), 0.1);
  assert.equal(d({ rsa: true }), -0.06);
});

test('F17: the rules line and payouts describe the variants', () => {
  const [one, two] = R.describe({ ...base, rsa: true, enhc: true, doubleOn: '10-11' });
  assert.match(one, /Double on hard 10 or 11, also after a split/);
  assert.match(one, /Split pairs up to 4 hands, aces too/);
  assert.match(two, /No hole card: a dealer blackjack takes doubles and splits too/);
  assert.match(R.describe({ ...base, enhc: true, obo: true })[1], /original bet \(OBO\)/);
  assert.match(R.describe(base)[0], /Double on any two cards, also after a split/);
  const rows = Object.fromEntries(R.payoutRows({ ...base, doubleOn: '9-11', enhc: true }));
  assert.equal(rows['Double down'], 'Hard 9, 10 or 11, also after a split');
  assert.equal(rows['Dealer blackjack (no hole card)'], 'You lose doubles and splits too');
});
