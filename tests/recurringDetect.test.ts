import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { detectRecurring } from '../server/src/services/recurring';

// detectRecurring() runs on the module singleton and had no direct test — it's one of the
// riskiest untested services (heuristic grouping + frequency classification + variance gates).
// These lock its current behavior so a future semi-monthly/cadence improvement has a net.

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      merchant_name TEXT,
      original_name TEXT NOT NULL DEFAULT '',
      pending INTEGER NOT NULL DEFAULT 0,
      recurring_id TEXT,
      category_id TEXT,
      -- Detection skips transfers and confirmed duplicates: they are not spending, and card
      -- payments have a rigid cadence with a wild amount, which the relaxed amount gate would admit.
      transfer_status TEXT NOT NULL DEFAULT 'none',
      duplicate_status TEXT NOT NULL DEFAULT 'none'
    );
    CREATE TABLE recurring_patterns (
      id TEXT PRIMARY KEY,
      merchant_name TEXT NOT NULL UNIQUE,
      category_id TEXT,
      average_amount INTEGER NOT NULL,
      amount_variance REAL NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      next_expected TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

// Insert `count` transactions for `merchant`, `gapDays` apart, ending `endDaysAgo` before today.
function seedSeries(
  db: Database.Database,
  merchant: string,
  amountCents: number,
  gapDays: number,
  count: number,
  endDaysAgo = 0
): void {
  const ins = db.prepare(
    'INSERT INTO transactions (id, date, amount, merchant_name, original_name, pending) VALUES (?,?,?,?,?,0)'
  );
  for (let i = 0; i < count; i++) {
    const daysAgo = endDaysAgo + gapDays * (count - 1 - i);
    ins.run(`${merchant}_${i}`, format(subDays(new Date(), daysAgo), 'yyyy-MM-dd'), amountCents, merchant, merchant.toUpperCase());
  }
}

test('detects a monthly pattern and links its transactions', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    seedSeries(db, 'Netflix', -1599, 30, 4);
    detectRecurring();

    const rows = db.prepare('SELECT * FROM recurring_patterns').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const p = rows[0];
    assert.equal(p.merchant_name, 'netflix'); // normalizeMerchant lowercases
    assert.equal(p.frequency, 'monthly');
    assert.equal(p.average_amount, 1599); // median of abs amounts, stays cents
    assert.equal(p.transaction_count, 4);
    assert.equal(p.is_active, 1);
    assert.equal(p.is_confirmed, 0);

    const linked = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE recurring_id = ?').get(p.id) as { n: number };
    assert.equal(linked.n, 4);
  } finally {
    db.close();
  }
});

test('detects a biweekly pattern (~14-day gaps)', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    seedSeries(db, 'Gym', -4000, 14, 4);
    detectRecurring();
    const p = db.prepare("SELECT frequency FROM recurring_patterns WHERE merchant_name = 'gym'").get() as { frequency: string } | undefined;
    assert.equal(p?.frequency, 'biweekly');
  } finally {
    db.close();
  }
});

test('a weekly pattern with one forgotten occurrence still detects as weekly', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    // Occurrences at 28, 21, 14, 0 days ago: the day-7 entry is missing, leaving a single
    // 14-day gap among 7-day gaps. Without skip-tolerance the gap variance rejects this.
    const ins = db.prepare(
      'INSERT INTO transactions (id, date, amount, merchant_name, original_name, pending) VALUES (?,?,?,?,?,0)'
    );
    [28, 21, 14, 0].forEach((d, i) =>
      ins.run(`coffee_${i}`, format(subDays(new Date(), d), 'yyyy-MM-dd'), -650, 'Blue Bottle', 'BLUE BOTTLE')
    );
    detectRecurring();
    const p = db.prepare("SELECT frequency, transaction_count FROM recurring_patterns WHERE merchant_name = 'blue bottle'").get() as { frequency: string; transaction_count: number } | undefined;
    assert.equal(p?.frequency, 'weekly');
    assert.equal(p?.transaction_count, 4);
  } finally {
    db.close();
  }
});

