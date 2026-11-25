// Guests are read-only on the server. What they draw and choose is kept in this browser only.
const KEY = 'guest';
const empty = () => ({ drawings: {}, flags: {}, grps: {}, order: [], groups: {}, indicators: null });

// The storage is looked up when needed: some browsers refuse access to it.
export function createGuestLocal(storage = () => globalThis.localStorage) {
  function read() {
    try { return { ...empty(), ...JSON.parse(storage().getItem(KEY) ?? '{}') }; } catch { return empty(); }
  }
  function change(fn) {
    const d = read();
    fn(d);
    try { storage().setItem(KEY, JSON.stringify(d)); } catch { throw new Error('This browser could not save it.'); }
    return { ok: true };
  }
  const routes = {
    'GET drawings': q => read().drawings[q.get('id')] ?? [],
    'POST drawings': (q, { id, put = [], del = [] }) => change(d => {
      const items = (d.drawings[id] ?? []).filter(x => !del.includes(x.uid));
      for (const x of put) { const i = items.findIndex(y => y.uid === x.uid); if (i >= 0) items[i] = x; else items.push(x); }
      d.drawings[id] = items;
    }),
    'GET indicators': () => read().indicators,
    'PUT indicators': (q, cfg) => change(d => { d.indicators = cfg; }),
    'GET groups': () => read().groups,
    'PUT groups': (q, g) => change(d => { d.groups = { on: g.on, order: g.order, closed: g.closed }; }),
    'PUT watchlist/flag': (q, { id, flag }) => change(d => { d.flags[id] = flag; }),
    'PUT watchlist/group': (q, { id, grp }) => change(d => { d.grps[id] = grp; }),
    'PUT watchlist/order': (q, { ids }) => change(d => { d.order = ids; }),
    'GET rev': () => ({ rev: 0 }),
  };
  return {
    // Answers a request locally, or returns undefined when it belongs to the server.
    handle(path, method, json) {
      const [name, query = ''] = path.split('?');
      return routes[`${method} ${name}`]?.(new URLSearchParams(query), json);
    },
    // The server list with this guest's own order, colors and groups.
    apply(list) {
      const d = read(), at = id => { const i = d.order.indexOf(id); return i < 0 ? d.order.length : i; };
      return list.map(i => ({ ...i, flag: d.flags[i.id] ?? i.flag, grp: d.grps[i.id] ?? i.grp })).sort((a, b) => at(a.id) - at(b.id));
    },
    clear() { try { storage().removeItem(KEY); } catch { /* no storage */ } },
  };
}
