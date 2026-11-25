import test from 'node:test';
import assert from 'node:assert/strict';
import { assetName } from '../public/names.js';

test('names: what is shown under each ticker', () => {
  const cases = [
    [{ source: 'yahoo', symbol: 'O', label: 'O', name: 'Realty Income Corporation', type: 'EQUITY', currency: 'USD' }, 'Realty Income Corporation'],
    [{ source: 'yahoo', symbol: 'EURBRL=X', label: 'EURBRL', name: 'EUR/BRL', type: 'CURRENCY', currency: 'BRL' }, 'Euro / Brazilian Real'],
    [{ source: 'yahoo', symbol: 'BRL=X', label: 'USDBRL', name: 'USD/BRL', type: 'CURRENCY', currency: 'BRL' }, 'US Dollar / Brazilian Real'],
    [{ source: 'binance', symbol: 'BTCUSDT', label: 'BTCUSDT', name: 'BTC / USDT', type: 'CRYPTOCURRENCY', currency: 'USDT' }, 'Bitcoin / Tether'],
    [{ source: 'binance', symbol: 'USDTBRL', label: 'USDTBRL', name: 'USDT / BRL', type: 'CRYPTOCURRENCY', currency: 'BRL' }, 'Tether / Brazilian Real'],
    [{ source: 'binance', symbol: '1000SATSUSDT', label: '1000SATSUSDT', name: '1000SATS / USDT', type: 'CRYPTOCURRENCY', currency: 'USDT' }, '1000SATS / Tether'],
    [{ source: 'yahoo', symbol: 'NEXO-USD', label: 'NEXOUSD', name: 'Nexo USD', type: 'CRYPTOCURRENCY', currency: 'USD' }, 'Nexo / US Dollar'],
    [{ source: 'yahoo', symbol: '^BVSP', label: 'IBOV', name: 'IBOVESPA', type: 'INDEX', currency: 'BRL' }, 'IBOVESPA'],
    [{ source: 'yahoo', symbol: 'ABC', label: 'ABC', name: 'ABC', type: 'EQUITY', currency: 'USD' }, ''],
    [{ source: 'yahoo', symbol: 'ABC', label: 'ABC', name: null, type: 'EQUITY', currency: 'USD' }, ''],
  ];
  for (const [inst, want] of cases) assert.equal(assetName(inst), want, inst.symbol);
});
