import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  guessAccountTypeAndLiability,
  reclassifyAutoAccountTypes,
} from '../server/src/services/accountClassification';

test('guessAccountTypeAndLiability recognizes known brokerage institutions for generically-named accounts', () => {
  assert.deepEqual(guessAccountTypeAndLiability('Individual', 'Fidelity Investments'), { type: 'brokerage', isLiability: false });
  assert.deepEqual(guessAccountTypeAndLiability('ROTH IRA', 'Fidelity Investments'), { type: 'ira_roth', isLiability: false });
});

test('guessAccountTypeAndLiability recognizes cash-management/HYSA products by name, not institution, even at brokerage-adjacent fintechs', () => {
  // Wealthfront offers both a real brokerage and a cash account, often both named
  // "Individual" - only the "APY" in the name distinguishes the cash product.
  assert.deepEqual(guessAccountTypeAndLiability('Individual 3.30% APY', 'Wealthfront'), { type: 'savings', isLiability: false });
  assert.deepEqual(guessAccountTypeAndLiability('Individual', 'Wealthfront'), { type: 'brokerage', isLiability: false });
  assert.deepEqual(guessAccountTypeAndLiability('Cash Account', 'Betterment'), { type: 'savings', isLiability: false });
});

test('guessAccountTypeAndLiability still classifies credit cards and generic checking correctly', () => {
  assert.deepEqual(guessAccountTypeAndLiability('Sapphire Preferred', 'Chase Credit Card'), { type: 'credit', isLiability: true });
  assert.deepEqual(guessAccountTypeAndLiability('Everyday Checking', 'Chase Bank'), { type: 'checking', isLiability: false });
  assert.deepEqual(guessAccountTypeAndLiability('Something Unrelated', 'Some Random Bank'), { type: 'checking', isLiability: false });
});

test('guessAccountTypeAndLiability recognizes known credit card product names that contain neither "credit" nor "card"', () => {
  assert.deepEqual(guessAccountTypeAndLiability('Customized Cash Rewards Visa Signature- 2448', 'Bank of America'), { type: 'credit', isLiability: true });
  assert.deepEqual(guessAccountTypeAndLiability('Savor', 'Capital One'), { type: 'credit', isLiability: true });
  assert.deepEqual(guessAccountTypeAndLiability('Venture X', 'Capital One'), { type: 'credit', isLiability: true });
});

function setupAccountsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL,
      institution_name TEXT NOT NULL DEFAULT '',
      connection_type TEXT NOT NULL,
      type TEXT NOT NULL,
      is_liability INTEGER NOT NULL DEFAULT 0,
      type_source TEXT NOT NULL DEFAULT 'auto',
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

test('reclassifyAutoAccountTypes fixes frozen auto accounts but never touches manual overrides', (t) => {
  const db = setupAccountsDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO accounts (id, account_name, institution_name, connection_type, type, is_liability, type_source, updated_at)
    VALUES
      ('fidelity_individual', 'Individual', 'Fidelity Investments', 'simplefin', 'checking', 0, 'auto', '2026-01-01'),
      ('user_corrected', 'Individual', 'Fidelity Investments', 'simplefin', 'checking', 0, 'manual', '2026-01-01'),
      ('already_correct', 'Individual', 'Fidelity Investments', 'simplefin', 'brokerage', 0, 'auto', '2026-01-01'),
      ('coinbase_wallet', 'BTC Wallet', 'Coinbase', 'coinbase', 'crypto_wallet', 0, 'manual', '2026-01-01')
  `).run();

  const result = reclassifyAutoAccountTypes(db);
  assert.equal(result.updated, 1);

  const rows = db.prepare('SELECT id, type, is_liability FROM accounts ORDER BY id').all() as Array<{
    id: string; type: string; is_liability: number;
  }>;

  assert.deepEqual(rows, [
    { id: 'already_correct', type: 'brokerage', is_liability: 0 },
    { id: 'coinbase_wallet', type: 'crypto_wallet', is_liability: 0 },
    { id: 'fidelity_individual', type: 'brokerage', is_liability: 0 },
    { id: 'user_corrected', type: 'checking', is_liability: 0 }, // manual override, untouched despite being "wrong"
  ]);
});
