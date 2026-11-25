// Local database (Node's built-in SQLite). Everything lives in data/market.db.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    -- id = "source:symbol", e.g. "yahoo:NVDA", "binance:BTCUSDT"
    CREATE TABLE IF NOT EXISTS instruments (
      id       TEXT PRIMARY KEY,
      source   TEXT NOT NULL,
      symbol   TEXT NOT NULL,
      label    TEXT NOT NULL,
      name     TEXT NOT NULL DEFAULT '',
      type     TEXT NOT NULL DEFAULT '',
      exchange TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT '',
      tz       TEXT NOT NULL DEFAULT 'UTC'
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id  TEXT PRIMARY KEY REFERENCES instruments(id),
      pos INTEGER NOT NULL,
      flag TEXT NOT NULL DEFAULT ''
    );

    -- t = bar start in UTC seconds. On daily bars, t = midnight UTC of the trading date.
    CREATE TABLE IF NOT EXISTS candles (
      id TEXT NOT NULL, tf TEXT NOT NULL, t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
      PRIMARY KEY (id, tf, t)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS sync_state (
      id TEXT NOT NULL, tf TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (id, tf)
    );

    -- One row per drawing, tied to a symbol. data = JSON with points (time, price) and style.
    CREATE TABLE IF NOT EXISTS drawings (
      uid  TEXT PRIMARY KEY,
      id   TEXT NOT NULL REFERENCES instruments(id),
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drawings_by_id ON drawings (id);

    -- Symbol logos. data is NULL when no source has one; that is retried after a week.
    CREATE TABLE IF NOT EXISTS icons (id TEXT PRIMARY KEY, type TEXT, data BLOB, at INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  // Databases created before groups existed.
  if (!db.prepare('PRAGMA table_info(watchlist)').all().some(c => c.name === 'grp')) {
    db.exec("ALTER TABLE watchlist ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
  }

  const q = {
    getInst: db.prepare('SELECT * FROM instruments WHERE id = ?'),
    putInst: db.prepare(`INSERT INTO instruments (id, source, symbol, label, name, type, exchange, currency, tz)
      VALUES ($id, $source, $symbol, $label, $name, $type, $exchange, $currency, $tz)
      ON CONFLICT(id) DO UPDATE SET label=$label, name=$name, type=$type,
        exchange=$exchange, currency=$currency, tz=$tz`),
    watch: db.prepare('SELECT i.*, w.flag, w.grp FROM watchlist w JOIN instruments i USING (id) ORDER BY w.pos'),
    addWatch: db.prepare(`INSERT OR IGNORE INTO watchlist (id, pos)
      VALUES (?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM watchlist))`),
    delWatch: db.prepare('DELETE FROM watchlist WHERE id = ?'),
    setGrp: db.prepare('UPDATE watchlist SET grp = ? WHERE id = ?'),
    setFlag: db.prepare('UPDATE watchlist SET flag = ? WHERE id = ?'),
    setPos: db.prepare('UPDATE watchlist SET pos = ? WHERE id = ?'),
    putCandle: db.prepare(`INSERT INTO candles (id, tf, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, tf, t) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v`),
    candles: db.prepare('SELECT t, o, h, l, c, v FROM candles WHERE id = ? AND tf = ? AND t >= ? ORDER BY t'),
    lastCandles: db.prepare('SELECT t, o, h, l, c, v FROM candles WHERE id = ? AND tf = ? ORDER BY t DESC LIMIT ?'),
    rescale: db.prepare(`UPDATE candles SET o=o*$r, h=h*$r, l=l*$r, c=c*$r, v=v/$r
      WHERE id = $id AND tf = $tf AND t < $before`),
    getSync: db.prepare('SELECT synced_at FROM sync_state WHERE id = ? AND tf = ?'),
    putSync: db.prepare('INSERT OR REPLACE INTO sync_state (id, tf, synced_at) VALUES (?, ?, ?)'),
    coverage: db.prepare(`SELECT c.id, c.tf, COUNT(*) AS n, MIN(c.t) AS first, MAX(c.t) AS last, s.synced_at AS syncedAt
      FROM candles c LEFT JOIN sync_state s USING (id, tf) GROUP BY c.id, c.tf`),
    drawings: db.prepare('SELECT data FROM drawings WHERE id = ? ORDER BY rowid'),
    putDrawing: db.prepare(`INSERT INTO drawings (uid, id, data) VALUES (?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET data = excluded.data WHERE id = excluded.id`),
    delDrawing: db.prepare('DELETE FROM drawings WHERE id = ? AND uid = ?'),
    getIcon: db.prepare('SELECT type, data, at FROM icons WHERE id = ?'),
    putIcon: db.prepare('INSERT OR REPLACE INTO icons (id, type, data, at) VALUES (?, ?, ?, ?)'),
    bump: db.prepare(`INSERT INTO meta (key, value) VALUES ('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    putMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };

  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // User data changes also move the revision, so open screens know when to refresh.
  const bump = () => q.bump.run();
  const change = fn => tx(() => { const r = fn(); bump(); return r; });
  const putInst = i => q.putInst.run({
    id: i.id, source: i.source, symbol: i.symbol, label: i.label, name: i.name ?? '',
    type: i.type ?? '', exchange: i.exchange ?? '', currency: i.currency ?? '', tz: i.tz ?? 'UTC',
  });
  function mirrorWatchlist(list) {
    const keep = new Set(list.map(i => i.id));
    for (const i of q.watch.all()) if (!keep.has(i.id)) q.delWatch.run(i.id);
    list.forEach((i, pos) => { putInst(i); q.addWatch.run(i.id); q.setPos.run(pos, i.id); q.setFlag.run(i.flag, i.id); q.setGrp.run(i.grp, i.id); });
  }

  return {
    close: () => db.close(),
    instrument: id => q.getInst.get(id),
    saveInstrument: putInst,
    watchlist: () => q.watch.all(),
    addToWatchlist: id => change(() => q.addWatch.run(id)),
    removeFromWatchlist: id => change(() => q.delWatch.run(id)),
    groupWatchlist: (id, grp) => change(() => q.setGrp.run(grp, id)),
    flagWatchlist: (id, flag) => change(() => q.setFlag.run(flag, id)),
    reorderWatchlist: ids => change(() => ids.forEach((id, i) => q.setPos.run(i, id))),
    candles: (id, tf, since = -1e12) => q.candles.all(id, tf, since),
    lastCandles: (id, tf, n) => q.lastCandles.all(id, tf, n).reverse(),
    // Saves new bars; after a split (ratio != 1), older bars are rescaled first.
    saveCandles: (id, tf, rows, ratio = 1) => tx(() => {
      if (ratio !== 1 && rows.length) q.rescale.run({ r: ratio, id, tf, before: rows[0].t });
      for (const r of rows) q.putCandle.run(id, tf, r.t, r.o, r.h, r.l, r.c, r.v);
      q.putSync.run(id, tf, Math.floor(Date.now() / 1000));
    }),
    touchSync: (id, tf) => q.putSync.run(id, tf, Math.floor(Date.now() / 1000)),
    syncedAt: (id, tf) => q.getSync.get(id, tf)?.synced_at ?? null,
    coverage: () => q.coverage.all(),
    drawings: id => q.drawings.all(id).map(r => JSON.parse(r.data)),
    // Saves and deletes in one step, so undo/redo is never left halfway.
    changeDrawings: (id, put, del) => change(() => {
      for (const d of put) q.putDrawing.run(d.uid, id, JSON.stringify(d));
      for (const uid of del) q.delDrawing.run(id, uid);
    }),
    exportAll: () => ({
      instruments: db.prepare('SELECT * FROM instruments').all(),
      watchlist: db.prepare('SELECT id, flag, grp FROM watchlist ORDER BY pos').all(),
      drawings: db.prepare('SELECT id, data FROM drawings ORDER BY rowid').all().map(r => ({ id: r.id, data: JSON.parse(r.data) })),
    }),
    importAll: b => change(() => {
      for (const { id, source, symbol, label, name, type, exchange, currency, tz } of b.instruments) q.putInst.run({ id, source, symbol, label, name, type, exchange, currency, tz });
      for (const w of b.watchlist) { q.addWatch.run(w.id); q.setFlag.run(w.flag, w.id); q.setGrp.run(w.grp, w.id); }
      for (const d of b.drawings) q.putDrawing.run(d.data.uid, d.id, JSON.stringify(d.data));
    }),
    // Local copy of what is on the web version.
    mirrorWatchlist: list => tx(() => mirrorWatchlist(list)),
    mirrorDrawings: (id, items) => tx(() => {
      const keep = new Set(items.map(d => d.uid));
      for (const r of q.drawings.all(id)) { const d = JSON.parse(r.data); if (!keep.has(d.uid)) q.delDrawing.run(id, d.uid); }
      for (const d of items) q.putDrawing.run(d.uid, id, JSON.stringify(d));
    }),
    mirrorAll: b => tx(() => {
      for (const i of b.instruments) putInst(i);
      const byId = new Map(b.instruments.map(i => [i.id, i]));
      mirrorWatchlist(b.watchlist.map(w => ({ ...byId.get(w.id), ...w })));
      db.exec('DELETE FROM drawings');
      for (const d of b.drawings) q.putDrawing.run(d.data.uid, d.id, JSON.stringify(d.data));
      for (const k of ['groups', 'indicators']) if (b.meta[k]) q.putMeta.run(k, JSON.stringify(b.meta[k]));
    }),
    icons: {
      get(id) {
        const r = q.getIcon.get(id);
        if (!r || (!r.data && Date.now() / 1000 - r.at > 7 * 86400)) return undefined;
        return r.data ? { data: Buffer.from(r.data), type: r.type } : null;
      },
      put: (id, icon) => { q.putIcon.run(id, icon?.type ?? null, icon?.data ?? null, Math.floor(Date.now() / 1000)); },
    },
    rev: () => Number(q.getMeta.get('rev')?.value ?? 0),
    meta: key => q.getMeta.get(key)?.value ?? null,
    setMeta: (key, value) => { q.putMeta.run(key, value); if (key === 'groups' || key === 'indicators') bump(); },
  };
}
