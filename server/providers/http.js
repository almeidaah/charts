// fetch with timeout, retries and a per-provider concurrency limit.
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function createClient({ name, concurrency, headers = {} }) {
  let active = 0;
  const queue = [];
  const acquire = () => new Promise(res => {
    if (active < concurrency) { active++; res(); } else queue.push(res);
  });
  const release = () => { const next = queue.shift(); if (next) next(); else active--; };

  return async function getJson(url, { timeout = 30000, retries = 2 } = {}) {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
          if (res.ok) return await res.json();
        } catch (e) {
          if (attempt >= retries) throw new ProviderError(`${name}: no response (${e.cause?.code ?? e.name})`, 502);
        }
        if (res && !res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          if (!retryable || attempt >= retries) {
            const why = res.status === 404 ? 'symbol not found'
              : res.status === 429 || res.status === 418 ? 'rate limit reached, try again in a few minutes'
              : `HTTP error ${res.status}`;
            throw new ProviderError(`${name}: ${why}`, res.status);
          }
        }
        await sleep((res ? 800 : 250) * 2 ** attempt); // dropped connection: retry soon
      }
    } finally { release(); }
  };
}
