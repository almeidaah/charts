import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHandler } from '../api/index.js';
import { createAuth } from '../server/auth.js';
import { SAMPLE, createLimiter } from '../server/guest.js';
import { createGuestLocal } from '../public/guest.js';
import { iconSources } from '../server/icons.js';
import { fakeTurso } from '../scripts/fake-turso.js';

const OWNER = 'correct horse battery', GUEST = 'guest pass for trial';
const providers = Object.fromEntries(['yahoo', 'binance'].map(source => [source, {
  QUOTE_TTL: 0, search: async () => [], history: async () => [], quotes: async () => ({}),
  describe: async symbol => ({ id: `${source}:${symbol}`, source, symbol, label: symbol, name: 'n', type: 'EQUITY', exchange: 'X', currency: 'USD', tz: 'UTC' }),
}]));

async function site(env = {}) {
  const turso = fakeTurso();
  const server = http.createServer(createHandler({ APP_PASSWORD: OWNER, GUEST_PASSWORD: GUEST, TURSO_DATABASE_URL: 'libsql://x', TURSO_AUTH_TOKEN: 't', ...env }, { fetchFn: turso.fetch, providers })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const user = async password => {
    const login = await fetch(base + 'login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const cookie = login.headers.get('set-cookie') ?? '';
    const call = async (method, path, json) => {
      const r = await fetch(base + path, { method, headers: { Cookie: cookie.split(';')[0], ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json && JSON.stringify(json) });
      return { status: r.status, data: await r.json() };
    };
    return { status: login.status, cookie, call };
  };
  return { user, close: () => server.close() };
}
const ids = r => r.data.map(i => i.id);
const line = uid => ({ uid, tool: 'hline', pts: [{ t: 1, p: 2 }] });

test('guest: sees the sample list and never the owner', async () => {
  const s = await site();
  try {
    const owner = await s.user(OWNER), guest = await s.user(GUEST);
    await owner.call('POST', 'watchlist', { id: 'yahoo:SECRET' });
    await owner.call('POST', 'watchlist', { id: 'yahoo:AAPL' });
    await owner.call('PUT', 'watchlist/flag', { id: 'yahoo:AAPL', flag: 'red' });
    const r = await guest.call('GET', 'watchlist');
    assert.deepEqual(ids(r), SAMPLE.map(i => i.id));
    assert.ok(r.data.every(i => i.flag === '' && i.grp === ''));
    for (const p of ['icon?id=yahoo:SECRET', 'candles?id=yahoo:SECRET&tf=1d']) assert.equal((await guest.call('GET', p)).status, 404);
    assert.equal((await guest.call('GET', 'candles?id=yahoo:AAPL&tf=1d')).status, 200);
    assert.equal((await guest.call('GET', 'quotes?focus=yahoo:SECRET')).data['yahoo:SECRET'], undefined);
    assert.deepEqual([(await guest.call('GET', 'status')).data.role, (await owner.call('GET', 'status')).data.role], ['guest', 'owner']);
    assert.equal((await owner.call('GET', 'status')).data.guest, 'on');
    assert.equal((await guest.call('GET', 'status')).data.guest, undefined);
  } finally { s.close(); }
});

test('guest: everything else is refused and the owner data does not move', async () => {
  const s = await site();
  try {
    const owner = await s.user(OWNER), guest = await s.user(GUEST);
    await owner.call('POST', 'watchlist', { id: 'yahoo:AAPL' });
    await owner.call('POST', 'drawings', { id: 'yahoo:AAPL', put: [line('ownerline1')] });
    const before = JSON.stringify((await owner.call('GET', 'backup')).data), rev = (await owner.call('GET', 'rev')).data.rev;
    const id = 'yahoo:AAPL';
    for (const [m, p, b] of [
      ['GET', 'drawings?id=' + id], ['GET', 'backup'], ['GET', 'groups'], ['GET', 'indicators'], ['GET', 'rev'], ['GET', 'selftest'], ['GET', 'search?q=a'],
      ['POST', 'watchlist', { id: 'yahoo:NEW' }], ['DELETE', 'watchlist?id=' + id], ['PUT', 'watchlist/flag', { id, flag: 'red' }],
      ['PUT', 'watchlist/group', { id, grp: 'x' }], ['PUT', 'watchlist/order', { ids: [id] }], ['POST', 'drawings', { id, put: [line('guestline1')], del: ['ownerline1'] }],
      ['PUT', 'indicators', { a: 1 }], ['PUT', 'groups', { on: true, order: [], closed: [] }], ['POST', 'backup', { app: 'charts' }], ['POST', 'status', {}],
    ]) assert.equal((await guest.call(m, p, b)).status, 403, m + ' ' + p);
    assert.equal(JSON.stringify((await owner.call('GET', 'backup')).data), before);
    assert.equal((await owner.call('GET', 'rev')).data.rev, rev);
    assert.equal((await guest.call('POST', 'logout', {})).status, 200);
  } finally { s.close(); }
});

test('guest: one address cannot ask too much', () => {
  let now = 0;
  const limit = createLimiter({ max: 3, windowMs: 1000, now: () => now });
  for (let i = 0; i < 3; i++) limit('a');
  assert.throws(() => limit('a'), /Too many/);
  limit('b');
  now = 1000;
  limit('a');
});

test('guest: drawings and settings stay in the browser', () => {
  const m = new Map(), storage = () => ({ getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) });
  const g = createGuestLocal(storage), id = 'yahoo:^GSPC', q = new URLSearchParams({ id });
  assert.deepEqual(g.handle('drawings?' + q, 'GET'), []);
  g.handle('drawings', 'POST', { id, put: [line('one'), line('two')] });
  g.handle('drawings', 'POST', { id, put: [{ ...line('two'), color: 'x' }], del: ['one'] });
  assert.deepEqual(createGuestLocal(storage).handle('drawings?' + q, 'GET'), [{ ...line('two'), color: 'x' }]);
  g.handle('indicators', 'PUT', { a: 1 });
  assert.deepEqual(g.handle('indicators', 'GET'), { a: 1 });
  g.handle('watchlist/flag', 'PUT', { id: 'b', flag: 'red' });
  g.handle('watchlist/order', 'PUT', { ids: ['b', 'a'] });
  assert.deepEqual(g.apply(['a', 'b', 'c'].map(x => ({ id: x, flag: '', grp: '' }))).map(i => i.id + i.flag), ['bred', 'a', 'c']);
  for (const [p, method] of [['watchlist', 'GET'], ['quotes?focus=', 'GET'], ['candles?id=a', 'GET'], ['status', 'GET'], ['logout', 'POST'], ['login', 'POST']]) assert.equal(g.handle(p, method, {}), undefined);
  g.clear();
  assert.equal(g.handle('indicators', 'GET'), null);
  m.set('guest', '{broken');
  assert.deepEqual(g.handle('drawings?' + q, 'GET'), []);
  const refused = createGuestLocal(() => { throw new Error('denied'); });
  assert.throws(() => refused.handle('indicators', 'PUT', {}), /could not save/);
  assert.deepEqual(refused.handle('drawings?' + q, 'GET'), []);
});

test('guest: off without a password, or with a weak or repeated one; the owner is never affected', async () => {
  for (const [GUEST_PASSWORD, expected] of [['', 'off'], ['short', /12 characters/], [OWNER, /different/]]) {
    const s = await site({ GUEST_PASSWORD });
    try {
      const owner = await s.user(OWNER);
      assert.equal(owner.status, 200);
      const { guest, role } = (await owner.call('GET', 'status')).data;
      assert.equal(role, 'owner');
      if (typeof expected === 'string') assert.equal(guest, expected); else assert.match(guest, expected);
      assert.equal((await s.user(GUEST)).status, 403);
      if (GUEST_PASSWORD === 'short') assert.equal((await s.user('short')).status, 403);
    } finally { s.close(); }
  }
});

test('guest: sessions are short, cannot be promoted, and end when the password is removed', async () => {
  let now = 1e12;
  const store = { meta: async () => null, setMeta: async () => {}, deleteMeta: async () => {} };
  const make = guestPassword => createAuth({ password: OWNER, guestPassword, secret: 't', store, now: () => now });
  const cookie = (await make(GUEST).login(GUEST, 'ip')).cookie.split(';')[0];
  assert.equal(make(GUEST).check(cookie), 'guest');
  assert.equal(make(GUEST).check(cookie.replace('=g.', '=')), null); // same signature, pretending to be the owner
  assert.equal(make('').check(cookie), null);
  assert.equal(make('another guest pass').check(cookie), null);
  now += 25 * 3600_000;
  assert.equal(make(GUEST).check(cookie), null);
  now = 1e12;
  const own = (await make(GUEST).login(OWNER, 'ip')).cookie.split(';')[0];
  assert.equal(make('').check(own), 'owner'); // owner sessions do not depend on the guest password
  assert.equal(make(GUEST).check(own.replace('=', '=g.')), null);
});

test('guest: the shared password neither locks anyone out nor allows more guesses at the owner password', async () => {
  const s = await site();
  try {
    for (let i = 0; i < 12; i++) assert.equal((await s.user(GUEST)).status, 200);
    const seen = [];
    for (let i = 0; i < 9; i++) { seen.push((await s.user('wrong password!!')).status); assert.equal((await s.user(GUEST)).status, 200); }
    assert.deepEqual(seen, [...Array(8).fill(403), 429]);
    assert.equal((await s.user(OWNER)).status, 429);
  } finally { s.close(); }
});

test('guest: the sample is valid', () => {
  for (const i of SAMPLE) { assert.equal(i.id, `${i.source}:${i.symbol}`); new Intl.DateTimeFormat('en', { timeZone: i.tz }); iconSources(i); }
  assert.equal(new Set(SAMPLE.map(i => i.id)).size, SAMPLE.length);
});
