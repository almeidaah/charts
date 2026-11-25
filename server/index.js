import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { openDb } from './db.js';
import { createLinkedStore } from './store-linked.js';
import { createMarket, dayStats } from './market.js';
import { createRoutes, HttpError, readJson } from './routes.js';
import { TIMEFRAMES } from './timeframes.js';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 5180);

const db = openDb(process.env.CHARTS_DB ?? join(ROOT, 'data', 'market.db'));
const store = createLinkedStore(db); // shares user data with the web version, when connected
const market = createMarket(store);

// Starter watchlist, used only on the first run.
const SEED = [
  'binance:BTCUSDT', 'binance:ETHUSDT', 'yahoo:AAPL', 'yahoo:MSFT', 'yahoo:NVDA', 'yahoo:SPY',
  'yahoo:PETR4.SA', 'yahoo:VALE3.SA', 'yahoo:EURUSD=X', 'yahoo:USDBRL=X', 'yahoo:^GSPC', 'yahoo:^BVSP', 'yahoo:GC=F',
];

async function seed() {
  if (store.linkStatus()) return; // the web version already has the watchlist
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

const routes = createRoutes({
  store,
  market: {
    ...market,
    candles(inst, tf, opts) {
      if (TIMEFRAMES[tf].base !== '1d') market.sync(inst, '1d', 60).catch(() => {}); // keeps the day details fresh
      return market.candles(inst, tf, opts);
    },
  },
  extra: {
    'GET /api/ping': () => ({ app: 'charts-app' }),
    'GET /api/quotes': async () => {
      const list = db.watchlist(), data = await market.quotes(list);
      return Object.fromEntries(list.map(i => [i.id, { ...data[i.id], ...dayStats(db.lastCandles(i.id, '1d', 366)) }]));
    },
    'GET /api/status': () => ({ sync: syncJob, coverage: db.coverage(), link: store.linkStatus() }),
    'POST /api/link': async ({ body }) => {
      const { url, password } = await body();
      if (typeof url !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Enter the address and the password');
      const r = await store.connect(url, password);
      syncAll();
      return r;
    },
    'DELETE /api/link': async () => { await store.disconnect(); return { ok: true }; },
    'POST /api/sync': async ({ body }) => { await body(); syncAll(); return { ok: true }; },
  },
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

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
    if (routes.has(req.method, url.pathname)) {
      const data = await routes.run(req.method, url.pathname, { query: url.searchParams, body: () => readJson(req) });
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
