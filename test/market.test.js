import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, weekStart, monthStart, localDay } from '../server/timeframes.js';
import { normalize, parseQuote } from '../server/providers/yahoo.js';
import { splitRatio, createMarket } from '../server/market.js';
import { openDb } from '../server/db.js';

const ts = s => Date.parse(s) / 1000;
const bar = (t, o, h, l, c, v = 1) => ({ t, o, h, l, c, v });
const stock = { id: 'yahoo:X', source: 'yahoo', symbol: 'X', label: 'X', type: 'EQUITY', tz: 'America/New_York' };
const crypto = { ...stock, type: 'CRYPTOCURRENCY', tz: 'UTC' };

test('weeks start on Monday and months on day 1', () => {
  assert.equal(weekStart(ts('2026-11-25T00:00:00Z')), ts('2026-11-23T00:00:00Z'));
  assert.equal(weekStart(ts('2026-11-23T00:00:00Z')), ts('2026-11-23T00:00:00Z'));
  assert.equal(weekStart(ts('2026-11-22T00:00:00Z')), ts('2026-11-16T00:00:00Z'));
  assert.equal(weekStart(ts('1962-01-03T00:00:00Z')), ts('1962-01-01T00:00:00Z'));
  assert.equal(monthStart(ts('2026-11-25T00:00:00Z')), ts('2026-11-01T00:00:00Z'));
});

test('aggregates daily bars into weekly bars', () => {
  const rows = [
    bar(ts('2026-11-19'), 1, 5, 1, 2), bar(ts('2026-11-20'), 2, 3, 0.5, 3),
    bar(ts('2026-11-23'), 3, 4, 3, 4), bar(ts('2026-11-24'), 4, 9, 2, 8),
  ];
  assert.deepEqual(aggregate(rows, '1w', stock), [
    bar(ts('2026-11-16'), 1, 5, 0.5, 3, 2), bar(ts('2026-11-23'), 3, 9, 2, 8, 2),
  ]);
});

test('3h: stocks count from the open, crypto from midnight UTC', () => {
  const t0 = ts('2026-11-24T14:30:00Z');
  const s = aggregate([0, 1, 2, 3, 4, 5, 6].map(i => bar(t0 + i * 3600, 1, 1, 1, 1)), '3h', stock);
  assert.deepEqual(s.map(r => [r.t - t0, r.v]), [[0, 3], [10800, 3], [21600, 1]]);
  const c0 = ts('2026-11-24T02:00:00Z');
  const c = aggregate([0, 1, 2].map(i => bar(c0 + i * 3600, 1, 1, 1, 1)), '3h', crypto);
  assert.deepEqual(c.map(r => r.t), [ts('2026-11-24T00:00:00Z'), ts('2026-11-24T03:00:00Z')]);
});

test('trading day follows the exchange time zone (forex during London summer time)', () => {
  assert.equal(localDay(ts('2026-07-06T23:00:00Z'), 'Europe/London'), ts('2026-07-07'));
  assert.equal(localDay(ts('2026-07-06T13:30:00Z'), 'America/New_York'), ts('2026-07-06'));
});

const yres = (timestamps, rows, meta = {}) => ({
  timestamp: timestamps, meta,
  indicators: { quote: [{ open: rows.map(r => r[0]), high: rows.map(r => r[1]), low: rows.map(r => r[2]), close: rows.map(r => r[3]), volume: rows.map(r => r[4]) }] },
});

test('yahoo: skips gaps, merges the live bar of the same day and fixes high/low', () => {
  const r = normalize(yres(
    [ts('2026-11-23T14:30:00Z'), ts('2026-11-24T14:30:00Z'), ts('2026-11-24T21:00:01Z')],
    [[null, null, null, null, null], [10, 9, 8, 11, 100], [11, 12, 11, 12, 0]]), '1d', stock);
  assert.deepEqual(r, [bar(ts('2026-11-24'), 10, 12, 8, 12, 100)]);
});

