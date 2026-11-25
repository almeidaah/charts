// Single Vercel function: handles everything under /api/*.
import pkg from '../package.json' with { type: 'json' };
import { createAuth } from '../server/auth.js';
import { createRemoteMarket } from '../server/remote-market.js';
import { createIcons, memoryCache } from '../server/icons.js';
import { createRoutes, HttpError, readJson, sendResult } from '../server/routes.js';
import { openTurso } from '../server/store-turso.js';

export function createHandler(env, { fetchFn, providers, iconFetch } = {}) {
  let app = null;
  function boot() {
    if (app) return app;
    // The Vercel integration may add a prefix to the names, such as STORAGE_TURSO_DATABASE_URL.
    const setting = name => {
      const key = env[name] ? name : Object.keys(env).find(k => k.endsWith(`_${name}`) && env[k]);
      if (!key) throw new HttpError(503, `Setup is incomplete: ${name} is missing in the Vercel project settings`);
      return env[key].trim();
    };
    const url = setting('TURSO_DATABASE_URL'), token = setting('TURSO_AUTH_TOKEN'), password = setting('APP_PASSWORD');
    const store = openTurso(url, token, fetchFn);
    let auth;
    try { auth = createAuth({ password, secret: token, store }); }
    catch (e) { throw new HttpError(503, `Setup is incomplete: ${e.message}`); }
    const market = createRemoteMarket(store, providers);
    const attempt = async fn => { const t = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (e) { return { ok: false, error: e.message }; } };
    const extra = {
      'GET /api/status': () => ({ version: pkg.version, cloud: true, sync: { running: false, seeding: false, done: 0, total: 0, errors: [] }, coverage: [] }),
      'GET /api/quotes': async ({ query }) => {
        const list = await store.watchlist();
        const focus = list.find(i => i.id === query.get('focus'));
        const [data, stats] = await Promise.all([market.quotes(list), focus ? market.stats(focus).catch(() => ({})) : {}]);
        if (focus) data[focus.id] = { ...data[focus.id], ...stats };
        return data;
      },
      'GET /api/selftest': async () => ({
        database: await attempt(() => store.meta('groups')),
        yahoo: await attempt(() => market.candles({ id: 'yahoo:AAPL', source: 'yahoo', symbol: 'AAPL', type: 'EQUITY', tz: 'America/New_York' }, '1d')),
        binance: await attempt(() => market.candles({ id: 'binance:BTCUSDT', source: 'binance', symbol: 'BTCUSDT', type: 'CRYPTOCURRENCY', tz: 'UTC' }, '1d', { since: Math.floor(Date.now() / 1000) - 86400 })),
      }),
    };
    return (app = { auth, routes: createRoutes({ store, market, icons: createIcons(memoryCache(), iconFetch), extra }) });
  }

  return async function handler(req, res) {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'https://x');
      const rewritten = url.searchParams.get('__path'); // the Vercel rewrite may pass the path here
      url.searchParams.delete('__path');
      const path = rewritten != null ? '/api/' + rewritten.replace(/^\/+/, '') : url.pathname.replace(/\/+$/, '');
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== host) throw new HttpError(403, 'Origin not allowed');

      if (req.method === 'GET' && path === '/api/ping') return send(200, { app: 'charts-app', cloud: true });
      const { auth, routes } = boot();
      if (req.method === 'POST' && path === '/api/login') {
        const { password } = await readJson(req, 10_000);
        const ip = req.headers['x-real-ip'] ?? (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
        const r = await auth.login(password, ip);
        if (r.locked) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
        if (!r.cookie) throw new HttpError(403, 'Wrong password');
        return send(200, { ok: true }, { 'Set-Cookie': r.cookie });
      }
      if (!auth.check(req.headers.cookie)) throw new HttpError(401, 'Sign in required');
      if (req.method === 'POST' && path === '/api/logout') return send(200, { ok: true }, { 'Set-Cookie': auth.logout() });
      if (!routes.has(req.method, path)) throw new HttpError(404, 'Not found');
      sendResult(res, await routes.run(req.method, path, { query: url.searchParams, body: () => readJson(req) }));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      if (status >= 500) console.error(req.method, req.url?.split('?')[0], e.message);
      send(status, { error: e.message });
    }
  };
}

export default createHandler(process.env);
