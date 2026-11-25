// Symbol logos. Fetched once by the server from public sources, checked, and cached.
const MAX_BYTES = 300_000;
const TIMEOUT = 6000;
const YAHOO_LOGOS = new Set(['s.yimg.com', 's2.coinmarketcap.com']);
const enc = encodeURIComponent;
const SAFE = /^[A-Z0-9][A-Z0-9.-]{0,14}$/i;

const binance = coin => `https://bin.bnbstatic.com/static/assets/logos/${enc(coin)}.png`;
const stock = symbol => `https://financialmodelingprep.com/image-stock/${enc(symbol)}.png`;
const b3 = code => `https://raw.githubusercontent.com/thefintz/icones-b3/main/icones/${enc(code)}.png`;

// Where to look, best first. Forex, futures and indices are drawn by the interface instead.
export function iconSources(inst) {
  if (inst.source === 'binance') {
    const coin = (inst.name ?? '').split(' / ')[0];
    return SAFE.test(coin) ? [binance(coin)] : [];
  }
  if (!SAFE.test(inst.symbol)) return [];
  if (inst.type === 'CRYPTOCURRENCY') return [binance(inst.symbol.replace(/-.*$/, ''))];
  if (!['EQUITY', 'ETF', 'MUTUALFUND'].includes(inst.type)) return [];
  if (/\.SA$/i.test(inst.symbol)) return [b3(inst.symbol.slice(0, -3).toUpperCase()), stock(inst.symbol)];
  return [stock(inst.symbol)];
}

// Yahoo knows the logo of some smaller coins.
async function yahooLogo(inst, fetchFn) {
  const res = await fetchFn(`https://query1.finance.yahoo.com/v1/finance/search?${new URLSearchParams({ q: inst.symbol, quotesCount: 3, newsCount: 0, enableLogoUrl: true })}`, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': 'Mozilla/5.0' } });
  const url = res.ok && (await res.json()).quotes?.find(q => q.symbol === inst.symbol)?.logoUrl;
  return url && new URL(url).protocol === 'https:' && YAHOO_LOGOS.has(new URL(url).hostname) ? url : null;
}

// The type comes from the bytes, never from the source. Only raster images are accepted.
export function imageType(b) {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// { data, type }, null when no source has it, or an error when a source could not be reached.
export async function fetchIcon(inst, fetchFn = (...a) => fetch(...a)) {
  let failure = null;
  const sources = iconSources(inst).map(u => () => u);
  if (inst.type === 'CRYPTOCURRENCY' && inst.source === 'yahoo' && sources.length) sources.push(() => yahooLogo(inst, fetchFn));
  for (const source of sources) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = await source();
        if (!url) break;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) break;
        const data = Buffer.from(await res.arrayBuffer()), type = imageType(data);
        if (type && data.length <= MAX_BYTES) return { data, type };
        break;
      } catch (e) { if (attempt) failure = e; }
    }
  }
  if (failure) throw failure;
  return null;
}

// Keeps icons so each one is asked for only once. "cache" needs get(id) and put(id, icon or null).
export function createIcons(cache, fetchFn) {
  const inflight = new Map();
  return async inst => {
    const hit = await cache.get(inst.id);
    if (hit !== undefined) return hit;
    if (!inflight.has(inst.id)) {
      inflight.set(inst.id, fetchIcon(inst, fetchFn)
        .then(async icon => { await cache.put(inst.id, icon); return icon; })
        .catch(() => null) // not cached: tried again next time
        .finally(() => inflight.delete(inst.id)));
    }
    return inflight.get(inst.id);
  };
}

export function memoryCache(max = 500) {
  const m = new Map();
  return { get: id => m.get(id), put: (id, icon) => { if (m.size >= max) m.clear(); m.set(id, icon); } };
}
