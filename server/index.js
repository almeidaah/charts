import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { openDb } from './db.js';
import { createMarket } from './market.js';
import { TIMEFRAMES } from './timeframes.js';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 5180);

const db = openDb(process.env.CHARTS_DB ?? join(ROOT, 'data', 'market.db'));
const market = createMarket(db);

// Starter watchlist, used only on the first run.
const SEED = [
  'binance:BTCUSDT', 'binance:ETHUSDT', 'yahoo:AAPL', 'yahoo:MSFT', 'yahoo:NVDA', 'yahoo:SPY',
  'yahoo:PETR4.SA', 'yahoo:VALE3.SA', 'yahoo:EURUSD=X', 'yahoo:USDBRL=X', 'yahoo:^GSPC', 'yahoo:^BVSP', 'yahoo:GC=F',
];

async function seed() {
  const saved = db.meta('seed_pending');
  const pending = saved ? JSON.parse(saved) : SEED;
  const failed = [];
  for (const id of pending) {
    try { await market.add(id); } catch (e) { failed.push(id); console.warn(`Initial watchlist, ${id}: ${e.message}`); }
  }
  db.setMeta('seed_pending', JSON.stringify(failed)); // whatever failed is retried next time
}
// Downloads the full daily history of the watchlist in the background.
const syncJob = { running: false, seeding: true, done: 0, total: 0, errors: [] };
async function syncAll() {
  if (syncJob.running) return;
  const list = db.watchlist();
  Object.assign(syncJob, { running: true, done: 0, total: list.length, errors: [] });
  await Promise.all(list.map(async inst => {
    try { await market.sync(inst, '1d', 300); } catch (e) { syncJob.errors.push(`${inst.label}: ${e.message}`); }
    syncJob.done++;
  }));
  syncJob.running = false;
}

