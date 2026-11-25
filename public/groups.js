// Groups the watchlist by asset type. The group is automatic unless the user picks another one.
export const AUTO_GROUPS = ['Crypto', 'USA', 'Brazil', 'Forex', 'Indices', 'Commodities', 'Other'];

const FIAT = 'BRL|USD|EUR|GBP|JPY|TRY|ARS|AUD|CAD|CHF|MXN|PLN|ZAR';
const STABLE_FX = new RegExp(`^(USDT|USDC|FDUSD|DAI|EURI)(${FIAT})$`); // USDTBRL is a dollar quote, not crypto

export function autoGroup(inst) {
  if (inst.type === 'CURRENCY' || STABLE_FX.test(inst.symbol)) return 'Forex';
  if (inst.type === 'CRYPTOCURRENCY') return 'Crypto';
  if (inst.type === 'INDEX') return 'Indices';
  if (inst.type === 'FUTURE') return 'Commodities';
  if (/\.SA$/.test(inst.symbol)) return 'Brazil';
  if (!inst.symbol.includes('.') && inst.currency === 'USD') return 'USA';
  return 'Other';
}
export const groupOf = inst => inst.grp || autoGroup(inst);

// Returns [{ name, items }] without empty groups, in saved order; new groups go last.
export function arrange(list, order = []) {
  const map = new Map();
  for (const inst of list) {
    const g = groupOf(inst);
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(inst);
  }
  const base = [...new Set([...order, ...AUTO_GROUPS.slice(0, -1), ...map.keys()])].filter(n => n !== 'Other' || order.includes(n));
  if (!base.includes('Other')) base.push('Other');
  return base.filter(n => map.has(n)).map(name => ({ name, items: map.get(name) }));
}

export function cleanName(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
}
