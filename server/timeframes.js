// Timeframes. "Base" ones are downloaded and stored; the rest are built from them.
export const TIMEFRAMES = {
  '1m':  { base: '1m' },
  '3m':  { base: '1m', seconds: 180 },
  '5m':  { base: '5m' },
  '15m': { base: '15m' },
  '30m': { base: '30m' },
  '45m': { base: '15m', seconds: 2700 },
  '1h':  { base: '1h' },
  '2h':  { base: '1h', seconds: 2 * 3600 },
  '3h':  { base: '1h', seconds: 3 * 3600 },
  '4h':  { base: '1h', seconds: 4 * 3600 },
  '1d':  { base: '1d' },
  '1w':  { base: '1d', calendar: 'week' },
  '1M':  { base: '1d', calendar: 'month' },
};

export const BASE_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400 };

const fmtCache = new Map();
function dayFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

// Local date (in the exchange's time zone) expressed as midnight UTC.
export function localDay(t, tz) {
  if (tz === 'UTC') return Math.floor(t / 86400) * 86400;
  return Date.parse(dayFormatter(tz).format(new Date(t * 1000)) + 'T00:00:00Z') / 1000;
}

export function weekStart(t) {
  const day = Math.floor(t / 86400);
  return (day - ((((day + 3) % 7) + 7) % 7)) * 86400; // Monday (1970-01-01 was a Thursday)
}

export function monthStart(t) {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

// Exchanges with sessions: 45m/2h/3h/4h count from the open. 24h markets: from midnight UTC.
const hasSession = inst => ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(inst.type);

export function aggregate(rows, tf, inst) {
  const spec = TIMEFRAMES[tf];
  if (!spec.calendar && !spec.seconds) return rows;
  const out = [];
  let cur = null, curKey = null, day = null, anchor = 0;
  for (const r of rows) {
    let key;
    if (spec.calendar === 'week') key = weekStart(r.t);
    else if (spec.calendar === 'month') key = monthStart(r.t);
    else if (hasSession(inst)) {
      const d = localDay(r.t, inst.tz);
      if (d !== day) { day = d; anchor = r.t; }
      key = anchor + Math.floor((r.t - anchor) / spec.seconds) * spec.seconds;
    } else key = Math.floor(r.t / spec.seconds) * spec.seconds;

    if (key !== curKey) {
      cur = { t: key, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
      curKey = key;
      out.push(cur);
    } else {
      if (r.h > cur.h) cur.h = r.h;
      if (r.l < cur.l) cur.l = r.l;
      cur.c = r.c;
      cur.v += r.v;
    }
  }
  return out;
}
