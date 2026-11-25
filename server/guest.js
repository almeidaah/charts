// Guest access on the web version: a fixed sample list, read-only. Nothing is read from or written to the database.
import { HttpError } from './errors.js';

const crypto = (symbol, base, quote) => ({ id: `binance:${symbol}`, source: 'binance', symbol, label: symbol, name: `${base} / ${quote}`, type: 'CRYPTOCURRENCY', exchange: 'Binance', currency: quote, tz: 'UTC' });
const yahoo = (symbol, label, name, type, exchange, currency, tz) => ({ id: `yahoo:${symbol}`, source: 'yahoo', symbol, label, name, type, exchange, currency, tz });
const NY = 'America/New_York', SP = 'America/Sao_Paulo', LON = 'Europe/London';
export const SAMPLE = [
  crypto('BTCUSDT', 'BTC', 'USDT'), crypto('ETHUSDT', 'ETH', 'USDT'),
  yahoo('AAPL', 'AAPL', 'Apple Inc.', 'EQUITY', 'NasdaqGS', 'USD', NY),
  yahoo('MSFT', 'MSFT', 'Microsoft Corporation', 'EQUITY', 'NasdaqGS', 'USD', NY),
  yahoo('NVDA', 'NVDA', 'NVIDIA Corporation', 'EQUITY', 'NasdaqGS', 'USD', NY),
  yahoo('PETR4.SA', 'PETR4', 'Petróleo Brasileiro S.A. - Petrobras', 'EQUITY', 'São Paulo', 'BRL', SP),
  yahoo('VALE3.SA', 'VALE3', 'Vale S.A.', 'EQUITY', 'São Paulo', 'BRL', SP),
  yahoo('EURUSD=X', 'EURUSD', 'EUR/USD', 'CURRENCY', 'CCY', 'USD', LON),
  yahoo('^GSPC', 'SPX', 'S&P 500', 'INDEX', 'SNP', 'USD', NY),
  yahoo('^BVSP', 'IBOV', 'IBOVESPA', 'INDEX', 'São Paulo', 'BRL', SP),
  yahoo('GC=F', 'GOLD', 'Gold', 'FUTURE', 'COMEX', 'USD', NY),
];

// The only routes a guest can use. Drawings, indicators and groups stay in the guest's own browser.
const ALLOWED = new Set(['GET /api/status', 'GET /api/watchlist', 'GET /api/quotes', 'GET /api/candles', 'GET /api/icon']);
export const guestMay = (method, path) => ALLOWED.has(`${method} ${path}`);

export const guestStore = {
  watchlist: async () => SAMPLE.map(i => ({ ...i, flag: '', grp: '' })),
  instrument: async id => SAMPLE.find(i => i.id === id) ?? null,
};

// Protects the price providers from one address asking too much. Kept in memory, so it is approximate.
export function createLimiter({ max = 240, windowMs = 60_000, now = Date.now } = {}) {
  let start = now(), hits = new Map();
  return ip => {
    if (now() - start >= windowMs) { start = now(); hits = new Map(); }
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    if (n > max) throw new HttpError(429, 'Too many requests. Wait a minute.');
  };
}
