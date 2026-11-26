import { Chart } from './chart.js';
import { Layer } from './drawings.js';
import { mountTools } from './tools.js';
import { mountIndicators } from './legend.js';
import { withDefaults } from './indicators.js';
import { createTicks, firstChange } from './ticks.js';
import { logo } from './logos.js';
import { assetName } from './names.js';
import { holidayFor } from './holidays.js';
import { createGuestLocal } from './guest.js';
import { createLive, applyTick } from './live.js';
import { AUTO_GROUPS, arrange, autoGroup, groupOf, cleanName } from './groups.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// Writes in flight, so a refresh never overwrites a change that is still being saved.
let pending = 0, writes = 0;
async function api(path, opts = {}) {
  if ((opts.method ?? 'GET') === 'GET') return request(path, opts);
  pending++; writes++;
  try { return await request(path, opts); } finally { pending--; }
}
const guest = createGuestLocal();
async function request(path, { method = 'GET', json } = {}) {
  if (role === 'guest') {
    const local = guest.handle(path, method, json);
    if (local !== undefined) return local;
  }
  let res;
  try {
    res = await fetch('/api/' + path, {
      method, headers: json ? { 'Content-Type': 'application/json' } : {}, body: json && JSON.stringify(json),
    });
  } catch { throw new Error(location.protocol === 'https:' ? 'No connection.' : 'The local server is not responding. Open Charts again.'); }
  let data;
  try { data = await res.json(); } catch { throw new Error(`Error ${res.status}`); }
  if (res.status === 401) showLogin();
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return role === 'guest' && method === 'GET' && path === 'watchlist' ? guest.apply(data) : data;
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg; $('toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500);
}

// ---------- state ----------
const TFS = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '1d', '1w', '1M'];
const TF_SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '45m': 2700, '1h': 3600, '2h': 7200, '3h': 10800, '4h': 14400, '1d': 86400, '1w': 604800, '1M': 28 * 86400 };
const TF_NAME = { '1d': 'D', '1w': 'W', '1M': 'M' };
const RANGES = [ // label, timeframe, days
  ['1D', '5m', 1], ['5D', '30m', 5], ['1M', '1h', 31], ['3M', '1d', 92], ['6M', '1d', 183],
  ['YTD', '1d', 'ytd'], ['1Y', '1d', 366], ['5Y', '1w', 1827], ['All', '1M', 'all'],
];
const FLAGS = ['', 'red', 'blue', 'green', 'amber', 'violet', 'cyan', 'pink'];
const TYPE_NAME = { EQUITY: 'Stock', ETF: 'ETF', INDEX: 'Index', CURRENCY: 'Forex', CRYPTOCURRENCY: 'Crypto', FUTURE: 'Future', MUTUALFUND: 'Fund' };

const state = { id: null, tf: '1d', type: 'candles', log: true, side: true, details: true, draw: {}, styles: {} };
try { Object.assign(state, JSON.parse(localStorage.getItem('view') ?? '{}')); } catch { /* first run */ }
if (!TFS.includes(state.tf)) state.tf = '1d';
const save = () => { try { localStorage.setItem('view', JSON.stringify(state)); } catch { /* no storage */ } };

let list = [], quotes = {}, coverage = [], current = null, loadSeq = 0, cloud = false, editing = false, link = null, rev = null, role = 'owner', guestAccess = 'off';

