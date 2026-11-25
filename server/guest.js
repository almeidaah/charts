// Guest access on the web version: its own small watchlist, kept apart from the owner's data.
import { HttpError } from './errors.js';

export const LIMITS = { symbols: 40, instruments: 300, drawings: 300, drawingBytes: 20_000, settingBytes: 20_000 };

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
const sampleBackup = { instruments: SAMPLE, watchlist: SAMPLE.map(i => ({ id: i.id, flag: '', grp: '' })), drawings: [] };

// Wraps the guest tables: fills them with the sample on first use, and keeps them small.
export function createGuestStore(store) {
  let ready = null;
  function seed() {
    ready ??= (async () => {
      if (await store.meta('seeded')) return;
      await store.importAll(sampleBackup);
      await store.setMeta('seeded', '1');
    })().catch(e => { ready = null; throw e; });
    return ready;
  }
  const full = what => new HttpError(403, `The guest area is limited to ${what}`);
  return {
    ...store,
    watchlist: async () => { await seed(); return store.watchlist(); },
    instrument: async id => { await seed(); return store.instrument(id); },
    async saveInstrument(i) {
      if (await store.count('instruments') >= LIMITS.instruments) throw full(`${LIMITS.instruments} different symbols`);
      return store.saveInstrument(i);
    },
    async addToWatchlist(id) {
      if (await store.count('watchlist') >= LIMITS.symbols) throw full(`${LIMITS.symbols} symbols`);
      return store.addToWatchlist(id);
    },
    async changeDrawings(id, put, del) {
      if (put.some(d => JSON.stringify(d).length > LIMITS.drawingBytes)) throw full('smaller drawings');
      if (put.length && await store.count('drawings') + put.length > LIMITS.drawings) throw full(`${LIMITS.drawings} drawings`);
      return store.changeDrawings(id, put, del);
    },
    async setMeta(key, value) {
      if (value.length > LIMITS.settingBytes) throw full('smaller settings');
      return store.setMeta(key, value);
    },
    // Back to the sample list.
    async reset() {
      await store.clear();
      ready = null;
      await seed();
    },
  };
}
