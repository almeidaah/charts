import test from 'node:test';
import assert from 'node:assert/strict';
import { iconSources, imageType, fetchIcon, createIcons, memoryCache } from '../server/icons.js';
import { avatarOf, currencyPair, logoStyle } from '../public/logos.js';
import { openDb } from '../server/db.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), Buffer.alloc(40)]);
const i = (symbol, type, extra = {}) => ({ id: `yahoo:${symbol}`, source: 'yahoo', symbol, type, name: '', ...extra });

test('icons: where each kind of symbol is looked up', () => {
  assert.match(iconSources({ source: 'binance', symbol: 'BTCUSDT', name: 'BTC / USDT' })[0], /bnbstatic.*\/BTC\.png$/);
  assert.match(iconSources(i('NEXO-USD', 'CRYPTOCURRENCY'))[0], /\/NEXO\.png$/);
  assert.match(iconSources(i('VICI', 'EQUITY'))[0], /image-stock\/VICI\.png$/);
  assert.equal(iconSources(i('PETR4.SA', 'EQUITY')).length, 2);
  for (const x of [i('EURBRL=X', 'CURRENCY'), i('^BVSP', 'INDEX'), i('GC=F', 'FUTURE'), i('../x', 'EQUITY'), i('a/b', 'EQUITY')]) assert.deepEqual(iconSources(x), []);
});

test('icons: only real raster images are accepted', async () => {
  assert.equal(imageType(png), 'image/png');
  assert.equal(imageType(Buffer.from('<svg onload=alert(1)>')), null);
  const reply = body => async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
  assert.equal(await fetchIcon(i('A', 'EQUITY'), reply('<html>')), null);
  assert.equal(await fetchIcon(i('A', 'EQUITY'), reply(Buffer.concat([png, Buffer.alloc(400_000)]))), null);
  assert.equal((await fetchIcon(i('A', 'EQUITY'), reply(png))).type, 'image/png');
});

test('icons: asked for once; missing is remembered, failures are not', async () => {
  let calls = 0, mode = 'ok';
  const icons = createIcons(memoryCache(), async () => { calls++; if (mode === 'down') throw new Error('x'); return new Response(mode === 'ok' ? png : '', { status: mode === 'ok' ? 200 : 404 }); });
  await Promise.all([icons(i('A', 'EQUITY')), icons(i('A', 'EQUITY'))]);
  assert.ok(await icons(i('A', 'EQUITY')));
  assert.equal(calls, 1);
  mode = 'missing';
  assert.equal(await icons(i('B', 'EQUITY')), null);
  const n = calls; await icons(i('B', 'EQUITY')); assert.equal(calls, n);
  mode = 'down';
  assert.equal(await icons(i('C', 'EQUITY')), null);
  const m = calls; mode = 'ok'; assert.ok(await icons(i('C', 'EQUITY'))); assert.ok(calls > m);
});

test('icons: smaller coins use the logo Yahoo knows, from trusted hosts only', async () => {
  const run = logoUrl => fetchIcon(i('WPAY-USD', 'CRYPTOCURRENCY'), async url => (/bnbstatic/.test(url) ? new Response('', { status: 404 })
    : /v1\/finance\/search/.test(url) ? Response.json({ quotes: [{ symbol: 'WPAY-USD', logoUrl }] }) : new Response(png)));
  assert.equal((await run('https://s2.coinmarketcap.com/a.png')).type, 'image/png');
  assert.equal(await run('https://evil.test/a.png'), null);
  assert.equal(await run('http://s2.coinmarketcap.com/a.png'), null);
  assert.equal(await run(undefined), null);
});

test('icons: light logos get a dark background', () => {
  const px = (n, ...rgba) => Array.from({ length: n }, () => rgba).flat();
  assert.deepEqual(logoStyle([...px(50, 255, 255, 255, 255), ...px(50, 0, 0, 0, 0)]), { dark: true, padded: true });
  assert.equal(logoStyle([...px(50, 10, 10, 10, 255), ...px(50, 0, 0, 0, 0)]).dark, false);
  assert.deepEqual(logoStyle(px(100, 255, 255, 255, 255)), { dark: false, padded: false }); // opaque: has its own background
});

test('icons: kept in the local database', () => {
  const db = openDb(':memory:');
  assert.equal(db.icons.get('x'), undefined);
  db.icons.put('x', { data: png, type: 'image/png' });
  assert.deepEqual(Buffer.from(db.icons.get('x').data), png);
  db.icons.put('y', null);
  assert.equal(db.icons.get('y'), null);
});

test('icons: avatars and currency pairs', () => {
  assert.equal(avatarOf('MXRF11').text, 'MX');
  assert.equal(avatarOf('A').color, avatarOf('A').color);
  assert.deepEqual(currencyPair(i('EURBRL=X', 'CURRENCY')), ['EUR', 'BRL']);
  assert.deepEqual(currencyPair(i('BRL=X', 'CURRENCY')), ['USD', 'BRL']);
  assert.equal(currencyPair(i('NVDA', 'EQUITY')), null);
});
