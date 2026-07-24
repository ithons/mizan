import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, startOfMonth, subMonths } from 'date-fns';
import { _setDbForTesting, closeDb } from '../server/src/db/index';
import { backfillSnapshots, takeSnapshot } from '../server/src/services/snapshot';

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
      pending INTEGER NOT NULL DEFAULT 0,
      category_id TEXT
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
    CREATE TABLE holdings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, security_id TEXT NOT NULL,
      quantity REAL NOT NULL, institution_price REAL NOT NULL, institution_value INTEGER NOT NULL,
      cost_basis INTEGER
    );
    CREATE TABLE holdings_history (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, security_id TEXT NOT NULL, date TEXT NOT NULL,
      quantity REAL NOT NULL, institution_price REAL NOT NULL, institution_value INTEGER NOT NULL,
      cost_basis INTEGER, created_at TEXT NOT NULL, UNIQUE(account_id, security_id, date)
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
    db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending) VALUES (?,?,?,?,?)').run('t_exp', 'acc_check', today, -20000, 0);
    db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending) VALUES (?,?,?,?,?)').run('t_buy', 'acc_card', today, -30000, 0);

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

test('backfillSnapshots reverses only contributions for market-driven accounts', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    // Brokerage worth $2000 today. Last month: a $100 auto-invest (contribution), a $500
    // sell (internal reshuffle), and a $5 dividend. Only the contribution should move the
    // estimated past value; reversing the buy/sell/dividend would be market-blind nonsense.
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('acc_inv', 200000, 0, 0, 'brokerage');
    const today = format(new Date(), 'yyyy-MM-dd');
    const ins = db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending,category_id) VALUES (?,?,?,?,?,?)');
    ins.run('t_contrib', 'acc_inv', today, -10000, 0, 'cat_inv_buy');   // $100 new money in
    ins.run('t_sell', 'acc_inv', today, 50000, 0, 'cat_inv_sell');      // internal, no value change
    ins.run('t_div', 'acc_inv', today, 500, 0, 'cat_inv_dividend');     // ignored (held flat)

    backfillSnapshots();

    const target = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
    const snap = db.prepare(
      'SELECT total_assets, investment_assets FROM net_worth_snapshots WHERE date = ?'
    ).get(target) as { total_assets: number; investment_assets: number };

    assert.ok(snap, `expected an estimated snapshot at ${target}`);
    // Only the $100 contribution reverses: 200000 - 10000 = 190000. The sell and dividend
    // must NOT move it (old reverse-everything logic would have given 200000-50000-500).
    assert.equal(snap.total_assets, 190000);
    assert.equal(snap.investment_assets, 190000);
  } finally {
    db.close();
  }
});

test('backfillSnapshots clamps a spend-only card liability at zero instead of going negative', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    // Card is paid off today ($0 owed). We have only its purchases (a spend-only import),
    // no payments — reversing purchases alone would drive "owed" to −$500 (a phantom asset).
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('acc_card', 0, 1, 0, 'credit');
    const today = format(new Date(), 'yyyy-MM-dd');
    db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending) VALUES (?,?,?,?,?)')
      .run('t_buy', 'acc_card', today, -50000, 0);

    backfillSnapshots();

    const target = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
    const snap = db.prepare('SELECT total_liabilities FROM net_worth_snapshots WHERE date = ?')
      .get(target) as { total_liabilities: number };
    assert.ok(snap);
    assert.equal(snap.total_liabilities, 0); // clamped, not −50000
  } finally {
    db.close();
  }
});

test('backfillSnapshots reaches back to the oldest transaction, past the 12-month wall', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('acc_check', 100000, 0, 0, 'checking');

    // A single posted transaction 30 months ago — deep history the old 12-month cap missed.
    const oldDate = format(subMonths(new Date(), 30), 'yyyy-MM-dd');
    db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending) VALUES (?,?,?,?,?)').run('t_old', 'acc_check', oldDate, -5000, 0);

    backfillSnapshots();

    // A snapshot must now exist 24 months back, which the hardcoded-12 version never produced.
    const target = format(startOfMonth(subMonths(new Date(), 24)), 'yyyy-MM-dd');
    const snap = db.prepare('SELECT id FROM net_worth_snapshots WHERE date = ?').get(target);
    assert.ok(snap, `expected an estimated snapshot at ${target}`);
  } finally {
    // The service caches getDb(); drop the test handle so later suites don't reuse it.
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
    void closeDb;
  }
});

test('takeSnapshot buckets todays balances and excludes hidden accounts; closed accounts add $0', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    const ins = db.prepare('INSERT INTO accounts (id, current_balance, is_liability, is_hidden, type) VALUES (?,?,?,?,?)');
    ins.run('chk', 100000, 0, 0, 'checking');   // $1000 liquid
    ins.run('card', 50000, 1, 0, 'credit');     // $500 owed
    ins.run('cb', 20000, 0, 0, 'crypto_wallet'); // $200 crypto
    ins.run('closed', 0, 0, 0, 'closed');        // $0 closed (kept for history)
    ins.run('hid', 999999, 0, 1, 'checking');    // hidden — must be excluded

    takeSnapshot();

    const today = format(new Date(), 'yyyy-MM-dd');
    const snap = db.prepare('SELECT * FROM net_worth_snapshots WHERE date = ?').get(today) as Record<string, number>;
    assert.equal(snap.total_assets, 120000, 'assets = checking + crypto (+ $0 closed), hidden excluded');
    assert.equal(snap.total_liabilities, 50000);
    assert.equal(snap.net_worth, 70000);
    assert.equal(snap.liquid_assets, 100000, 'closed adds $0');
    assert.equal(snap.crypto_assets, 20000);
    assert.equal(snap.investment_assets, 0);
    assert.equal(snap.is_estimated, 0, 'live snapshot is not an estimate');
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
    void closeDb;
  }
});

test('backfillSnapshots nets a Coinbase convert to zero (matched crypto buy + sell legs)', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    // Crypto wallet worth $500 today. Last month: a BTC->ETH convert (a $100 sell leg + a $100
    // buy leg, no external money). The estimate for before the convert must be unchanged ($500),
    // not $400 (the old bug that reversed only the buy leg).
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('cb', 50000, 0, 0, 'crypto_wallet');
    const today = format(new Date(), 'yyyy-MM-dd');
    const ins = db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending,category_id) VALUES (?,?,?,?,?,?)');
    ins.run('t_sell', 'cb', today, 10000, 0, 'cat_crypto_sell');  // +$100 (coin out)
    ins.run('t_buy', 'cb', today, -10000, 0, 'cat_crypto_buy');   // -$100 (coin in)

    backfillSnapshots();

    const target = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
    const snap = db.prepare('SELECT crypto_assets, total_assets FROM net_worth_snapshots WHERE date = ?')
      .get(target) as { crypto_assets: number; total_assets: number };
    assert.ok(snap);
    assert.equal(snap.crypto_assets, 50000, 'convert nets to zero: pre-convert crypto still $500');
    assert.equal(snap.total_assets, 50000);
  } finally {
    db.close();
  }
});
