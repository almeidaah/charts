// Cloud database (Turso) over plain HTTP, no dependencies.
// Stores only user data; price history always comes from the providers.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS instruments (id TEXT PRIMARY KEY, source TEXT NOT NULL, symbol TEXT NOT NULL, label TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', exchange TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT '', tz TEXT NOT NULL DEFAULT 'UTC')`,
  `CREATE TABLE IF NOT EXISTS watchlist (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, flag TEXT NOT NULL DEFAULT '', grp TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS drawings (uid TEXT PRIMARY KEY, id TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS drawings_by_id ON drawings (id)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
const PUT_INST = `INSERT INTO instruments (id, source, symbol, label, name, type, exchange, currency, tz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label, name=excluded.name, type=excluded.type,
    exchange=excluded.exchange, currency=excluded.currency, tz=excluded.tz`;
const ADD_WATCH = `INSERT OR IGNORE INTO watchlist (id, pos) VALUES (?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM watchlist))`;
const PUT_DRAW = `INSERT INTO drawings (uid, id, data) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET data = excluded.data WHERE id = excluded.id`;
const BUMP = [`INSERT INTO meta (key, value) VALUES ('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`];
const PUT_META = 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)';
const instArgs = i => [i.id, i.source, i.symbol, i.label, i.name ?? '', i.type ?? '', i.exchange ?? '', i.currency ?? '', i.tz ?? 'UTC'];

const encode = v => (v == null ? { type: 'null' }
  : Number.isInteger(v) ? { type: 'integer', value: String(v) }
  : typeof v === 'number' ? { type: 'float', value: v }
  : { type: 'text', value: String(v) });
const decode = c => (c.type === 'null' ? null : c.type === 'integer' || c.type === 'float' ? Number(c.value) : c.value);
const TABLES = /\b(instruments|watchlist|drawings|drawings_by_id|meta)\b/g;

// prefix keeps a second, separate set of tables in the same database (the guest area).
export function openTurso(url, token, fetchFn = fetch, prefix = '') {
  const toStmt = ([sql, ...args]) => ({ sql: prefix ? sql.replace(TABLES, `${prefix}$1`) : sql, args: args.map(encode), want_rows: true });
  const endpoint = url.replace(/^libsql:/, 'https:').replace(/\/+$/, '') + '/v2/pipeline';

  async function pipeline(request) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(endpoint, {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [request, { type: 'close' }] }),
        });
      } catch (e) {
        if (attempt < 1) continue;
        throw new Error('Database: no response');
      }
      if (!res.ok) {
        if (res.status >= 500 && attempt < 1) continue;
        throw new Error(res.status === 401 || res.status === 403 ? 'Database: access denied (check TURSO_AUTH_TOKEN)' : `Database: HTTP ${res.status}`);
      }
      const { results: [r] } = await res.json();
      if (r.type !== 'ok') throw new Error(`Database: ${r.error?.message ?? 'error'}`);
      return r.response.result;
    }
  }
  const rowsOf = r => r.rows.map(row => Object.fromEntries(r.cols.map((c, i) => [c.name, decode(row[i])])));

  // Several statements in one transaction: all or nothing.
  async function batch(list) {
    if (!list.length) return;
    const steps = [{ stmt: { sql: 'BEGIN IMMEDIATE' } }];
    for (const s of list) steps.push({ stmt: toStmt(s), condition: { type: 'ok', step: steps.length - 1 } });
    steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: steps.length - 1 } });
    steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: steps.length - 1 } } });
    const r = await pipeline({ type: 'batch', batch: { steps } });
    const err = r.step_errors.slice(0, -1).find(Boolean);
    if (err) throw new Error(`Database: ${err.message}`);
  }

  let ready = null;
  function init() {
    ready ??= batch(SCHEMA.map(sql => [sql])).catch(e => { ready = null; throw e; });
    return ready;
  }
  async function all(sql, ...args) { await init(); return rowsOf(await pipeline({ type: 'execute', stmt: toStmt([sql, ...args]) })); }
  async function tx(list) { await init(); return batch(list); }
  const change = list => tx([...list, BUMP]); // user data: also moves the revision
  const one = async (...a) => (await all(...a))[0];

  return {
    instrument: id => one('SELECT * FROM instruments WHERE id = ?', id),
    saveInstrument: i => change([[PUT_INST, ...instArgs(i)]]),
    watchlist: () => all('SELECT i.*, w.flag, w.grp FROM watchlist w JOIN instruments i USING (id) ORDER BY w.pos'),
    addToWatchlist: id => change([[ADD_WATCH, id]]),
    removeFromWatchlist: id => change([['DELETE FROM watchlist WHERE id = ?', id]]),
    flagWatchlist: (id, flag) => change([['UPDATE watchlist SET flag = ? WHERE id = ?', flag, id]]),
    groupWatchlist: (id, grp) => change([['UPDATE watchlist SET grp = ? WHERE id = ?', grp, id]]),
    reorderWatchlist: ids => change(ids.map((id, i) => ['UPDATE watchlist SET pos = ? WHERE id = ?', i, id])),
    drawings: async id => (await all('SELECT data FROM drawings WHERE id = ? ORDER BY rowid', id)).map(r => JSON.parse(r.data)),
    changeDrawings: (id, put, del) => change([
      ...put.map(d => [PUT_DRAW, d.uid, id, JSON.stringify(d)]),
      ...del.map(uid => ['DELETE FROM drawings WHERE id = ? AND uid = ?', id, uid]),
    ]),
    meta: async key => (await one('SELECT value FROM meta WHERE key = ?', key))?.value ?? null,
    setMeta: (key, value) => (key.startsWith('login:') ? tx : change)([[PUT_META, key, value]]),
    rev: async () => Number((await one("SELECT value FROM meta WHERE key = 'rev'"))?.value ?? 0),
    count: async table => Number((await one(`SELECT COUNT(*) AS n FROM ${table}`)).n),
    // Empties this set of tables. Only the guest area uses it.
    clear: () => { if (!prefix) throw new Error('Only the guest area can be cleared'); return tx(['watchlist', 'drawings', 'instruments', 'meta'].map(t => [t === 'meta' ? "DELETE FROM meta WHERE key <> 'rev'" : `DELETE FROM ${t}`]).concat([BUMP])); },
    deleteMeta: key => tx([['DELETE FROM meta WHERE key = ?', key]]),
    exportAll: async () => ({
      instruments: await all('SELECT * FROM instruments'),
      watchlist: await all('SELECT id, flag, grp FROM watchlist ORDER BY pos'),
      drawings: (await all('SELECT id, data FROM drawings ORDER BY rowid')).map(r => ({ id: r.id, data: JSON.parse(r.data) })),
    }),
    importAll: b => change([
      ...b.instruments.map(i => [PUT_INST, ...instArgs(i)]),
      ...b.watchlist.flatMap(w => [[ADD_WATCH, w.id], ['UPDATE watchlist SET flag = ?, grp = ? WHERE id = ?', w.flag, w.grp, w.id]]),
      ...b.drawings.map(d => [PUT_DRAW, d.data.uid, d.id, JSON.stringify(d.data)]),
    ]),
  };
}
