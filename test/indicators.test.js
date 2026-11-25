import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, withDefaults, DEFAULTS } from '../public/indicators.js';
import { positionStats, parseLevels, segDist } from '../public/drawings.js';
import { openDb } from '../server/db.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('simple moving average, including gaps', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(sma([null, null, 2, 4, 6], 2), [null, null, null, 3, 5]);
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test('exponential moving average is seeded with the simple one', () => {
  const r = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(r.slice(0, 2), [null, null]);
  [2, 3, 4].forEach((v, i) => close(r[i + 2], v));
});

test('RSI: limits and a known value', () => {
  assert.equal(rsi([1, 2, 3, 4], 2).at(-1), 100);
  assert.equal(rsi([4, 3, 2, 1], 2).at(-1), 0);
  assert.equal(rsi([5, 5, 5, 5], 2).at(-1), 50);
  // 10, 11, 10, 12 with length 2: gain 0.5 -> 1.25; loss 0.5 -> 0.25 => 83.33
  close(rsi([10, 11, 10, 12], 2).at(-1), 100 - 100 / 6);
  assert.equal(rsi([1, 2], 14).every(v => v === null), true);
});

test('invalid saved settings fall back to defaults', () => {
  assert.deepEqual(withDefaults(null), DEFAULTS);
  const c = withDefaults({ ma: { lines: [{ n: -3, type: 'x', color: 'red' }, { n: 21 }] }, rsi: { frac: 9 } });
  assert.equal(c.ma.lines[0].n, 8);
  assert.equal(c.ma.lines[1].n, 21);
  assert.equal(c.rsi.frac, DEFAULTS.rsi.frac);
});

test('positions: risk/reward for long and short', () => {
  assert.equal(positionStats(100, 120, 90).rr, 2);
  assert.equal(positionStats(100, 80, 110).rr, 2);
  assert.equal(positionStats(100, 120, 100).rr, null);
});

test('Fibonacci levels accept comma and dot', () => {
  assert.deepEqual(parseLevels('1 0,618 0.5'), [0.5, 0.618, 1]);
  assert.equal(parseLevels('abc'), null);
  assert.equal(parseLevels(''), null);
});

test('distance to a segment', () => {
  assert.equal(segDist({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(segDist({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});

test('drawings in the database: save, change, delete, and no leaks between symbols', () => {
  const db = openDb(':memory:');
  for (const id of ['yahoo:A', 'yahoo:B']) db.saveInstrument({ id, source: 'yahoo', symbol: id, label: id });
  const d = { uid: 'abcdef1', tool: 'trend', pts: [{ t: 1, p: 2 }] };
  db.changeDrawings('yahoo:A', [d], []);
  db.changeDrawings('yahoo:A', [{ ...d, color: '#fff' }], []);
  assert.deepEqual(db.drawings('yahoo:A'), [{ ...d, color: '#fff' }]);
  db.changeDrawings('yahoo:B', [{ ...d, color: '#000' }], ['abcdef1']); // another symbol cannot touch it
  assert.equal(db.drawings('yahoo:A')[0].color, '#fff');
  assert.deepEqual(db.drawings('yahoo:B'), []);
  db.changeDrawings('yahoo:A', [], ['abcdef1']);
  assert.deepEqual(db.drawings('yahoo:A'), []);
});
