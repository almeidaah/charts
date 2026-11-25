import { compute, withDefaults } from './indicators.js';

// Canvas chart engine, no dependencies.
// Positions: X is the (fractional) bar index, Y is price (or log of price).

export const THEME = {
  bg: '#12151c', grid: '#1d222c', axis: '#2a303c', text: '#98a1b0', strong: '#e4e8ee',
  up: '#1fa58a', down: '#ef5350', line: '#5b9cf5', cross: '#6b7484', label: '#39414f',
};
const FONT = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const AXIS_H = 28;

const niceStep = raw => {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};

export function heikinAshi(rows) {
  let po, pc;
  return rows.map((r, i) => {
    const c = (r.o + r.h + r.l + r.c) / 4;
    const o = i ? (po + pc) / 2 : (r.o + r.c) / 2;
    po = o; pc = c;
    return { t: r.t, o, c, h: Math.max(r.h, o, c), l: Math.min(r.l, o, c), v: r.v };
  });
}

// First index with t >= target.
export function lowerBound(rows, t) {
  let a = 0, b = rows.length;
  while (a < b) { const m = (a + b) >> 1; if (rows[m].t < t) a = m + 1; else b = m; }
  return a;
}

export class Chart {
  constructor(canvas, { onHover, onAutoChange, onLayout } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover ?? (() => {});
    this.onAutoChange = onAutoChange ?? (() => {});
    this.onLayout = onLayout ?? (() => {});
    this.layer = null; // drawing layer
    this.cfg = withDefaults(null);
    this.ind = { ma: [], rsi: null, rsiMa: null };
    this.raw = []; this.rows = []; this.weights = [];
    this.type = 'candles'; this.log = true; this.auto = true;
    this.barW = 8; this.right = 0; this.y0 = 0; this.y1 = 1;
    this.intraday = false; this.decimals = 2; this.step = 86400;
    this.mouse = null; this.axisW = 70; this.w = 0; this.h = 0;
    this.#bind();
    new ResizeObserver(() => this.#resize()).observe(canvas.parentElement);
    this.#resize();
  }

  // ---------- data ----------
  setData(rows, { intraday, decimals, seconds = 86400 }) {
    this.raw = rows; this.intraday = intraday; this.decimals = decimals; this.tfSeconds = seconds;
    this.#rebuild(); this.setAuto(true); this.resetView();
  }

  updateTail(tail) {
    if (!tail.length) return;
    const follow = this.right >= this.raw.length - 1;
    const before = this.raw.length;
    const keep = lowerBound(this.raw, tail[0].t);
    this.raw = [...this.raw.slice(0, keep), ...tail];
    this.#rebuild();
    if (follow) this.right += this.raw.length - before;
    this.draw();
  }

  #rebuild() {
    this.rows = this.type === 'heikin' ? heikinAshi(this.raw) : this.raw;
    this.ind = compute(this.raw, this.cfg);
    // Average bar spacing, to place drawings in the future.
    const n = Math.min(200, this.raw.length - 1);
    this.step = n > 0 ? (this.raw.at(-1).t - this.raw.at(-1 - n).t) / n : this.tfSeconds;
    // Weight of each bar for axis labels: change of year > month > day > hour > rest.
    let py, pm, pd, ph;
    this.weights = this.raw.map(r => {
      const d = new Date(r.t * 1000);
      const [y, m, day, h] = this.intraday
        ? [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]
        : [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0];
      const w = y !== py ? 5 : m !== pm ? 4 : day !== pd ? 3 : h !== ph ? 2 : 1;
      py = y; pm = m; pd = day; ph = h;
      return w;
    });
  }

  // Replaces the data without losing the view (used when fresh history replaces cached history).
  refresh(rows) {
    if (!this.raw.length || !rows.length) return;
    const follow = this.right >= this.raw.length - 1, gap = this.right - (this.raw.length - 1), t = this.timeAt(this.right);
    this.raw = rows; this.#rebuild();
    this.right = follow ? rows.length - 1 + gap : this.indexOf(t, true);
    this.#clampRight(); this.draw();
  }

