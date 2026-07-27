import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { liabilityAdjustedCents, upsertHoldingsFromSimplefin, zeroAccountsMissingFromResponse } from '../server/src/services/simplefin';

test('a liability reported negative (the normal SimpleFIN convention) stores positive owed', () => {
  const errors: string[] = [];
  // $500 owed, reported as -500 by the provider -> stored +50000 cents.
  assert.equal(liabilityAdjustedCents(-500, true, 'Chase Sapphire', errors), 50000);
  assert.equal(errors.length, 0);
});

test('a liability reported positive flags the unexpected sign', () => {
  const errors: string[] = [];
  const cents = liabilityAdjustedCents(500, true, 'Weird Card', errors);
  assert.equal(cents, -50000); // negated as before, but...
  assert.equal(errors.length, 1); // ...the anomaly is surfaced through the sync result
  assert.match(errors[0], /Weird Card/);
  assert.match(errors[0], /sign may be wrong/);
});

test('an asset balance is stored as-is with no warning', () => {
  const errors: string[] = [];
  assert.equal(liabilityAdjustedCents(1234.56, false, 'Checking', errors), 123456);
  assert.equal(errors.length, 0);
});

// ── Stale-account zeroing ────────────────────────────────────────────────────
// An account closed at the institution simply stops appearing in the response, so absence is
// the only signal available. That inference is only valid when the response is complete:
// SimpleFIN reports a failing institution in `errors` on an otherwise-200 response, and that
// institution's accounts can be missing entirely. runFullSync() snapshots net worth in the same
// pass, so a wrong zero is written into history as measured fact and overwrites the day's real
// value. Balances recover on the next sync; the snapshot does not.

function setupAccountsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      simplefin_account_id TEXT,
      connection_type TEXT NOT NULL,
      account_name TEXT NOT NULL,
      current_balance INTEGER NOT NULL DEFAULT 0,
      is_liability INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL DEFAULT '2026-07-01'
    );
  `);
  const ins = db.prepare(
    "INSERT INTO accounts (id, simplefin_account_id, connection_type, account_name, current_balance) VALUES (?,?,'simplefin',?,?)"
  );
  ins.run('a_seen', 'sf_seen', 'Chase Checking', 429055);
  ins.run('a_absent', 'sf_absent', 'Wealthfront Cash', 100170);
  return db;
}

test('a clean response zeroes accounts the provider no longer returns', () => {
  const db = setupAccountsDb();
  const changes = zeroAccountsMissingFromResponse(db, new Set(['sf_seen']), '2026-07-24', []);

  const balances = Object.fromEntries(
    (db.prepare('SELECT id, current_balance FROM accounts').all() as Array<{ id: string; current_balance: number }>)
      .map((r) => [r.id, r.current_balance])
  );
  assert.equal(balances.a_seen, 429055, 'a returned account keeps its balance');
  assert.equal(balances.a_absent, 0, 'a genuinely closed account is zeroed');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousBalance, 1001.7);
  db.close();
});

test('a response carrying provider errors never zeroes a missing account', () => {
  const db = setupAccountsDb();
  // The reauth case: Wealthfront's accounts are absent from `accounts`, and the reason is in
  // `errors`, not in the account list.
  const changes = zeroAccountsMissingFromResponse(
    db,
    new Set(['sf_seen']),
    '2026-07-24',
    ['Wealthfront: connection needs to be re-authorized']
  );

  const absent = db.prepare("SELECT current_balance FROM accounts WHERE id = 'a_absent'").get() as { current_balance: number };
  assert.equal(absent.current_balance, 100170, 'balance preserved: absence here means "unknown", not "empty"');
  assert.deepEqual(changes, [], 'and nothing is reported as a balance change');
  db.close();
});

// ── Sold positions ───────────────────────────────────────────────────────────
// The upsert-only pass left a fully-sold position at its last market value forever, inflating
// the portfolio total. coinbase.ts already zeroed its side; this brings SimpleFIN into line.

function setupHoldingsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE securities (id TEXT PRIMARY KEY, ticker TEXT, name TEXT, type TEXT, currency TEXT);
    CREATE TABLE holdings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, security_id TEXT NOT NULL,
      quantity REAL NOT NULL, institution_price REAL NOT NULL, institution_value INTEGER NOT NULL,
      cost_basis INTEGER, currency TEXT NOT NULL DEFAULT 'USD', updated_at TEXT NOT NULL,
      UNIQUE(account_id, security_id)
    );
  `);
  return db;
}

test('a position the institution stops reporting is zeroed, not left at its last value', () => {
  const db = setupHoldingsDb();

  upsertHoldingsFromSimplefin(db, 'acct', [
    { symbol: 'VT', description: 'Vanguard Total World', shares: 8, market_value: 1248.62 },
    { symbol: 'FSKAX', description: 'Fidelity Total Market', shares: 3, market_value: 604.98 },
  ], '2026-07-01');

  let rows = db.prepare('SELECT s.ticker, h.institution_value FROM holdings h JOIN securities s ON s.id=h.security_id ORDER BY s.ticker').all() as Array<{ ticker: string; institution_value: number }>;
  assert.deepEqual(rows, [
    { ticker: 'FSKAX', institution_value: 60498 },
    { ticker: 'VT', institution_value: 124862 },
  ]);

  // Next sync: FSKAX has been sold, so it simply is not in the payload.
  upsertHoldingsFromSimplefin(db, 'acct', [
    { symbol: 'VT', description: 'Vanguard Total World', shares: 8, market_value: 1300 },
  ], '2026-07-02');

  rows = db.prepare('SELECT s.ticker, h.institution_value FROM holdings h JOIN securities s ON s.id=h.security_id ORDER BY s.ticker').all() as Array<{ ticker: string; institution_value: number }>;
  assert.deepEqual(rows, [
    { ticker: 'FSKAX', institution_value: 0 },
    { ticker: 'VT', institution_value: 130000 },
  ]);
  db.close();
});

test('zeroing is scoped to the account being synced', () => {
  const db = setupHoldingsDb();
  upsertHoldingsFromSimplefin(db, 'brokerage', [{ symbol: 'VT', shares: 8, market_value: 1000 }], '2026-07-01');
  upsertHoldingsFromSimplefin(db, 'roth', [{ symbol: 'FSKAX', shares: 3, market_value: 500 }], '2026-07-01');

  // Syncing the brokerage account must not touch the Roth's positions.
  upsertHoldingsFromSimplefin(db, 'brokerage', [], '2026-07-02');

  const roth = db.prepare("SELECT institution_value FROM holdings WHERE account_id = 'roth'").get() as { institution_value: number };
  const brokerage = db.prepare("SELECT institution_value FROM holdings WHERE account_id = 'brokerage'").get() as { institution_value: number };
  assert.equal(roth.institution_value, 50000);
  assert.equal(brokerage.institution_value, 0);
  db.close();
});
