// Binance (spot market): public data, no key, real time.
import { createClient, ProviderError } from './http.js';
import { BASE_SECONDS } from '../timeframes.js';

const HOST = 'https://api.binance.com';
const PAGE = 1000;
export const QUOTE_TTL = 8_000;
const MAX_CANDLES = 100_000; // cap per timeframe on the first download
const getJson = createClient({ name: 'Binance', concurrency: 6 });

let symbolsCache = null;
async function allSymbols() {
  if (!symbolsCache || Date.now() - symbolsCache.at > 6 * 3600e3) {
    const j = await getJson(`${HOST}/api/v3/exchangeInfo?permissions=SPOT&showPermissionSets=false`);
    symbolsCache = { at: Date.now(), list: j.symbols.filter(s => s.status === 'TRADING') };
  }
  return symbolsCache.list;
}

const toInst = s => ({
  id: `binance:${s.symbol}`, source: 'binance', symbol: s.symbol, label: s.symbol,
  name: `${s.baseAsset} / ${s.quoteAsset}`, type: 'CRYPTOCURRENCY', exchange: 'Binance',
  currency: s.quoteAsset, tz: 'UTC',
});

export async function search(text) {
  const t = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!t) return [];
  const rank = s => (s.symbol === t ? 0 : s.baseAsset === t ? 1 : s.symbol.startsWith(t) ? 2 : 3);
  const quoteRank = s => { const i = ['USDT', 'BRL', 'USDC', 'BTC'].indexOf(s.quoteAsset); return i < 0 ? 9 : i; };
  return (await allSymbols()).filter(s => s.symbol.includes(t))
    .sort((a, b) => rank(a) - rank(b) || quoteRank(a) - quoteRank(b) || a.symbol.localeCompare(b.symbol))
    .slice(0, 10).map(toInst);
}

export async function describe(symbol) {
  const s = (await allSymbols()).find(x => x.symbol === symbol);
  if (!s) throw new ProviderError('Binance: symbol not found', 404);
  return toInst(s);
}

async function page(symbol, tf, startTime, limit = PAGE) {
  const rows = await getJson(`${HOST}/api/v3/klines?${new URLSearchParams({ symbol, interval: tf, startTime, limit })}`);
  return rows.map(k => ({ t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

export async function history(inst, tf, since) {
  const step = BASE_SECONDS[tf];
  const now = Math.floor(Date.now() / 1000);
  let start = since;
  if (start == null) {
    const [first] = await page(inst.symbol, tf, 0, 1);
    if (!first) return [];
    start = Math.max(first.t, now - MAX_CANDLES * step);
  }
  const starts = [];
  for (let t = start; t <= now; t += PAGE * step) starts.push(t);
  const pages = await Promise.all(starts.map(t => page(inst.symbol, tf, Math.floor(t) * 1000)));
  const byTime = new Map();
  for (const r of pages.flat()) byTime.set(r.t, r);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

// Day change against the 00:00 UTC open, as on daily charts.
export async function quotes(instruments) {
  if (!instruments.length) return {};
  const symbols = JSON.stringify(instruments.map(i => i.symbol));
  try {
    const rows = await getJson(`${HOST}/api/v3/ticker/tradingDay?symbols=${encodeURIComponent(symbols)}`);
    return Object.fromEntries(rows.map(r => [`binance:${r.symbol}`, {
      last: +r.lastPrice, chg: +r.priceChange, pct: +r.priceChangePercent, ext: null,
      time: Math.floor(Date.now() / 1000),
    }]));
  } catch (e) {
    return Object.fromEntries(instruments.map(i => [i.id, { error: e.message }]));
  }
}
