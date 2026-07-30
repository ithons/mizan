import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, startOfMonth, subMonths } from 'date-fns';
import { _setDbForTesting, closeDb } from '../server/src/db/index';
import { backfillSnapshots, estimateFloorMonth, takeSnapshot } from '../server/src/services/snapshot';

// backfillSnapshots estimates historical net worth by reversing later transactions off the
// current balances. Liability balances are stored as positive "amount owed" and move opposite
// the transaction sign (a purchase is a negative amount but raises what's owed), so they must
// be reversed in the opposite direction from asset balances. This guards that split.

// Reverse-replay only runs for months the ledger actually reaches back to (see
// estimateFloorMonth): otherwise "undo every later transaction off today's balance" just
// restates today's balance under a past date. These fixtures test the DIRECTION of the
// reversal, and use "last month" only as a convenient target, so each one needs an anchor
// transaction old enough to establish coverage. The anchor is dated before the target month,
// so it is never among the transactions being reversed and never perturbs the arithmetic.
function anchorCoverage(db: Database.Database, accountId: string): void {
  db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending) VALUES (?,?,?,?,?)')
    .run(`anchor_${accountId}`, accountId, format(subMonths(new Date(), 4), 'yyyy-MM-dd'), 0, 0);
}

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
      manually_categorized INTEGER NOT NULL DEFAULT 0,
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
    anchorCoverage(db, 'acc_check');
    anchorCoverage(db, 'acc_card');

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
    anchorCoverage(db, 'acc_inv');
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
    // A zero-balance account has nothing to reconstruct, so it never establishes coverage on
    // its own. A funded checking account alongside it puts the month in range.
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('acc_check', 100000, 0, 0, 'checking');
    anchorCoverage(db, 'acc_card');
    anchorCoverage(db, 'acc_check');
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
    anchorCoverage(db, 'cb');
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

// ── Coverage gate ────────────────────────────────────────────────────────────
// Reverse-replay produces a number for any month you ask for, but past the end of the ledger
// that number is just today's balance restated. On real data this manufactured 20 consecutive
// months with identical breakdowns, rendered on the same line as measured snapshots.

test('estimateFloorMonth is bounded by the account whose history starts latest', () => {
  const floor = estimateFloorMonth(
    [
      { id: 'old', current_balance: 100000 },
      { id: 'new', current_balance: 50000 },
    ],
    new Map([
      ['old', '2024-03-15'],
      ['new', '2026-03-10'],
    ])
  );
  // 'new' only has history back to March 2026, so nothing before that is reconstructable for
  // the portfolio as a whole, however deep 'old' happens to go.
  assert.equal(floor, '2026-03-01');
});

test('estimateFloorMonth ignores accounts with nothing to reconstruct', () => {
  const floor = estimateFloorMonth(
    [
      { id: 'funded', current_balance: 100000 },
      { id: 'static', current_balance: 38000 },  // manual cash: no transactions, never moves
      { id: 'emptied', current_balance: 0 },     // closed/paid off: no value to reconstruct
    ],
    new Map([
      ['funded', '2024-03-15'],
      ['emptied', '2026-07-01'],
    ])
  );
  assert.equal(floor, '2024-03-01');
});

test('estimateFloorMonth returns null when nothing that holds value has any history', () => {
  assert.equal(estimateFloorMonth([{ id: 'cash', current_balance: 38000 }], new Map()), null);
});

test('backfillSnapshots emits nothing for months the ledger does not reach', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('acc_check', 100000, 0, 0, 'checking');
    // History starts 3 months ago. Anything older than that is unknowable.
    db.prepare('INSERT INTO transactions (id,account_id,date,amount,pending) VALUES (?,?,?,?,?)')
      .run('t1', 'acc_check', format(subMonths(new Date(), 3), 'yyyy-MM-dd'), -5000, 0);

    backfillSnapshots();

    const inRange = format(startOfMonth(subMonths(new Date(), 2)), 'yyyy-MM-dd');
    const outOfRange = format(startOfMonth(subMonths(new Date(), 6)), 'yyyy-MM-dd');
    assert.ok(
      db.prepare('SELECT id FROM net_worth_snapshots WHERE date = ?').get(inRange),
      'a month inside the covered window is still estimated'
    );
    assert.equal(
      db.prepare('SELECT id FROM net_worth_snapshots WHERE date = ?').get(outOfRange),
      undefined,
      'a month older than the ledger must produce no snapshot at all'
    );
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
    void closeDb;
  }
});

test('backfillSnapshots writes nothing when no funded account has any history', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    // A manual cash account with a balance and no transactions ever. Every "estimate" here
    // would be $380 copied backwards forever, which is what the old code produced.
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run('wallet', 38000, 0, 0, 'cash');

    backfillSnapshots();

    const count = db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
    void closeDb;
  }
});
