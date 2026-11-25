// Side toolbar and the bar for the selected drawing.
import { TOOLS, FIB_LEVELS, parseLevels } from './drawings.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="1.8"/>`;
const ICONS = {
  cursor: '<path d="M12 4v6M12 14v6M4 12h6M14 12h6"/>',
  trend: `<path d="M6.5 17.5 17.5 6.5"/>${dot(5, 19)}${dot(19, 5)}`,
  hline: `<path d="M3 12h7M14 12h7"/>${dot(12, 12)}`,
  vline: `<path d="M12 3v7M12 14v7"/>${dot(12, 12)}`,
  hray: `<path d="M7 12h14"/>${dot(5, 12)}`,
  channel: `<path d="M5 13 14 4M10 20l9-9"/>${dot(4, 14)}${dot(15, 3)}${dot(9, 21)}`,
  fib: '<path d="M4 5h16M4 10h16M4 14.5h16M4 19h16"/><path d="M5 19 19 5" stroke-dasharray="2 2"/>',
  xabcd: `<path d="M4 18 8 6l4 8 5-9 3 13-8-4-8 4"/>`,
  long: '<path d="M4 4h16v9H4zM4 13v6h16v-6"/><path d="M12 11V6.5M10 8.5l2-2 2 2"/>',
  short: '<path d="M4 20h16v-9H4zM4 11V5h16v6"/><path d="M12 13v4.500M10 15.500l2 2 2-2"/>',
  prange: '<path d="M5 4h14M5 20h14M12 6v12M9.500 8.500 12 6l2.500 2.500M9.500 15.500 12 18l2.500-2.500"/>',
  rect: `<path d="M7 6h10M18 7v10M17 18H7M6 17V7"/>${dot(6, 6)}${dot(18, 6)}${dot(6, 18)}${dot(18, 18)}`,
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  emoji: '<circle cx="12" cy="12" r="8"/><path d="M8.500 14c1.500 2.500 5.500 2.500 7 0M9.500 9.500v.6M14.500 9.500v.6"/>',
  measure: '<path d="m3.500 15.500 12-12 5 5-12 12zM7 12l2 2M10 9l2.500 2.500M13 6l2 2"/>',
  keep: '<path d="m4 20 1-4L15 6l3 3L8 19zM13 8l3 3"/><path d="M15 17h6v4h-6zM16.500 17v-1.500a1.500 1.500 0 0 1 3 0V17"/>',
  hidden: '<path d="M3 12c4-7 14-7 18 0-4 7-14 7-18 0z"/><circle cx="12" cy="12" r="2.600"/><path d="M4 20 20 4"/>',
  undo: '<path d="M8 5 4 9l4 4M4 9h10a5 5 0 0 1 0 10H9"/>',
  redo: '<path d="m16 5 4 4-4 4M20 9H10a5 5 0 0 0 0 10h5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6.500 7l1 13h9l1-13M10 11v5.500M14 11v5.500"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const KEYS = { trend: 'Alt+T', hline: 'Alt+H', vline: 'Alt+V', hray: 'Alt+J', fib: 'Alt+F' };
const EMOJIS = ['🚀', '🔥', '⭐', '✅', '❌', '⚠️', '❓', '❗', '👍', '👎', '👀', '💰', '💎', '🎯', '📈', '📉', '🐂', '🐻', '🟢', '🔴', '🔵', '⬆️', '⬇️', '🏁', '😀', '😎', '🤔', '😱', '😭', '🙏'];
const SWATCHES = ['#4c8df0', '#2cb89b', '#5bb974', '#e0a83a', '#f0605c', '#a877e8', '#e4e8ee', '#8b93a1'];

export function mountTools({ layer, nav, bar, host, toast, persist }) {
  const { opts } = layer;
  const buttons = {};
  const btn = (name, title, run) => {
    const b = el('button');
    b.innerHTML = svg(name); b.title = title; b.setAttribute('aria-label', title); b.onclick = run;
    buttons[name] = b; return b;
  };
  const gap = () => el('hr');

  // ---------- emojis ----------
  const picker = el('div', 'picker'); picker.hidden = true;
  picker.append(...EMOJIS.map(x => {
    const b = el('button', '', x);
    b.onclick = () => { layer.emoji = x; picker.hidden = true; layer.setTool('emoji'); };
    return b;
  }));
  host.append(picker);
  document.addEventListener('pointerdown', e => {
    if (!picker.hidden && !picker.contains(e.target) && !buttons.emoji.contains(e.target)) picker.hidden = true;
  });

  // ---------- side toolbar ----------
  const tool = name => btn(name, TOOLS[name].name + (KEYS[name] ? ` (${KEYS[name]})` : ''), () => {
    if (name === 'emoji') { picker.hidden = !picker.hidden; return; }
    layer.setTool(layer.tool === name ? null : name);
  });
  const toggle = (name, title) => btn(name, title, () => {
    opts[name] = !opts[name];
    if (name === 'hidden') layer.select(null);
    persist(); refresh(); layer.chart.draw();
  });
  nav.append(
    btn('cursor', 'Cursor (Esc)', () => layer.setTool(null)), gap(),
    ...['trend', 'hline', 'hray', 'vline', 'channel', 'fib', 'xabcd', 'long', 'short', 'prange', 'rect', 'text', 'emoji'].map(tool), gap(),
    btn('measure', 'Measure (or Shift + drag)', () => layer.setTool(layer.tool === 'measure' ? null : 'measure')), gap(),
    toggle('keep', 'Keep drawing with the same tool'),
    toggle('hidden', 'Hide all drawings'), gap(),
    btn('undo', 'Undo (Ctrl+Z)', () => layer.undo()),
    btn('redo', 'Redo (Ctrl+Y)', () => layer.redo()),
    btn('trash', 'Delete all drawings on this symbol', () => {
      const free = layer.items.filter(d => !d.locked).length, kept = layer.items.length - free;
      if (!free) { toast(kept ? 'This symbol only has locked drawings.' : 'This symbol has no drawings.'); return; }
      layer.remove([...layer.items]);
      toast(`${free} ${free === 1 ? 'drawing' : 'drawings'} deleted${kept ? `, ${kept} locked kept` : ''}. Ctrl+Z to undo.`);
    }),
  );

  function refresh() {
    const t = layer.tool ?? 'cursor';
    for (const [k, b] of Object.entries(buttons)) {
      if (k in opts) b.setAttribute('aria-pressed', opts[k]);
      else if (k in TOOLS || ['cursor', 'measure'].includes(k)) b.setAttribute('aria-pressed', k === t);
    }
  }

  // ---------- selection bar ----------
  function setStyle(d, patch) {
    layer.edit(d, o => Object.assign(o, patch));
    layer.styles[d.tool] = { ...layer.styles[d.tool], ...patch };
    persist(); renderBar(d);
  }
  function renderBar(d) {
    bar.hidden = !d;
    if (!d) return;
    const parts = [el('span', 'barname', TOOLS[d.tool].name)];
    const isPos = d.tool === 'long' || d.tool === 'short';
    if (!isPos && d.tool !== 'emoji' && !d.locked) {
      const sw = el('div', 'swatches');
      for (const c of SWATCHES) {
        const b = el('button', 'sw'); b.style.background = c; b.title = c; b.setAttribute('aria-label', `Color ${c}`);
        b.setAttribute('aria-pressed', d.color === c); b.onclick = () => setStyle(d, { color: c });
        sw.append(b);
      }
      const custom = el('input'); custom.type = 'color'; custom.value = d.color; custom.title = 'Custom color';
      custom.onchange = () => setStyle(d, { color: custom.value });
      sw.append(custom); parts.push(sw);
    }
    if (!isPos && !d.locked) {
      const w = el('select'); w.title = d.tool === 'text' || d.tool === 'emoji' ? 'Size' : 'Thickness';
      for (let i = 1; i <= 5; i++) w.append(new Option((d.tool === 'text' || d.tool === 'emoji' ? 'Size ' : '') + i + (d.tool === 'text' || d.tool === 'emoji' ? '' : ' px'), i));
      w.value = d.width ?? 2; w.onchange = () => setStyle(d, { width: Number(w.value) });
      parts.push(w);
    }
    if (['trend', 'hline', 'vline', 'hray', 'channel', 'rect', 'brush', 'prange'].includes(d.tool) && !d.locked) {
      const b = el('button', '', 'Dashed'); b.setAttribute('aria-pressed', !!d.dash); b.onclick = () => setStyle(d, { dash: !d.dash }); parts.push(b);
    }
    if (d.tool === 'fib' && !d.locked) {
      const i = el('input', 'levels'); i.value = (d.levels ?? FIB_LEVELS).join(' '); i.title = 'Levels, separated by spaces. Enter to apply.';
      i.onchange = () => { const v = parseLevels(i.value); if (v) setStyle(d, { levels: v }); else toast('Use numbers separated by spaces, such as 0 0.382 0.618 1'); };
      parts.push(i);
    }
    if (d.tool === 'text' && !d.locked) { const b = el('button', '', 'Edit text'); b.onclick = () => layer.editText(d); parts.push(b); }
    const lock = el('button', '', d.locked ? 'Unlock' : 'Lock');
    lock.onclick = () => { layer.edit(d, o => { o.locked = !o.locked; }); renderBar(d); };
    parts.push(lock);
    if (!d.locked) {
      const dup = el('button', '', 'Duplicate'); dup.onclick = () => layer.duplicate(d);
      const del = el('button', 'danger', 'Delete'); del.title = 'Delete'; del.onclick = () => layer.remove([d]);
      parts.push(dup, del);
    }
    bar.replaceChildren(...parts);
  }

  layer.onTool = () => refresh();
  layer.onSelect = renderBar;
  refresh(); renderBar(null);
}