// ---------- phone ----------
const phone = matchMedia('(max-width: 860px)');
function setTab(tab) {
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-pressed', b.dataset.tab === tab);
  if (tab === 'chart') chart.resize();
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => setTab(b.dataset.tab);
setTab('list');

// ---------- history cache (web version): opens instantly, then updates ----------
const histKey = (id, tf) => `/hist?${new URLSearchParams({ id, tf })}`;
async function cachedHistory(id, tf) {
  if (!cloud || !window.caches) return null;
  try { return await (await (await caches.open('history')).match(histKey(id, tf)))?.json() ?? null; } catch { return null; }
}
async function cacheHistory(id, tf, candles) {
  if (!cloud || !window.caches || !candles.length) return;
  try { await (await caches.open('history')).put(histKey(id, tf), new Response(JSON.stringify(candles), { headers: { 'Content-Type': 'application/json' } })); } catch { /* no space */ }
}

// ---------- formats ----------
function decimalsFor(inst, price) {
  const p = Math.abs(price ?? 0);
  if (p >= 10) return 2;
  if (inst && ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(inst.type) && p >= 1) return 2;
  return p >= 1 ? 4 : p >= 0.01 ? 5 : 8;
}
const num = (v, d) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const pct = v => (v == null ? '' : num(v, 2) + '%');
const compact = v => v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const tone = v => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

// Price with the digits that just changed in green or red.
const ticks = createTicks();
function priceCell(inst, q, d, tag = 'span') {
  const cell = el(tag, '', '');
  if (q.last == null) { cell.textContent = q.error ? 'error' : '…'; return cell; }
  const text = num(q.last, d), m = ticks.get(inst.id);
  const i = m ? firstChange(num(m.from, d), text) : text.length;
  cell.append(text.slice(0, i));
  if (i < text.length) {
    const s = el('span', 'tick ' + (m.up ? 'up' : 'down'), text.slice(i));
    s.style.setProperty('--left', `${m.until - Date.now()}ms`);
    cell.append(s);
  }
  return cell;
}

// ---------- chart ----------
const chart = new Chart($('chart'), {
  onHover: renderOhlc,
  onAutoChange: on => $('auto').setAttribute('aria-pressed', on),
  onLayout: () => saveIndicators(chart.cfg),
});

const layer = new Layer(chart, {
  load: id => api(`drawings?${new URLSearchParams({ id })}`),
  save: (id, put, del) => api('drawings', { method: 'POST', json: { id, put, del } }),
  onSelect: () => {}, onTool: () => {}, toast,
});
for (const k of Object.keys(layer.opts)) if (typeof state.draw?.[k] === 'boolean') layer.opts[k] = state.draw[k];
if (state.styles && typeof state.styles === 'object') layer.styles = state.styles;
mountTools({
  layer, nav: $('tools'), bar: $('selbar'), host: $('stage'), toast,
  persist: () => { state.draw = { ...layer.opts }; state.styles = layer.styles; save(); },
});

let indTimer = 0;
function saveIndicators(cfg) {
  clearTimeout(indTimer);
  indTimer = setTimeout(() => { indTimer = 0; api('indicators', { method: 'PUT', json: cfg }).catch(e => toast(e.message)); }, 300);
}
const indicators = mountIndicators({ chart, top: $('lgInd'), rsiBox: $('lgRsi'), dialog: $('indDialog'), onChange: saveIndicators });

function renderOhlc(i) {
  indicators?.update(i);
  const box = $('lgOhlc');
  const r = i == null ? null : chart.rows[i];
  if (!r) { box.replaceChildren(); return; }
  const d = chart.decimals, prev = chart.rows[i - 1], base = prev ? prev.c : r.o, chg = r.c - base;
  const cell = (k, v) => { const s = el('span', '', k + ' '); s.append(el('b', tone(r.c - r.o), v)); return s; };
  box.replaceChildren(
    cell('O', num(r.o, d)), cell('H', num(r.h, d)), cell('L', num(r.l, d)), cell('C', num(r.c, d)),
    el('span', tone(chg), `${chg > 0 ? '+' : ''}${num(chg, d)} (${chg > 0 ? '+' : ''}${base ? pct((chg / base) * 100) : '—'})`),
  );
}

function message(text) { $('message').hidden = !text; $('message').textContent = text ?? ''; }
const parse = rows => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const isIntraday = tf => !['1d', '1w', '1M'].includes(tf);

async function load(range) {
  if (!current) return;
  const seq = ++loadSeq, inst = current, tf = state.tf;
  layer.cancel();
  chart.setData([], { intraday: isIntraday(tf), decimals: 2, seconds: TF_SECONDS[tf] });
  renderHeader();
  message('Loading history…');
  let cachedRows = null;
  try {
    const saved = await cachedHistory(inst.id, tf);
    if (seq !== loadSeq) return;
    if (saved?.length) {
      cachedRows = parse(saved);
      message(null);
      chart.setData(cachedRows, { intraday: isIntraday(tf), decimals: decimalsFor(inst, cachedRows.at(-1).c), seconds: TF_SECONDS[tf] });
      if (range) applyRange(range);
      renderCoverage();
    }
    const { candles, warning } = await api(`candles?${new URLSearchParams({ id: inst.id, tf })}`);
    if (seq !== loadSeq) return;
    const rows = parse(candles);
    cacheHistory(inst.id, tf, candles);
    if (cachedRows && rows.length) { chart.refresh(rows); renderCoverage(); return; }
    message(rows.length ? null : 'The data source has nothing for this timeframe.');
    chart.setData(rows, { intraday: isIntraday(tf), decimals: decimalsFor(inst, rows.at(-1)?.c), seconds: TF_SECONDS[tf] });
    if (warning) toast(`Showing saved data. ${warning}`);
    if (range) applyRange(range);
    setTimeout(() => { if (seq === loadSeq) poll(); }, 1500); // picks up anything that arrived late
    renderCoverage();
    refreshStatus();
  } catch (e) {
    if (seq !== loadSeq) return;
    if (cachedRows) toast(`Showing saved data. ${e.message}`); else message(e.message);
  }
}

async function poll() {
  const last = chart.raw.at(-1);
  if (!current || !last || document.hidden) return;
  const seq = loadSeq;
  try {
    const { candles } = await api(`candles?${new URLSearchParams({ id: current.id, tf: state.tf, since: last.t })}`);
    if (seq === loadSeq) chart.updateTail(parse(candles));
  } catch { /* retries on the next cycle */ }
}

function applyRange(days) {
  const rows = chart.raw;
  if (!rows.length) return;
  if (days === 'all') return chart.showRange(-Infinity);
  const last = rows.at(-1).t;
  if (days === 'ytd') return chart.showRange(Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000);
  if (days === 1 || days === 5) { // trading sessions, not calendar days
    const seen = new Set();
    for (let i = rows.length - 1; i >= 0; i--) {
      seen.add(new Date(rows[i].t * 1000).toDateString());
      if (seen.size > days) return chart.showRange(rows[i + 1].t);
    }
    return chart.showRange(-Infinity);
  }
  chart.showRange(last - days * 86400);
}

function select(id) {
  const inst = list.find(i => i.id === id);
  if (!inst) return;
  current = inst; state.id = id; save();
  if (groups.on && groups.closed.includes(groupOf(inst))) { groups.closed = groups.closed.filter(n => n !== groupOf(inst)); saveGroups(); }
  renderList(); renderDetails(); renderGroupBox(); load(); layer.load(id);
  document.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
}

function setTf(tf, range) { state.tf = tf; save(); renderTfs(); load(range); }
$('tfSel').replaceChildren(...TFS.map(tf => new Option(TF_NAME[tf] ?? tf, tf)));
$('tfSel').onchange = e => setTf(e.target.value);

// ---------- header ----------
function renderHeader() {
  $('symbolLabel').textContent = current?.label ?? '—';
  $('lgName').textContent = current ? current.name || current.label : '';
  $('lgInfo').textContent = current ? [TF_NAME[state.tf] ?? state.tf, current.exchange, current.currency].filter(Boolean).join(', ') : '';
  const q = quotes[current?.id];
  document.title = current ? `${current.label}${q?.last != null ? ' ' + num(q.last, decimalsFor(current, q.last)) : ''}` : 'Charts';
}
function renderTfs() {
  $('tfSel').value = state.tf;
  $('tfs').replaceChildren(...TFS.map(tf => {
    const b = el('button', '', TF_NAME[tf] ?? tf);
    b.setAttribute('aria-pressed', tf === state.tf); b.onclick = () => setTf(tf);
    return b;
  }));
}
function renderCoverage() {
  const rows = chart.raw;
  $('coverage').textContent = rows.length
    ? `${rows.length.toLocaleString('en-US')} bars since ${new Date(rows[0].t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : '';
}

// ---------- watchlist ----------
const groups = { on: true, order: [], closed: [] };
const saveGroups = () => api('groups', { method: 'PUT', json: groups }).catch(e => toast(e.message));
const arranged = () => arrange(list, groups.order);
// Symbols in display order, without collapsed groups.
const visible = () => (groups.on ? arranged().filter(g => !groups.closed.includes(g.name)).flatMap(g => g.items) : list);

function renderList() {
  const box = $('list');
  const top = box.scrollTop;
  if (groups.on) {
    box.replaceChildren(...arranged().flatMap(g => {
      const open = !groups.closed.includes(g.name);
      return [groupHead(g, open), ...(open ? g.items.map(listRow) : [])];
    }));
  } else box.replaceChildren(...list.map(listRow));
  box.scrollTop = top;
}

function groupHead(g, open) {
  const h = el('button', 'ghead');
  h.setAttribute('aria-expanded', open); h.draggable = true;
  h.title = 'Click to expand or collapse. Drag to reorder, or drop a symbol here.';
  h.append(el('span', '', g.name), el('span', 'n', g.items.length));
  h.onclick = () => {
    groups.closed = open ? [...groups.closed, g.name] : groups.closed.filter(n => n !== g.name);
    renderList(); saveGroups();
  };
  h.ondragstart = e => { e.dataTransfer.setData('application/x-group', g.name); e.dataTransfer.effectAllowed = 'move'; };
  h.ondragover = e => { e.preventDefault(); h.classList.add('drop'); };
  h.ondragleave = () => h.classList.remove('drop');
  h.ondrop = e => {
    e.preventDefault(); h.classList.remove('drop');
    const name = e.dataTransfer.getData('application/x-group');
    if (!name) { const inst = list.find(i => i.id === e.dataTransfer.getData('text/plain')); if (inst) setGroup(inst, g.name); return; }
    if (name === g.name) return;
    const names = arranged().map(x => x.name), to = names.indexOf(g.name);
    names.splice(names.indexOf(name), 1); names.splice(to, 0, name);
    groups.order = names; renderList(); saveGroups();
  };
  return h;
}

async function setGroup(inst, name) {
  if (groupOf(inst) === name) return;
  const grp = name === autoGroup(inst) ? '' : name, old = inst.grp;
  inst.grp = grp;
  renderList(); renderGroupBox();
  try { await api('watchlist/group', { method: 'PUT', json: { id: inst.id, grp } }); }
  catch (e) { inst.grp = old; renderList(); renderGroupBox(); toast(e.message); }
}

function renderGroupBox() {
  const box = $('groupBox');
  if (!current || !groups.on) { box.replaceChildren(); return; }
  const inst = current, s = el('select');
  s.setAttribute('aria-label', 'Symbol group');
  for (const n of new Set([...arranged().map(g => g.name), ...AUTO_GROUPS])) s.append(new Option(n, n));
  s.append(new Option('New group…', '\0new'));
  s.value = groupOf(inst);
  s.onchange = () => {
    if (s.value !== '\0new') { setGroup(inst, s.value); return; }
    const i = el('input'); i.placeholder = 'Group name, Enter to confirm'; i.maxLength = 30;
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      const name = cleanName(i.value);
      if (ok && name && name !== groupOf(inst)) setGroup(inst, name); else renderGroupBox();
    };
    i.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
    i.onblur = () => finish(true);
    s.replaceWith(i); i.focus();
  };
  box.replaceChildren(el('span', '', 'Group'), s);
}

function listRow(inst) {
    const q = quotes[inst.id] ?? {}, d = decimalsFor(inst, q.last);
    const row = el('div', 'rows row' + (inst.id === state.id ? ' active' : ''));
    row.draggable = true; row.dataset.id = inst.id;
    const hol = holidayFor(inst);
    row.title = q.error ?? `${inst.name} (${inst.exchange})` + (hol ? `\n* ${hol.market} closed today: ${hol.name}` : '');
    const sym = el('span', 'sym', inst.label);
    if (hol) { const star = el('span', 'hol', '*'); star.setAttribute('aria-label', `holiday, ${hol.market} closed today`); sym.append(star); }
    const flag = el('button', 'flag');
    flag.dataset.c = inst.flag; flag.title = 'Change flag color'; flag.setAttribute('aria-label', `Flag for ${inst.label}`);
    flag.onclick = e => { e.stopPropagation(); cycleFlag(inst); };
    const del = el('button', 'del', '×');
    del.title = 'Remove from watchlist (history is kept)'; del.setAttribute('aria-label', `Remove ${inst.label} from watchlist`);
    del.onclick = e => { e.stopPropagation(); remove(inst); };
    row.append(flag, logo(inst), sym,
      priceCell(inst, q, d),
      el('span', tone(q.chg), q.chg == null ? '' : num(q.chg, d)),
      el('span', tone(q.pct), pct(q.pct)), el('span', tone(q.ext), pct(q.ext)), el('span', 'name', assetName(inst)), del);
    row.onclick = () => { if (!editing) open(inst.id); };
    row.oncontextmenu = e => { e.preventDefault(); flagMenu(inst, e.clientX, e.clientY); };
    if (editing) editRow(row, inst, del);
    row.ondragstart = e => { e.dataTransfer.setData('text/plain', inst.id); e.dataTransfer.effectAllowed = 'move'; };
    row.ondragover = e => { e.preventDefault(); row.classList.add('drop'); };
    row.ondragleave = () => row.classList.remove('drop');
    row.ondrop = e => { e.preventDefault(); row.classList.remove('drop'); move(e.dataTransfer.getData('text/plain'), inst.id); };
    return row;
}

// Opening a symbol from the list also shows the chart on phones.
function open(id) {
  setTab('chart');
  if (id !== state.id || !chart.raw.length) select(id);
}

// Edit mode replaces hover and drag, which touch screens do not have.
function editRow(row, inst, del) {
  row.classList.add('editing');
  row.draggable = false;
  const btn = (text, title, run) => { const b = el('button', 'step', text); b.title = title; b.setAttribute('aria-label', `${title}: ${inst.label}`); b.onclick = e => { e.stopPropagation(); run(); }; return b; };
  const near = d => {
    const rows = groups.on ? arranged().find(g => g.name === groupOf(inst)).items : list;
    return rows[rows.indexOf(inst) + d];
  };
  const box = el('span', 'editbox');
  if (groups.on) {
    const s = el('select');
    s.setAttribute('aria-label', `Group of ${inst.label}`);
    for (const n of new Set([...arranged().map(g => g.name), ...AUTO_GROUPS])) s.append(new Option(n, n));
    s.append(new Option('New group…', '\0new'));
    s.value = groupOf(inst);
    s.onclick = e => e.stopPropagation();
    s.onchange = () => {
      if (s.value !== '\0new') return setGroup(inst, s.value);
      const name = cleanName(prompt('Group name') ?? '');
      if (name) setGroup(inst, name); else renderList();
    };
    box.append(s);
  }
  box.append(btn('↑', 'Move up', () => { const n = near(-1); if (n) move(inst.id, n.id); }),
    btn('↓', 'Move down', () => { const n = near(1); if (n) move(n.id, inst.id); }));
  row.replaceChildren(row.children[0], row.children[1], row.children[2], box, del);
}

const cycleFlag = inst => setFlag(inst, FLAGS[(FLAGS.indexOf(inst.flag) + 1) % FLAGS.length]);
async function setFlag(inst, flag) {
  const old = inst.flag;
  if (old === flag) return;
  inst.flag = flag;
  renderList();
  try { await api('watchlist/flag', { method: 'PUT', json: { id: inst.id, flag } }); }
  catch (e) { inst.flag = old; renderList(); toast(e.message); }
}
async function unflagAll() {
  const flagged = list.filter(i => i.flag);
  for (const i of flagged) i.flag = '';
  renderList();
  try { for (const i of flagged) await api('watchlist/flag', { method: 'PUT', json: { id: i.id, flag: '' } }); }
  catch (e) { toast(e.message); }
}

// Right-click menu of a row: pick the flag color, or click the current one to remove it.
function flagMenu(inst, x, y) {
  const menu = $('flagMenu');
  const dots = el('div', 'dots');
  for (const c of FLAGS.filter(Boolean)) {
    const b = el('button', 'dot'), on = inst.flag === c;
    b.dataset.c = c; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', on);
    b.title = on ? 'Remove flag' : c[0].toUpperCase() + c.slice(1);
    b.setAttribute('aria-label', b.title);
    b.onclick = () => { closeFlagMenu(); setFlag(inst, on ? '' : c); };
    dots.append(b);
  }
  const all = el('button', 'mitem', 'Unflag all symbols');
  all.setAttribute('role', 'menuitem');
  all.disabled = !list.some(i => i.flag);
  all.onclick = () => { closeFlagMenu(); unflagAll(); };
  menu.replaceChildren(el('div', 'mhead', `Flag/Unflag ${inst.label}`), dots, all);
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  (dots.querySelector('[aria-checked="true"]') ?? dots.firstChild).focus();
}
function closeFlagMenu() { $('flagMenu').hidden = true; }
document.addEventListener('pointerdown', e => { if (!$('flagMenu').hidden && !$('flagMenu').contains(e.target)) closeFlagMenu(); }, true);
addEventListener('blur', closeFlagMenu);
addEventListener('resize', closeFlagMenu);
$('list').addEventListener('scroll', closeFlagMenu);
$('flagMenu').addEventListener('keydown', e => {
  e.stopPropagation();
  const dots = [...$('flagMenu').querySelectorAll('.dot')], i = dots.indexOf(document.activeElement);
  if (e.key === 'Escape') closeFlagMenu();
  else if (i >= 0 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); dots[(i + (e.key === 'ArrowRight' ? 1 : dots.length - 1)) % dots.length].focus(); }
});
async function move(id, beforeId) {
  const from = list.findIndex(i => i.id === id);
  if (from < 0 || id === beforeId) return;
  const target = list.findIndex(i => i.id === beforeId);
  if (groups.on) setGroup(list[from], groupOf(list[target]));
  const [item] = list.splice(from, 1);
  list.splice(target, 0, item);
  renderList();
  try { await api('watchlist/order', { method: 'PUT', json: { ids: list.map(i => i.id) } }); } catch (e) { toast(e.message); }
}
async function remove(inst) {
  const shownNow = visible(), at = shownNow.findIndex(x => x.id === inst.id), next = shownNow[at + 1] ?? shownNow[at - 1];
  try {
    await api(`watchlist?${new URLSearchParams({ id: inst.id })}`, { method: 'DELETE' });
    const i = list.findIndex(x => x.id === inst.id);
    list.splice(i, 1);
    if (inst.id === state.id && list.length) select((next ?? list[Math.min(i, list.length - 1)]).id); else renderList();
    toast(`${inst.label} was removed. Its history is kept.`);
  } catch (e) { toast(e.message); }
}

function renderDetails() {
  const box = $('details'), q = quotes[current?.id];
  if (!current) { box.replaceChildren(); return; }
  const d = decimalsFor(current, q?.last);
  const parts = [el('h3', '', current.name || current.label),
    el('div', 'sub', [TYPE_NAME[current.type] ?? current.type, current.exchange, `Data: ${current.source === 'yahoo' ? 'Yahoo' : 'Binance'}`].filter(Boolean).join(' · '))];
  if (q?.last != null) {
    const p = el('div', 'price');
    p.append(priceCell(current, q, d), ' ');
    p.append(el('small', '', current.currency + ' '), el('small', tone(q.pct), pct(q.pct)));
    parts.push(p);
    const range = (name, lo, hi) => {
      if (lo == null || hi == null) return;
      const r = el('div', 'rng'), bar = el('div', 'bar'), dot = el('i');
      dot.style.left = (hi > lo ? Math.max(0, Math.min(100, ((q.last - lo) / (hi - lo)) * 100)) : 50) + '%';
      bar.append(dot); r.append(el('span', '', num(lo, d)), el('span', '', name), el('span', '', num(hi, d)), bar); parts.push(r);
    };
    range('Day range', q.dayLow, q.dayHigh);
    range('52 weeks', q.yearLow, q.yearHigh);
    if (q.volume) parts.push(el('div', 'sub', `Day volume: ${compact(q.volume)}`));
  } else if (q?.error) parts.push(el('div', 'sub', q.error));
  box.replaceChildren(...parts);
}

// Live Binance prices: each update touches only its own row.
const live = createLive({
  onPrice(id, price) {
    const q = quotes[id];
    if (!q || q.last === price) return;
    quotes[id] = applyTick(q, price);
    ticks.update({ [id]: quotes[id] });
    if (!editing) updateRow(id);
    if (current?.id === id) { chart.livePrice(price); renderDetails(); renderHeader(); }
  },
});
function followLive() {
  live.setSymbols(list.filter(i => i.source === 'binance').map(i => i.symbol));
  live.check();
}
function updateRow(id) {
  const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`), inst = list.find(i => i.id === id), q = quotes[id];
  if (!row || !inst) return;
  const d = decimalsFor(inst, q.last), [, , , price, chg, change] = row.children;
  price.replaceWith(priceCell(inst, q, d));
  chg.textContent = q.chg == null ? '' : num(q.chg, d); chg.className = tone(q.chg);
  change.textContent = pct(q.pct); change.className = tone(q.pct);
}

