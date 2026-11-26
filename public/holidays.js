// Exchange holidays for the watchlist: NYSE/Nasdaq (US) and B3 (Brazil).
// Computed from the rules of each year, so there is no list to update.

const pad = n => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const keyOf = dt => key(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
const shift = (dt, days) => new Date(dt.getTime() + days * 86400000);

// Easter Sunday (Gregorian calendar, anonymous algorithm).
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month, day);
}

// nth weekday of a month (n = -1 is the last one). weekday: 0 = Sunday.
function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = utc(y, m, 1);
    return shift(first, ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
  }
  const last = utc(y, m + 1, 0);
  return shift(last, -((last.getUTCDay() - weekday + 7) % 7));
}

// Fixed-date US holiday moved to Friday (Saturday) or Monday (Sunday).
function observed(dt) {
  const wd = dt.getUTCDay();
  return wd === 6 ? shift(dt, -1) : wd === 0 ? shift(dt, 1) : dt;
}

function usHolidays(y) {
  const out = new Map();
  const add = (dt, name) => out.set(keyOf(dt), name);
  const newYear = utc(y, 1, 1);
  if (newYear.getUTCDay() !== 6) add(observed(newYear), "New Year's Day"); // NYSE does not close the Friday before
  add(nthWeekday(y, 1, 1, 3), 'Martin Luther King Jr. Day');
  add(nthWeekday(y, 2, 1, 3), "Washington's Birthday");
  add(shift(easter(y), -2), 'Good Friday');
  add(nthWeekday(y, 5, 1, -1), 'Memorial Day');
  if (y >= 2022) add(observed(utc(y, 6, 19)), 'Juneteenth');
  add(observed(utc(y, 7, 4)), 'Independence Day');
  add(nthWeekday(y, 9, 1, 1), 'Labor Day');
  add(nthWeekday(y, 11, 4, 4), 'Thanksgiving Day');
  add(observed(utc(y, 12, 25)), 'Christmas Day');
  return out;
}

function brHolidays(y) {
  const out = new Map();
  const add = (dt, name) => out.set(keyOf(dt), name);
  const e = easter(y);
  add(utc(y, 1, 1), 'Confraternização Universal');
  add(shift(e, -48), 'Carnaval');
  add(shift(e, -47), 'Carnaval');
  add(shift(e, -2), 'Sexta-feira Santa');
  add(utc(y, 4, 21), 'Tiradentes');
  add(utc(y, 5, 1), 'Dia do Trabalho');
  add(shift(e, 60), 'Corpus Christi');
  add(utc(y, 9, 7), 'Independência do Brasil');
  add(utc(y, 10, 12), 'Nossa Senhora Aparecida');
  add(utc(y, 11, 2), 'Finados');
  add(utc(y, 11, 15), 'Proclamação da República');
  if (y >= 2024) add(utc(y, 11, 20), 'Dia da Consciência Negra');
  add(utc(y, 12, 24), 'Véspera de Natal');
  add(utc(y, 12, 25), 'Natal');
  add(utc(y, 12, 31), 'Último dia do ano');
  return out;
}

const MARKETS = {
  'America/New_York': { calendar: usHolidays, name: 'US market' },
  'America/Chicago': { calendar: usHolidays, name: 'US market' }, // Cboe indices such as the VIX
  'America/Sao_Paulo': { calendar: brHolidays, name: 'B3' },
};
// Only exchange-traded assets follow these calendars; forex, futures and crypto do not.
const TYPES = ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'];

const cache = new Map();
function calendarFor(market, y) {
  const k = `${market.name}:${y}`;
  if (!cache.has(k)) cache.set(k, market.calendar(y));
  return cache.get(k);
}

// Date (YYYY-MM-DD) at the exchange right now.
const dayIn = (tz, now) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

// Returns { market, name } when the asset's exchange is closed for a holiday today, otherwise null.
export function holidayFor(inst, now = new Date()) {
  const market = MARKETS[inst?.tz];
  if (!market || inst.source !== 'yahoo' || !TYPES.includes(inst.type)) return null;
  const day = dayIn(inst.tz, now);
  const name = calendarFor(market, Number(day.slice(0, 4))).get(day);
  return name ? { market: market.name, name } : null;
}
