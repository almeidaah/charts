// Passwords for the web version: the owner's, and an optional one for guests.
// The session is a signed cookie; passwords are never stored.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const OWNER_DAYS = 180, GUEST_DAYS = 1;
const MIN = 12;
const COOKIE = '__Host-charts';
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;
const sha = s => createHash('sha256').update(s).digest();

// Why a guest password cannot be used, or null when it is fine.
export function guestProblem(password, guestPassword) {
  if (guestPassword.length < MIN) return `GUEST_PASSWORD needs at least ${MIN} characters`;
  return guestPassword === password ? 'GUEST_PASSWORD must be different from APP_PASSWORD' : null;
}

export function createAuth({ password, guestPassword = '', secret, store, now = Date.now }) {
  if (!password || password.length < MIN) throw new Error(`APP_PASSWORD must be set with at least ${MIN} characters`);
  // Changing a password ends the sessions that used it. A bad guest password only turns guests off.
  const signer = (kind, pw) => { const key = sha(`${kind}|${pw}|${secret}`); return exp => createHmac('sha256', key).update(String(exp)).digest('base64url'); };
  const same = (a, b) => timingSafeEqual(sha(a), sha(b));
  const guests = guestPassword && !guestProblem(password, guestPassword);
  const signOwner = signer('charts', password), signGuest = guests ? signer('charts-guest', guestPassword) : null;

  return {
    // 'owner', 'guest' or null.
    check(cookieHeader) {
      const raw = (cookieHeader ?? '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
      const parts = (raw ?? '').split('.'), guest = parts[0] === 'g';
      const [exp, sig] = guest ? parts.slice(1) : parts, sign = guest ? signGuest : signOwner;
      return sign && exp && sig && /^\d+$/.test(exp) && Number(exp) > now() && same(sig, sign(exp)) ? (guest ? 'guest' : 'owner') : null;
    },

    // Returns the cookie, or null for a wrong password. Too many attempts from one address lock it for 15 minutes.
    async login(given, ip) {
      const k = 'login:' + createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 24);
      const saved = JSON.parse(await store.meta(k) ?? '{"n":0,"at":0}');
      const fails = now() - saved.at < LOCK_MS ? saved.n : 0;
      if (fails >= MAX_FAILS) return { locked: true };
      // Count the attempt before checking, so parallel attempts cannot slip through.
      await store.setMeta(k, JSON.stringify({ n: fails + 1, at: now() }));
      const owner = typeof given === 'string' && same(given, password);
      const guest = !owner && guests && typeof given === 'string' && same(given, guestPassword);
      if (!owner && !guest) return { cookie: null };
      // A guest sign-in does not clear the count: it would allow endless guesses at the owner's password.
      if (owner) await store.deleteMeta(k);
      const days = owner ? OWNER_DAYS : GUEST_DAYS, exp = now() + days * 86400_000;
      const value = owner ? `${exp}.${signOwner(exp)}` : `g.${exp}.${signGuest(exp)}`;
      return { cookie: `${COOKIE}=${value}; Path=/; Max-Age=${days * 86400}; Secure; HttpOnly; SameSite=Lax` };
    },
    logout: () => `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  };
}
