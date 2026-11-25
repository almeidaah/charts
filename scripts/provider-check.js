// Calls each provider a few times and reports what worked. Exits with 1 if anything failed.
import * as yahoo from '../server/providers/yahoo.js';
import * as binance from '../server/providers/binance.js';

const stock = { id: 'yahoo:AAPL', source: 'yahoo', symbol: 'AAPL', type: 'EQUITY', tz: 'America/New_York' };
const b3 = { id: 'yahoo:PETR4.SA', source: 'yahoo', symbol: 'PETR4.SA', type: 'EQUITY', tz: 'America/Sao_Paulo' };
const coin = { id: 'binance:BTCUSDT', source: 'binance', symbol: 'BTCUSDT', type: 'CRYPTOCURRENCY', tz: 'UTC' };
const week = () => Math.floor(Date.now() / 1000) - 7 * 86400;

const checks = {
  'yahoo search': async () => (await yahoo.search('apple')).length,
  'yahoo daily history': async () => (await yahoo.history(stock, '1d', null)).length,
  'yahoo intraday': async () => (await yahoo.history(stock, '5m', week())).length,
  'yahoo B3': async () => (await yahoo.history(b3, '1d', null)).length,
  'yahoo quotes': async () => Object.values(await yahoo.quotes([stock, b3])).filter(q => q.last != null).length,
  'binance history': async () => (await binance.history(coin, '1h', week())).length,
  'binance quotes': async () => Object.values(await binance.quotes([coin])).filter(q => q.last != null).length,
};

let failed = 0;
for (let round = 1; round <= 3; round++) {
  for (const [name, run] of Object.entries(checks)) {
    const t = Date.now();
    try {
      const n = await run();
      if (!n) throw new Error('empty result');
      console.log(`round ${round}  ok    ${name}: ${n} (${Date.now() - t} ms)`);
    } catch (e) {
      failed++;
      console.log(`round ${round}  FAIL  ${name}: ${e.message} (${Date.now() - t} ms)`);
    }
  }
}
console.log(failed ? `${failed} failed` : 'all providers answered');
process.exitCode = failed ? 1 : 0;