  setType(type) { this.type = type; this.#rebuild(); this.draw(); }
  setLog(on) { this.log = on; this.setAuto(true); }
  setIndicators(cfg) { this.cfg = cfg; this.ind = compute(this.raw, cfg); this.draw(); }
  get showVolume() { return this.cfg.vol.on && this.cfg.vol.visible; }
  get showMa() { return this.cfg.ma.on && this.cfg.ma.visible; }
  setAuto(on) { this.auto = on; this.onAutoChange(on); this.draw(); }

  // ---------- view ----------
  resetView() {
    this.barW = 8;
    this.right = this.rows.length - 1 + Math.min(6, this.plotW / this.barW / 5);
    this.draw();
  }
  showRange(from, to = Infinity) {
    if (!this.rows.length) return;
    const a = lowerBound(this.rows, from);
    const b = to === Infinity ? this.rows.length : lowerBound(this.rows, to);
    const n = Math.max(b - a, 5);
    this.barW = this.#clampBar(this.plotW / (n * 1.04 + 1));
    this.right = b - 1 + (this.plotW / this.barW - n) / 2;
    this.setAuto(true);
  }
  goTo(t) {
    if (!this.rows.length) return false;
    const i = Math.min(lowerBound(this.rows, t), this.rows.length - 1);
    this.right = i + this.plotW / this.barW / 2;
    this.setAuto(true);
    return t >= this.rows[0].t - 7 * 86400;
  }
  #clampBar(w) { return Math.min(80, Math.max(0.15, w)); }
  #clampRight() {
    const span = this.plotW / this.barW, n = this.rows.length;
    this.right = Math.min(n - 1 + span * 0.85, Math.max(Math.min(4, n - 1), this.right));
  }
  #zoom(factor, x) {
    const i = this.idx(x);
    this.barW = this.#clampBar(this.barW * factor);
    this.right = i + (this.plotW - x) / this.barW;
    this.#clampRight(); this.draw();
  }

  // ---------- coordinates ----------
  // Time <-> index. A point falls on the bar containing that time; outside the data it extrapolates.
  indexOf(t, exact = false) {
    const rows = this.raw, n = rows.length;
    if (!n) return 0;
    if (t < rows[0].t) return (t - rows[0].t) / this.step;
    if (t >= rows[n - 1].t) {
      const over = t - rows[n - 1].t;
      return exact || over >= this.tfSeconds - 1 ? n - 1 + over / this.step : n - 1;
    }
    const j = lowerBound(rows, t);
    if (rows[j].t === t) return j;
    if (exact) return j - 1 + (t - rows[j - 1].t) / (rows[j].t - rows[j - 1].t);
    return t - rows[j - 1].t < this.tfSeconds ? j - 1 : j;
  }
  timeAt(i) {
    const rows = this.raw, n = rows.length;
    if (i <= 0) return rows[0].t + i * this.step;
    if (i >= n - 1) return rows[n - 1].t + (i - n + 1) * this.step;
    const a = Math.floor(i);
    return rows[a].t + (i - a) * (rows[a + 1].t - rows[a].t);
  }
  x(i) { return this.plotW - (this.right - i) * this.barW; }
  idx(x) { return this.right - (this.plotW - x) / this.barW; }
  get isLog() { return this.log && this.logOk; }
  f(p) { return this.isLog ? Math.log(p) : p; }
  inv(v) { return this.isLog ? Math.exp(v) : v; }
  y(p) { return this.plotH * (1 - (this.f(p) - this.y0) / (this.y1 - this.y0)); }
  price(y) { return this.inv(this.y0 + (1 - y / this.plotH) * (this.y1 - this.y0)); }
  fmt(p) {
    return p.toLocaleString('en-US', { minimumFractionDigits: this.decimals, maximumFractionDigits: this.decimals });
  }

  // ---------- input ----------
  #bind() {
    const c = this.canvas;
    const pointers = new Map();
    let drag = null, pinch = 0, hold = 0;
    const pos = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const zone = p => (p.y > this.paneH ? 'time'
      : this.rsiH && Math.abs(p.y - this.plotH) <= 4 ? 'sep'
      : p.y > this.plotH ? (p.x > this.plotW ? 'rsiaxis' : 'rsi')
      : p.x > this.plotW ? 'price' : 'plot');

    c.addEventListener('pointerdown', e => {
      if (e.button > 0 || !this.raw.length) return;
      c.setPointerCapture(e.pointerId);
      const p = pos(e), touch = e.pointerType === 'touch';
      this.touch = touch;
      this.mouse = touch ? null : p;
      clearTimeout(hold);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; this.layer?.cancelDrag(); if (this.layer?.draft) this.layer.cancel();
      } else if (zone(p) === 'plot' && this.layer?.down(p, e)) drag = { zone: 'layer' };
      else {
        drag = { ...p, zone: zone(p), right: this.right, barW: this.barW, y0: this.y0, y1: this.y1 };
        // Touch: press and hold shows the crosshair, then dragging moves it.
        if (touch && (drag.zone === 'plot' || drag.zone === 'rsi')) hold = setTimeout(() => { drag = { zone: 'cross' }; this.mouse = p; this.draw(); }, 350);
      }
    });
    c.addEventListener('pointermove', e => {
      const p = pos(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.#zoom(d / pinch, (a.x + b.x) / 2); pinch = d;
        return;
      }
      const touch = e.pointerType === 'touch';
      if (touch && drag && drag.x != null && Math.hypot(p.x - drag.x, p.y - drag.y) > 8) clearTimeout(hold);
      if (drag?.zone === 'layer' || (!drag && this.layer?.drafting)) this.layer.move(p, e);
      else if (drag && drag.zone !== 'cross') {
        const dx = p.x - drag.x, dy = p.y - drag.y;
        if (drag.zone === 'sep') {
          this.cfg.rsi.frac = Math.min(0.6, Math.max(0.08, 1 - p.y / this.paneH));
        } else if (drag.zone === 'plot' || drag.zone === 'rsi') {
          this.right = drag.right - dx / drag.barW; this.#clampRight();
          if (!this.auto && drag.zone === 'plot') {
            const s = (dy / this.plotH) * (drag.y1 - drag.y0);
            this.y0 = drag.y0 + s; this.y1 = drag.y1 + s;
          }
        } else if (drag.zone === 'price' && Math.abs(dy) > 2) {
          if (this.auto) { this.auto = false; this.onAutoChange(false); }
          const k = Math.exp(dy / 200), mid = (drag.y0 + drag.y1) / 2, half = ((drag.y1 - drag.y0) / 2) * k;
          this.y0 = mid - half; this.y1 = mid + half;
        } else if (drag.zone === 'time') {
          this.barW = this.#clampBar(drag.barW * Math.exp(-dx / 200)); this.#clampRight();
        }
      }
      if (!touch || drag?.zone === 'cross' || drag?.zone === 'layer') this.mouse = p;
      const z = drag?.zone ?? zone(p);
      c.style.cursor = z === 'price' || z === 'sep' ? 'ns-resize' : z === 'time' ? 'ew-resize'
        : z === 'layer' ? (this.layer.cursor(p) ?? 'crosshair') : drag && z !== 'rsiaxis' ? 'grabbing'
        : (z === 'plot' && this.layer?.cursor(p)) || 'crosshair';
      this.draw();
    });
    const up = e => {
      clearTimeout(hold);
      pointers.delete(e.pointerId);
      if (e.pointerType === 'touch' && drag?.zone !== 'cross') this.mouse = null;
      if (drag?.zone === 'layer') { if (e.type === 'pointerup') this.layer.up(pos(e), e); else this.layer.cancelDrag(); }
      if (drag?.zone === 'sep') this.onLayout();
      drag = null; pinch = 0;
      this.draw();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', e => { if (!drag && e.pointerType !== 'touch') { this.mouse = null; this.draw(); } });
    c.addEventListener('dblclick', e => {
      const z = zone(pos(e));
      if (z === 'price') this.setAuto(true);
      else if (z === 'time') this.resetView();
      else if (z === 'plot') this.layer?.dblclick(pos(e));
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : 1;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.right += ((e.deltaX || e.deltaY) * unit) / this.barW; this.#clampRight(); this.draw();
      } else {
        const d = Math.max(-240, Math.min(240, e.deltaY * unit));
        this.#zoom(Math.exp(-d / 700), Math.min(pos(e).x, this.plotW));
      }
    }, { passive: false });
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return; // hidden
    const first = !this.w;
    const dpr = window.devicePixelRatio || 1;
    const bars = this.w ? this.plotW / this.barW : 0;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.dpr = dpr; this.w = w; this.h = h;
    if (first && this.rows.length) this.resetView();
    else if (bars && this.rows.length) this.#clampRight();
    this.draw();
  }
  get plotW() { return Math.max(1, this.w - this.axisW); }
  resize() { this.#resize(); }
  get paneH() { return Math.max(1, this.h - AXIS_H); }
  get rsiH() { return this.cfg.rsi.on ? Math.round(this.paneH * this.cfg.rsi.frac) : 0; }
  get plotH() { return Math.max(1, this.paneH - this.rsiH); }

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.#paint(); });
  }

  // ---------- rendering ----------
  #paint() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = FONT;
    ctx.fillStyle = THEME.bg; ctx.fillRect(0, 0, this.w, this.h);
    if (!this.rows.length) { this.onHover(null); return; }

    const first = Math.max(0, Math.floor(this.idx(0)) - 1);
    const last = Math.min(this.rows.length - 1, Math.ceil(this.idx(this.plotW)) + 1);
    this.#fitY(first, last);
    const ticks = this.#priceTicks();
    const widest = Math.max(...ticks.map(p => ctx.measureText(this.fmt(p)).width), ctx.measureText(this.fmt(this.raw.at(-1).c)).width);
    const axisW = Math.ceil(widest / 8) * 8 + 18;
    if (axisW !== this.axisW) { this.axisW = axisW; this.draw(); }
    this.paneLabelTop?.(this.plotH);

    const times = this.#timeTicks(first, last);
    ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of ticks) { const y = Math.round(this.y(p)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(this.plotW, y); }
    for (const k of times) { const x = Math.round(this.x(k.i)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, this.paneH); }
    ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, this.plotW, this.plotH); ctx.clip();
    if (this.showVolume) this.#volume(first, last);
    if (this.type === 'line' || this.type === 'area') this.#line(first, last);
    else this.#bars(first, last);
    if (this.showMa) this.cfg.ma.lines.forEach((l, k) => this.#series(this.ind.ma[k], first, last, v => this.y(v), l.color, l.width));
    this.#lastLine();
    this.layer?.render(ctx);
    ctx.restore();
    if (this.rsiH) this.#rsiPane(first, last);

    this.#axes(ticks, times);
    if (this.rsiH) this.#rsiAxis();
    this.#crosshair();
  }

  #fitY(a, b) {
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i <= b; i++) { const r = this.rows[i]; if (r.l < lo) lo = r.l; if (r.h > hi) hi = r.h; }
    if (this.showMa) {
      for (const line of this.ind.ma) {
        if (!line) continue;
        for (let i = a; i <= b; i++) { const v = line[i]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      }
    }
    this.logOk = lo > 0;
    if (!this.auto || !Number.isFinite(lo)) return;
    lo = this.f(lo); hi = this.f(hi);
    if (hi === lo) { const d = Math.abs(hi) * 0.01 || 1; lo -= d; hi += d; }
    const s = hi - lo;
    this.y0 = lo - s * (this.showVolume ? 0.2 : 0.08); this.y1 = hi + s * 0.08;
  }

  #priceTicks() {
    const out = [];
    let prev = Infinity;
    for (let y = this.plotH; y > 0; y -= 52) {
      const a = this.price(y), step = niceStep(Math.abs(this.price(y - 52) - a) || 1);
      const p = Math.ceil(a / step) * step, py = this.y(p);
      if (py > 8 && py < this.plotH - 8 && prev - py >= 28) { out.push(p); prev = py; }
    }
    return out;
  }

  #timeTicks(a, b) {
    const minGap = 78, chosen = [];
    for (let w = 5; w >= 1; w--) {
      for (let i = Math.max(a, 1); i <= b; i++) {
        if (this.weights[i] !== w) continue;
        const x = this.x(i);
        if (x < 24 || x > this.plotW - 24) continue;
        if (this.barW * chosen.length > this.plotW) break;
        // "chosen" stays sorted by index; look up the neighbors.
        let lo = 0, hi = chosen.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (chosen[m].i < i) lo = m + 1; else hi = m; }
        if (lo > 0 && (i - chosen[lo - 1].i) * this.barW < minGap) continue;
        if (lo < chosen.length && (chosen[lo].i - i) * this.barW < minGap) continue;
        chosen.splice(lo, 0, { i, w });
      }
    }
    return chosen;
  }

  #tickLabel({ i, w }) {
    const d = new Date(this.raw[i].t * 1000);
    const tz = this.intraday ? undefined : 'UTC';
    if (w === 5) return d.toLocaleDateString('en-GB', { year: 'numeric', timeZone: tz });
    if (w === 4) return d.toLocaleDateString('en-GB', { month: 'short', timeZone: tz }).replace('.', '');
    if (w === 3) return d.toLocaleDateString('en-GB', { day: 'numeric', timeZone: tz });
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  #timeLabel(t) {
    const d = new Date(t * 1000);
    return this.intraday
      ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  #bodyW() {
    if (this.barW < 2.5) return Math.max(0.6, this.barW * 0.8);
    let w = Math.floor(this.barW * 0.72);
    if (w % 2 === 0) w -= 1; // odd, so the wick is centered
    return Math.max(1, w);
  }

  #volume(a, b) {
    const { ctx } = this;
    let max = 0;
    for (let i = a; i <= b; i++) if (this.rows[i].v > max) max = this.rows[i].v;
    if (!max) return;
    const w = this.#bodyW(), H = this.plotH * 0.16;
    ctx.globalAlpha = 0.32;
    for (const up of [true, false]) {
      ctx.fillStyle = up ? THEME.up : THEME.down;
      ctx.beginPath();
      for (let i = a; i <= b; i++) {
        const r = this.rows[i];
        if ((r.c >= r.o) !== up || !r.v) continue;
        const h = Math.max(1, (r.v / max) * H);
        ctx.rect(Math.round(this.x(i)) - w / 2 + (w >= 1 ? 0.5 : 0), this.plotH - h, w, h);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  #bars(a, b) {
    const { ctx } = this;
    const w = this.#bodyW(), hollow = this.type === 'hollow', ohlc = this.type === 'bars';
    const thin = this.barW < 2.5;
    for (const up of [true, false]) {
      ctx.fillStyle = ctx.strokeStyle = up ? THEME.up : THEME.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const frames = [];
      for (let i = a; i <= b; i++) {
        const r = this.rows[i];
        if ((r.c >= r.o) !== up) continue;
        const x = thin ? this.x(i) : Math.round(this.x(i));
        const yh = this.y(r.h), yl = this.y(r.l), yo = this.y(r.o), yc = this.y(r.c);
        const top = Math.round(Math.min(yo, yc)), bh = Math.max(1, Math.round(Math.abs(yo - yc)));
        if (thin) { ctx.rect(x, yh, w, Math.max(1, yl - yh)); continue; }
        if (ohlc) {
          const s = Math.max(1, Math.floor(w / 2));
          ctx.rect(x, yh, 1, Math.max(1, yl - yh));
          ctx.rect(x - s, Math.round(yo), s, 1);
          ctx.rect(x, Math.round(yc), s + 1, 1);
        } else if (hollow && up && w >= 3 && bh >= 3) {
          ctx.rect(x, yh, 1, Math.max(0, top - yh));
          ctx.rect(x, top + bh, 1, Math.max(0, yl - top - bh));
          frames.push([x - (w - 1) / 2 + 0.5, top + 0.5, w - 1, bh - 1]);
        } else {
          ctx.rect(x, yh, 1, Math.max(1, yl - yh));
          ctx.rect(x - (w - 1) / 2, top, w, bh);
        }
      }
      ctx.fill();
      for (const f of frames) ctx.strokeRect(...f);
    }
  }

  #line(a, b) {
    const { ctx } = this;
    ctx.beginPath();
    for (let i = a; i <= b; i++) { const x = this.x(i), y = this.y(this.rows[i].c); i === a ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = THEME.line; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.stroke();
    if (this.type === 'area') {
      ctx.lineTo(this.x(b), this.plotH); ctx.lineTo(this.x(a), this.plotH); ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, this.plotH);
      g.addColorStop(0, THEME.line + '40'); g.addColorStop(1, THEME.line + '00');
      ctx.fillStyle = g; ctx.fill();
    }
  }

  #series(vals, a, b, y, color, width) {
    if (!vals) return;
    const { ctx } = this;
    ctx.beginPath();
    let pen = false;
    for (let i = a; i <= b; i++) {
      const v = vals[i];
      if (v == null) { pen = false; continue; }
      if (pen) ctx.lineTo(this.x(i), y(v)); else ctx.moveTo(this.x(i), y(v));
      pen = true;
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.stroke();
  }

  // ---------- RSI pane ----------
  rsiY(v) { return this.plotH + this.rsiH * (1 - (v - this.r0) / (this.r1 - this.r0)); }

  #rsiPane(a, b) {
    const { ctx } = this, c = this.cfg.rsi, top = this.plotH, h = this.rsiH;
    let lo = c.low, hi = c.high;
    if (c.visible) {
      for (const s of [this.ind.rsi, this.ind.rsiMa]) {
        if (!s) continue;
        for (let i = a; i <= b; i++) { const v = s[i]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      }
    }
    this.r0 = Math.max(0, lo - 6); this.r1 = Math.min(100, hi + 6);
    const y = v => this.rsiY(v);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top, this.plotW, h); ctx.clip();
    if (c.visible) {
      ctx.fillStyle = c.color + '1c';
      ctx.fillRect(0, y(c.high), this.plotW, y(c.low) - y(c.high));
      // Highlight above/below the limits.
      for (const [lim, from, color] of [[c.high, this.r1, THEME.up], [c.low, this.r0, THEME.down]]) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, Math.min(y(lim), y(from)), this.plotW, Math.abs(y(lim) - y(from))); ctx.clip();
        ctx.beginPath();
        let started = false, lastX = 0;
        for (let i = a; i <= b; i++) {
          const v = this.ind.rsi?.[i];
          if (v == null) continue;
          if (!started) { ctx.moveTo(this.x(i), y(lim)); started = true; }
          lastX = this.x(i); ctx.lineTo(lastX, y(v));
        }
        if (started) { ctx.lineTo(lastX, y(lim)); ctx.closePath(); ctx.fillStyle = color + '70'; ctx.fill(); }
        ctx.restore();
      }
      ctx.strokeStyle = THEME.cross; ctx.lineWidth = 1; ctx.setLineDash([5, 5]); ctx.beginPath();
      for (const v of [c.high, 50, c.low]) { const yy = Math.round(y(v)) + 0.5; ctx.moveTo(0, yy); ctx.lineTo(this.plotW, yy); }
      ctx.stroke(); ctx.setLineDash([]);
      this.#series(this.ind.rsi, a, b, y, c.color, 1.5);
      this.#series(this.ind.rsiMa, a, b, y, c.maColor, 1.5);
    }
    ctx.restore();
  }

  #rsiAxis() {
    const { ctx } = this, c = this.cfg.rsi;
    ctx.strokeStyle = THEME.axis; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(0, this.plotH + 0.5); ctx.lineTo(this.w, this.plotH + 0.5); ctx.stroke();
    const now = c.visible ? this.ind.rsi?.at(-1) : null;
    ctx.fillStyle = THEME.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const v of [c.high, 50, c.low]) {
      if (now == null || Math.abs(this.rsiY(v) - this.rsiY(now)) > 16) ctx.fillText(String(v), this.plotW + 8, this.rsiY(v) + 0.5);
    }
    if (now != null) this.#tag(now.toFixed(2), this.rsiY(now), c.color, '#0b0d11', this.plotH, this.paneH);
  }

  #lastLine() {
    const r = this.raw.at(-1), y = Math.round(this.y(r.c)) + 0.5, { ctx } = this;
    ctx.strokeStyle = r.c >= r.o ? THEME.up : THEME.down; ctx.lineWidth = 1;
    ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.plotW, y); ctx.stroke(); ctx.setLineDash([]);
  }

  #tag(text, y, bg, fg, min = 0, max = this.plotH) {
    const { ctx } = this, yy = Math.max(min + 10, Math.min(max - 10, y));
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(this.plotW + 1, yy - 10, this.axisW - 3, 20, 3); ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.fillText(text, this.plotW + 8, yy + 0.5);
  }

  #axes(ticks, times) {
    const { ctx } = this;
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(this.plotW, 0, this.axisW, this.h); ctx.fillRect(0, this.paneH, this.w, AXIS_H);
    ctx.strokeStyle = THEME.axis; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(this.plotW + 0.5, 0); ctx.lineTo(this.plotW + 0.5, this.h);
    ctx.moveTo(0, this.paneH + 0.5); ctx.lineTo(this.w, this.paneH + 0.5); ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = THEME.text;
    const r = this.raw.at(-1), ly = this.y(r.c);
    for (const p of ticks) if (Math.abs(this.y(p) - ly) > 18) ctx.fillText(this.fmt(p), this.plotW + 8, this.y(p) + 0.5);
    ctx.textAlign = 'center';
    for (const k of times) {
      ctx.fillStyle = k.w >= 4 ? THEME.strong : THEME.text;
      ctx.fillText(this.#tickLabel(k), this.x(k.i), this.paneH + AXIS_H / 2);
    }
    for (const k of this.layer?.axisTags() ?? []) {
      const ky = this.y(k.p);
      if (ky > 0 && ky < this.plotH) this.#tag(this.fmt(k.p), ky, k.color, '#ffffff');
    }
    if (ly > -10 && ly < this.plotH + 10) this.#tag(this.fmt(r.c), ly, r.c >= r.o ? THEME.up : THEME.down, '#0b0d11');
  }

  #crosshair() {
    const { ctx, mouse: m } = this;
    if (!m || m.x > this.plotW || m.y > this.paneH) { this.onHover(this.rows.length - 1); return; }
    const inRsi = m.y > this.plotH;
    const i = Math.max(0, Math.min(this.rows.length - 1, Math.round(this.idx(m.x))));
    const inside = Math.abs(this.idx(m.x) - i) <= 0.5;
    const x = Math.round(inside ? this.x(i) : m.x) + 0.5, y = Math.round(m.y) + 0.5;
    ctx.strokeStyle = THEME.cross; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.paneH); ctx.moveTo(0, y); ctx.lineTo(this.plotW, y); ctx.stroke();
    ctx.setLineDash([]);
    if (inRsi) {
      const v = this.r0 + (1 - (m.y - this.plotH) / this.rsiH) * (this.r1 - this.r0);
      this.#tag(v.toFixed(2), m.y, THEME.label, THEME.strong, this.plotH, this.paneH);
    } else this.#tag(this.fmt(this.price(m.y)), m.y, THEME.label, THEME.strong);
    if (inside) {
      const text = this.#timeLabel(this.raw[i].t), w = ctx.measureText(text).width + 16;
      const cx = Math.max(w / 2, Math.min(this.plotW - w / 2, x));
      ctx.fillStyle = THEME.label; ctx.beginPath(); ctx.roundRect(cx - w / 2, this.paneH + 3, w, AXIS_H - 6, 3); ctx.fill();
      ctx.fillStyle = THEME.strong; ctx.textAlign = 'center'; ctx.fillText(text, cx, this.paneH + AXIS_H / 2);
    }
    this.onHover(i);
  }
}
