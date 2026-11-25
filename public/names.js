// Asset names shown under the ticker. Providers give good names for stocks and indices, but only codes for coins and forex.
import { currencyPair } from './logos.js';

const COINS = {
  BTC: 'Bitcoin', ETH: 'Ethereum', USDT: 'Tether', USDC: 'USD Coin', FDUSD: 'First Digital USD', DAI: 'Dai', BNB: 'BNB', SOL: 'Solana', XRP: 'XRP',
  ADA: 'Cardano', DOGE: 'Dogecoin', TRX: 'TRON', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: 'Polkadot', LTC: 'Litecoin', BCH: 'Bitcoin Cash',
  ETC: 'Ethereum Classic', XLM: 'Stellar', XMR: 'Monero', ATOM: 'Cosmos', NEAR: 'NEAR Protocol', UNI: 'Uniswap', AAVE: 'Aave', SHIB: 'Shiba Inu',
  PEPE: 'Pepe', SUI: 'Sui', TON: 'Toncoin', HBAR: 'Hedera', FIL: 'Filecoin', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', PAXG: 'PAX Gold', POL: 'Polygon',
};
const money = new Intl.DisplayNames(['en'], { type: 'currency', fallback: 'none' });
const currency = code => { try { return money.of(code); } catch { return undefined; } };
const asset = code => COINS[code] ?? currency(code) ?? code;

export function assetName(inst) {
  const name = (inst.name ?? '').trim();
  const pair = currencyPair(inst);
  if (pair) return pair.map(c => currency(c) ?? c).join(' / ');
  if (inst.type === 'CRYPTOCURRENCY') {
    const parts = name.split(' / ');
    if (inst.source === 'binance' && parts.length === 2) return parts.map(asset).join(' / ');
    const [, coin, quote] = /^(.+) ([A-Z]{3})$/.exec(name) ?? []; // Yahoo: "Bitcoin USD"
    if (coin && quote === inst.currency) return `${coin} / ${asset(quote)}`;
  }
  return name === inst.label ? '' : name;
}
