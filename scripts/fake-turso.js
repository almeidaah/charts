// In-memory stand-in for the Turso HTTP API, used by the tests and by scripts/web-dev.js.
import { DatabaseSync } from 'node:sqlite';

export function fakeTurso(file = ':memory:') {
  const db = new DatabaseSync(file);
  const self = { failOn: null };
  const arg = a => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value);
  const val = v => (v == null ? { type: 'null' } : Number.isInteger(v) ? { type: 'integer', value: String(v) } : typeof v === 'number' ? { type: 'float', value: v } : { type: 'text', value: v });

  function execute({ sql, args = [] }) {
    if (self.failOn?.test(sql)) throw new Error('forced failure');
    const rows = db.prepare(sql).all(...args.map(arg));
    const cols = rows.length ? Object.keys(rows[0]) : [];
    return { cols: cols.map(name => ({ name })), rows: rows.map(r => cols.map(c => val(r[c]))) };
  }
  function batch({ steps }) {
    const step_results = [], step_errors = [];
    const met = c => !c || (c.type === 'ok' ? !!step_results[c.step] : !met(c.cond));
    steps.forEach((s, i) => {
      step_results[i] = step_errors[i] = null;
      if (!met(s.condition)) return;
      try { step_results[i] = execute(s.stmt); } catch (e) { step_errors[i] = { message: e.message }; }
    });
    return { step_results, step_errors };
  }

  self.fetch = async (url, { headers, body }) => {
    if (!headers.Authorization?.startsWith('Bearer ')) return new Response('', { status: 401 });
    const results = JSON.parse(body).requests.map(r => {
      try {
        const result = r.type === 'execute' ? execute(r.stmt) : r.type === 'batch' ? batch(r.batch) : undefined;
        return { type: 'ok', response: { type: r.type, result } };
      } catch (e) { return { type: 'error', error: { message: e.message } }; }
    });
    return Response.json({ baton: null, results });
  };
  return self;
}
