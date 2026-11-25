import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHandler } from '../api/index.js';
import { createAuth } from '../server/auth.js';
import { SAMPLE, LIMITS } from '../server/guest.js';
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

test('guest: starts with the sample list and never sees the owner', async () => {
  const s = await site();
  try {
    const owner = await s.user(OWNER), guest = await s.user(GUEST);
    await owner.call('POST', 'watchlist', { id: 'yahoo:SECRET' });
    await owner.call('POST', 'drawings', { id: 'yahoo:SECRET', put: [line('ownerline1')] });
    await owner.call('PUT', 'groups', { on: true, order: ['Private'], closed: [] });
    await owner.call('PUT', 'indicators', { mine: true });

    assert.deepEqual(ids(await guest.call('GET', 'watchlist')), SAMPLE.map(i => i.id));
    assert.equal((await guest.call('GET', 'drawings?id=yahoo:SECRET')).status, 404);
    assert.equal((await guest.call('GET', 'icon?id=yahoo:SECRET')).status, 404);
    assert.equal((await guest.call('GET', 'candles?id=yahoo:SECRET&tf=1d')).status, 404);
    assert.deepEqual((await guest.call('GET', 'groups')).data, {});
    assert.equal((await guest.call('GET', 'indicators')).data, null);
    const backup = JSON.stringify((await guest.call('GET', 'backup')).data);
    assert.ok(!/SECRET|ownerline|Private|mine/.test(backup));
  } finally { s.close(); }
});

test('guest: changes stay in the guest area', async () => {
  const s = await site();
  try {
    const owner = await s.user(OWNER), guest = await s.user(GUEST);
    await owner.call('POST', 'watchlist', { id: 'yahoo:AAPL' });
    await owner.call('POST', 'drawings', { id: 'yahoo:AAPL', put: [line('sameuid1')] });
    const rev = (await owner.call('GET', 'rev')).data.rev;

    await guest.call('POST', 'watchlist', { id: 'yahoo:NEW' });
    await guest.call('DELETE', 'watchlist?id=yahoo:AAPL');
    await guest.call('PUT', 'watchlist/flag', { id: 'yahoo:MSFT', flag: 'red' });
    await guest.call('POST', 'drawings', { id: 'yahoo:AAPL', put: [{ ...line('sameuid1'), color: '#000' }] });
    await guest.call('POST', 'drawings', { id: 'yahoo:AAPL', del: ['sameuid1'] });
    await guest.call('PUT', 'indicators', { x: 1 });

    assert.deepEqual(ids(await owner.call('GET', 'watchlist')), ['yahoo:AAPL']);
    assert.deepEqual((await owner.call('GET', 'drawings?id=yahoo:AAPL')).data, [line('sameuid1')]);
    assert.equal((await owner.call('GET', 'indicators')).data, null);
    assert.equal((await owner.call('GET', 'rev')).data.rev, rev);
    const second = await s.user(GUEST); // another guest shares the guest list
    assert.ok(ids(await second.call('GET', 'watchlist')).includes('yahoo:NEW'));
  } finally { s.close(); }
});

test('guest: some actions are for the owner only', async () => {
  const s = await site();
  try {
    const owner = await s.user(OWNER), guest = await s.user(GUEST);
    for (const [m, p, b] of [['POST', 'backup', { app: 'charts' }], ['GET', 'selftest'], ['POST', 'guest/reset', {}]]) assert.equal((await guest.call(m, p, b)).status, 403, p);
    assert.deepEqual([(await guest.call('GET', 'status')).data.role, (await owner.call('GET', 'status')).data.role], ['guest', 'owner']);
    assert.equal((await owner.call('GET', 'status')).data.guest, 'on');
    assert.equal((await guest.call('GET', 'status')).data.guest, undefined);

    await guest.call('POST', 'watchlist', { id: 'yahoo:NEW' });
    await guest.call('POST', 'drawings', { id: 'yahoo:NEW', put: [line('guestline1')] });
    await owner.call('POST', 'watchlist', { id: 'yahoo:MINE' });
    assert.equal((await owner.call('POST', 'guest/reset', {})).status, 200);
    assert.deepEqual(ids(await guest.call('GET', 'watchlist')), SAMPLE.map(i => i.id));
    assert.equal((await guest.call('GET', 'drawings?id=yahoo:NEW')).status, 404);
    assert.deepEqual(ids(await owner.call('GET', 'watchlist')), ['yahoo:MINE']);
  } finally { s.close(); }
});

test('guest: the area is kept small', async () => {
  const s = await site();
  try {
    const guest = await s.user(GUEST);
    await guest.call('GET', 'watchlist');
    for (let i = SAMPLE.length; i < LIMITS.symbols; i++) assert.equal((await guest.call('POST', 'watchlist', { id: `yahoo:S${i}` })).status, 200);
    assert.equal((await guest.call('POST', 'watchlist', { id: 'yahoo:TOOMANY' })).status, 403);
    assert.equal((await guest.call('POST', 'drawings', { id: 'yahoo:AAPL', put: [{ ...line('bigone11'), text: 'x'.repeat(LIMITS.drawingBytes) }] })).status, 403);
    assert.equal((await guest.call('POST', 'drawings', { id: 'yahoo:AAPL', put: Array.from({ length: LIMITS.drawings + 1 }, (_, i) => line(`many${1000 + i}`)) })).status, 403);
    assert.equal((await guest.call('PUT', 'indicators', { a: 'x'.repeat(LIMITS.settingBytes) })).status, 403);
  } finally { s.close(); }
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

test('guest: signing in as a guest does not allow more guesses at the owner password', async () => {
  const s = await site();
  try {
    const seen = [];
    for (let i = 0; i < 5; i++) { seen.push((await s.user('wrong password!!')).status, (await s.user(GUEST)).status); }
    assert.deepEqual(seen.slice(0, 8), [403, 200, 403, 200, 403, 200, 403, 200]);
    assert.deepEqual(seen.slice(8), [429, 429]);
  } finally { s.close(); }
});

test('guest: the sample is valid', () => {
  for (const i of SAMPLE) { assert.equal(i.id, `${i.source}:${i.symbol}`); new Intl.DateTimeFormat('en', { timeZone: i.tz }); iconSources(i); }
  assert.equal(new Set(SAMPLE.map(i => i.id)).size, SAMPLE.length);
});