async function refreshQuotes() {
  if (document.hidden || !list.length) return;
  followLive();
  try {
    const fresh = await api(`quotes?${new URLSearchParams({ focus: current?.id ?? '' })}`);
    for (const [id, q] of Object.entries(fresh)) if (live.fresh(id) && quotes[id]?.last != null) fresh[id] = applyTick(q, quotes[id].last); // the stream is newer
    quotes = fresh; ticks.update(quotes); if (!editing) renderList(); renderDetails(); renderHeader();
  } catch { /* next cycle */ }
}

function setRole(s) {
  role = s.role ?? 'owner'; guestAccess = s.guest ?? 'off';
  $('guestBadge').hidden = role !== 'guest';
  document.body.classList.toggle('guest', role === 'guest');
}
async function refreshStatus() {
  try {
    const s = await api('status');
    cloud = !!s.cloud; setRole(s);
    for (const v of document.querySelectorAll('.version')) v.textContent = s.version ? `v${s.version}` : '';
    document.body.classList.toggle('cloud', cloud);
    if (cloud) { $('syncInfo').textContent = list.length === 1 ? '1 symbol' : `${list.length} symbols`; return; }
    coverage = s.coverage; link = s.link;
    const daily = new Set(coverage.filter(c => c.tf === '1d').map(c => c.id));
    const ready = list.filter(i => daily.has(i.id)).length;
    const busy = s.sync.running || s.sync.seeding;
    $('syncInfo').textContent = busy ? `Downloading ${s.sync.done}/${s.sync.total || '…'}` : link ? (link.error ? 'web sync: offline' : 'synced with web') : `${ready}/${list.length} with history`;
    $('syncInfo').title = [link?.error, `${ready}/${list.length} with history`, ...s.sync.errors].filter(Boolean).join('\n');
    $('syncBtn').disabled = busy;
    if (busy) {
      const fresh = await api('watchlist');
      if (fresh.length !== list.length) {
        list = fresh; renderList(); refreshQuotes();
        if (!current && list.length) select(list[0].id);
      }
      setTimeout(refreshStatus, 1200);
    }
  } catch (e) { $('syncInfo').textContent = 'offline'; }
}

