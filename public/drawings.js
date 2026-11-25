// Drawing layer: create, select, move, edit, undo.
// Every point is stored as { t: time, p: price }, so it follows zoom, scroll and timeframe changes.
import { THEME } from './chart.js';

const UI = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const HIT = 7;
const ACCENT = '#4c8df0';

// n = how many clicks the drawing needs
export const TOOLS = {
  trend: { name: 'Trend line', n: 2 },
  hline: { name: 'Horizontal line', n: 1 },
  vline: { name: 'Vertical line', n: 1 },
  hray: { name: 'Horizontal ray', n: 1 },
  channel: { name: 'Parallel channel', n: 3 },
  fib: { name: 'Fib retracement', n: 2 },
  xabcd: { name: 'XABCD pattern', n: 5 },
  long: { name: 'Long position', n: 1 },
  short: { name: 'Short position', n: 1 },
  prange: { name: 'Price range', n: 2 },
  rect: { name: 'Rectangle', n: 2 },
  brush: { name: 'Brush', n: 0 },
  text: { name: 'Text', n: 1 },
  emoji: { name: 'Emoji', n: 1 },
};

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];
const FIB_COLORS = { 0: '#8b93a1', 0.236: '#f0605c', 0.382: '#f0a03c', 0.5: '#5bb974', 0.618: '#2cb89b', 0.786: '#4c8df0', 1: '#8b93a1', 1.618: '#a877e8' };
const DEFAULT_STYLE = { color: ACCENT, width: 2, dash: false };
const SPECIAL = { xabcd: { color: '#a877e8' }, text: { color: '#e4e8ee' }, brush: { color: '#e0a83a' } };

const clone = x => (x == null ? null : structuredClone(x));
const fixed = (v, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const signed = (v, s) => (v > 0 ? '+' : '') + s;

export function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const k = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy);
}
const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
const inBox = (p, b, m = 0) => b && p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;
const edges = b => {
  const c = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
  return c.map((p, i) => [p, c[(i + 1) % 4]]);
};

// Long/short position stats.
export function positionStats(entry, target, stop) {
  const gain = Math.abs(target - entry), risk = Math.abs(entry - stop);
  return { gain, risk, gainPct: (gain / entry) * 100, riskPct: (risk / entry) * 100, rr: risk ? gain / risk : null };
}
export function parseLevels(text) {
  const v = text.split(/[\s;]+/).filter(Boolean).map(x => Number(x.replace(',', '.')));
  return v.length && v.length <= 20 && v.every(x => Number.isFinite(x) && Math.abs(x) <= 20) ? [...new Set(v)].sort((a, b) => a - b) : null;
}

export class Layer {
  constructor(chart, { save, load, onSelect, onTool, toast }) {
    Object.assign(this, { chart, saveApi: save, loadApi: load, onSelect, onTool, toast });
    this.items = []; this.sel = null; this.tool = null; this.draft = null; this.drag = null;
    this.measure = null; this.zoomBox = null; this.emoji = '🚀';
    this.opts = { keep: false, hidden: false };
    this.styles = {};
    this.stacks = new Map(); // undo/redo per symbol
    this.boxes = new WeakMap(); // area taken by text and emoji
    this.queue = Promise.resolve();
    chart.layer = this;
  }

