import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Holding } from '../shared/types';
import { migratedTestDb, insertAccount, TEST_NOW } from './helpers/schema';
import { upsertHoldingsFromSimplefin } from '../server/src/services/simplefin';
import { listHoldingsWithMetadata } from '../server/src/services/investmentMetadata';
import { getCostBasisStats, holdingGain } from '../client/src/lib/investmentAnalytics';

// SimpleFIN reports a cost_basis field for every Fidelity position whether or not it knows one,
// and for the SPAXX cash sweep it sends 0. Stored and read as a real number, that 0 says the
// position was acquired for nothing and turns its entire market value into unrealized gain. On
// the live database two such rows worth $104.99 carried the Investments header from a true
// $36.83 / 1.8% to $141.82 / 7.1%, against $2,002.80 of basis that genuinely exists.

function seedSecurity(db: Database.Database, id: string, ticker: string, name: string): void {
  db.prepare("INSERT INTO securities (id, ticker, name, type, currency) VALUES (?, ?, ?, 'etf', 'USD')")
    .run(id, ticker, name);
}

function insertHolding(
  db: Database.Database,
  row: {
    id: string;
    account_id: string;
    security_id: string;
    quantity: number;
    institution_price: number;
    institution_value: number;
    cost_basis: number | null;
    manual_cost_basis?: number | null;
  }
): void {
  db.prepare(`
    INSERT INTO holdings
      (id, account_id, security_id, quantity, institution_price, institution_value,
       cost_basis, manual_cost_basis, currency, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?)
  `).run(
    row.id,
    row.account_id,
    row.security_id,
    row.quantity,
    row.institution_price,
    row.institution_value,
    row.cost_basis,
    row.manual_cost_basis ?? null,
    TEST_NOW
  );
}

test('a SimpleFIN cost_basis of 0 with no usable purchase_price is stored as unknown, not as zero', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const accountId = insertAccount(db, { type: 'brokerage', connection_type: 'simplefin' });

  upsertHoldingsFromSimplefin(db, accountId, [
    { symbol: 'SPAXX', description: 'Fidelity Government Money Market', shares: 104.61, market_value: 104.61, cost_basis: 0, purchase_price: null },
    { symbol: 'VT', description: 'Vanguard Total World Stock ETF', shares: 8.003, market_value: 1236.06, cost_basis: 1199.84, purchase_price: null },
    { symbol: 'FSKAX', description: 'Fidelity Total Market Index', shares: 3.416, market_value: 698.81, cost_basis: 0, purchase_price: 205.72 },
  ], TEST_NOW);

  const stored = db.prepare(
    'SELECT s.ticker, h.cost_basis FROM holdings h JOIN securities s ON s.id = h.security_id ORDER BY s.ticker'
  ).all() as Array<{ ticker: string; cost_basis: number | null }>;

  assert.deepEqual(stored, [
    // purchase_price is real, so shares * price stands in for the basis the provider withheld.
    { ticker: 'FSKAX', cost_basis: Math.round(3.416 * 205.72 * 100) },
    { ticker: 'SPAXX', cost_basis: null },
    { ticker: 'VT', cost_basis: 119984 },
  ]);
});

test('a zero basis already in the database reads back as missing, and a positive one still reads as provider', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const accountId = insertAccount(db, { type: 'brokerage', connection_type: 'simplefin' });
  seedSecurity(db, 'sec_spaxx', 'SPAXX', 'Fidelity Government Money Market');
  seedSecurity(db, 'sec_vt', 'VT', 'Vanguard Total World Stock ETF');

  insertHolding(db, { id: 'h_spaxx', account_id: accountId, security_id: 'sec_spaxx', quantity: 104.61, institution_price: 1, institution_value: 10461, cost_basis: 0 });
  insertHolding(db, { id: 'h_vt', account_id: accountId, security_id: 'sec_vt', quantity: 8.003, institution_price: 154.45, institution_value: 123606, cost_basis: 119984 });

  const byTicker = new Map(listHoldingsWithMetadata(db).map((h) => [h.ticker, h]));

  const sweep = byTicker.get('SPAXX');
  assert.equal(sweep?.cost_basis_quality, 'missing');
  assert.equal(sweep?.cost_basis, null);
  assert.equal(sweep?.effective_cost_basis, null);
  assert.equal(sweep?.provider_cost_basis, null);

  const etf = byTicker.get('VT');
  assert.equal(etf?.cost_basis_quality, 'provider');
  assert.equal(etf?.cost_basis, 119984);
  assert.equal(etf?.effective_cost_basis, 119984);
});