// ---------- live updates ----------
// Every few seconds checks whether something changed on another device and shows it here.
const interacting = () => pending || indTimer || editing || layer.draft || layer.drag || layer.closeText
  || document.querySelector('dialog[open], #groupBox input, .row.drop');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function checkChanges() {
  if (document.hidden || role === 'guest' || interacting()) return;
  try {
    const now = (await api('rev')).rev;
    if (now == null || now === rev) return;
    const mark = writes, id = current?.id;
    const [newList, newGroups, newInd, newDrawings] = await Promise.all([
      api('watchlist'), api('groups'), api('indicators'), id ? api(`drawings?${new URLSearchParams({ id })}`).catch(() => null) : null,
    ]);
    if (writes !== mark || interacting() || current?.id !== id) return; // try again on the next cycle
    rev = now;
    const g = { on: true, order: [], closed: [], ...newGroups };
    if (!same(g, { on: groups.on, order: groups.order, closed: groups.closed }) || !same(newList, list)) {
      Object.assign(groups, g);
      list = newList;
      $('groupBtn').setAttribute('aria-pressed', groups.on);
      current = list.find(i => i.id === id) ?? null;
      renderList();
      if (!list.length) showEmpty();
      else if (!current) select(list[0].id);
      else { renderGroupBox(); refreshQuotes(); }
    }
    const cfg = withDefaults(newInd);
    if (!same(cfg, chart.cfg)) { chart.setIndicators(cfg); indicators.build(); }
    if (newDrawings && current?.id === id) layer.replace(newDrawings);
  } catch { /* retries on the next cycle */ }
}

