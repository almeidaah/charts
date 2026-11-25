import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoGroup, arrange, cleanName } from '../public/groups.js';
import { openDb } from '../server/db.js';

const i = (symbol, type, currency = 'USD', grp = '') => ({ id: symbol, symbol, type, currency, grp });

test('automatic group by type', () => {
  assert.equal(autoGroup(i('BTCUSDT', 'CRYPTOCURRENCY', 'USDT')), 'Crypto');
  assert.equal(autoGroup(i('ETH-USD', 'CRYPTOCURRENCY')), 'Crypto');
  assert.equal(autoGroup(i('USDTBRL', 'CRYPTOCURRENCY', 'BRL')), 'Forex');
  assert.equal(autoGroup(i('EURBRL=X', 'CURRENCY', 'BRL')), 'Forex');
  assert.equal(autoGroup(i('NVDA', 'EQUITY')), 'USA');
  assert.equal(autoGroup(i('HGLG11.SA', 'EQUITY', 'BRL')), 'Brazil');
  assert.equal(autoGroup(i('^BVSP', 'INDEX', 'BRL')), 'Indices');
  assert.equal(autoGroup(i('GC=F', 'FUTURE')), 'Commodities');
  assert.equal(autoGroup(i('SAP.DE', 'EQUITY', 'EUR')), 'Other');
});

test('group order: saved first, empty ones disappear, Other last', () => {
  const list = [i('SAP.DE', 'EQUITY', 'EUR'), i('NVDA', 'EQUITY'), i('BTCUSDT', 'CRYPTOCURRENCY', 'USDT'), i('HGLG11.SA', 'EQUITY', 'BRL', 'REITs')];
  assert.deepEqual(arrange(list).map(g => g.name), ['Crypto', 'USA', 'REITs', 'Other']);
  assert.deepEqual(arrange(list, ['REITs', 'USA']).map(g => g.name), ['REITs', 'USA', 'Crypto', 'Other']);
  assert.equal(arrange(list).flatMap(g => g.items).length, 4);
  assert.equal(cleanName('  My   REITs '), 'My REITs');
});

test('older databases gain the group column and keep the watchlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'charts-')), file = join(dir, 'x.db');
  try {
    let db = openDb(file);
    db.saveInstrument({ id: 'yahoo:A', source: 'yahoo', symbol: 'A', label: 'A' });
    db.addToWatchlist('yahoo:A');
    db.close();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE watchlist DROP COLUMN grp');
    raw.close();
    db = openDb(file);
    assert.equal(db.watchlist()[0].grp, '');
    db.groupWatchlist('yahoo:A', 'REITs');
    assert.equal(db.watchlist()[0].grp, 'REITs');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
