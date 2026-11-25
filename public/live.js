// Live Binance prices over a WebSocket, straight from the browser (about one update per second).
// The regular quote polling keeps running, so nothing is lost when the stream is unavailable.
const HOSTS = ['wss://stream.binance.com', 'wss://data-stream.binance.vision'];
const QUIET = 15_000; // no message for this long: reconnect

export const streamUrl = (host, symbols) => `${host}/stream?streams=${symbols.map(s => `${s.toLowerCase()}@miniTicker`).join('/')}`;

// Returns { id, last } or null for anything that is not a price message.
export function parseTick(text) {
  let m;
  try { m = JSON.parse(text); } catch { return null; }
  const d = m?.data ?? m;
  const last = Number(d?.c);
  return d?.e === '24hrMiniTicker' && typeof d.s === 'string' && last > 0 ? { id: `binance:${d.s}`, last } : null;
}

// Applies a live price to a quote. The day change is measured against the same open the quote used.
export function applyTick(quote, last) {
  if (quote?.last == null || quote.chg == null) return { ...quote, last };
  const open = quote.last - quote.chg;
  return { ...quote, last, chg: last - open, pct: open ? ((last - open) / open) * 100 : quote.pct };
}

// onPrice(id, price) is called for each update. setSymbols([]) or a hidden page closes the connection.
export function createLive({ onPrice, WebSocketClass = globalThis.WebSocket, isHidden = () => document.hidden }) {
  let ws = null, wanted = '', host = 0, retry = 0, timer = 0, heard = 0, seen = new Map();

  function close() {
    clearTimeout(timer); timer = 0;
    if (ws) { ws.onclose = ws.onmessage = ws.onerror = null; try { ws.close(); } catch { /* already closed */ } }
    ws = null;
  }
  function connect() {
    close();
    if (!wanted || isHidden() || !WebSocketClass) return;
    heard = Date.now();
    try { ws = new WebSocketClass(streamUrl(HOSTS[host], wanted.split(','))); } catch { return again(); }
    ws.onmessage = e => {
      heard = Date.now(); retry = 0;
      const t = parseTick(e.data);
      if (t) { seen.set(t.id, heard); onPrice(t.id, t.last); }
    };
    ws.onclose = again;
  }
  function again() {
    close();
    host = (host + 1) % HOSTS.length;
    timer = setTimeout(() => { timer = 0; connect(); }, Math.min(30_000, 1000 * 2 ** retry++));
  }

  return {
    setSymbols(symbols) {
      const next = [...new Set(symbols)].sort().slice(0, 200).join(',');
      if (next === wanted) return;
      wanted = next; retry = 0;
      connect();
    },
    // Call now and then: reconnects a silent stream, and follows the page being shown or hidden.
    check() {
      if (isHidden()) close();
      else if (wanted && !ws && !timer) connect();
      else if (ws && Date.now() - heard > QUIET) again();
    },
    // True while the stream is the freshest source for this symbol.
    fresh: id => Date.now() - (seen.get(id) ?? 0) < 8000,
    close,
  };
}
