// Market for the web: nothing is stored, prices come from the providers on each request (with a short memory cache).
import { TIMEFRAMES, aggregate } from './timeframes.js';
import { createMarket, dayStats } from './market.js';

const MAX = 15_000; // bars per request: fits the response limit and opens fast on a phone

export function createRemoteMarket(store, providers) {
  const base = createMarket(store, providers);
  const src = base.providers;
  const cache = new Map();
  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    if (cache.size > 200) cache.clear();
    const data = fn();
    cache.set(key, { at: Date.now(), data });
    data.catch(() => cache.delete(key));
    return data;
  }

  return {
    search: base.search,
    add: base.add,
    quotes: base.quotes,

    async candles(inst, tf, { since } = {}) {
      const b = TIMEFRAMES[tf].base;
      const history = from => src[inst.source].history(inst, b, from, { max: MAX });
      if (since == null) {
        const rows = await cached(`${inst.id}|${b}`, 20_000, () => history(null));
        return { candles: aggregate(rows.slice(-MAX), tf, inst), warning: null };
      }
      // Only the tail, with room to rebuild the aggregated bar that is still open.
      const margin = b === '1d' ? 35 * 86400 : 4 * 86400;
      const rows = await cached(`${inst.id}|${b}|${since}`, 8_000, () => history(since - margin));
      return { candles: aggregate(rows, tf, inst).filter(r => r.t >= since), warning: null };
    },

    async stats(inst) {
      const from = Math.floor(Date.now() / 1000) - 372 * 86400;
      return dayStats(await cached(`${inst.id}|stats`, 300_000, () => src[inst.source].history(inst, '1d', from, { max: 400 })));
    },
  };
}