function showEmpty() {
  chart.setData([], { intraday: false, decimals: 2 });
  message(cloud ? 'Your watchlist is empty. Add a symbol, or import a backup in More.' : 'Your watchlist is empty. Click Add.');
  $('list').replaceChildren(el('p', 'empty', cloud ? 'Your watchlist is empty. Tap Add, or import a backup in More.' : 'Your watchlist is empty.'));
}

// ---------- search ----------
const GROUPS = { All: null, Stocks: ['EQUITY'], ETFs: ['ETF', 'MUTUALFUND'], Indices: ['INDEX'], Forex: ['CURRENCY'], Crypto: ['CRYPTOCURRENCY'], Futures: ['FUTURE'] };
let found = [], shown = [], sel = 0, group = 'All', searchSeq = 0, searchTimer;

function openSearch(initial = '') {
  if ($('search').open) return;
  if (role === 'guest') { toast('The guest list is fixed.'); return; }
  $('search').showModal();
  $('q').value = initial; found = []; renderResults(initial ? 'Searching…' : 'Type to search stocks, B3, ETFs, forex and crypto.');
  $('q').focus();
  if (initial) queueSearch();
}
function queueSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); }
async function runSearch() {
  const text = $('q').value.trim(), seq = ++searchSeq;
  if (!text) { found = []; renderResults('Type to search stocks, B3, ETFs, forex and crypto.'); return; }
  try {
    const r = await api(`search?${new URLSearchParams({ q: text })}`);
    if (seq !== searchSeq) return;
    found = r; sel = 0; renderResults();
  } catch (e) { if (seq === searchSeq) { found = []; renderResults(e.message); } }
}
function renderResults(note) {
  $('filters').replaceChildren(...Object.keys(GROUPS).map(g => {
    const b = el('button', '', g); b.setAttribute('aria-pressed', g === group);
    b.onclick = () => { group = g; sel = 0; renderResults(); $('q').focus(); };
    return b;
  }));
  shown = found.filter(r => !GROUPS[group] || GROUPS[group].includes(r.type));
  if (!shown.length) { $('results').replaceChildren(el('p', '', note ?? 'Nothing found. Try the exchange symbol, such as PETR4 or AAPL.')); return; }
  const have = new Set(list.map(i => i.id));
  $('results').replaceChildren(...shown.map((r, i) => {
    const row = el('div', 'res' + (i === sel ? ' sel' : ''));
    row.append(el('b', '', r.label), el('span', 'nm', r.name),
      el('span', 'ex', `${TYPE_NAME[r.type] ?? r.type} · ${r.exchange}`), el('span', 'in', have.has(r.id) ? 'added' : ''));
    row.onclick = () => choose(r);
    return row;
  }));
  $('results').children[sel]?.scrollIntoView({ block: 'nearest' });
}
async function choose(r) {
  $('search').close();
  if (!list.some(i => i.id === r.id)) {
    toast(`Adding ${r.label}…`);
    try {
      await api('watchlist', { method: 'POST', json: { id: r.id } });
      list = await api('watchlist');
      refreshQuotes();
    } catch (e) { toast(`Could not add ${r.label}: ${e.message}`); return; }
  }
  open(r.id);
}
$('q').oninput = queueSearch;
$('q').onkeydown = e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sel = Math.max(0, Math.min(shown.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
    renderResults();
  } else if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) choose(shown[sel]); }
};
$('searchClose').onclick = () => $('search').close();
$('search').onclick = e => { if (e.target === $('search')) $('search').close(); };