test('requires at least 3 transactions', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    seedSeries(db, 'Rare', -2000, 30, 2);
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('rejects irregular gaps (high gap variance)', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    // Same merchant, deliberately erratic spacing: gaps 4, 45, 10 days.
    const ins = db.prepare(
      'INSERT INTO transactions (id, date, amount, merchant_name, original_name, pending) VALUES (?,?,?,?,?,0)'
    );
    const daysAgo = [59, 55, 10, 0];
    daysAgo.forEach((d, i) =>
      ins.run(`erratic_${i}`, format(subDays(new Date(), d), 'yyyy-MM-dd'), -2500, 'Erratic', 'ERRATIC')
    );
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

// This pair replaces an earlier test that rejected ANY pattern with amount CV >= 0.25. That gate
// threw away the most valuable recurring items on real data: a weekly paycheck tracking hours
// (gap CV 0.11, amount CV 0.43), a monthly interest credit, a utility bill. A varying amount is now
// disqualifying only when the cadence is also loose.
test('admits a varying amount when the cadence is rigid, and records the variance', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    const ins = db.prepare(
      'INSERT INTO transactions (id, date, amount, merchant_name, original_name, pending) VALUES (?,?,?,?,?,0)'
    );
    // Exactly-monthly cadence (gap CV 0), amounts all over the place — the paycheck shape.
    const amts = [-1000, -9000, -2000, -8000];
    amts.forEach((a, i) =>
      ins.run(`varamt_${i}`, format(subDays(new Date(), 30 * (amts.length - 1 - i)), 'yyyy-MM-dd'), a, 'VarAmt', 'VARAMT')
    );
    detectRecurring();

    const row = db.prepare(
      'SELECT frequency, amount_variance FROM recurring_patterns WHERE merchant_name = ?'
    ).get('varamt') as { frequency: string; amount_variance: number } | undefined;
    assert.equal(row?.frequency, 'monthly');
    // Recorded, not discarded: the forecast renders this as "~$X · varies" rather than a firm bill.
    assert.ok((row?.amount_variance ?? 0) >= 0.25);
  } finally {
    db.close();
  }
});

test('still rejects a varying amount when the cadence is only loosely regular', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    const ins = db.prepare(
      'INSERT INTO transactions (id, date, amount, merchant_name, original_name, pending) VALUES (?,?,?,?,?,0)'
    );
    // Gaps 30/22/38/30 -> gap CV ~0.19: regular enough to pass the base gate, too loose to earn the
    // variable-amount exception. Amount CV ~0.71.
    const offsets = [120, 90, 68, 30, 0];
    const amts = [-1000, -9000, -2000, -8000, -1500];
    offsets.forEach((off, i) =>
      ins.run(`loose_${i}`, format(subDays(new Date(), off), 'yyyy-MM-dd'), amts[i], 'Loose', 'LOOSE')
    );
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('detection ignores transfers and confirmed duplicates', () => {
  const db = setupDb();
  _setDbForTesting(db);
  try {
    const ins = db.prepare(
      `INSERT INTO transactions (id, date, amount, merchant_name, original_name, pending, transfer_status, duplicate_status, category_id)
       VALUES (?,?,?,?,?,0,?,?,?)`
    );
    // A card payment: rigid monthly cadence, wild amount. Without the exclusion the relaxed gate
    // would book it as a recurring bill and double-count the spending it settles.
    const amts = [-69300, -146500, -55200, -109600];
    amts.forEach((a, i) =>
      ins.run(`pay_${i}`, format(subDays(new Date(), 30 * (amts.length - 1 - i)), 'yyyy-MM-dd'), a,
        'Payment Thank You', 'PAYMENT THANK YOU', 'confirmed', 'none', null)
    );
    detectRecurring();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});
