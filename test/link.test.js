import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/index.js';
import { openDb } from '../server/db.js';
import { createLinkedStore, cleanUrl } from '../server/store-linked.js';
import { fakeTurso } from '../scripts/fake-turso.js';
import { Readable } from 'node:stream';

const PASSWORD = 'correct horse battery';
const inst = id => ({ id, source: 'yahoo', symbol: id.slice(6), label: id.slice(6), name: 'n', type: 'EQUITY', exchange: 'X', currency: 'USD', tz: 'UTC' });
const providers = { yahoo: { QUOTE_TTL: 0, describe: async s => inst(`yahoo:${s}`), search: async () => [], history: async () => [], quotes: async () => ({}) } };
const line = (uid, p = 1) => ({ uid, tool: 'hline', pts: [{ t: 1, p }], color: '#ffffff' });

// The real web handler, called in memory instead of over the network.
function web() {
  const handler = createHandler({ APP_PASSWORD: PASSWORD, TURSO_DATABASE_URL: 'libsql://x', TURSO_AUTH_TOKEN: 't' }, { fetchFn: fakeTurso().fetch, providers });
  const site = { down: false, calls: 0 };
  site.fetch = async (url, { method = 'GET', headers = {}, body } = {}) => {
    site.calls++;
    if (site.down) throw new TypeError('fetch failed');
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, { method, url: url.replace('https://site.test', ''), headers: { host: 'site.test', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) } });
    let status, head, text;
    await handler(req, { writeHead: (s, h) => { status = s; head = h; }, end: t => { text = t; } });
    return new Response(text, { status, headers: head });
  };
  return site;
}
function desktop(site) {
  const db = openDb(':memory:');
  return { db, store: createLinkedStore(db, site.fetch) };
}
const add = async (d, ...ids) => { for (const id of ids) { d.db.saveInstrument(inst(id)); await d.store.addToWatchlist(id); } };
const labels = list => list.map(i => i.label);

test('web sync: address rules', () => {
  assert.equal(cleanUrl('my-site.vercel.app/x?y'), 'https://my-site.vercel.app');
  assert.equal(cleanUrl('http://localhost:5190'), 'http://localhost:5190');
  for (const bad of ['http://my-site.test', 'ftp://x.test', '']) assert.throws(() => cleanUrl(bad), bad);
});

test('web sync: connecting merges both sides and loses nothing', async () => {
  const site = web(), a = desktop(site), b = desktop(site);
  await add(a, 'yahoo:AAA', 'yahoo:BBB');
  await a.store.changeDrawings('yahoo:AAA', [line('drawing1')], []);
  await a.store.setMeta('groups', JSON.stringify({ on: true, order: ['Mine'], closed: [] }));
  assert.equal(a.store.linkStatus(), null);
  await assert.rejects(a.store.connect('https://site.test', 'wrong password!!'), /Wrong password/);
  assert.equal(a.store.linkStatus(), null);
  const r = await a.store.connect('https://site.test', PASSWORD);
  assert.deepEqual(r.sent, { watchlist: 2, drawings: 1 });

  await add(b, 'yahoo:BBB', 'yahoo:CCC');
  await b.store.flagWatchlist('yahoo:BBB', 'red'); // the site already has BBB: its version wins
  await b.store.setMeta('groups', JSON.stringify({ on: false, order: [], closed: [] }));
  await b.store.connect('https://site.test', PASSWORD);
  assert.deepEqual(labels(await b.store.watchlist()), ['AAA', 'BBB', 'CCC']);
  assert.equal((await b.store.watchlist())[1].flag, '');
  assert.deepEqual(await b.store.drawings('yahoo:AAA'), [line('drawing1')]);
  assert.deepEqual(JSON.parse(await b.store.meta('groups')).order, ['Mine']);
  assert.ok(!JSON.stringify(b.db.meta('link')).includes(PASSWORD));
});

test('web sync: a change on one computer shows up on the other', async () => {
  const site = web(), a = desktop(site), b = desktop(site);
  await add(a, 'yahoo:AAA', 'yahoo:BBB');
  await a.store.connect('https://site.test', PASSWORD);
  await b.store.connect('https://site.test', PASSWORD);
  const before = await b.store.rev();
  await a.store.removeFromWatchlist('yahoo:AAA');
  await a.store.flagWatchlist('yahoo:BBB', 'blue');
  await a.store.changeDrawings('yahoo:BBB', [line('drawing2', 5)], []);
  await a.store.setMeta('indicators', '{"x":1}');
  assert.ok(await b.store.rev() > before);
  assert.deepEqual((await b.store.watchlist()).map(i => [i.label, i.flag]), [['BBB', 'blue']]);
  assert.equal((await b.store.drawings('yahoo:BBB'))[0].pts[0].p, 5);
  assert.equal(await b.store.meta('indicators'), '{"x":1}');
  assert.deepEqual(labels(b.db.watchlist()), ['BBB']); // local copy follows
  const r = await b.store.rev();
  await b.store.watchlist(); await b.store.drawings('yahoo:BBB'); await b.store.meta('groups');
  assert.equal(await b.store.rev(), r); // reading is not a change
});

test('web sync: offline shows the last copy and refuses changes', async () => {
  const site = web(), a = desktop(site);
  await add(a, 'yahoo:AAA');
  await a.store.changeDrawings('yahoo:AAA', [line('drawing1')], []);
  await a.store.setMeta('groups', '{"on":true,"order":["G"],"closed":[]}');
  await a.store.connect('https://site.test', PASSWORD);
  site.down = true;
  assert.deepEqual(labels(await a.store.watchlist()), ['AAA']);
  assert.equal((await a.store.drawings('yahoo:AAA')).length, 1);
  assert.deepEqual(JSON.parse(await a.store.meta('groups')).order, ['G']);
  assert.equal(await a.store.rev(), null);
  await assert.rejects(a.store.removeFromWatchlist('yahoo:AAA'), /not saved/);
  assert.deepEqual(labels(a.db.watchlist()), ['AAA']);
  assert.equal(a.store.linkStatus().online, false);
  site.down = false;
  await a.store.removeFromWatchlist('yahoo:AAA');
  assert.equal(a.store.linkStatus().online, true);
  assert.deepEqual(await a.store.watchlist(), []);
});

test('web sync: signed-out session is reported, disconnecting keeps the copy', async () => {
  const site = web(), a = desktop(site);
  await add(a, 'yahoo:AAA');
  await a.store.connect('https://site.test', PASSWORD);
  const link = JSON.parse(a.db.meta('link'));
  a.db.setMeta('link', JSON.stringify({ ...link, cookie: '__Host-charts=1.x' }));
  assert.deepEqual(labels(await a.store.watchlist()), ['AAA']);
  assert.match(a.store.linkStatus().error, /sign in again/);
  await assert.rejects(a.store.flagWatchlist('yahoo:AAA', 'red'), /sign in again/);
  await a.store.disconnect();
  assert.equal(a.store.linkStatus(), null);
  site.calls = 0;
  await a.store.flagWatchlist('yahoo:AAA', 'red');
  assert.equal((await a.store.watchlist())[0].flag, 'red');
  assert.equal(site.calls, 0);
});

test('web sync: refuses addresses that are not a Charts site', async () => {
  const a = desktop({ fetch: async () => new Response('<html>', { status: 200 }) });
  await assert.rejects(a.store.connect('https://site.test', PASSWORD), /No Charts site/);
});
