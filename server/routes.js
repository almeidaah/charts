// API routes, shared by the desktop (SQLite) and the web (Turso). "store" keeps user data; "market" fetches prices.
import { TIMEFRAMES } from './timeframes.js';

import { HttpError } from './errors.js';

export { HttpError };

const FLAGS = ['', 'red', 'blue', 'green', 'amber', 'violet', 'cyan', 'pink'];
const UID = /^[\w-]{6,40}$/;
const ID = /^(yahoo|binance):\S{1,40}$/;
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const text = (x, max) => typeof x === 'string' && x.length <= max;

export const validDrawing = d => isObj(d) && UID.test(d.uid) && typeof d.tool === 'string'
  && Array.isArray(d.pts) && d.pts.length > 0 && d.pts.length <= 5000
  && d.pts.every(p => Number.isFinite(p?.t) && Number.isFinite(p?.p));

function validGroups(g) {
  const names = x => Array.isArray(x) && x.length <= 100 && x.every(n => text(n, 30));
  return isObj(g) && typeof g.on === 'boolean' && names(g.order) && names(g.closed);
}

function validInstrument(i) {
  if (!isObj(i) || !ID.test(i.id) || i.id !== `${i.source}:${i.symbol}`) return false;
  if (!['label', 'name', 'type', 'exchange', 'currency', 'tz'].every(k => text(i[k], 200))) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: i.tz }); return true; } catch { return false; }
}

export function validBackup(b) {
  if (!isObj(b) || b.app !== 'charts') return false;
  const arr = (x, max) => Array.isArray(x) && x.length <= max;
  if (!arr(b.instruments, 5000) || !arr(b.watchlist, 5000) || !arr(b.drawings, 20000) || !isObj(b.meta)) return false;
  const ids = new Set(b.instruments.map(i => i?.id));
  return b.instruments.every(validInstrument)
    && b.watchlist.every(w => isObj(w) && ids.has(w.id) && FLAGS.includes(w.flag) && text(w.grp, 30))
    && b.drawings.every(x => isObj(x) && ids.has(x.id) && validDrawing(x.data))
    && (b.meta.groups == null || validGroups(b.meta.groups))
    && (b.meta.indicators == null || isObj(b.meta.indicators));
}

