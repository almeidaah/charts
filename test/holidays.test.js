import test from 'node:test';
import assert from 'node:assert/strict';
import { holidayFor, easter } from '../public/holidays.js';

const us = { source: 'yahoo', symbol: 'AAPL', type: 'EQUITY', tz: 'America/New_York' };
const br = { source: 'yahoo', symbol: 'PETR4.SA', type: 'EQUITY', tz: 'America/Sao_Paulo' };
// Noon at the exchange, so the local day is never in doubt.
const at = (inst, day) => holidayFor(inst, new Date(`${day}T15:00:00Z`))?.name ?? null;

test('holidays: Easter', () => {
  assert.equal(easter(2024).toISOString().slice(0, 10), '2024-03-31');
  assert.equal(easter(2026).toISOString().slice(0, 10), '2026-04-05');
  assert.equal(easter(2027).toISOString().slice(0, 10), '2027-03-28');
});

test('holidays: NYSE calendar, including observed days', () => {
  const closed = {
    '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday",
    '2026-04-03': 'Good Friday', '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth',
    '2026-07-03': 'Independence Day', '2026-09-07': 'Labor Day', '2026-11-26': 'Thanksgiving Day',
    '2026-12-25': 'Christmas Day', '2027-06-18': 'Juneteenth', '2027-07-05': 'Independence Day',
    '2027-12-24': 'Christmas Day', '2027-03-26': 'Good Friday',
  };
  for (const [day, name] of Object.entries(closed)) assert.equal(at(us, day), name, day);
  for (const day of ['2026-07-04', '2026-11-27', '2026-11-20', '2021-12-31', '2026-04-21'])
    assert.equal(at(us, day), null, day);
});

test('holidays: B3 calendar', () => {
  const closed = {
    '2026-01-01': 'Confraternização Universal', '2026-02-16': 'Carnaval', '2026-02-17': 'Carnaval',
    '2026-04-03': 'Sexta-feira Santa', '2026-04-21': 'Tiradentes', '2026-05-01': 'Dia do Trabalho',
    '2026-06-04': 'Corpus Christi', '2026-09-07': 'Independência do Brasil', '2026-10-12': 'Nossa Senhora Aparecida',
    '2026-11-02': 'Finados', '2026-11-20': 'Dia da Consciência Negra', '2026-12-24': 'Véspera de Natal',
    '2026-12-25': 'Natal', '2026-12-31': 'Último dia do ano',
  };
  for (const [day, name] of Object.entries(closed)) assert.equal(at(br, day), name, day);
  for (const day of ['2026-11-26', '2026-02-18', '2026-07-03', '2023-11-20']) assert.equal(at(br, day), null, day);
});

test('holidays: uses the date at the exchange, not on this computer', () => {
  // 02:00 UTC on Nov 27 is still Thanksgiving evening in New York.
  assert.equal(holidayFor(us, new Date('2026-11-27T02:00:00Z'))?.name, 'Thanksgiving Day');
  assert.equal(holidayFor(us, new Date('2026-11-27T06:00:00Z')), null);
});

test('holidays: only exchange-traded assets get the mark', () => {
  const day = new Date('2026-11-26T15:00:00Z');
  assert.equal(holidayFor({ ...us, type: 'ETF' }, day)?.market, 'US market');
  assert.equal(holidayFor({ ...us, symbol: '^GSPC', type: 'INDEX' }, day)?.market, 'US market');
  assert.equal(holidayFor({ ...us, symbol: '^VIX', type: 'INDEX', tz: 'America/Chicago' }, day)?.market, 'US market');
  assert.equal(holidayFor({ ...us, symbol: 'GC=F', type: 'FUTURE' }, day), null);
  assert.equal(holidayFor({ source: 'yahoo', symbol: 'BRL=X', type: 'CURRENCY', tz: 'Europe/London' }, day), null);
  assert.equal(holidayFor({ source: 'binance', symbol: 'BTCUSDT', type: 'CRYPTOCURRENCY', tz: 'UTC' }, day), null);
  assert.equal(holidayFor({ source: 'yahoo', symbol: 'SAP.DE', type: 'EQUITY', tz: 'Europe/Berlin' }, day), null);
  assert.equal(holidayFor({ ...us, tz: undefined }, day), null);
});
