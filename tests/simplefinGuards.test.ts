import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  liabilityAdjustedCents,
  providerErrorStrings,
  simplefinAccountsOrThrow,
  triageSimplefinErrors,
  upsertHoldingsFromSimplefin,
  upsertSimplefinTransaction,
  zeroAccountsMissingFromResponse,
} from '../server/src/services/simplefin';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

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

test('a response with no accounts at all never zeroes a balance, even with no errors reported', () => {
  const db = setupAccountsDb();
  // The maintenance-page case: HTTP 200, nothing parseable, so no account ids were seen and the
  // provider reported no errors either. Absence of every account is "unknown", not "all closed".
  const changes = zeroAccountsMissingFromResponse(db, new Set<string>(), '2026-07-24', []);

  const balances = (db.prepare('SELECT id, current_balance FROM accounts ORDER BY id').all() as Array<{ id: string; current_balance: number }>);
  assert.deepEqual(balances, [
    { id: 'a_absent', current_balance: 100170 },
    { id: 'a_seen', current_balance: 429055 },
  ]);
  assert.deepEqual(changes, []);
  db.close();
});

test('the empty-response guard holds against the real migrated schema', () => {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { connection_type: 'simplefin', current_balance: 429055, is_manual: 0 });
  db.prepare('UPDATE accounts SET simplefin_account_id = ? WHERE id = ?').run('sf_1', accountId);

  const changes = zeroAccountsMissingFromResponse(db, new Set<string>(), '2026-07-24', []);

  const row = db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(accountId) as { current_balance: number };
  assert.equal(row.current_balance, 429055);
  assert.deepEqual(changes, []);
  db.close();
});

// ── Unreadable 200s ──────────────────────────────────────────────────────────
// accountCount 0 with no errors used to be indistinguishable from a real empty response, which
// made a maintenance HTML page look like a successful sync of nothing.

test('a 200 without an accounts array fails the stage instead of reporting zero accounts', () => {
  const maintenancePage = '<html><body>SimpleFIN Bridge is down for maintenance</body></html>';
  assert.throws(() => simplefinAccountsOrThrow(maintenancePage), /no accounts array/);
  assert.throws(() => simplefinAccountsOrThrow({}), /no accounts array/);
  assert.throws(() => simplefinAccountsOrThrow({ errors: ['something went wrong'] }), /no accounts array/);
  assert.throws(() => simplefinAccountsOrThrow({ accounts: null }), /no accounts array/);
  assert.throws(() => simplefinAccountsOrThrow(null), /no accounts array/);
});

test('a genuinely empty account list is still a valid response', () => {
  assert.deepEqual(simplefinAccountsOrThrow({ accounts: [] }), []);
  assert.equal(simplefinAccountsOrThrow({ accounts: [{ id: 'a', name: 'Checking', balance: '1.00' }] }).length, 1);
});

