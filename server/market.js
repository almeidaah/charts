// Local database + providers: download once, then only fetch what is missing.
import * as yahoo from './providers/yahoo.js';
import * as binance from './providers/binance.js';
import { TIMEFRAMES, BASE_SECONDS, aggregate } from './timeframes.js';

const OVERLAP = 10;        // bars re-downloaded on each update, to check and correct
const STALE_SECONDS = 10;  // do not ask the provider again before this

// Compares saved bars with fresh ones. If opens changed scale (split or reverse split),
// returns the ratio; otherwise 1.
export function splitRatio(stored, fresh) {
  const byT = new Map(fresh.map(r => [r.t, r]));
  const ratios = stored.map(s => byT.get(s.t)).map((f, i) => (f && stored[i].o ? f.o / stored[i].o : null))
    .filter(r => r > 0).sort((a, b) => a - b);
  if (ratios.length < 3) return 1;
  const med = ratios[Math.floor(ratios.length / 2)];
  const consistent = ratios.filter(r => Math.abs(r / med - 1) < 0.005).length >= ratios.length * 0.6;
  return consistent && Math.abs(med - 1) > 0.01 ? med : 1;
}

export function createMarket(db, providers = { yahoo, binance }) {
  const inflight = new Map();
  const quoteCache = new Map(); // source -> { at, key, data (promise) }

  async function doSync(inst, tf) {
    const provider = providers[inst.source];
    const stored = db.lastCandles(inst.id, tf, OVERLAP);
    if (stored.length < OVERLAP) {
      db.saveCandles(inst.id, tf, await provider.history(inst, tf, null));
      return;
    }
    const fresh = await provider.history(inst, tf, stored[0].t - BASE_SECONDS[tf]);
    if (!fresh.length) { db.touchSync(inst.id, tf); return; }
    const ratio = splitRatio(stored, fresh);
    if (ratio !== 1) {
      const full = await provider.history(inst, tf, null);
      db.saveCandles(inst.id, tf, full, ratio);
    } else db.saveCandles(inst.id, tf, fresh);
  }

  function sync(inst, tf, maxAge = STALE_SECONDS) {
    const last = db.syncedAt(inst.id, tf);
    if (last && Date.now() / 1000 - last < maxAge) return Promise.resolve();
    const key = `${inst.id}|${tf}`;
    if (!inflight.has(key)) {
      inflight.set(key, doSync(inst, tf).finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }

  return {
    sync,

    // Returns bars from the database after updating it. Offline, serves what is already saved.
    async candles(inst, tf, { since, offline = false } = {}) {
      const base = TIMEFRAMES[tf].base;
      let warning = null;
      if (!offline) {
        const update = sync(inst, base).catch(e => { warning = e.message; });
        // Already have history? Do not block the screen on the network: the next poll brings the rest.
        if (since == null && db.syncedAt(inst.id, base)) await Promise.race([update, new Promise(r => setTimeout(r, 500))]);
        else await update;
      }
      // Margin so the first aggregated bar is not cut in half (month = 31 days).
      const from = since == null ? undefined : since - 35 * 86400;
      let rows = aggregate(db.candles(inst.id, base, from), tf, inst);
      if (since != null) rows = rows.filter(r => r.t >= since);
      if (warning && !rows.length && since == null) throw new Error(warning);
      return { candles: rows, warning };
    },

    async quotes(list) {
      const by = src => list.filter(i => i.source === src);
      const parts = await Promise.all(Object.entries(providers).map(([src, p]) => {
        const items = by(src), key = items.map(i => i.id).sort().join();
        let hit = quoteCache.get(src);
        if (!hit || hit.key !== key || Date.now() - hit.at > p.QUOTE_TTL) {
          hit = { at: Date.now(), key, data: p.quotes(items) };
          quoteCache.set(src, hit);
        }
        return hit.data;
      }));
      return Object.assign({}, ...parts);
    },

    async search(text) {
      const r = await Promise.allSettled(Object.values(providers).map(p => p.search(text)));
      if (r.every(x => x.status === 'rejected')) throw r[0].reason;
      const [y = [], b = []] = r.map(x => (x.status === 'fulfilled' ? x.value : []));
      const up = text.toUpperCase();
      const exact = x => x.symbol.toUpperCase() === up || x.label.toUpperCase() === up;
      const all = [...y, ...b];
      return [...all.filter(exact), ...all.filter(x => !exact(x))];
    },

    async add(id) {
      let inst = db.instrument(id);
      if (!inst) {
        const i = id.indexOf(':');
        const source = id.slice(0, i), symbol = id.slice(i + 1);
        if (!Object.hasOwn(providers, source) || !symbol) throw new Error('Invalid symbol');
        inst = await providers[source].describe(symbol);
        db.saveInstrument(inst);
      }
      db.addToWatchlist(inst.id);
      return db.instrument(inst.id);
    },
  };
}
