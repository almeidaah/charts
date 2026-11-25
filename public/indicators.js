// Pure indicator math. Input: array of numbers; output: array of the same length (null = no value).

export function sma(src, n) {
  const out = new Array(src.length).fill(null);
  let sum = 0, run = 0; // run = consecutive valid values
  for (let i = 0; i < src.length; i++) {
    if (src[i] == null) { sum = 0; run = 0; continue; }
    sum += src[i]; run++;
    if (run > n) sum -= src[i - n];
    if (run >= n) out[i] = sum / n;
  }
  return out;
}

export function ema(src, n) {
  const out = new Array(src.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null, sum = 0, run = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] == null) continue;
    if (prev == null) { // seeded with the simple average of the first n
      sum += src[i];
      if (++run === n) out[i] = prev = sum / n;
    } else out[i] = prev = src[i] * k + prev * (1 - k);
  }
  return out;
}

// RSI with Wilder's smoothing.
export function rsi(src, n) {
  const out = new Array(src.length).fill(null);
  let up = 0, down = 0;
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= n) {
      up += u / n; down += w / n;
      if (i < n) continue;
    } else {
      up = (up * (n - 1) + u) / n;
      down = (down * (n - 1) + w) / n;
    }
    out[i] = down === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / down);
  }
  return out;
}

export const DEFAULTS = {
  ma: {
    on: true, visible: true,
    lines: [
      { on: true, type: 'EMA', n: 8, color: '#ffffff', width: 1.5 },
      { on: true, type: 'SMA', n: 20, color: '#ffeb3b', width: 1.5 },
      { on: true, type: 'SMA', n: 50, color: '#ff9800', width: 1.5 },
      { on: true, type: 'SMA', n: 200, color: '#f23645', width: 1.5 },
    ],
  },
  rsi: { on: true, visible: true, n: 14, maOn: true, maN: 14, high: 70, low: 30, color: '#8f6fd8', maColor: '#ffd740', frac: 0.2 },
  vol: { on: true, visible: true },
};

// Merges saved settings with the defaults, dropping invalid values.
export function withDefaults(saved) {
  const d = structuredClone(DEFAULTS);
  const s = saved && typeof saved === 'object' ? saved : {};
  const int = (v, def, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : def);
  const hex = (v, def) => (/^#[0-9a-f]{6}$/i.test(v) ? v : def);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  for (const k of ['ma', 'rsi', 'vol']) {
    d[k].on = bool(s[k]?.on, d[k].on);
    d[k].visible = bool(s[k]?.visible, d[k].visible);
  }
  d.ma.lines = d.ma.lines.map((l, i) => {
    const x = s.ma?.lines?.[i] ?? {};
    return { on: bool(x.on, l.on), type: ['SMA', 'EMA'].includes(x.type) ? x.type : l.type, n: int(x.n, l.n, 1, 2000), color: hex(x.color, l.color), width: l.width };
  });
  const r = d.rsi, x = s.rsi ?? {};
  Object.assign(r, {
    n: int(x.n, r.n, 2, 500), maOn: bool(x.maOn, r.maOn), maN: int(x.maN, r.maN, 1, 500),
    high: int(x.high, r.high, 51, 99), low: int(x.low, r.low, 1, 49),
    color: hex(x.color, r.color), maColor: hex(x.maColor, r.maColor),
    frac: x.frac >= 0.08 && x.frac <= 0.6 ? x.frac : r.frac,
  });
  return d;
}

export function compute(rows, cfg) {
  const close = rows.map(r => r.c);
  const avg = (src, type, n) => (type === 'EMA' ? ema(src, n) : sma(src, n));
  const r = cfg.rsi.on ? rsi(close, cfg.rsi.n) : null;
  return {
    ma: cfg.ma.on ? cfg.ma.lines.map(l => (l.on ? avg(close, l.type, l.n) : null)) : [],
    rsi: r, rsiMa: r && cfg.rsi.maOn ? sma(r, cfg.rsi.maN) : null,
  };
}