test('provider errors are read only from an array of strings', () => {
  assert.deepEqual(providerErrorStrings({ errors: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(providerErrorStrings({ errors: 'a string, not a list' }), []);
  assert.deepEqual(providerErrorStrings({ errors: ['keep', { nested: true }, 7] }), ['keep']);
  assert.deepEqual(providerErrorStrings(undefined), []);
});

// ── Advisories vs auth failures ──────────────────────────────────────────────
// The bridge caps the app's own 730-day first-sync request and says so in `errors`. Reading that as
// an expired login told the owner to re-link the institution, the riskiest action the app offers.

test('the capped-date-range notice is an advisory, not a reauth prompt', () => {
  const triage = triageSimplefinErrors(['Requested date range exceeds limit of 90 days and was capped.']);
  assert.deepEqual(triage.reauth, []);
  assert.equal(triage.advisories.length, 1);
});

test('a real access failure is still classified as reauth', () => {
  const triage = triageSimplefinErrors([
    'Wealthfront: connection needs to be re-authorized',
    'Requested date range exceeds limit of 90 days and was capped.',
    'Chase: credentials are no longer valid',
  ]);
  assert.equal(triage.reauth.length, 2);
  assert.deepEqual(triage.advisories, ['Requested date range exceeds limit of 90 days and was capped.']);
});

test("this app's own data warnings are advisories, not login problems", () => {
  const errors: string[] = [];
  liabilityAdjustedCents(500, true, 'Weird Card', errors);
  errors.push('Account "Euro Savings" is in EUR, but Mizān treats balances as USD — its value may be misstated.');
  errors.push('SimpleFIN returned a non-numeric transaction abc amount: "n/a"');

  const triage = triageSimplefinErrors(errors);
  assert.deepEqual(triage.reauth, [], 'none of these mean the institution login expired');
  assert.equal(triage.advisories.length, 3);
});

// ── Provider writes vs owner edits ───────────────────────────────────────────
// The old unconditional UPDATE rewrote date/amount/merchant_name/original_name/pending for every
// row in the payload, which reverted the owner's merchant corrections within the hour and reported
// every untouched row as 'modified'.

function insertSimplefinTransaction(
  db: Database.Database,
  providerId: string,
  overrides: Parameters<typeof insertTransaction>[1] = {}
): string {
  const id = insertTransaction(db, { source_type: 'simplefin', ...overrides });
  db.prepare('UPDATE transactions SET simplefin_transaction_id = ? WHERE id = ?').run(providerId, id);
  return id;
}

test('a hand-edited merchant name survives a resync of the same posted transaction', () => {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  const txnId = insertSimplefinTransaction(db, 'sf_txn_1', {
    account_id: accountId,
    date: '2026-07-10',
    amount: -4211,
    merchant_name: 'Trader Joe’s',        // the owner's correction
    original_name: 'TRADER JOES #431 CAMBRIDGE MA',
    pending: 0,
  });

  const write = upsertSimplefinTransaction(db, accountId, {
    providerId: 'sf_txn_1',
    date: '2026-07-10',
    amount: -4211,
    merchantName: 'TRADER JOES #431',          // what the provider keeps sending
    originalName: 'TRADER JOES #431 CAMBRIDGE MA',
    pending: 0,
  }, '2026-07-30T12:00:00.000Z');

  const row = db.prepare('SELECT merchant_name, original_name FROM transactions WHERE id = ?').get(txnId) as
    { merchant_name: string; original_name: string };
  assert.equal(row.merchant_name, 'Trader Joe’s');
  assert.equal(row.original_name, 'TRADER JOES #431 CAMBRIDGE MA', 'the provider still owns the raw description');
  assert.equal(write, 'unchanged', 'and the row is not reported as touched');
  db.close();
});

test('a settling transaction still takes the provider date, amount and payee', () => {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  const txnId = insertSimplefinTransaction(db, 'sf_txn_2', {
    account_id: accountId,
    date: '2026-07-10',
    amount: -5000,
    merchant_name: 'SQ *RESTAURANT',
    original_name: 'SQ *RESTAURANT',
    pending: 1,
  });

  // The authorization posts two days later with the tip added and a cleaner payee.
  const write = upsertSimplefinTransaction(db, accountId, {
    providerId: 'sf_txn_2',
    date: '2026-07-12',
    amount: -6000,
    merchantName: 'Restaurant Name',
    originalName: 'SQ *RESTAURANT NAME',
    pending: 0,
  }, '2026-07-30T12:00:00.000Z');

  assert.equal(write, 'modified');
  const row = db.prepare('SELECT date, amount, merchant_name, pending FROM transactions WHERE id = ?').get(txnId) as
    { date: string; amount: number; merchant_name: string; pending: number };
  assert.deepEqual(row, { date: '2026-07-12', amount: -6000, merchant_name: 'Restaurant Name', pending: 0 });
  db.close();
});

test('a blank merchant name is filled in by the provider rather than protected', () => {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  const txnId = insertSimplefinTransaction(db, 'sf_txn_3', {
    account_id: accountId,
    merchant_name: null,
    original_name: 'ACH CREDIT',
    pending: 0,
  });

  const write = upsertSimplefinTransaction(db, accountId, {
    providerId: 'sf_txn_3',
    date: '2026-07-01',
    amount: -1000,
    merchantName: 'Payroll',
    originalName: 'ACH CREDIT',
    pending: 0,
  }, '2026-07-30T12:00:00.000Z');

  assert.equal(write, 'modified');
  const row = db.prepare('SELECT merchant_name FROM transactions WHERE id = ?').get(txnId) as { merchant_name: string };
  assert.equal(row.merchant_name, 'Payroll');
  db.close();
});

test('an unchanged row is not counted as modified and its updated_at is left alone', () => {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  const values = {
    providerId: 'sf_txn_4',
    date: '2026-07-10',
    amount: -1234,
    merchantName: 'Backblaze',
    originalName: 'BACKBLAZE INC',
    pending: 0,
  };

  assert.equal(upsertSimplefinTransaction(db, accountId, values, '2026-07-29T12:00:00.000Z'), 'added');
  const afterInsert = db.prepare('SELECT updated_at FROM transactions WHERE simplefin_transaction_id = ?').get('sf_txn_4') as
    { updated_at: string };

  // The next twelve hourly syncs serve exactly the same row.
  for (let i = 0; i < 12; i += 1) {
    assert.equal(upsertSimplefinTransaction(db, accountId, values, '2026-07-30T12:00:00.000Z'), 'unchanged');
  }

  const afterResyncs = db.prepare('SELECT updated_at FROM transactions WHERE simplefin_transaction_id = ?').get('sf_txn_4') as
    { updated_at: string };
  assert.equal(afterResyncs.updated_at, afterInsert.updated_at, 'a no-op sync must not restamp the row');
  db.close();
});

test('a real provider revision is still counted as modified', () => {
  const db = migratedTestDb();
  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  insertSimplefinTransaction(db, 'sf_txn_5', {
    account_id: accountId,
    date: '2026-07-10',
    amount: -1234,
    merchant_name: 'Backblaze',
    original_name: 'BACKBLAZE INC',
    pending: 0,
  });

  const write = upsertSimplefinTransaction(db, accountId, {
    providerId: 'sf_txn_5',
    date: '2026-07-10',
    amount: -1999,
    merchantName: 'Backblaze',
    originalName: 'BACKBLAZE INC',
    pending: 0,
  }, '2026-07-30T12:00:00.000Z');

  assert.equal(write, 'modified');
  const row = db.prepare("SELECT amount FROM transactions WHERE simplefin_transaction_id = 'sf_txn_5'").get() as { amount: number };
  assert.equal(row.amount, -1999);
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