export function createRoutes({ store, market, icons, extra = {} }) {
  async function known(id) {
    const inst = id && await store.instrument(id);
    if (!inst) throw new HttpError(404, 'Unknown symbol');
    return inst;
  }
  const meta = async (key, fallback) => JSON.parse(await store.meta(key) ?? 'null') ?? fallback;
  const ok = { ok: true };

  const routes = {
    'GET /api/watchlist': () => store.watchlist(),
    'POST /api/watchlist': async ({ body }) => {
      const { id } = await body();
      if (!ID.test(id)) throw new HttpError(400, 'Invalid symbol');
      const inst = await market.add(id);
      market.sync?.(inst, '1d').catch(() => {});
      return inst;
    },
    'DELETE /api/watchlist': async ({ query }) => { await store.removeFromWatchlist(query.get('id') ?? ''); return ok; },
    'PUT /api/watchlist/flag': async ({ body }) => {
      const { id, flag } = await body();
      if (!FLAGS.includes(flag)) throw new HttpError(400, 'Invalid color');
      await store.flagWatchlist((await known(id)).id, flag);
      return ok;
    },
    'PUT /api/watchlist/group': async ({ body }) => {
      const { id, grp } = await body();
      if (!text(grp, 30)) throw new HttpError(400, 'Invalid group');
      await store.groupWatchlist((await known(id)).id, grp);
      return ok;
    },
    'PUT /api/watchlist/order': async ({ body }) => {
      const { ids } = await body();
      if (!Array.isArray(ids) || ids.length > 5000 || !ids.every(x => typeof x === 'string')) throw new HttpError(400, 'Invalid list');
      await store.reorderWatchlist(ids);
      return ok;
    },
    // Goes up with every change, so open screens know when to refresh.
    'GET /api/rev': async () => ({ rev: await store.rev() }),
    'GET /api/groups': () => meta('groups', {}),
    'PUT /api/groups': async ({ body }) => {
      const g = await body();
      if (!validGroups(g)) throw new HttpError(400, 'Invalid groups');
      await store.setMeta('groups', JSON.stringify({ on: g.on, order: g.order, closed: g.closed }));
      return ok;
    },
    'GET /api/search': ({ query }) => {
      const q = (query.get('q') ?? '').trim();
      return q ? market.search(q.slice(0, 60)) : [];
    },
    'GET /api/candles': async ({ query }) => {
      const inst = await known(query.get('id'));
      const tf = query.get('tf') ?? '1d';
      if (!Object.hasOwn(TIMEFRAMES, tf)) throw new HttpError(400, 'Invalid timeframe');
      const since = query.has('since') ? Number(query.get('since')) : undefined;
      if (since !== undefined && !Number.isFinite(since)) throw new HttpError(400, 'Invalid since');
      const { candles, warning } = await market.candles(inst, tf, { since });
      // Compact format: [t,o,h,l,c,v]
      const n = x => Number(x.toPrecision(10));
      return { warning, candles: candles.map(r => [r.t, n(r.o), n(r.h), n(r.l), n(r.c), n(r.v)]) };
    },
    'GET /api/icon': async ({ query }) => {
      const icon = await icons(await known(query.get('id')));
      if (!icon) throw new HttpError(404, 'No icon');
      return { binary: icon.data, type: icon.type };
    },
    'GET /api/drawings': async ({ query }) => store.drawings((await known(query.get('id'))).id),
    'POST /api/drawings': async ({ body }) => {
      const { id, put = [], del = [] } = await body();
      const inst = await known(id);
      if (!Array.isArray(put) || !Array.isArray(del) || !del.every(u => UID.test(u)) || !put.every(validDrawing)) {
        throw new HttpError(400, 'Invalid drawing');
      }
      await store.changeDrawings(inst.id, put, del);
      return ok;
    },
    'GET /api/indicators': () => meta('indicators', null),
    'PUT /api/indicators': async ({ body }) => {
      const cfg = await body();
      if (!isObj(cfg)) throw new HttpError(400, 'Invalid settings');
      await store.setMeta('indicators', JSON.stringify(cfg));
      return ok;
    },
    // Everything that belongs to the user, to move between desktop and web or to keep as a backup.
    'GET /api/backup': async () => ({
      app: 'charts', version: 1, ...await store.exportAll(),
      meta: { groups: await meta('groups', null), indicators: await meta('indicators', null) },
    }),
    'POST /api/backup': async ({ body }) => {
      const b = await body();
      if (!validBackup(b)) throw new HttpError(400, 'This file is not a Charts backup');
      await store.importAll(b);
      for (const k of ['groups', 'indicators']) if (b.meta[k]) await store.setMeta(k, JSON.stringify(b.meta[k]));
      return { watchlist: b.watchlist.length, drawings: b.drawings.length };
    },
    ...extra,
  };

  return {
    has: (method, path) => Object.hasOwn(routes, `${method} ${path}`),
    run: (method, path, ctx) => routes[`${method} ${path}`](ctx),
  };
}

// Sends what a route returned: JSON, or a cached image.
export function sendResult(res, data) {
  if (data?.binary) {
    res.writeHead(200, { 'Content-Type': data.type, 'Cache-Control': 'private, max-age=2592000', 'X-Content-Type-Options': 'nosniff' });
    res.end(data.binary);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
}

// Reads the JSON body of a Node request (on Vercel it may already be parsed in req.body).
export async function readJson(req, max = 4e6) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
  try { if (isObj(req.body)) return req.body; } catch { throw new HttpError(400, 'Invalid JSON'); }
  let s = '';
  if (typeof req.body === 'string') s = req.body;
  else {
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw new HttpError(413, 'Too large');
      parts.push(Buffer.from(chunk));
    }
    s = Buffer.concat(parts).toString('utf8');
  }
  let v;
  try { v = JSON.parse(s); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!isObj(v)) throw new HttpError(400, 'Invalid JSON');
  return v;
}
