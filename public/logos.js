// Round symbol icons for the watchlist: a logo from the server, flags for forex, or a drawn fallback.
const wrap = (inner, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${inner}</svg>`;

// Simplified flags, drawn on a 24x24 square and cut into a circle by the stylesheet.
const FLAGS = {
  BRL: '<rect width="24" height="24" fill="#1f9a4c"/><path d="m12 4 9 8-9 8-9-8z" fill="#f5d033"/><circle cx="12" cy="12" r="4" fill="#24408f"/>',
  USD: '<rect width="24" height="24" fill="#f3f4f6"/><path d="M0 2h24M0 6h24M0 10h24M0 14h24M0 18h24M0 22h24" stroke="#c8333f" stroke-width="2"/><rect width="12" height="12" fill="#2f4a8f"/><g fill="#fff"><circle cx="3" cy="3" r="1"/><circle cx="8" cy="3" r="1"/><circle cx="5.500" cy="6" r="1"/><circle cx="3" cy="9" r="1"/><circle cx="8" cy="9" r="1"/></g>',
  EUR: '<rect width="24" height="24" fill="#24408f"/><g fill="#f5d033"><circle cx="12" cy="5" r="1.300"/><circle cx="12" cy="19" r="1.300"/><circle cx="5" cy="12" r="1.300"/><circle cx="19" cy="12" r="1.300"/><circle cx="7" cy="7" r="1.300"/><circle cx="17" cy="7" r="1.300"/><circle cx="7" cy="17" r="1.300"/><circle cx="17" cy="17" r="1.300"/></g>',
  GBP: '<rect width="24" height="24" fill="#2f4a8f"/><path d="m0 0 24 24M24 0 0 24" stroke="#fff" stroke-width="4"/><path d="M12 0v24M0 12h24" stroke="#fff" stroke-width="7"/><path d="M12 0v24M0 12h24" stroke="#c8333f" stroke-width="4"/>',
  JPY: '<rect width="24" height="24" fill="#f3f4f6"/><circle cx="12" cy="12" r="6" fill="#c8333f"/>',
  CHF: '<rect width="24" height="24" fill="#d8323c"/><path d="M12 6v12M6 12h12" stroke="#fff" stroke-width="4"/>',
  CNY: '<rect width="24" height="24" fill="#d8323c"/><circle cx="9" cy="10" r="3" fill="#f5d033"/>',
  CAD: '<rect width="24" height="24" fill="#f3f4f6"/><path d="M0 0h6v24H0zM18 0h6v24h-6z" fill="#d8323c"/><path d="m12 6 4 6-4 6-4-6z" fill="#d8323c"/>',
};
const bars = (a, b) => `<rect width="24" height="24" fill="${b}"/><g fill="${a}"><path d="M9 7h6l1.500 4h-9zM4.500 13h6l1.500 4H3zM13.500 13h6l1.500 4h-9z"/></g>`;
const FUTURES = {
  GOLD: bars('#fff3c9', '#d69d16'), SILVER: bars('#ffffff', '#8b95a3'), COPPER: bars('#ffe1cf', '#b0623a'),
  WTI: '<rect width="24" height="24" fill="#23282f"/><path d="M12 5c3 4 5 6.500 5 9a5 5 0 0 1-10 0c0-2.500 2-5 5-9z" fill="#e0a83a"/>',
};
FUTURES.BRENT = FUTURES.WTI;
FUTURES.NATGAS = '<rect width="24" height="24" fill="#23282f"/><path d="M12 5c3 4 5 6.500 5 9a5 5 0 0 1-10 0c0-2.500 2-5 5-9z" fill="#4c8df0"/>';

const COLORS = ['#3b6fd1', '#2a8f7a', '#8a5ad1', '#b5652b', '#b3415a', '#4d7a2f', '#5a6b86', '#9a7a1f'];
export function avatarOf(label) {
  let h = 0;
  for (const c of label) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return { text: label.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase() || '?', color: COLORS[h % COLORS.length] };
}

// "USDBRL=X" and "BRL=X" -> ['USD', 'BRL']
export function currencyPair(inst) {
  const s = inst.symbol.replace(/=X$/, '');
  const p = /^[A-Z]{6}$/.test(s) ? [s.slice(0, 3), s.slice(3)] : /^[A-Z]{3}$/.test(s) ? ['USD', s] : null;
  return inst.type === 'CURRENCY' ? p : null;
}

// Looks at the pixels: light logos on a transparent background need a dark disc, and any
// transparent logo gets a little room so it is not cut by the circle.
export function logoStyle(pixels) {
  let clear = 0, light = 0, solid = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 40) { clear++; continue; }
    solid++;
    light += (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;
  }
  const total = pixels.length / 4;
  return { dark: solid > 0 && clear / total > 0.08 && light / solid > 0.72, padded: clear / total > 0.3 };
}
function fit(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 32, 32);
    const s = logoStyle(x.getImageData(0, 0, 32, 32).data);
    img.classList.toggle('dark', s.dark);
    img.classList.toggle('padded', s.padded);
  } catch { /* keep the default look */ }
}

// Few at a time, so logos never hold up prices and charts.
const queue = [];
let loading = 0;
function next() {
  while (loading < 2 && queue.length) {
    const { img, src, done } = queue.shift();
    loading++;
    img.onload = () => { loading--; fit(img); done(); next(); };
    img.onerror = () => { loading--; next(); };
    img.src = src;
  }
}

const nodes = new Map(); // one element per symbol, reused so the list never flickers
export function logo(inst) {
  let box = nodes.get(inst.id);
  if (box) return box;
  box = document.createElement('span');
  box.className = 'logo';
  box.setAttribute('aria-hidden', 'true');
  nodes.set(inst.id, box);

  const avatar = () => {
    const a = avatarOf(inst.label), i = document.createElement('i');
    i.className = 'avatar'; i.textContent = a.text; i.style.background = a.color;
    box.replaceChildren(i);
  };
  const pair = currencyPair(inst);
  if (pair && pair.every(c => FLAGS[c])) { box.classList.add('pair'); box.innerHTML = pair.map(c => wrap(FLAGS[c])).join(''); }
  else if (inst.type === 'FUTURE' && FUTURES[inst.label]) box.innerHTML = wrap(FUTURES[inst.label]);
  else if (inst.type === 'INDEX' && FLAGS[inst.currency]) box.innerHTML = wrap(FLAGS[inst.currency]);
  else if (['CURRENCY', 'FUTURE', 'INDEX'].includes(inst.type)) avatar();
  else {
    avatar(); // shown until the logo arrives, and kept if there is none
    const img = new Image();
    img.alt = ''; img.decoding = 'async';
    queue.push({ img, src: `/api/icon?${new URLSearchParams({ id: inst.id })}`, done: () => box.replaceChildren(img) });
    next();
  }
  return box;
}
