import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  getHoldingHistory,
  listHoldingsWithMetadata,
  setManualCostBasis,
  setSecurityMetadata,
} from '../server/src/services/investmentMetadata';

function setupDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE securities (
      id TEXT PRIMARY KEY,
      plaid_security_id TEXT,
      ticker TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      sector TEXT,
      sector_source TEXT
    );

    CREATE TABLE holdings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      institution_price REAL NOT NULL,
      institution_value REAL NOT NULL,
      cost_basis REAL,
      manual_cost_basis REAL,
      manual_cost_basis_note TEXT,
      manual_cost_basis_updated_at TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE holdings_history (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      security_id TEXT NOT NULL,
      date TEXT NOT NULL,
      quantity REAL NOT NULL,
      institution_price REAL NOT NULL,
      institution_value REAL NOT NULL,
      cost_basis REAL,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, security_id, date)
    );
  `);

  db.prepare(`
    INSERT INTO securities (id, plaid_security_id, ticker, name, type, currency, sector, sector_source)
    VALUES
      ('sec_vti', 'plaid_vti', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 'USD', NULL, NULL),
      ('sec_cash', NULL, NULL, 'Cash', 'cash', 'USD', NULL, NULL)
  `).run();

  db.prepare(`
    INSERT INTO holdings (
      id, account_id, security_id, quantity, institution_price, institution_value,
      cost_basis, manual_cost_basis, manual_cost_basis_note, manual_cost_basis_updated_at, currency, updated_at
    )
    VALUES
      ('hold_vti', 'acct', 'sec_vti', 10, 120, 1200, 1000, NULL, NULL, NULL, 'USD', '2026-06-30T00:00:00.000Z'),
      ('hold_cash', 'acct', 'sec_cash', 1, 50, 50, NULL, NULL, NULL, NULL, 'USD', '2026-06-30T00:00:00.000Z')
  `).run();

  return db;
}

test('holdings expose effective cost basis while preserving provider basis', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const initial = listHoldingsWithMetadata(db);
  const vti = initial.find((holding) => holding.id === 'hold_vti');
  const cash = initial.find((holding) => holding.id === 'hold_cash');

  assert.equal(vti?.provider_cost_basis, 1000);
  assert.equal(vti?.cost_basis, 1000);
  assert.equal(vti?.cost_basis_quality, 'provider');
  assert.equal(cash?.cost_basis_quality, 'missing');

  const updated = setManualCostBasis(db, 'hold_vti', {
    manual_cost_basis: 1100,
    manual_cost_basis_note: 'Imported from broker tax lot view',
  });

  assert.equal(updated.provider_cost_basis, 1000);
  assert.equal(updated.cost_basis, 110000);
  assert.equal(updated.effective_cost_basis, 110000);
  assert.equal(updated.manual_cost_basis, 110000);
  assert.equal(updated.cost_basis_quality, 'manual');

  const cleared = setManualCostBasis(db, 'hold_vti', {
    manual_cost_basis: null,
  });
  assert.equal(cleared.cost_basis, 1000);
  assert.equal(cleared.cost_basis_quality, 'provider');
});

test('security metadata updates sector fields without touching holdings', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  const security = setSecurityMetadata(db, 'sec_vti', {
    sector: 'Broad Market',
    sector_source: 'manual',
  });
  assert.equal(security.sector, 'Broad Market');
  assert.equal(security.sector_source, 'manual');

  const [holding] = listHoldingsWithMetadata(db).filter((item) => item.id === 'hold_vti');
  assert.equal(holding.sector, 'Broad Market');
  assert.equal(holding.sector_source, 'manual');

  const cleared = setSecurityMetadata(db, 'sec_vti', { sector: null });
  assert.equal(cleared.sector, null);
  assert.equal(cleared.sector_source, null);
});

test('getHoldingHistory returns a holding\'s value-over-time series in date order, scoped to its account+security', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO holdings_history (id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at)
    VALUES
      ('h1', 'acct', 'sec_vti', '2026-06-28', 10, 110, 1100, 1000, '2026-06-28T00:00:00.000Z'),
      ('h2', 'acct', 'sec_vti', '2026-06-30', 10, 120, 1200, 1000, '2026-06-30T00:00:00.000Z'),
      ('h3', 'acct', 'sec_cash', '2026-06-30', 1, 50, 50, NULL, '2026-06-30T00:00:00.000Z')
  `).run();

  const history = getHoldingHistory(db, 'hold_vti', 90);
  assert.deepEqual(history, [
    { date: '2026-06-28', quantity: 10, institution_price: 110, institution_value: 1100, cost_basis: 1000 },
    { date: '2026-06-30', quantity: 10, institution_price: 120, institution_value: 1200, cost_basis: 1000 },
  ]);
});

test('getHoldingHistory throws for an unknown holding id', (t) => {
  const db = setupDb();
  t.after(() => db.close());

  assert.throws(() => getHoldingHistory(db, 'nonexistent'), /Holding not found/);
});
