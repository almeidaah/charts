// Indicator legend over the chart, and the settings dialog.
import { DEFAULTS } from './indicators.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const num = (v, d) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const NAMES = { ma: 'Moving averages', rsi: 'RSI', vol: 'Volume' };

export function mountIndicators({ chart, top, rsiBox, dialog, onChange }) {
  const cfg = () => chart.cfg;
  const vals = { ma: [], rsi: [], vol: [] };

  function apply() { chart.setIndicators(cfg()); build(); onChange(cfg()); }

  // ---------- legend ----------
  function row(key, label, colors) {
    const r = el('div', 'ind' + (cfg()[key].visible ? '' : ' off'));
    r.append(el('span', 'indname', label));
    vals[key] = colors.map(c => { const s = el('span', 'indval'); s.style.color = c; r.append(s); return s; });
    const act = el('span', 'indact');
    const b = (text, title, run) => { const x = el('button', '', text); x.title = title; x.onclick = run; act.append(x); };
    b(cfg()[key].visible ? 'Hide' : 'Show', `${cfg()[key].visible ? 'Hide' : 'Show'} ${NAMES[key]}`, () => { cfg()[key].visible = !cfg()[key].visible; apply(); });
    b('Settings', `Settings for ${NAMES[key]}`, () => open(key));
    b('Remove', `Remove ${NAMES[key]} (turn it back on in Indicators)`, () => { cfg()[key].on = false; apply(); });
    r.append(act);
    return r;
  }
  function build() {
    const c = cfg(), rows = [];
    vals.ma = []; vals.rsi = []; vals.vol = [];
    if (c.ma.on) rows.push(row('ma', `MA ${c.ma.lines.filter(l => l.on).map(l => (l.type === 'EMA' ? 'E' : '') + l.n).join(' ')}`, c.ma.lines.map(l => l.color)));
    if (c.vol.on) rows.push(row('vol', 'Vol', ['']));
    top.replaceChildren(...rows);
    rsiBox.hidden = !c.rsi.on;
    rsiBox.replaceChildren(...(c.rsi.on ? [row('rsi', `RSI ${c.rsi.n}`, [c.rsi.color, c.rsi.maColor])] : []));
  }
  chart.paneLabelTop = y => { rsiBox.style.top = y + 6 + 'px'; };

  // Called whenever the crosshair moves.
  function update(i) {
    const c = cfg(), ok = i != null && chart.rows[i];
    vals.ma.forEach((s, k) => { const v = ok && c.ma.lines[k].on ? chart.ind.ma[k]?.[i] : null; s.textContent = !c.ma.lines[k].on ? '' : v == null ? 'Ø' : num(v, chart.decimals); });
    const pair = [chart.ind.rsi?.[i], chart.ind.rsiMa?.[i]];
    vals.rsi.forEach((s, k) => { s.textContent = ok && pair[k] != null ? num(pair[k], 2) : ''; });
    if (vals.vol[0]) {
      const r = ok ? chart.raw[i] : null;
      vals.vol[0].textContent = r?.v ? r.v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 }) : '';
      vals.vol[0].className = 'indval ' + (r && r.c < r.o ? 'down' : 'up');
    }
  }

  // ---------- dialog ----------
  const field = (label, input) => { const l = el('label', 'field'); l.append(el('span', '', label), input); return l; };
  const number = (v, min, max, set) => {
    const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.step = 1; i.value = v;
    i.onchange = () => { const n = Math.round(Number(i.value)); if (n >= min && n <= max) { set(n); apply(); } i.value = n >= min && n <= max ? n : v; };
    return i;
  };
  const color = (v, set) => { const i = el('input'); i.type = 'color'; i.value = v; i.onchange = () => { set(i.value); apply(); }; return i; };
  const check = (v, set) => { const i = el('input'); i.type = 'checkbox'; i.checked = v; i.onchange = () => { set(i.checked); apply(); render(); }; return i; };

  function section(key, body) {
    const s = el('section', 'indsec'); s.dataset.key = key;
    const h = el('label', 'indhead'); h.append(check(cfg()[key].on, v => { cfg()[key].on = v; cfg()[key].visible = true; }), el('b', '', NAMES[key]));
    s.append(h);
    if (cfg()[key].on && body) s.append(body);
    return s;
  }
  function render() {
    const c = cfg();
    const ma = el('div', 'indgrid');
    c.ma.lines.forEach((l, k) => {
      const r = el('div', 'indline'), type = el('select');
      type.append(new Option('Simple', 'SMA'), new Option('Exponential', 'EMA')); type.value = l.type;
      type.onchange = () => { l.type = type.value; apply(); };
      type.setAttribute('aria-label', `Type of MA ${k + 1}`);
      const n = number(l.n, 1, 2000, v => { l.n = v; }); n.setAttribute('aria-label', `Length of MA ${k + 1}`);
      const col = color(l.color, v => { l.color = v; }); col.setAttribute('aria-label', `Color of MA ${k + 1}`);
      const on = check(l.on, v => { l.on = v; }); on.setAttribute('aria-label', `Show MA ${k + 1}`);
      r.append(on, type, n, col); ma.append(r);
    });
    const rsi = el('div', 'indfields'), r = c.rsi;
    rsi.append(
      field('Length', number(r.n, 2, 500, v => { r.n = v; })), field('Color', color(r.color, v => { r.color = v; })),
      field('RSI average', check(r.maOn, v => { r.maOn = v; })), field('Average length', number(r.maN, 1, 500, v => { r.maN = v; })),
      field('Average color', color(r.maColor, v => { r.maColor = v; })),
      field('Upper limit', number(r.high, 51, 99, v => { r.high = v; })), field('Lower limit', number(r.low, 1, 49, v => { r.low = v; })),
    );
    const foot = el('div', 'indfoot'), reset = el('button', '', 'Reset to defaults'), done = el('button', 'primary', 'Close');
    reset.onclick = () => { Object.assign(cfg(), structuredClone(DEFAULTS)); apply(); render(); };
    done.onclick = () => dialog.close();
    foot.append(reset, done);
    dialog.replaceChildren(el('h2', '', 'Indicators'), section('ma', ma), section('rsi', rsi), section('vol'), foot);
  }
  function open(key) {
    render();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector(`[data-key="${key}"] input`)?.focus();
  }
  dialog.onclick = e => { if (e.target === dialog) dialog.close(); };

  build();
  return { update, build, open };
}
