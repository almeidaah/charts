import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTick, applyTick, streamUrl, createLive } from '../public/live.js';

const tick = (s, c) => JSON.stringify({ stream: 'x', data: { e: '24hrMiniTicker', s, c: String(c) } });

test('live: parses prices and ignores everything else', () => {
  assert.deepEqual(parseTick(tick('BTCUSDT', 57829.41)), { id: 'binance:BTCUSDT', last: 57829.41 });
  for (const bad of ['', '{}', '[]', 'null', tick('BTCUSDT', 0), JSON.stringify({ result: null, id: 1 })]) assert.equal(parseTick(bad), null, bad);
  assert.equal(streamUrl('wss://h', ['BTCUSDT', 'USDTBRL']), 'wss://h/stream?streams=btcusdt@miniTicker/usdtbrl@miniTicker');
});

test('live: the day change keeps the same open', () => {
  const q = applyTick({ last: 110, chg: 10, pct: 10, dayLow: 99 }, 105);
  assert.deepEqual(q, { last: 105, chg: 5, pct: 5, dayLow: 99 });
  assert.deepEqual(applyTick(undefined, 5), { last: 5 });
});

test('live: connects, switches symbols, pauses when hidden and reconnects', async () => {
  const sockets = [];
  class Fake { constructor(url) { this.url = url; sockets.push(this); } close() { this.closed = true; } }
  let hidden = false;
  const got = [];
  const live = createLive({ onPrice: (id, p) => got.push([id, p]), WebSocketClass: Fake, isHidden: () => hidden });
  live.setSymbols([]);
  assert.equal(sockets.length, 0);
  live.setSymbols(['BTCUSDT', 'USDTBRL', 'BTCUSDT']);
  assert.equal(sockets.length, 1);
  live.setSymbols(['USDTBRL', 'BTCUSDT']); // same symbols: keeps the connection
  assert.equal(sockets.length, 1);
  sockets[0].onmessage({ data: tick('BTCUSDT', 5) });
  assert.deepEqual(got, [['binance:BTCUSDT', 5]]);
  assert.equal(live.fresh('binance:BTCUSDT'), true);
  assert.equal(live.fresh('binance:USDTBRL'), false);
  live.setSymbols(['ETHUSDT']);
  assert.equal(sockets[0].closed, true);
  assert.match(sockets[1].url, /ethusdt/);
  hidden = true; live.check();
  assert.equal(sockets[1].closed, true);
  hidden = false; live.check();
  assert.equal(sockets.length, 3);
  sockets[2].onclose(); // dropped: tries the other address
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(sockets.length, 4);
  assert.notEqual(new URL(sockets[3].url).host, new URL(sockets[2].url).host);
  live.close();
});
