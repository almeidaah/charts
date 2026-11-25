import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicks, firstChange } from '../public/ticks.js';

test('price change: only the digits from the first difference on', () => {
  assert.equal(firstChange('96.18', '96.50'), 3);
  assert.equal(firstChange('62.67', '62.66'), 4);
  assert.equal(firstChange('99.99', '100.00'), 0);
  assert.equal(firstChange('5.00', '5.00'), 4);
});

test('price change: direction, first load and expiry', () => {
  let now = 1000;
  const t = createTicks(() => now);
  assert.equal(t.update({ a: { last: 10 }, b: { error: 'x' } }), false); // first load is not a move
  assert.equal(t.get('a'), null);
  assert.equal(t.update({ a: { last: 10 } }), false);
  assert.equal(t.update({ a: { last: 11 } }), true);
  assert.deepEqual([t.get('a').up, t.get('a').from], [true, 10]);
  t.update({ a: { last: 9 } });
  assert.equal(t.get('a').up, false);
  now += t.SHOW;
  assert.equal(t.get('a'), null);
});