test('yahoo: the intraday close mark becomes part of the last bar', () => {
  const close = ts('2026-11-24T21:00:00Z');
  const r = normalize(yres([close - 3600, close - 1800, close],
    [[1, 2, 1, 2, 5], [2, 3, 2, 3, 5], [4, 4, 4, 4, 0]], { regularMarketTime: close + 1 }), '30m', stock);
  assert.equal(r.length, 2);
  assert.equal(r[1].c, 4);
});

test('yahoo: the live bar stays aligned even when the source skips an interval', () => {
  const t = ts('2026-11-25T09:10:00Z');
  const r = normalize(yres([t, t + 11 * 60 + 7], [[1, 2, 1, 2, 5], [2, 3, 2, 3, 0]]), '5m', crypto);
  assert.deepEqual(r.map(x => x.t), [t, t + 600]);
});

test('detects splits but not normal price moves', () => {
  const stored = [100, 101, 102, 103].map((o, i) => bar(i, o, o, o, o));
  assert.equal(splitRatio(stored, stored), 1);
  assert.equal(splitRatio(stored, stored.map(r => ({ ...r, c: r.c * 1.2 }))), 1);
  assert.ok(Math.abs(splitRatio(stored, stored.map(r => ({ ...r, o: r.o / 10 }))) - 0.1) < 1e-9);
});

test('sync: everything first, then only the tail; a split rescales older bars', async () => {
  const db = openDb(':memory:');
  db.saveInstrument(stock);
  const inst = db.instrument(stock.id);
  let data = Array.from({ length: 30 }, (_, i) => bar(i * 1800, 100 + i, 100 + i, 100 + i, 100 + i, 10));
  const calls = [];
  const market = createMarket(db, { yahoo: {
    history: async (_, __, since) => { calls.push(since); return since == null ? data : data.filter(r => r.t >= since); },
  } });
  await market.sync(inst, '30m', -1);
  assert.equal(db.candles(stock.id, '30m').length, 30);
  await market.sync(inst, '30m', -1);
  assert.deepEqual(calls, [null, 19 * 1800]);

  // 2:1 split, and the provider no longer returns the first 5 bars.
  data = data.slice(5).map(r => bar(r.t, r.o / 2, r.h / 2, r.l / 2, r.c / 2, r.v * 2));
  await market.sync(inst, '30m', -1);
  const rows = db.candles(stock.id, '30m');
  assert.equal(rows.length, 30);
  assert.deepEqual([rows[0].o, rows[0].v, rows[5].o, rows[5].v], [50, 20, 52.5, 20]);
});

test('offline: returns saved data with a warning', async () => {
  const db = openDb(':memory:');
  db.saveInstrument(stock);
  db.saveCandles(stock.id, '1d', [bar(0, 1, 1, 1, 1)]);
  const market = createMarket(db, { yahoo: { history: async () => { throw new Error('offline'); } } });
  const orig = Date.now;
  Date.now = () => orig() + 60_000;
  try {
    const r = await market.candles(db.instrument(stock.id), '1d');
    assert.equal(r.candles.length, 1);
    assert.equal(r.warning, 'offline');
  } finally { Date.now = orig; }
});

test('yahoo: quotes split out extended hours and use the previous close', () => {
  const q = parseQuote({ close: [155.38], fulldayPrice: 147.7, chartPreviousClose: 165.05 }, stock);
  assert.equal(q.last, 155.38);
  assert.ok(Math.abs(q.pct + 5.859) < 0.01 && Math.abs(q.ext + 4.943) < 0.01);
  const c = parseQuote({ close: [1.07], fulldayPrice: 1.08, chartPreviousClose: 1 }, crypto);
  assert.equal(c.last, 1.08);
  assert.equal(c.ext, null);
  assert.ok(parseQuote(undefined, stock).error);
});