// ---------- controls ----------
$('symbolBtn').onclick = $('addBtn').onclick = () => openSearch();
$('type').onchange = e => { state.type = e.target.value; save(); chart.setType(state.type); };
$('log').onclick = () => { state.log = !state.log; save(); $('log').setAttribute('aria-pressed', state.log); chart.setLog(state.log); };
$('groupBtn').onclick = () => { groups.on = !groups.on; $('groupBtn').setAttribute('aria-pressed', groups.on); renderList(); renderGroupBox(); saveGroups(); };
$('indBtn').onclick = () => indicators.open('ma');
$('auto').onclick = () => chart.setAuto(!chart.auto);
$('sideBtn').onclick = () => { state.side = !state.side; save(); renderSide(); };
$('syncBtn').onclick = async () => { try { await api('sync', { method: 'POST', json: {} }); refreshStatus(); } catch (e) { toast(e.message); } };
$('goto').onchange = e => {
  if (!e.target.value) return;
  if (!chart.goTo(Date.parse(e.target.value + 'T00:00:00Z') / 1000)) toast('History for this timeframe starts after that date.');
};
$('drawBtn').onclick = () => {
  const on = document.body.classList.toggle('drawing');
  $('drawBtn').setAttribute('aria-pressed', on);
  chart.resize();
  if (!on) layer.setTool(null);
};
$('editBtn').onclick = () => { editing = !editing; $('editBtn').setAttribute('aria-pressed', editing); $('editBtn').textContent = editing ? 'Done' : 'Edit'; renderList(); };

