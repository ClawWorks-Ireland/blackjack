const test = require('node:test');
const assert = require('node:assert/strict');
const { dealControlAt } = require('./report-hit.js');

const ctl = (id, left, top, right, bottom, extra) => ({ id, rect: { left, top, right, bottom }, enabled: true, visible: true, ...extra });

test('dealControlAt returns deal for a point inside it', () => {
  const c = [ctl('deal', 10, 10, 50, 30), ctl('rebet-1', 60, 10, 100, 30)];
  assert.equal(dealControlAt(30, 20, c).id, 'deal');
  assert.equal(dealControlAt(80, 20, c).id, 'rebet-1');
});

test('dealControlAt returns null outside every control', () => {
  assert.equal(dealControlAt(5, 5, [ctl('deal', 10, 10, 50, 30)]), null);
  assert.equal(dealControlAt(5, 5, []), null);
});

test('dealControlAt skips a disabled or hidden control', () => {
  const c = [ctl('deal', 0, 0, 50, 50, { enabled: false }), ctl('rebet-1', 0, 0, 50, 50, { visible: false })];
  assert.equal(dealControlAt(10, 10, c), null);
});

test('dealControlAt counts edges as inside', () => {
  const c = [ctl('deal', 10, 10, 50, 30)];
  for (const [x, y] of [[10, 10], [50, 30], [10, 30], [50, 10]]) assert.equal(dealControlAt(x, y, c).id, 'deal');
  assert.equal(dealControlAt(51, 20, c), null);
});

test('dealControlAt: first match wins when rects overlap (deal before rebet)', () => {
  const c = [ctl('deal', 0, 0, 50, 50), ctl('rebet-1', 0, 0, 50, 50)];
  assert.equal(dealControlAt(10, 10, c).id, 'deal');
});
