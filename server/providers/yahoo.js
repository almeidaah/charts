// Yahoo Finance: stocks (US, B3 and other exchanges), ETFs, indices, forex, futures and crypto.
import { createClient, ProviderError } from './http.js';
import { BASE_SECONDS, localDay } from '../timeframes.js';

const HOST = 'https://query1.finance.yahoo.com';
const getJson = createClient({ name: 'Yahoo', concurrency: 3, headers: { 'User-Agent': 'Mozilla/5.0' } });

// How far back Yahoo goes on each timeframe.
const MAX_DAYS = { '1m': 7, '5m': 59, '15m': 59, '30m': 59, '1h': 729 };
export const QUOTE_TTL = 45_000; // ms between quote requests
const SESSION_TYPES = ['EQUITY', 'ETF', 'INDEX'];
const DAY_ONLY_WEEKDAYS = ['CURRENCY', 'FUTURE'];

const chartUrl = (symbol, params) =>
  `${HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams(params)}`;

async function chart(symbol, params) {
  const j = await getJson(chartUrl(symbol, params));
  const r = j.chart?.result?.[0];
  if (!r) throw new ProviderError(`Yahoo: ${j.chart?.error?.description ?? 'empty response'}`, 404);
  return r;
}

const TYPES = ['EQUITY', 'ETF', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY', 'FUTURE', 'MUTUALFUND'];

export async function search(text) {
  const j = await getJson(`${HOST}/v1/finance/search?${new URLSearchParams({ q: text, quotesCount: 15, newsCount: 0 })}`);
  return (j.quotes ?? []).filter(q => q.symbol && TYPES.includes(q.quoteType)).map(q => ({
    id: `yahoo:${q.symbol}`, source: 'yahoo', symbol: q.symbol, label: labelFor(q.symbol),
    name: (q.longname || q.shortname || '').trim(), type: q.quoteType, exchange: q.exchDisp ?? '',
  }));
}

const NICE = { 'GC=F': 'GOLD', 'SI=F': 'SILVER', 'CL=F': 'WTI', 'BZ=F': 'BRENT', 'HG=F': 'COPPER', 'NG=F': 'NATGAS', '^BVSP': 'IBOV', '^GSPC': 'SPX', '^IXIC': 'NASDAQ', '^NDX': 'NDX', '^DJI': 'DJI', '^VIX': 'VIX' };
function labelFor(symbol) {
  if (NICE[symbol]) return NICE[symbol];
  if (/^[A-Z]{3}=X$/.test(symbol)) return 'USD' + symbol.slice(0, 3); // BRL=X is the dollar in reais
  return symbol.replace(/\.SA$/, '').replace(/=X$/, '').replace(/-USD$/, 'USD');
}

// Yahoo sometimes answers with another name (BRL=X / USDBRL=X); what was asked for always wins.
export async function describe(symbol) {
  const { meta: m } = await chart(symbol, { interval: '1d', range: '5d' });
  return {
    id: `yahoo:${symbol}`, source: 'yahoo', symbol, label: labelFor(symbol),
    name: m.longName || m.shortName || m.symbol, type: m.instrumentType ?? '',
    exchange: m.fullExchangeName ?? '', currency: m.currency ?? '', tz: m.exchangeTimezoneName ?? 'UTC',
  };
}

// Turns the response into clean bars: no gaps, no duplicates, and with the live bar
// (which Yahoo returns with an odd timestamp) merged into the bar it belongs to.
export function normalize(result, tf, inst) {
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const meta = result.meta ?? {};
  const step = BASE_SECONDS[tf];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], c = q.close?.[i], rawH = q.high?.[i], rawL = q.low?.[i];
    if (o == null || c == null || rawH == null || rawL == null) continue;
    const r = { t: ts[i], o, c, h: Math.max(o, c, rawH), l: Math.min(o, c, rawL), v: q.volume?.[i] ?? 0 };
    const prev = out.at(-1);
    let merge = false;
    if (tf === '1d') {
      r.t = localDay(ts[i], inst.tz);
      const wd = new Date(r.t * 1000).getUTCDay();
      if (DAY_ONLY_WEEKDAYS.includes(inst.type) && (wd === 0 || wd === 6)) continue;
      merge = prev && prev.t === r.t;
    } else if (prev) {
      // Aligns the live bar with the others (US stocks open at :30, for example).
      const phase = prev.t % step;
      if (i === ts.length - 1) r.t = Math.floor((r.t - phase) / step) * step + phase;
      const isCloseMark = i === ts.length - 1 && r.v === 0 && r.o === r.c && SESSION_TYPES.includes(inst.type)
        && Math.abs(ts[i] - (meta.regularMarketTime ?? 0)) <= 120;
      merge = r.t - prev.t < step || (isCloseMark && r.t - prev.t <= step);
    }
    if (merge) {
      prev.h = Math.max(prev.h, r.h);
      prev.l = Math.min(prev.l, r.l);
      prev.c = r.c;
      prev.v = Math.max(prev.v, r.v);
    } else if (!prev || r.t > prev.t) out.push(r);
  }
  return out;
}

// since = null downloads everything available; otherwise only from there on.
export async function history(inst, tf, since) {
  const now = Math.floor(Date.now() / 1000);
  const oldest = tf === '1d' ? -3e9 : now - MAX_DAYS[tf] * 86400;
  const period1 = Math.max(since ?? oldest, oldest);
  const r = await chart(inst.symbol, {
    interval: tf, period1: Math.floor(period1), period2: now + 86400, includePrePost: false,
  });
  return normalize(r, tf, inst);
}

// Batch quotes (Yahoo accepts up to 20 per request).
export async function quotes(instruments) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < instruments.length; i += 20) chunks.push(instruments.slice(i, i + 20));
  await Promise.all(chunks.map(async list => {
    try {
      const symbols = list.map(i => encodeURIComponent(i.symbol)).join(',');
      const j = await getJson(`${HOST}/v8/finance/spark?symbols=${symbols}&range=1d&interval=1d`);
      for (const inst of list) out[inst.id] = parseQuote(j[inst.symbol], inst);
    } catch (e) { for (const inst of list) out[inst.id] = { error: e.message }; }
  }));
  return out;
}

export function parseQuote(s, inst) {
  const close = s?.close?.findLast(x => x != null) ?? null;
  const full = s?.fulldayPrice ?? null;
  if (close == null && full == null) return { error: 'Yahoo: no quote right now' };
  const gap = close && full ? (full / close - 1) * 100 : 0;
  const isExt = SESSION_TYPES.includes(inst.type) && inst.type !== 'INDEX' && Math.abs(gap) >= 0.02;
  const last = isExt ? close : (full ?? close);
  const prev = s.chartPreviousClose;
  return {
    last, chg: prev ? last - prev : null, pct: prev ? (last / prev - 1) * 100 : null,
    ext: isExt ? gap : null, time: s.timestamp?.at(-1) ?? null,
  };
}