// ---------- backup and session ----------
async function exportBackup() {
  try {
    const data = await api('backup');
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = `charts-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) { toast(e.message); }
}
$('backupFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('This file is not a Charts backup'); return; }
  try {
    const r = await api('backup', { method: 'POST', json: data });
    $('moreDialog').close();
    toast(`Imported ${r.watchlist} symbols and ${r.drawings} drawings.`);
    await start();
  } catch (err) { toast(err.message); }
};
$('moreBtn').onclick = () => {
  const d = $('moreDialog'), item = (text, sub, run) => { const b = el('button', 'item'); b.append(el('b', '', text), el('span', '', sub)); b.onclick = run; return b; };
  const parts = [el('h2', '', 'More'),
    ...(role === 'guest' ? [el('p', 'sub', 'You are a guest. The list is fixed, and your drawings and settings stay in this browser only.'),
      item('Clear my changes', 'Deletes your drawings and settings from this browser', () => { guest.clear(); location.reload(); })]
      : [item('Export backup', 'Watchlist, groups, drawings and indicators in one file', exportBackup),
        item('Import backup', 'Adds the contents of a backup file to what is here', () => $('backupFile').click())])];
  if (cloud) {
    const out = el('p', 'sub');
    if (guestAccess !== 'off') parts.push(el('p', 'sub', guestAccess === 'on' ? 'Guest access is on (read-only).' : `Guest access is off: ${guestAccess}`));
    if (role !== 'guest') parts.push(item('Connection test', 'Checks the database and the price providers', async () => {
      out.textContent = 'Testing…';
      try {
        const r = await api('selftest');
        out.textContent = Object.entries(r).map(([k, v]) => `${k}: ${v.ok ? `ok, ${v.ms} ms` : v.error}`).join('\n');
      } catch (e) { out.textContent = e.message; }
    }), out);
    parts.push(item('Sign out', 'On this device', async () => {
      try { await api('logout', { method: 'POST', json: {} }); } catch { /* already out */ }
      try { await caches.delete('history'); } catch { /* none */ }
      location.reload();
    }));
  }
  if (!cloud) parts.push(webSync(d));
  const close = el('button', 'primary', 'Close'); close.onclick = () => d.close();
  d.replaceChildren(...parts, close);
  d.showModal();
};
$('moreDialog').onclick = e => { if (e.target === $('moreDialog')) $('moreDialog').close(); };

// Desktop only: use the same watchlist, groups, drawings and indicators as the web version.
function webSync(dialog) {
  const box = el('form', 'websync');
  box.append(el('h3', '', 'Web sync'));
  if (link) {
    box.append(el('p', 'sub', link.error ? `${link.url}\n${link.error}` : `Sharing everything with ${link.url}`));
    const off = el('button', '', 'Disconnect'); off.type = 'button';
    off.onclick = async () => { try { await api('link', { method: 'DELETE' }); link = null; dialog.close(); toast('Disconnected. This computer keeps its copy.'); start(); } catch (e) { toast(e.message); } };
    box.append(off);
    if (!link.error) return box;
  } else box.append(el('p', 'sub', 'Share your watchlist, groups, drawings and indicators with your web version. Changes show up on every device in a few seconds.'));
  const url = el('input'), pass = el('input'), err = el('p', 'err'), go = el('button', 'primary', link ? 'Sign in again' : 'Connect');
  url.placeholder = 'your-site.vercel.app'; url.value = link?.url ?? ''; url.autocomplete = 'off'; url.spellcheck = false; url.required = true;
  url.setAttribute('aria-label', 'Site address'); pass.setAttribute('aria-label', 'Password of your site');
  pass.type = 'password'; pass.placeholder = 'Password of your site'; pass.autocomplete = 'off'; pass.required = true;
  err.setAttribute('role', 'alert');
  box.append(url, pass, err, go);
  box.onsubmit = async e => {
    e.preventDefault();
    err.textContent = ''; go.disabled = true; go.textContent = 'Connecting…';
    try {
      const r = await api('link', { method: 'POST', json: { url: url.value, password: pass.value } });
      pass.value = '';
      dialog.close();
      toast(`Connected: ${r.total.watchlist} symbols and ${r.total.drawings} drawings are now shared.`);
      await start();
    } catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = link ? 'Sign in again' : 'Connect'; }
  };
  return box;
}

function showLogin() {
  if ($('loginDialog').open) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('loginDialog').showModal();
}
$('loginDialog').oncancel = e => e.preventDefault();
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  $('loginError').hidden = true;
  try {
    await api('login', { method: 'POST', json: { password: $('password').value } });
    $('password').value = '';
    $('loginDialog').close();
    start();
  } catch (err) { $('loginError').textContent = err.message; $('loginError').hidden = false; }
};

$('detailsBtn').onclick = () => { state.details = !state.details; save(); renderSide(); };

function renderSide() {
  $('detailsBtn').setAttribute('aria-expanded', state.details);
  $('side').classList.toggle('nodetails', !state.details);
  document.querySelector('main').classList.toggle('noside', !state.side);
  $('sideBtn').setAttribute('aria-pressed', state.side);
}
$('ranges').replaceChildren(...RANGES.map(([name, tf, days]) => {
  const b = el('button', '', name);
  b.onclick = () => (state.tf === tf ? applyRange(days) : setTf(tf, days));
  return b;
}));

document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (layer.key(e)) { e.preventDefault(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[a-z0-9]$/i.test(e.key)) { e.preventDefault(); openSearch(e.key.toUpperCase()); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const rows = visible(), i = rows.findIndex(x => x.id === state.id) + (e.key === 'ArrowDown' ? 1 : -1);
    if (rows[i]) { e.preventDefault(); select(rows[i].id); }
  }
});

// ---------- startup ----------
// Loads everything that depends on the server. Runs again after signing in or importing.
async function start() {
  try {
    setRole(await api('status')); // first: it decides where everything else comes from
    rev = (await api('rev')).rev;
    list = await api('watchlist');
  } catch (e) { message(e.message); return; }
  await refreshStatus();
  try { chart.setIndicators(withDefaults(await api('indicators'))); indicators.build(); } catch { /* use defaults */ }
  try { Object.assign(groups, await api('groups')); } catch { /* use defaults */ }
  $('groupBtn').setAttribute('aria-pressed', groups.on);
  renderList();
  if (list.length) select((list.find(i => i.id === state.id) ?? list[0]).id);
  else if (cloud || link) showEmpty();
  else message('Building the initial watchlist…');
  refreshQuotes();
}

async function init() {
  renderTfs(); renderSide();
  $('type').value = state.type; chart.setType(state.type);
  $('log').setAttribute('aria-pressed', state.log); chart.log = state.log;
  const tick = () => { $('clock').textContent = new Date().toLocaleTimeString('en-GB'); };
  tick(); setInterval(tick, 1000);
  await start();
  // Guests ask less often; their crypto prices are still live.
  const every = (ms, guestMs, run) => { let last = 0; setInterval(() => { if (role === 'guest' && Object.keys(quotes).length && Date.now() - last < guestMs) return; last = Date.now(); run(); }, ms); };
  every(5_000, 14_000, refreshQuotes);
  setInterval(checkChanges, 4_000);
  every(10_000, 29_000, poll);
  document.addEventListener('visibilitychange', () => { live.check(); if (!document.hidden) { checkChanges(); refreshQuotes(); poll(); } });
}
init();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