test('a manual basis outranks the provider zero and stays known', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const accountId = insertAccount(db, { type: 'brokerage', connection_type: 'simplefin' });
  seedSecurity(db, 'sec_spaxx', 'SPAXX', 'Fidelity Government Money Market');

  insertHolding(db, { id: 'h_spaxx', account_id: accountId, security_id: 'sec_spaxx', quantity: 104.61, institution_price: 1, institution_value: 10461, cost_basis: 0, manual_cost_basis: 10400 });

  const [holding] = listHoldingsWithMetadata(db);
  assert.equal(holding.cost_basis_quality, 'manual');
  assert.equal(holding.effective_cost_basis, 10400);
  assert.deepEqual(holdingGain(holding), { gain: 61, pct: (61 / 10400) * 100 });
});

// The migration is a one-time repair of rows written before the ingest fix. It has to leave a
// manual override alone: that figure is the owner's deliberate statement, not the provider's.
test('migration 043 nulls a provider zero but never one the owner overrode by hand', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());
  const accountId = insertAccount(db, { type: 'brokerage', connection_type: 'simplefin' });
  seedSecurity(db, 'sec_spaxx', 'SPAXX', 'Fidelity Government Money Market');
  seedSecurity(db, 'sec_vt', 'VT', 'Vanguard Total World Stock ETF');

  // Seeded to the pre-migration state and replayed against the real file: migratedTestDb() has
  // already applied 043 to an empty schema, which proves nothing about what it does to data.
  insertHolding(db, { id: 'h_zero', account_id: accountId, security_id: 'sec_spaxx', quantity: 104.61, institution_price: 1, institution_value: 10461, cost_basis: 0 });
  insertHolding(db, { id: 'h_overridden', account_id: accountId, security_id: 'sec_vt', quantity: 8.003, institution_price: 154.45, institution_value: 123606, cost_basis: 0, manual_cost_basis: 119984 });
  db.prepare(`
    INSERT INTO holdings_history
      (id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at)
    VALUES ('hh_zero', ?, 'sec_spaxx', '2026-07-01', 104.61, 1, 10461, 0, ?)
  `).run(accountId, TEST_NOW);

  db.exec(fs.readFileSync(
    path.join(process.cwd(), 'server/src/db/migrations/043_null_zero_cost_basis.sql'),
    'utf-8'
  ));

  const history = db.prepare('SELECT cost_basis FROM holdings_history').all();
  assert.deepEqual(history, [{ cost_basis: null }]);

  const rows = db.prepare('SELECT id, cost_basis, manual_cost_basis FROM holdings ORDER BY id').all();
  assert.deepEqual(rows, [
    { id: 'h_overridden', cost_basis: 0, manual_cost_basis: 119984 },
    { id: 'h_zero', cost_basis: null, manual_cost_basis: null },
  ]);
});

// The live portfolio, in the cents the API hands the client.
function livePortfolio(): Holding[] {
  const holding = (
    ticker: string,
    institution_value: number,
    cost_basis: number | null
  ): Holding => ({
    id: `h_${ticker}_${institution_value}`,
    account_id: 'acct_fidelity',
    security_id: `sec_${ticker}`,
    quantity: 1,
    institution_price: 1,
    institution_value,
    cost_basis,
    provider_cost_basis: cost_basis,
    effective_cost_basis: cost_basis,
    manual_cost_basis: null,
    cost_basis_quality: cost_basis == null ? 'missing' : 'provider',
    currency: 'USD',
    updated_at: TEST_NOW,
    ticker,
    security_name: ticker,
    security_type: 'etf',
    sector: null,
  });

  return [
    holding('VT', 123606, 119984),
    holding('FSKAX', 69881, 70274),
    holding('SPAXX', 10461, null),
    holding('VT', 10456, 9998),
    holding('SPAXX', 38, null),
    holding('FSKAX', 20, 24),
  ];
}

test('the header aggregate excludes basis-less positions from value, basis, and return', () => {
  const stats = getCostBasisStats(livePortfolio());

  assert.equal(stats.totalCount, 6);
  assert.equal(stats.knownCount, 4);
  assert.equal(stats.missingCount, 2);
  assert.equal(stats.label, 'Partial');
  assert.equal(stats.knownCostBasis, 200280);
  // 2,039.63 of market value against 2,002.80 of basis, not 2,144.62 against 2,002.80.
  assert.equal(stats.unrealized, 3683);
  assert.ok(stats.returnPct != null && Math.abs(stats.returnPct - 1.8389) < 0.001);
});

test('the header aggregate and the per-row gain agree on which holdings have a basis', () => {
  const holdings = livePortfolio();
  const stats = getCostBasisStats(holdings);
  const rowsWithGain = holdings.filter((holding) => holdingGain(holding) != null);

  assert.equal(rowsWithGain.length, stats.knownCount);
  assert.equal(
    rowsWithGain.reduce((sum, holding) => sum + (holdingGain(holding)?.gain ?? 0), 0),
    stats.unrealized
  );
});

test('a position with a real basis still reports its own gain', () => {
  const [vt] = livePortfolio();
  assert.deepEqual(holdingGain(vt), { gain: 3622, pct: (3622 / 119984) * 100 });
});