// Day and 52-week ranges, from the local daily history.
function dayStats(id) {
  const rows = db.lastCandles(id, '1d', 366);
  const last = rows.at(-1);
  if (!last) return {};
  const year = rows.filter(r => r.t > last.t - 365 * 86400);
  return {
    dayLow: last.l, dayHigh: last.h, volume: last.v,
    yearLow: Math.min(...year.map(r => r.l)), yearHigh: Math.max(...year.map(r => r.h)),
  };
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function known(id) {
  const inst = id && db.instrument(id);
  if (!inst) throw new HttpError(404, 'Unknown symbol');
  return inst;
}

async function body(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 1e6) throw new HttpError(413, 'Too large'); }
  try { return JSON.parse(s); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const validDrawing = d => d && typeof d === 'object' && /^[\w-]{6,40}$/.test(d.uid) && typeof d.tool === 'string'
  && Array.isArray(d.pts) && d.pts.length > 0 && d.pts.length <= 5000
  && d.pts.every(p => Number.isFinite(p?.t) && Number.isFinite(p?.p));

const routes = {
  'GET /api/watchlist': () => db.watchlist(),
  'POST /api/watchlist': async (req) => {
    const { id } = await body(req);
    if (typeof id !== 'string') throw new HttpError(400, 'Missing id');
    const inst = await market.add(id);
    market.sync(inst, '1d').catch(() => {});
    return inst;
  },
  'DELETE /api/watchlist': (req, url) => { db.removeFromWatchlist(url.searchParams.get('id') ?? ''); return { ok: true }; },
  'PUT /api/watchlist/flag': async (req) => {
    const { id, flag } = await body(req);
    if (!['', 'red', 'blue', 'green', 'amber', 'violet'].includes(flag)) throw new HttpError(400, 'Invalid color');
    db.flagWatchlist(known(id).id, flag);
    return { ok: true };
  },
  'PUT /api/watchlist/group': async (req) => {
    const { id, grp } = await body(req);
    if (typeof grp !== 'string' || grp.length > 30) throw new HttpError(400, 'Invalid group');
    db.groupWatchlist(known(id).id, grp);
    return { ok: true };
  },
  'GET /api/groups': () => JSON.parse(db.meta('groups') ?? '{}'),
  'PUT /api/groups': async (req) => {
    const g = await body(req);
    const names = x => Array.isArray(x) && x.length <= 100 && x.every(n => typeof n === 'string' && n.length <= 30);
    if (typeof g?.on !== 'boolean' || !names(g.order) || !names(g.closed)) throw new HttpError(400, 'Invalid groups');
    db.setMeta('groups', JSON.stringify({ on: g.on, order: g.order, closed: g.closed }));
    return { ok: true };
  },
  'GET /api/ping': () => ({ app: 'charts-app' }),
  'PUT /api/watchlist/order': async (req) => {
    const { ids } = await body(req);
    if (!Array.isArray(ids) || !ids.every(x => typeof x === 'string')) throw new HttpError(400, 'Invalid list');
    db.reorderWatchlist(ids);
    return { ok: true };
  },
  'GET /api/quotes': async () => {
    const list = db.watchlist();
    const data = await market.quotes(list);
    return Object.fromEntries(list.map(i => [i.id, { ...data[i.id], ...dayStats(i.id) }]));
  },
  'GET /api/search': (req, url) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    return q ? market.search(q.slice(0, 60)) : [];
  },
  'GET /api/candles': async (req, url) => {
    const inst = known(url.searchParams.get('id'));
    const tf = url.searchParams.get('tf') ?? '1d';
    if (!Object.hasOwn(TIMEFRAMES, tf)) throw new HttpError(400, 'Invalid timeframe');
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined;
    if (since !== undefined && !Number.isFinite(since)) throw new HttpError(400, 'Invalid since');
    if (TIMEFRAMES[tf].base !== '1d') market.sync(inst, '1d', 60).catch(() => {}); // keeps the day details fresh
    const { candles, warning } = await market.candles(inst, tf, { since });
    // Compact format: [t,o,h,l,c,v]
    return { warning, candles: candles.map(r => [r.t, r.o, r.h, r.l, r.c, r.v]) };
  },
  'GET /api/drawings': (req, url) => db.drawings(known(url.searchParams.get('id')).id),
  'POST /api/drawings': async (req) => {
    const { id, put = [], del = [] } = await body(req);
    const inst = known(id);
    const uid = /^[\w-]{6,40}$/;
    if (!Array.isArray(put) || !Array.isArray(del) || !del.every(u => uid.test(u)) || !put.every(validDrawing)) {
      throw new HttpError(400, 'Invalid drawing');
    }
    db.changeDrawings(inst.id, put, del);
    return { ok: true };
  },
  'GET /api/indicators': () => JSON.parse(db.meta('indicators') ?? 'null'),
  'PUT /api/indicators': async (req) => {
    const cfg = await body(req);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new HttpError(400, 'Invalid settings');
    db.setMeta('indicators', JSON.stringify(cfg));
    return { ok: true };
  },
  'GET /api/status': () => ({ sync: syncJob, coverage: db.coverage() }),
  'POST /api/sync': async (req) => { await body(req); syncAll(); return { ok: true }; },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'Forbidden');
  let data;
  try { data = await readFile(file); } catch { throw new HttpError(404, 'Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
}

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const server = http.createServer(async (req, res) => {
  try {
    // Only accepts requests from this computer, never from other sites open in the browser.
    if (!ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(403, 'Host not allowed');
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace('http://', ''))) throw new HttpError(403, 'Origin not allowed');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      const data = await route(req, url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } else if (req.method === 'GET') await serveStatic(url, res);
    else throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    if (status >= 500) console.error(`${req.method} ${req.url}:`, e.message);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// With --open (start.bat), opens the default browser.
function openBrowser() {
  if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { windowsHide: true });
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') openBrowser();
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is Charts already open?)` : e.message);
  setTimeout(() => process.exit(1), 500);
});
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Open at http://localhost:${PORT}`);
  openBrowser();
  await seed();
  syncJob.seeding = false;
  await syncAll();
  console.log(`Daily history: ${syncJob.done - syncJob.errors.length}/${syncJob.total} tickers`);
  for (const e of syncJob.errors) console.warn(' -', e);
});
