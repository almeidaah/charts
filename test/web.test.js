import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHandler } from '../api/index.js';
import { createAuth } from '../server/auth.js';
import { validBackup } from '../server/routes.js';
import { fakeTurso } from '../scripts/fake-turso.js';

const PASSWORD = 'correct horse battery';
const bar = (t, c) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 10 });
const day = 86400;
const TODAY = Math.floor(Date.now() / 1000 / day);
const providers = {
  yahoo: {
    QUOTE_TTL: 0,
    search: async () => [],
    describe: async symbol => {
      if (symbol === 'NOPE') throw new Error('Yahoo: symbol not found');
      return { id: `yahoo:${symbol}`, source: 'yahoo', symbol, label: symbol, name: symbol, type: 'EQUITY', exchange: 'X', currency: 'USD', tz: 'America/New_York' };
    },
    history: async (inst, tf, since) => Array.from({ length: 40 }, (_, i) => bar((TODAY - 39 + i) * day, 100 + i)).filter(r => since == null || r.t >= since),
    quotes: async list => Object.fromEntries(list.map(i => [i.id, { last: 139, chg: 1, pct: 0.7, ext: null }])),
  },
};

async function site(env = {}, opts = {}) {
  const turso = fakeTurso();
  const handler = createHandler({ APP_PASSWORD: PASSWORD, TURSO_DATABASE_URL: 'libsql://db.test', TURSO_AUTH_TOKEN: 'token', ...env }, { fetchFn: turso.fetch, providers, ...opts });
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, json, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: json && JSON.stringify(json) });
    const set = res.headers.get('set-cookie');
    return { status: res.status, data: await res.json(), set };
  };
  const login = async (password = PASSWORD, headers) => {
    const r = await call('POST', '/api/login', { password }, headers);
    if (r.set) cookie = r.set.split(';')[0];
    return r;
  };
  return { call, login, turso, setCookie: c => { cookie = c; }, close: () => server.close() };
}

test('web: everything needs the password', async () => {
  const s = await site();
  try {
    for (const p of ['/api/watchlist', '/api/backup', '/api/quotes', '/api/candles?id=yahoo:A', '/api/selftest', '/api/nothing']) {
      assert.equal((await s.call('GET', p)).status, 401, p);
    }
    assert.equal((await s.login('wrong password!!')).status, 403);
    assert.equal((await s.call('GET', '/api/watchlist')).status, 401);
    s.setCookie('__Host-charts=99999999999999.forged');
    assert.equal((await s.call('GET', '/api/watchlist')).status, 401);
    s.setCookie('');
    const ok = await s.login();
    assert.equal(ok.status, 200);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(ok.set.includes(flag), flag);
    assert.deepEqual((await s.call('GET', '/api/watchlist')).data, []);
    assert.equal((await s.call('GET', '/api/ping')).data.cloud, true);
  } finally { s.close(); }
});

test('web: too many wrong passwords lock that address only', async () => {
  const s = await site();
  try {
    const bad = { 'x-real-ip': '10.0.0.1' };
    for (let i = 0; i < 8; i++) assert.equal((await s.login('wrong password!!', bad)).status, 403);
    assert.equal((await s.login(PASSWORD, bad)).status, 429);
    assert.equal((await s.login(PASSWORD, { 'x-real-ip': '10.0.0.2' })).status, 200);
  } finally { s.close(); }
});

test('web: sessions expire and end when the password changes', async () => {
  let now = 1e12;
  const store = { meta: async () => null, setMeta: async () => {}, deleteMeta: async () => {} };
  const make = password => createAuth({ password, secret: 't', store, now: () => now });
  const cookie = (await make(PASSWORD).login(PASSWORD, 'ip')).cookie.split(';')[0];
  assert.equal(make(PASSWORD).check(cookie), true);
  assert.equal(make('another password 1').check(cookie), false);
  now += 181 * day * 1000;
  assert.equal(make(PASSWORD).check(cookie), false);
  assert.throws(() => make('short'));
});

test('web: incomplete setup and other origins are refused', async () => {
  const s = await site({ TURSO_AUTH_TOKEN: '' });
  try {
    const r = await s.call('GET', '/api/watchlist');
    assert.equal(r.status, 503);
    assert.match(r.data.error, /TURSO_AUTH_TOKEN/);
  } finally { s.close(); }
  const o = await site();
  try { assert.equal((await o.call('GET', '/api/ping', null, { Origin: 'https://evil.test' })).status, 403); } finally { o.close(); }
});