  // ---------- load, save, undo ----------
  async load(inst) {
    this.inst = inst;
    this.cancel(); this.select(null);
    this.items = []; this.measure = null; this.chart.draw();
    await this.queue; // makes sure pending saves have reached the database
    try {
      const items = await this.loadApi(inst);
      if (this.inst === inst) { this.items = items; this.chart.draw(); }
    } catch (e) { if (this.inst === inst) this.toast(`Could not load drawings: ${e.message}`); }
  }
  get stack() {
    if (!this.stacks.has(this.inst)) this.stacks.set(this.inst, { undo: [], redo: [] });
    return this.stacks.get(this.inst);
  }
  #send(list, key) {
    const inst = this.inst;
    const put = list.map(c => c[key]).filter(Boolean);
    const del = list.filter(c => !c[key]).map(c => (c.before ?? c.after).uid);
    this.queue = this.queue.then(() => this.saveApi(inst, put, del))
      .catch(e => this.toast(`Drawing was not saved: ${e.message}`));
  }
  #commit(list) {
    if (!list.length) return;
    this.stack.undo.push(list); this.stack.redo = [];
    if (this.stack.undo.length > 200) this.stack.undo.shift();
    this.#send(list, 'after');
    this.chart.draw();
  }
  #replay(from, to, key) {
    const list = from.pop();
    if (!list) return;
    this.cancel(); this.select(null);
    for (const c of list) {
      const uid = (c.before ?? c.after).uid, i = this.items.findIndex(d => d.uid === uid), v = clone(c[key]);
      if (!v) { if (i >= 0) this.items.splice(i, 1); } else if (i >= 0) this.items[i] = v; else this.items.push(v);
    }
    to.push(list);
    this.#send(list, key);
    this.chart.draw();
  }
  undo() { this.#replay(this.stack.undo, this.stack.redo, 'before'); }
  redo() { this.#replay(this.stack.redo, this.stack.undo, 'after'); }

  // Changes a drawing and records it.
  edit(d, change) {
    const before = clone(d);
    change(d);
    if (JSON.stringify(before) !== JSON.stringify(d)) this.#commit([{ before, after: clone(d) }]);
  }
  remove(list) {
    const out = list.filter(d => !d.locked);
    if (!out.length) return 0;
    this.items = this.items.filter(d => !out.includes(d));
    this.select(null);
    this.#commit(out.map(d => ({ before: clone(d), after: null })));
    return out.length;
  }
  duplicate(d) {
    const c = this.chart, n = clone(d);
    n.uid = crypto.randomUUID(); n.locked = false;
    n.pts = n.pts.map(q => ({ t: c.timeAt(c.indexOf(q.t, d.tool === 'brush') + 3), p: c.price(c.y(q.p) + 20) }));
    this.items.push(n);
    this.#commit([{ before: null, after: clone(n) }]);
    this.select(n);
  }

  // ---------- tool and selection ----------
  setTool(t) {
    this.cancel();
    this.tool = t;
    if (t) { this.select(null); this.measure = null; if (TOOLS[t] && this.opts.hidden) this.opts.hidden = false; }
    this.onTool(t);
    this.chart.draw();
  }
  select(d) {
    if (this.sel === d) return;
    this.sel = d; this.onSelect(d); this.chart.draw();
  }
  cancel() { this.draft = null; this.zoomBox = null; this.cancelDrag(); this.closeText?.(); if (this.measure?.active) this.measure = null; this.chart.draw(); }
  cancelDrag() {
    if (this.drag) { Object.assign(this.drag.d, clone(this.drag.before)); this.drag = null; this.chart.draw(); }
    if (this.draft?.tool === 'brush') this.draft = null;
  }
  get drafting() { return (this.draft && this.draft.tool !== 'brush') || this.measure?.active; }
  styleOf(tool) { return { ...DEFAULT_STYLE, ...SPECIAL[tool], ...this.styles[tool] }; }

  // ---------- coordinates ----------
  screen(d) {
    const c = this.chart, exact = d.tool === 'brush';
    return d.pts.map(q => ({ x: c.x(c.indexOf(q.t, exact)), y: c.y(c.isLog ? Math.max(q.p, 1e-12) : q.p) }));
  }
  #pt(p, free = false) {
    const c = this.chart;
    const i = free ? c.idx(p.x) : Math.round(c.idx(p.x));
    return { t: c.timeAt(i), p: Number(c.price(p.y).toPrecision(8)) };
  }

  // ---------- mouse ----------
  down(p, e) {
    this.closeText?.();
    if (this.tool === 'zoom') { this.zoomBox = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return true; }
    if (this.measure?.active) { this.measure.b = this.#pt(p); this.measure.active = false; this.measure.at = null; if (this.tool === 'measure') this.setToolKeep(); return true; }
    if (this.tool === 'measure' || (!this.tool && e.shiftKey)) {
      const a = this.#pt(p);
      this.measure = { a, b: a, active: true, at: p };
      return true;
    }
    if (this.measure) { this.measure = null; this.chart.draw(); }

    if (TOOLS[this.tool]) return this.#downCreate(p, e);
    if (this.opts.hidden) { this.select(null); return false; }

    let h = this.sel && !this.sel.locked ? this.#handleAt(this.sel, p) : null;
    const d = h ? this.sel : this.#hit(p);
    if (d && !h && !d.locked) h = this.#handleAt(d, p);
    this.select(d);
    if (!d) return false;
    if (!d.locked) this.drag = { d, h, at: p, off: h ? { x: h.x - p.x, y: h.y - p.y } : null, before: clone(d), orig: h ? null : this.screen(d) };
    return true;
  }
  setToolKeep() { this.tool = null; this.onTool(null); this.chart.draw(); }

  #downCreate(p, e) {
    const tool = this.tool, pt = this.#pt(p, tool === 'brush');
    if (!this.draft) {
      this.draft = { uid: crypto.randomUUID(), tool, pts: [pt], ...this.styleOf(tool) };
      if (tool === 'fib') this.draft.levels = this.styles.fib?.levels ?? FIB_LEVELS;
      if (tool === 'emoji') this.draft.emoji = this.emoji;
      this.count = 1;
    } else { this.draft.pts[this.count] = pt; this.count++; }
    this.downAt = p;
    if (tool !== 'brush' && this.count < TOOLS[tool].n) this.draft.pts[this.count] = { ...pt };
    this.chart.draw();
    return true;
  }

  move(p, e) {
    if (this.zoomBox) { this.zoomBox.x1 = p.x; this.zoomBox.y1 = p.y; }
    else if (this.measure?.active) this.measure.b = this.#pt(p);
    else if (this.draft?.tool === 'brush') {
      const last = this.lastBrush ?? this.downAt;
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 3 && this.draft.pts.length < 4000) { this.draft.pts.push(this.#pt(p, true)); this.lastBrush = p; }
    } else if (this.draft) {
      if (this.count < TOOLS[this.draft.tool].n) this.draft.pts[this.count] = this.#pt(p);
    } else if (this.drag) this.#dragTo(p, e);
    this.chart.draw();
  }

  up(p, e) {
    if (this.zoomBox) {
      const z = this.zoomBox; this.zoomBox = null;
      if (Math.abs(z.x1 - z.x0) > 8 && Math.abs(z.y1 - z.y0) > 8) { this.chart.zoomTo(z.x0, z.x1, z.y0, z.y1); this.setTool(null); }
    } else if (this.measure?.active) {
      const at = this.measure.at;
      if (Math.hypot(p.x - at.x, p.y - at.y) > 6) { this.measure.active = false; if (this.tool === 'measure') this.setToolKeep(); }
    } else if (this.draft) {
      const { tool } = this.draft, n = TOOLS[tool].n;
      if (tool === 'brush') { this.lastBrush = null; if (this.draft.pts.length > 1) this.#finish(); else this.draft = null; } else {
        if (this.count < n && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > 6) {
          this.draft.pts[this.count] = this.#pt(p); this.count++;
          if (this.count < n) this.draft.pts[this.count] = this.#pt(p);
        }
        if (this.count >= n) this.#finish();
      }
    } else if (this.drag) {
      const { d, before } = this.drag; this.drag = null;
      if (JSON.stringify(before) !== JSON.stringify(d)) this.#commit([{ before, after: clone(d) }]);
    }
    this.chart.draw();
  }

  #finish() {
    const d = this.draft, c = this.chart;
    this.draft = null;
    if (d.tool === 'long' || d.tool === 'short') {
      const k = d.tool === 'long' ? 1 : -1, y = c.y(d.pts[0].p), i = c.indexOf(d.pts[0].t);
      const t1 = c.timeAt(i + Math.max(4, Math.round(170 / c.barW))), price = v => Number(c.price(v).toPrecision(8));
      d.pts.push({ t: t1, p: price(y - k * c.plotH * 0.16) }, { t: t1, p: price(y + k * c.plotH * 0.08) });
    }
    if (d.tool === 'text') { this.setToolAfter(); this.editText(d, true); return; }
    this.items.push(d);
    this.#commit([{ before: null, after: clone(d) }]);
    this.setToolAfter();
    if (!this.tool && d.tool !== 'brush') this.select(d);
  }
  setToolAfter() { if (!this.opts.keep) { this.tool = null; this.onTool(null); } }

  #dragTo(p, e) {
    const { d, h, at, off, orig } = this.drag, c = this.chart;
    if (h) { h.set(d, this.#pt({ x: p.x + off.x, y: p.y + off.y })); return; }
    const di = Math.round((p.x - at.x) / c.barW), dy = p.y - at.y;
    const before = this.drag.before;
    d.pts = before.pts.map((q, k) => ({
      t: d.tool === 'hline' || di === 0 ? q.t : c.timeAt(c.indexOf(q.t, d.tool === 'brush') + di),
      p: d.tool === 'vline' || dy === 0 ? q.p : Number(c.price(orig[k].y + dy).toPrecision(8)),
    }));
  }

  dblclick(p) {
    if (this.tool || this.opts.hidden) return;
    const d = this.#hit(p);
    if (d?.tool === 'text' && !d.locked) this.editText(d);
  }
  cursor(p) {
    if (this.tool === 'zoom') return 'zoom-in';
    if (this.tool || this.measure?.active) return 'crosshair';
    if (this.drag) return this.drag.h ? 'default' : 'move';
    if (this.opts.hidden) return null;
    if (this.sel && !this.sel.locked && this.#handleAt(this.sel, p)) return 'pointer';
    const d = this.#hit(p);
    return d ? (d.locked ? 'pointer' : 'move') : null;
  }

  // ---------- handles and hit testing ----------
  #handles(d) {
    const s = this.screen(d);
    if (d.tool === 'brush' || d.tool === 'emoji' || d.tool === 'text') return [];
    if (d.tool === 'long' || d.tool === 'short') {
      const k = d.tool === 'long' ? 1 : -1;
      const above = (v, ref) => (k > 0 ? Math.max(v, ref) : Math.min(v, ref));
      const below = (v, ref) => (k > 0 ? Math.min(v, ref) : Math.max(v, ref));
      return [
        { x: s[0].x, y: s[0].y, set: (o, q) => { o.pts[0] = { t: Math.min(q.t, o.pts[1].t), p: above(below(q.p, o.pts[1].p), o.pts[2].p) }; } },
        { x: s[1].x, y: s[0].y, set: (o, q) => { o.pts[1].t = o.pts[2].t = Math.max(q.t, o.pts[0].t); } },
        { x: s[0].x, y: s[1].y, set: (o, q) => { o.pts[1].p = above(q.p, o.pts[0].p); } },
        { x: s[0].x, y: s[2].y, set: (o, q) => { o.pts[2].p = below(q.p, o.pts[0].p); } },
      ];
    }
    const list = s.map((q, i) => ({ ...q, set: (o, v) => { o.pts[i] = v; } }));
    if (d.tool === 'rect') {
      list.push({ x: s[0].x, y: s[1].y, set: (o, v) => { o.pts[0].t = v.t; o.pts[1].p = v.p; } },
        { x: s[1].x, y: s[0].y, set: (o, v) => { o.pts[1].t = v.t; o.pts[0].p = v.p; } });
    }
    if (d.tool === 'hline') list[0].x = this.chart.plotW / 2;
    if (d.tool === 'vline') list[0].y = this.chart.plotH / 2;
    return list;
  }
  #handleAt(d, p) { return this.#handles(d).find(h => Math.hypot(h.x - p.x, h.y - p.y) <= (this.chart.touch ? 22 : 9)) ?? null; }

  #hit(p) {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.#touches(this.items[i], p)) return this.items[i];
    return null;
  }
  #touches(d, p) {
    const { plotW: W } = this.chart, s = this.screen(d), reach = this.chart.touch ? 16 : HIT;
    const near = segs => segs.some(([a, b]) => segDist(p, a, b) <= reach + (d.width ?? 1) / 2);
    const path = pts => pts.slice(1).map((q, i) => [pts[i], q]);
    switch (d.tool) {
      case 'trend': return near([s]);
      case 'hline': return Math.abs(p.y - s[0].y) <= reach;
      case 'vline': return Math.abs(p.x - s[0].x) <= reach;
      case 'hray': return near([[s[0], { x: Math.max(W, s[0].x), y: s[0].y }]]);
      case 'channel': return near(this.#channel(s));
      case 'fib': {
        const x0 = Math.min(s[0].x, s[1].x), x1 = Math.max(s[0].x, s[1].x);
        return near([[s[0], s[1]], ...this.#fib(d).map(l => [{ x: x0, y: l.y }, { x: x1, y: l.y }])]);
      }
      case 'xabcd': case 'brush': return near(path(s));
      case 'long': case 'short': return inBox(p, box({ x: s[0].x, y: Math.min(s[1].y, s[2].y) }, { x: s[1].x, y: Math.max(s[1].y, s[2].y) }));
      case 'rect': case 'prange': { const b = box(s[0], s[1]); return near(edges(b)) || (d === this.sel && inBox(p, b)); }
      case 'text': case 'emoji': return inBox(p, this.boxes.get(d), 4);
      default: return false;
    }
  }
  #channel(s) {
    if (s.length < 3) return [[s[0], s[1]]];
    const dx = s[1].x - s[0].x;
    const off = dx ? s[2].y - (s[0].y + ((s[1].y - s[0].y) * (s[2].x - s[0].x)) / dx) : 0;
    return [[s[0], s[1]], [{ x: s[0].x, y: s[0].y + off }, { x: s[1].x, y: s[1].y + off }]];
  }
  #fib(d) {
    const [a, b] = d.pts;
    return (d.levels ?? FIB_LEVELS).map(v => { const p = b.p + (a.p - b.p) * v; return { v, p, y: this.chart.y(p) }; });
  }

  // ---------- rendering ----------
  axisTags() {
    if (this.opts.hidden) return [];
    return this.items.filter(d => d.tool === 'hline' || d.tool === 'hray').map(d => ({ p: d.pts[0].p, color: d.color }));
  }

  render(ctx) {
    ctx.textBaseline = 'middle';
    if (!this.opts.hidden) for (const d of this.items) this.#drawOne(ctx, d);
    if (this.draft) this.#drawOne(ctx, this.draft);
    if (this.sel && !this.opts.hidden) {
      for (const h of this.#handles(this.sel)) {
        ctx.beginPath(); ctx.arc(h.x, h.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = THEME.bg; ctx.fill(); ctx.strokeStyle = this.sel.locked ? THEME.text : ACCENT; ctx.lineWidth = 2; ctx.stroke();
      }
      const b = this.boxes.get(this.sel);
      if (b && (this.sel.tool === 'text' || this.sel.tool === 'emoji')) { ctx.strokeStyle = ACCENT; ctx.lineWidth = 1; ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8); }
    }
    if (this.measure) this.#drawMeasure(ctx);
    if (this.zoomBox) {
      const z = this.zoomBox, b = box({ x: z.x0, y: z.y0 }, { x: z.x1, y: z.y1 });
      ctx.fillStyle = ACCENT + '22'; ctx.strokeStyle = ACCENT; ctx.lineWidth = 1;
      ctx.fillRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.setLineDash([]); ctx.textBaseline = 'alphabetic';
  }

  #label(ctx, text, x, y, bg, fg = '#ffffff') {
    const lines = text.split('\n');
    ctx.font = `12px ${UI}`;
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 14, h = lines.length * 16 + 6;
    const { plotW: W, plotH: H } = this.chart;
    if (x < -w / 2 || x > W + w / 2 || y < -h || y > H + h) return; // anchor is off screen
    const bx = Math.max(2, Math.min(W - w - 2, x - w / 2)), by = Math.max(2, Math.min(H - h - 2, y - h / 2));
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(bx, by, w, h, 4); ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, bx + w / 2, by + 11 + i * 16));
  }
  #arrow(ctx, x0, y0, x1, y1) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    for (const k of [0.5, -0.5]) { ctx.moveTo(x1, y1); ctx.lineTo(x1 - 8 * Math.cos(a + k), y1 - 8 * Math.sin(a + k)); }
    ctx.stroke();
  }

  #drawOne(ctx, d) {
    const c = this.chart, W = c.plotW, H = c.plotH, s = this.screen(d);
    ctx.strokeStyle = ctx.fillStyle = d.color; ctx.lineWidth = d.width ?? 2; ctx.lineJoin = ctx.lineCap = 'round';
    ctx.setLineDash(d.dash ? [6, 6] : []);
    const line = (...pts) => { ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); };
    switch (d.tool) {
      case 'trend': if (s[1]) line(s[0], s[1]); break;
      case 'hline': line({ x: 0, y: s[0].y }, { x: W, y: s[0].y }); break;
      case 'vline': line({ x: s[0].x, y: 0 }, { x: s[0].x, y: H }); break;
      case 'hray': line(s[0], { x: Math.max(W, s[0].x), y: s[0].y }); break;
      case 'channel': {
        const l = this.#channel(s);
        if (l[1]) {
          ctx.fillStyle = d.color + '18'; ctx.beginPath();
          ctx.moveTo(l[0][0].x, l[0][0].y); ctx.lineTo(l[0][1].x, l[0][1].y); ctx.lineTo(l[1][1].x, l[1][1].y); ctx.lineTo(l[1][0].x, l[1][0].y); ctx.fill();
        }
        for (const [a, b] of l) line(a, b);
        if (l[1]) {
          ctx.setLineDash([4, 5]); ctx.lineWidth = 1;
          line({ x: l[0][0].x, y: (l[0][0].y + l[1][0].y) / 2 }, { x: l[0][1].x, y: (l[0][1].y + l[1][1].y) / 2 });
        }
        break;
      }
      case 'fib': {
        if (!s[1]) break;
        const x0 = Math.min(s[0].x, s[1].x), x1 = Math.max(s[0].x, s[1].x), lv = this.#fib(d);
        lv.forEach((l, i) => {
          const col = FIB_COLORS[l.v] ?? d.color;
          if (i) { ctx.fillStyle = col + '14'; ctx.fillRect(x0, Math.min(l.y, lv[i - 1].y), x1 - x0, Math.abs(l.y - lv[i - 1].y)); }
        });
        lv.forEach(l => {
          ctx.strokeStyle = FIB_COLORS[l.v] ?? d.color; ctx.lineWidth = d.width > 2 ? 2 : 1;
          line({ x: x0, y: l.y }, { x: x1, y: l.y });
          ctx.font = `12px ${UI}`; ctx.textAlign = 'left'; ctx.fillStyle = ctx.strokeStyle;
          ctx.fillText(`${l.v} (${c.fmt(l.p)})`, x0 + 4, l.y - 8);
        });
        ctx.strokeStyle = THEME.text; ctx.lineWidth = 1; ctx.setLineDash([4, 5]); line(s[0], s[1]);
        break;
      }
      case 'xabcd': {
        ctx.fillStyle = d.color + '26';
        for (const tri of [[0, 1, 2], [2, 3, 4]]) {
          if (tri.every(i => s[i])) { ctx.beginPath(); tri.forEach((i, k) => (k ? ctx.lineTo(s[i].x, s[i].y) : ctx.moveTo(s[i].x, s[i].y))); ctx.fill(); }
        }
        line(...s);
        const P = d.pts.map(q => q.p), ratio = (a, b, e, f) => { const den = Math.abs(P[e] - P[f]); return den ? fixed(Math.abs(P[a] - P[b]) / den, 3) : '—'; };
        ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
        for (const [i, j, r] of [[0, 2, [1, 2, 0, 1]], [1, 3, [2, 3, 1, 2]], [2, 4, [3, 4, 2, 3]], [0, 4, [1, 4, 0, 1]]]) {
          if (!s[i] || !s[j]) continue;
          ctx.strokeStyle = d.color; line(s[i], s[j]);
          ctx.setLineDash([]); this.#label(ctx, ratio(...r), (s[i].x + s[j].x) / 2, (s[i].y + s[j].y) / 2, d.color); ctx.setLineDash([4, 5]);
        }
        s.forEach((q, i) => {
          const up = q.y <= (s[i - 1]?.y ?? s[i + 1]?.y ?? q.y);
          ctx.font = `bold 13px ${UI}`; ctx.fillStyle = d.color; ctx.textAlign = 'center'; ctx.fillText('XABCD'[i], q.x, q.y + (up ? -14 : 14));
        });
        break;
      }
      case 'long': case 'short': {
        if (s.length < 3) break;
        const [e, t, st] = d.pts.map(q => q.p), x = s[0].x, w = s[1].x - s[0].x, q = positionStats(e, t, st);
        for (const [y, col] of [[s[1].y, THEME.up], [s[2].y, THEME.down]]) { ctx.fillStyle = col + '33'; ctx.fillRect(x, Math.min(y, s[0].y), w, Math.abs(y - s[0].y)); }
        ctx.strokeStyle = THEME.text; ctx.lineWidth = 1; ctx.setLineDash([]);
        line(s[0], { x: x + w, y: s[0].y });
        if (w >= 90 || d === this.sel) {
          const k = d.tool === 'long' ? -1 : 1;
          this.#label(ctx, `Target ${c.fmt(t)} (${fixed(q.gainPct)}%)`, x + w / 2, s[1].y + k * 13, THEME.up, '#06110e');
          this.#label(ctx, `Stop ${c.fmt(st)} (${fixed(q.riskPct)}%)`, x + w / 2, s[2].y - k * 13, THEME.down, '#1a0605');
          this.#label(ctx, `Entry ${c.fmt(e)}\nRisk/reward ${q.rr == null ? '—' : fixed(q.rr)}`, x + w / 2, s[0].y, THEME.label);
        }
        break;
      }
      case 'prange': {
        if (!s[1]) break;
        const b = box(s[0], s[1]), diff = d.pts[1].p - d.pts[0].p, mid = b.x + b.w / 2;
        ctx.fillStyle = d.color + '1f'; ctx.fillRect(b.x, b.y, b.w, b.h);
        line({ x: b.x, y: s[0].y }, { x: b.x + b.w, y: s[0].y }); line({ x: b.x, y: s[1].y }, { x: b.x + b.w, y: s[1].y });
        this.#arrow(ctx, mid, s[0].y, mid, s[1].y);
        ctx.setLineDash([]);
        this.#label(ctx, `${signed(diff, c.fmt(diff))} (${signed(diff, fixed((diff / d.pts[0].p) * 100))}%)`, mid, s[1].y + (diff >= 0 ? -16 : 16), d.color);
        break;
      }
      case 'rect': {
        if (!s[1]) break;
        const b = box(s[0], s[1]);
        ctx.fillStyle = d.color + '22'; ctx.fillRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x, b.y, b.w, b.h);
        break;
      }
      case 'brush': {
        ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
        ctx.lineTo(s.at(-1).x, s.at(-1).y); ctx.stroke();
        break;
      }
      case 'text': {
        const size = this.textSize(d), lines = (d.text ?? '').split('\n');
        ctx.font = `600 ${size}px ${UI}`; ctx.textAlign = 'left';
        const lh = size * 1.3;
        lines.forEach((l, i) => ctx.fillText(l, s[0].x, s[0].y + lh * (i + 0.5)));
        this.boxes.set(d, { x: s[0].x, y: s[0].y, w: Math.max(10, ...lines.map(l => ctx.measureText(l).width)), h: lh * lines.length });
        break;
      }
      case 'emoji': {
        const size = 16 + (d.width ?? 2) * 8;
        ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
        ctx.fillText(d.emoji, s[0].x, s[0].y);
        this.boxes.set(d, { x: s[0].x - size * 0.6, y: s[0].y - size * 0.6, w: size * 1.2, h: size * 1.2 });
        break;
      }
    }
    ctx.setLineDash([]);
  }
  textSize(d) { return 10 + (d.width ?? 2) * 3; }

  #drawMeasure(ctx) {
    const c = this.chart, { a, b } = this.measure;
    const [p, q] = this.screen({ tool: 'rect', pts: [a, b] });
    const diff = b.p - a.p, col = diff >= 0 ? ACCENT : THEME.down, r = box(p, q);
    ctx.setLineDash([]); ctx.fillStyle = col + '26'; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    if (r.h > 12) this.#arrow(ctx, r.x + r.w / 2, p.y, r.x + r.w / 2, q.y);
    if (r.w > 12) this.#arrow(ctx, p.x, r.y + r.h / 2, q.x, r.y + r.h / 2);
    const bars = Math.round(c.indexOf(b.t) - c.indexOf(a.t)), secs = Math.abs(b.t - a.t);
    const time = secs >= 86400 ? `${fixed(secs / 86400, 0)} days` : secs >= 3600 ? `${fixed(secs / 3600, 1)} h` : `${fixed(secs / 60, 0)} min`;
    this.#label(ctx, `${signed(diff, c.fmt(diff))} (${signed(diff, fixed((diff / a.p) * 100))}%)\n${bars} bars, ${time}`, r.x + r.w / 2, q.y + (diff >= 0 ? -26 : 26), col);
  }

  // ---------- text ----------
  editText(d, isNew = false) {
    this.closeText?.();
    const host = this.chart.canvas.parentElement, s = this.screen(d)[0], size = this.textSize(d);
    const ta = document.createElement('textarea');
    ta.className = 'textedit'; ta.value = d.text ?? ''; ta.placeholder = 'Type here';
    ta.style.cssText = `left:${Math.max(4, Math.min(s.x, this.chart.plotW - 190))}px;top:${Math.max(4, Math.min(s.y, this.chart.plotH - 70))}px;font-size:${size}px;color:${d.color}`;
    host.append(ta);
    let open = true;
    this.closeText = (keep = true) => {
      if (!open) return;
      open = false; this.closeText = null;
      const text = ta.value.trim();
      ta.remove();
      if (!keep) return;
      if (isNew) {
        if (!text) return;
        d.text = text.slice(0, 2000); this.items.push(d); this.#commit([{ before: null, after: clone(d) }]);
      } else if (text) this.edit(d, o => { o.text = text.slice(0, 2000); });
      else this.remove([d]);
    };
    ta.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeText?.(false);
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.closeText?.(); }
    };
    // Wait for the click to finish before focusing, otherwise focus goes back to the chart.
    setTimeout(() => { ta.focus(); ta.onblur = () => this.closeText?.(); }, 30);
  }

  // ---------- keyboard ----------
  key(e) {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') { if (this.tool || this.draft || this.sel || this.measure) { this.measure = null; this.setTool(null); this.select(null); return true; } return false; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { this.remove([this.sel]); return true; }
    if (mod && k === 'z') { if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if (mod && k === 'y') { this.redo(); return true; }
    if (mod && k === 'd' && this.sel) { this.duplicate(this.sel); return true; }
    const quick = { t: 'trend', h: 'hline', v: 'vline', j: 'hray', f: 'fib' }[k];
    if (e.altKey && !mod && quick) { this.setTool(quick); return true; }
    return false;
  }
}
