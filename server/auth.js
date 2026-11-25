// Single password for the web version. The session is a signed cookie; the password is never stored.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const DAYS = 180;
const COOKIE = '__Host-charts';
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;
const sha = s => createHash('sha256').update(s).digest();

export function createAuth({ password, secret, store, now = Date.now }) {
  if (!password || password.length < 12) throw new Error('APP_PASSWORD must be set with at least 12 characters');
  const key = sha(`charts|${password}|${secret}`); // changing the password ends old sessions
  const sign = exp => createHmac('sha256', key).update(String(exp)).digest('base64url');
  const same = (a, b) => timingSafeEqual(sha(a), sha(b));

  return {
    check(cookieHeader) {
      const raw = (cookieHeader ?? '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
      const [exp, sig] = (raw ?? '').split('.');
      return !!exp && !!sig && /^\d+$/.test(exp) && Number(exp) > now() && same(sig, sign(exp));
    },

    // Returns the cookie, or null for a wrong password. Too many attempts from one address lock it for 15 minutes.
    async login(given, ip) {
      const k = 'login:' + createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
      const saved = JSON.parse(await store.meta(k) ?? '{"n":0,"at":0}');
      const fails = now() - saved.at < LOCK_MS ? saved.n : 0;
      if (fails >= MAX_FAILS) return { locked: true };
      // Count the attempt before checking, so parallel attempts cannot slip through.
      await store.setMeta(k, JSON.stringify({ n: fails + 1, at: now() }));
      if (typeof given !== 'string' || !same(given, password)) return { cookie: null };
      await store.deleteMeta(k);
      const exp = now() + DAYS * 86400_000;
      return { cookie: `${COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${DAYS * 86400}; Secure; HttpOnly; SameSite=Lax` };
    },
    logout: () => `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  };
}