test('web: watchlist, groups, drawings and indicators are stored', async () => {
  const s = await site();
  try {
    await s.login();
    for (const id of ['yahoo:AAA', 'yahoo:BBB']) assert.equal((await s.call('POST', '/api/watchlist', { id })).status, 200);
    assert.equal((await s.call('POST', '/api/watchlist', { id: 'yahoo:NOPE' })).status, 502);
    assert.equal((await s.call('POST', '/api/watchlist', { id: 'evil:1' })).status, 400);
    await s.call('PUT', '/api/watchlist/order', { ids: ['yahoo:BBB', 'yahoo:AAA'] });
    await s.call('PUT', '/api/watchlist/flag', { id: 'yahoo:AAA', flag: 'red' });
    await s.call('PUT', '/api/watchlist/group', { id: 'yahoo:AAA', grp: 'Mine' });
    const list = (await s.call('GET', '/api/watchlist')).data;
    assert.deepEqual(list.map(i => [i.id, i.flag, i.grp]), [['yahoo:BBB', '', ''], ['yahoo:AAA', 'red', 'Mine']]);
    const d = { uid: 'abcdef1', tool: 'trend', pts: [{ t: 1, p: 2.5 }], color: '#fff' };
    assert.equal((await s.call('POST', '/api/drawings', { id: 'yahoo:AAA', put: [d] })).status, 200);
    assert.deepEqual((await s.call('GET', '/api/drawings?id=yahoo:AAA')).data, [d]);
    await s.call('POST', '/api/drawings', { id: 'yahoo:BBB', put: [{ ...d, color: '#000' }], del: ['abcdef1'] });
    assert.deepEqual((await s.call('GET', '/api/drawings?id=yahoo:AAA')).data, [d]);
    await s.call('PUT', '/api/indicators', { a: 1 });
    assert.deepEqual((await s.call('GET', '/api/indicators')).data, { a: 1 });
    await s.call('DELETE', '/api/watchlist?id=yahoo:BBB');
    assert.equal((await s.call('GET', '/api/watchlist')).data.length, 1);
  } finally { s.close(); }
});

test('web: a failed statement rolls the whole change back', async () => {
  const s = await site();
  try {
    await s.login();
    await s.call('POST', '/api/watchlist', { id: 'yahoo:AAA' });
    s.turso.failOn = /DELETE FROM drawings/;
    const d = { uid: 'abcdef1', tool: 'trend', pts: [{ t: 1, p: 2 }] };
    assert.equal((await s.call('POST', '/api/drawings', { id: 'yahoo:AAA', put: [d], del: ['zzzzzz1'] })).status, 502);
    s.turso.failOn = null;
    assert.deepEqual((await s.call('GET', '/api/drawings?id=yahoo:AAA')).data, []);
  } finally { s.close(); }
});

test('web: candles, tail, quotes and stats', async () => {
  const s = await site();
  try {
    await s.login();
    await s.call('POST', '/api/watchlist', { id: 'yahoo:AAA' });
    const full = (await s.call('GET', '/api/candles?id=yahoo:AAA&tf=1d')).data.candles;
    assert.equal(full.length, 40);
    assert.deepEqual(full.at(-1), [TODAY * day, 139, 140, 138, 139, 10]);
    const weekly = (await s.call('GET', '/api/candles?id=yahoo:AAA&tf=1w')).data.candles;
    const last = weekly.at(-1);
    const tail = (await s.call('GET', `/api/candles?id=yahoo:AAA&tf=1w&since=${last[0]}`)).data.candles;
    assert.deepEqual(tail, [last]);
    const q = (await s.call('GET', '/api/quotes?focus=yahoo:AAA')).data['yahoo:AAA'];
    assert.equal(q.last, 139);
    assert.equal(q.yearHigh, 140);
    assert.equal((await s.call('GET', '/api/candles?id=yahoo:ZZZ&tf=1d')).status, 404);
    assert.equal((await s.call('GET', '/api/candles?id=yahoo:AAA&tf=__proto__')).status, 400);
  } finally { s.close(); }
});

test('web: paths passed by the Vercel rewrite work too', async () => {
  const s = await site();
  try {
    await s.login();
    assert.equal((await s.call('GET', '/api/index?__path=watchlist')).status, 200);
    assert.equal((await s.call('GET', '/api/index?__path=watchlist/../x')).status, 404);
  } finally { s.close(); }
});

test('backup: moves everything and refuses other files', async () => {
  const a = await site(), b = await site();
  try {
    await a.login(); await b.login();
    await a.call('POST', '/api/watchlist', { id: 'yahoo:AAA' });
    await a.call('PUT', '/api/watchlist/group', { id: 'yahoo:AAA', grp: 'Mine' });
    await a.call('PUT', '/api/groups', { on: true, order: ['Mine'], closed: [] });
    await a.call('POST', '/api/drawings', { id: 'yahoo:AAA', put: [{ uid: 'abcdef1', tool: 'hline', pts: [{ t: 1, p: 2 }] }] });
    const file = (await a.call('GET', '/api/backup')).data;
    assert.equal(validBackup(file), true);
    for (let i = 0; i < 2; i++) assert.deepEqual((await b.call('POST', '/api/backup', file)).data, { watchlist: 1, drawings: 1 });
    assert.equal((await b.call('GET', '/api/watchlist')).data[0].grp, 'Mine');
    assert.equal((await b.call('GET', '/api/drawings?id=yahoo:AAA')).data.length, 1);
    assert.deepEqual((await b.call('GET', '/api/groups')).data.order, ['Mine']);
    assert.equal((await b.call('POST', '/api/backup', { hello: 1 })).status, 400);
    assert.equal(validBackup({ ...file, instruments: [{ ...file.instruments[0], tz: 'Nowhere/Bad' }] }), false);
  } finally { a.close(); b.close(); }
});
