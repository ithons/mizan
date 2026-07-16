import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, startOfMonth, subMonths } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { backfillSnapshots } from '../server/src/services/snapshot';

// backfillSnapshots estimates historical net worth by reversing later transactions off the
// current balances. Liability balances are stored as positive "amount owed" and move opposite
// the transaction sign (a purchase is a negative amount but raises what's owed), so they must
// be reversed in the opposite direction from asset balances. This guards that split.

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      current_balance INTEGER NOT NULL DEFAULT 0,
      is_liability INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE net_worth_snapshots (
      id TEXT PRIMARY KEY,
      date TEXT UNIQUE NOT NULL,
      total_assets INTEGER NOT NULL,
      total_liabilities INTEGER NOT NULL,
      net_worth INTEGER NOT NULL,
      breakdown TEXT NOT NULL,
      is_estimated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      liquid_assets INTEGER,
      investment_assets INTEGER,
      crypto_assets INTEGER
    );
  `);
  return db;
}

test('backfillSnapshots reverses liability purchases in the correct direction', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    // Current state: checking holds $1000, card owes $500 (positive "amount owed").
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('acc_check', 100000, 0, 0, 'checking');
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('acc_card', 50000, 1, 0, 'credit');

    // Two transactions dated today (after every backfilled month):
    //  - a $200 expense on checking (negative), and
    //  - a $300 purchase on the card (negative → raises what's owed going forward).
    const today = format(new Date(), 'yyyy-MM-dd');
    db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run('t_exp', 'acc_check', today, -20000, 0);
    db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run('t_buy', 'acc_card', today, -30000, 0);

    backfillSnapshots();

    // Snapshot for the start of last month, before those transactions happened.
    const target = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
    const snap = db.prepare(
      'SELECT total_assets, total_liabilities, net_worth, is_estimated FROM net_worth_snapshots WHERE date = ?'
    ).get(target) as { total_assets: number; total_liabilities: number; net_worth: number; is_estimated: number };

    assert.ok(snap, `expected an estimated snapshot at ${target}`);
    // Checking before the $200 expense: 100000 - (-20000) = 120000.
    assert.equal(snap.total_assets, 120000);
    // Card owed before the $300 purchase: 50000 + (-30000) = 20000 (NOT 80000, the old bug).
    assert.equal(snap.total_liabilities, 20000);
    assert.equal(snap.net_worth, 100000);
    assert.equal(snap.is_estimated, 1);
  } finally {
    db.close();
  }
});
