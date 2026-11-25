// Desktop store that shares user data with the web version. Price history stays in the local database.
// Reads come from the web and are copied locally, so the last known state is still there when offline.
// Writes must reach the web first; if they cannot, nothing changes anywhere.
import { HttpError } from './errors.js';

const TIMEOUT = 15_000;
const SHARED_META = { groups: 'groups', indicators: 'indicators' };

export function cleanUrl(text) {
  let u;
  try { const t = String(text).trim(); u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`); } catch { throw new HttpError(400, 'Enter the address of your site'); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new HttpError(400, 'The address must start with https://');
  return u.origin;
}

async function call(origin, cookie, method, path, json, fetchFn) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchFn(`${origin}/api/${path}`, {
        method, signal: AbortSignal.timeout(TIMEOUT), redirect: 'error',
        headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: json ? JSON.stringify(json) : undefined,
      });
      break;
    } catch (e) {
      // Dropped connections are retried once, but only for requests that are safe to repeat.
      if (attempt < 1 && method === 'GET') continue;
      throw new HttpError(503, method === 'GET' ? 'No connection to your site.' : 'No connection to your site. The change was not saved.');
    }
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new HttpError(res.status === 401 ? 409 : res.status, res.status === 401 ? 'Your site asks you to sign in again: More > Web sync' : data?.error ?? `Your site answered with error ${res.status}`);
  return { data, res };
}

export function createLinkedStore(db, fetchFn = (...a) => fetch(...a)) {
  const state = { online: true, error: null };
  const link = () => JSON.parse(db.meta('link') ?? 'null');

  async function remote(method, path, json) {
    const l = link();
    try {
      const { data } = await call(l.url, l.cookie, method, path, json, fetchFn);
      state.online = true; state.error = null;
      return data;
    } catch (e) {
      state.online = e.status !== 503;
      state.error = e.message;
      throw e;
    }
  }
  // Reads fall back to the local copy when the site cannot be reached.
  async function read(path, keep, local) {
    if (!link()) return local();
    let data;
    try { data = await remote('GET', path); } catch { return local(); }
    keep(data);
    return data;
  }
  const write = async (method, path, json, local) => { if (link()) await remote(method, path, json); return local(); };
  const q = o => new URLSearchParams(o);

  return {
    ...db,
    watchlist: () => read('watchlist', list => db.mirrorWatchlist(list), db.watchlist),
    addToWatchlist: id => write('POST', 'watchlist', { id }, () => db.addToWatchlist(id)),
    removeFromWatchlist: id => write('DELETE', `watchlist?${q({ id })}`, null, () => db.removeFromWatchlist(id)),
    flagWatchlist: (id, flag) => write('PUT', 'watchlist/flag', { id, flag }, () => db.flagWatchlist(id, flag)),
    groupWatchlist: (id, grp) => write('PUT', 'watchlist/group', { id, grp }, () => db.groupWatchlist(id, grp)),
    reorderWatchlist: ids => write('PUT', 'watchlist/order', { ids }, () => db.reorderWatchlist(ids)),
    drawings: id => read(`drawings?${q({ id })}`, items => db.mirrorDrawings(id, items), () => db.drawings(id)),
    changeDrawings: (id, put, del) => write('POST', 'drawings', { id, put, del }, () => db.changeDrawings(id, put, del)),
    meta: key => (SHARED_META[key] ? read(SHARED_META[key], v => { if (v) db.setMeta(key, JSON.stringify(v)); }, () => null).then(v => (v == null ? db.meta(key) : JSON.stringify(v))) : db.meta(key)),
    setMeta: (key, value) => (SHARED_META[key] ? write('PUT', SHARED_META[key], JSON.parse(value), () => db.setMeta(key, value)) : db.setMeta(key, value)),
    exportAll: async () => (link() ? (({ instruments, watchlist, drawings }) => ({ instruments, watchlist, drawings }))(await remote('GET', 'backup')) : db.exportAll()),
    importAll: async b => { if (link()) await remote('POST', 'backup', { ...b, meta: {} }); db.importAll(b); },
    rev: async () => {
      if (!link()) return db.rev();
      try { return (await remote('GET', 'rev')).rev; } catch { return null; } // unknown while offline
    },

    linkStatus: () => { const l = link(); return l && { url: l.url, online: state.online, error: state.error }; },

    // Signs in to the site, sends what it does not have yet, and starts using it. The password is not stored.
    async connect(address, password) {
      const url = cleanUrl(address);
      const ping = await call(url, null, 'GET', 'ping', null, fetchFn).catch(() => null);
      if (ping?.data?.app !== 'charts-app' || !ping.data.cloud) throw new HttpError(400, 'No Charts site was found at this address');
      const { res } = await call(url, null, 'POST', 'login', { password }, fetchFn);
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
      if (!cookie) throw new HttpError(502, 'Your site did not accept the sign-in');

      const there = (await call(url, cookie, 'GET', 'backup', null, fetchFn)).data, here = db.exportAll();
      const ids = new Set(there.watchlist.map(w => w.id)), uids = new Set(there.drawings.map(d => d.data.uid));
      const missing = {
        app: 'charts', version: 1, instruments: here.instruments,
        watchlist: here.watchlist.filter(w => !ids.has(w.id)),
        drawings: here.drawings.filter(d => !uids.has(d.data.uid)),
        meta: Object.fromEntries(Object.keys(SHARED_META).map(k => [k, there.meta[k] ? null : JSON.parse(db.meta(k) ?? 'null')])),
      };
      await call(url, cookie, 'POST', 'backup', missing, fetchFn);
      db.setMeta('link', JSON.stringify({ url, cookie }));
      state.online = true; state.error = null;
      const all = (await call(url, cookie, 'GET', 'backup', null, fetchFn)).data;
      db.mirrorAll(all);
      return { url, sent: { watchlist: missing.watchlist.length, drawings: missing.drawings.length }, total: { watchlist: all.watchlist.length, drawings: all.drawings.length } };
    },
    async disconnect() {
      const l = link();
      if (!l) return;
      await call(l.url, l.cookie, 'POST', 'logout', {}, fetchFn).catch(() => {});
      db.setMeta('link', 'null');
    },
  };
}
