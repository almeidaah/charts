// Runs the web version on this computer with a throwaway database, to try it before publishing.
//   APP_PASSWORD="a long password" node scripts/web-dev.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { createHandler } from '../api/index.js';
import { fakeTurso } from './fake-turso.js';

const PUBLIC = join(import.meta.dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 5190);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const { headers: [{ headers }] } = JSON.parse(await readFile(join(import.meta.dirname, '..', 'vercel.json'), 'utf8'));
const api = createHandler({ APP_PASSWORD: process.env.APP_PASSWORD, TURSO_DATABASE_URL: 'libsql://local', TURSO_AUTH_TOKEN: 'local' }, { fetchFn: fakeTurso().fetch });

http.createServer(async (req, res) => {
  for (const h of headers) res.setHeader(h.key, h.value);
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res);
  const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  try {
    if (!file.startsWith(PUBLIC + sep)) throw new Error('outside');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, '127.0.0.1', () => console.log(`Web version at http://localhost:${PORT}`));
