import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import { addDays, format, startOfMonth, subMonths } from 'date-fns';
import { migratedTestDb, insertAccount, insertTransaction, TEST_NOW } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import reportsRouter from '../server/src/routes/reports';
import { backfillSnapshots, takeSnapshot } from '../server/src/services/snapshot';
import { remapAccountIdInSnapshots } from '../server/src/services/accounts';

/**
 * Which accounts a point on the Investments chart is a sum over is a fact about the day the point
 * was written, and it was being decided at read time from whatever the accounts table said now.
 *
 * `/api/reports/investments` resolved "the portfolio" from today's accounts and applied that one set
 * to every breakdown ever written. Nothing detected it, because no stored number moved: the row was
 * intact and its meaning was not. Measured on /tmp/phase2.db, a `.backup` copy of `.mizan/mizan.db`
 * taken 2026-08-01 at migration 055, against the 2026-07-30 snapshot, whose portfolio read $2,445.89:
 *
 *   retype Wealthfront Cash (savings, $1,001.70) to `brokerage`   ->  the same point reads $3,447.59
 *   hide Coinbase (routes/coinbase.ts disconnect, is_hidden = 1)  ->  the same point reads $2,045.04
 *
 * Retyping a BROKERAGE, which is how this was first described, in fact moves nothing on that ledger:
 * the portfolio predicate re-admits any account holding a position, and all three of its portfolio
 * accounts hold one. What moves history is an edit that changes the SET.
 *
 * Migration 056 records the set on the row. These tests are about three things and one of them is
 * silence: that an account edit no longer reaches backwards, that a set worked out afterwards is
 * never presented as one that was recorded, and that on a ledger nobody edited the whole change is
 * invisible to the cent.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, '../server/src/db/migrations');

const BROKER = 200000;
const CASH = 100000;

function setupDb(): Database.Database {
  const db = migratedTestDb();
  _setDbForTesting(db);

  insertAccount(db, { id: 'acc_broker', account_name: 'Fidelity Individual', type: 'brokerage', current_balance: BROKER });
  insertAccount(db, { id: 'acc_cash', account_name: 'Wealthfront Cash', type: 'savings', current_balance: CASH });

  db.prepare("INSERT INTO securities (id, ticker, name, type) VALUES ('sec_etf','VTI','Total Market ETF','etf')").run();
  db.prepare(`INSERT INTO holdings
    (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis, updated_at)
    VALUES ('h1','acc_broker','sec_etf',7,285.71,?,180000,?)`).run(BROKER, TEST_NOW);

  return db;
}

function closeDb(db: Database.Database): void {
  _setDbForTesting(undefined as unknown as Database.Database);
  db.close();
}

interface HistoryPoint {
  date: string;
  value: number;
  estimated: boolean;
  covered_accounts: number;
  membership: 'recorded' | 'reconstructed';
}

interface InvestmentsReport {
  portfolio_value: number;
  portfolio_account_ids: string[];
  history: HistoryPoint[];
}

async function getReport(db: Database.Database): Promise<InvestmentsReport> {
  _setDbForTesting(db);
  const app = express();
  app.use('/api/reports', reportsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/reports/investments`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: InvestmentsReport }).data;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function storedPortfolio(db: Database.Database, date: string): { accounts: string[] | null; source: string | null } {
  const row = db.prepare(
    'SELECT portfolio_accounts, portfolio_accounts_source FROM net_worth_snapshots WHERE date = ?'
  ).get(date) as { portfolio_accounts: string | null; portfolio_accounts_source: string | null } | undefined;
  if (!row) throw new Error(`no snapshot at ${date}`);
  return {
    accounts: row.portfolio_accounts === null ? null : (JSON.parse(row.portfolio_accounts) as string[]),
    source: row.portfolio_accounts_source,
  };
}

const today = (): string => format(new Date(), 'yyyy-MM-dd');

/* ── The defect ────────────────────────────────────────────────────────────── */

test('retyping an account into the portfolio does not move a snapshot taken before it', async () => {
  const db = setupDb();
  try {
    takeSnapshot();
    assert.deepEqual(storedPortfolio(db, today()), { accounts: ['acc_broker'], source: 'recorded' });

    // The edit. Wealthfront Cash is a savings account holding no position, so this genuinely
    // changes the set rather than being absorbed by the holdings arm of the predicate.
    db.prepare("UPDATE accounts SET type = 'brokerage' WHERE id = 'acc_cash'").run();

    const report = await getReport(db);
    const point = report.history.at(-1)!;

    // The headline is about today and moves, which is correct: the portfolio really is two accounts
    // now. The point behind it is about a day when it was one account, and does not.
    assert.equal(report.portfolio_value, 3000);
    assert.deepEqual(report.portfolio_account_ids, ['acc_broker', 'acc_cash']);
    assert.equal(point.value, 2000);
    assert.equal(point.covered_accounts, 1);
    assert.equal(point.membership, 'recorded');

    // What it read before the set was frozen: today's two accounts summed over yesterday's
    // breakdown. Same row, same stored cents, different portfolio.
    assert.notEqual(point.value, 3000);
  } finally {
    closeDb(db);
  }
});

test('hiding an account does not empty the history behind it', async () => {
  const db = setupDb();
  try {
    takeSnapshot();

    // DELETE /api/coinbase/disconnect and archiveAccount both do exactly this and leave the
    // balance alone.
    db.prepare("UPDATE accounts SET is_hidden = 1 WHERE id = 'acc_broker'").run();

    const report = await getReport(db);
    const point = report.history.at(-1)!;

    // Today's portfolio is empty, and the headline says so. The point still records the $2,000 the
    // account held: before this, the intersection came out empty and the point plotted as $0.00,
    // drawing a portfolio that had never existed.
    assert.deepEqual(report.portfolio_account_ids, []);
    assert.equal(report.portfolio_value, 0);
    assert.equal(point.value, 2000);
    assert.equal(point.covered_accounts, 1);
  } finally {
    closeDb(db);
  }
});

test('deleting an account does not delete it from the days it existed', async () => {
  const db = setupDb();
  try {
    takeSnapshot();
    db.prepare("DELETE FROM holdings WHERE account_id = 'acc_broker'").run();
    db.prepare("DELETE FROM accounts WHERE id = 'acc_broker'").run();

    const report = await getReport(db);

    assert.deepEqual(report.portfolio_account_ids, []);
    assert.equal(report.history.at(-1)!.value, 2000);
  } finally {
    closeDb(db);
  }
});

/* ── Reconstructed is never presented as recorded ──────────────────────────── */

/**
 * Every migration in filename order up to but excluding 056, which is the database this phase
 * inherits.
 *
 * Deliberately NOT `migratedTestDb()`: that helper has already applied 056, and the thing under
 * test here is what 056 does to rows that were written before it existed. `accountTypeClosed`,
 * `coinbaseConsolidation` and `deadPreferences` drive their own migration for the same reason.
 * Foreign keys are left OFF for the run, matching `runMigrationsOn`.
 */
function dbBefore056(): Database.Database {
  const db = new Database(':memory:');
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file.startsWith('056_')) break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
  }
  return db;
}

function apply056(db: Database.Database): void {
  db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, '056_snapshot_portfolio_membership.sql'), 'utf-8'));
}

test('migration 056 marks what it worked out as worked out, not as recorded', async () => {
  const db = dbBefore056();
  try {
    db.prepare(`INSERT INTO accounts
      (id, connection_type, institution_name, account_name, type, current_balance, is_liability,
       is_hidden, is_manual, created_at, updated_at)
      VALUES ('acc_broker','manual','Fidelity','Fidelity Individual','brokerage',?,0,0,1,?,?)`)
      .run(BROKER, TEST_NOW, TEST_NOW);
    db.prepare(`INSERT INTO accounts
      (id, connection_type, institution_name, account_name, type, current_balance, is_liability,
       is_hidden, is_manual, created_at, updated_at)
      VALUES ('acc_cash','manual','Wealthfront','Wealthfront Cash','savings',?,0,0,1,?,?)`)
      .run(CASH, TEST_NOW, TEST_NOW);

    const insert = db.prepare(`INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
      VALUES (?,?,?,0,?,?,?,?)`);
    insert.run('s1', '2026-07-30', BROKER + CASH, BROKER + CASH,
      JSON.stringify({ acc_broker: BROKER, acc_cash: CASH }), 0, TEST_NOW);
    // A row nothing can read. Inventing a membership for it would be inventing the only part of it
    // that was ever legible.
    insert.run('s2', '2026-07-29', 1, 1, '{not json', 0, TEST_NOW);

    apply056(db);

    assert.deepEqual(storedPortfolio(db, '2026-07-30'), {
      accounts: ['acc_broker'],
      source: 'reconstructed',
    });
    assert.deepEqual(storedPortfolio(db, '2026-07-29'), { accounts: null, source: null });

    // And the endpoint carries the distinction rather than keeping it in the table. A point taken
    // after 056 sits in the same series saying something different about itself.
    _setDbForTesting(db);
    takeSnapshot();
    const report = await getReport(db);
    const byDate = new Map(report.history.map((point) => [point.date, point]));

    assert.equal(byDate.get('2026-07-30')!.membership, 'reconstructed');
    assert.equal(byDate.get(today())!.membership, 'recorded');
    assert.equal(byDate.has('2026-07-29'), false);
  } finally {
    closeDb(db);
  }
});

test('a snapshot carrying no set at all falls back to today and says it reconstructed it', async () => {
  const db = setupDb();
  try {
    // The shape a future writer that forgets the column would leave, and the shape every test
    // fixture in this repo that inserts a snapshot by hand already leaves.
    db.prepare(`INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
      VALUES ('s_old','2026-07-30',?,0,?,?,0,?)`)
      .run(BROKER + CASH, BROKER + CASH, JSON.stringify({ acc_broker: BROKER, acc_cash: CASH }), TEST_NOW);

    const report = await getReport(db);
    const point = report.history.find((p) => p.date === '2026-07-30')!;

    assert.equal(point.value, 2000);
    assert.equal(point.membership, 'reconstructed');
  } finally {
    closeDb(db);
  }
});

test('neither writer leaves a row for the fallback to pick up', () => {
  const db = setupDb();
  try {
    insertTransaction(db, { account_id: 'acc_broker', date: midMonth(4), amount: 0 });
    insertTransaction(db, { account_id: 'acc_broker', date: midMonth(1), amount: -5000, category_id: 'cat_inv_transfer' });

    takeSnapshot();
    backfillSnapshots();

    const rows = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN portfolio_accounts IS NULL THEN 1 ELSE 0 END) AS unset,
             SUM(CASE WHEN portfolio_accounts_source != 'recorded' THEN 1 ELSE 0 END) AS not_recorded
      FROM net_worth_snapshots
    `).get() as { total: number; unset: number; not_recorded: number };

    assert.ok(rows.total >= 2, `expected a measured row and a reconstructed one, got ${rows.total}`);
    assert.equal(rows.unset, 0);
    assert.equal(rows.not_recorded, 0);
  } finally {
    closeDb(db);
  }
});

function midMonth(monthsBack: number): string {
  return format(addDays(startOfMonth(subMonths(new Date(), monthsBack)), 14), 'yyyy-MM-dd');
}

test('a reconstructed month records only the accounts that month could account for', () => {
  const db = setupDb();
  try {
    // A second brokerage whose own ledger starts one month ago, so months before that cannot
    // include it and its id must not appear in their frozen sets.
    insertAccount(db, { id: 'acc_late', account_name: 'New Brokerage', type: 'brokerage', current_balance: 50000 });
    insertTransaction(db, { account_id: 'acc_broker', date: midMonth(5), amount: 0 });
    insertTransaction(db, { account_id: 'acc_broker', date: midMonth(3), amount: -5000, category_id: 'cat_inv_transfer' });
    insertTransaction(db, { account_id: 'acc_late', date: midMonth(1), amount: -5000, category_id: 'cat_inv_transfer' });

    backfillSnapshots();

    const rows = db.prepare(
      "SELECT date, portfolio_accounts FROM net_worth_snapshots WHERE is_estimated = 1 ORDER BY date"
    ).all() as Array<{ date: string; portfolio_accounts: string }>;
    assert.ok(rows.length > 0, 'the fixture produced no reconstructed month');

    const lateFloor = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
    for (const row of rows) {
      const ids = JSON.parse(row.portfolio_accounts) as string[];
      assert.equal(ids.includes('acc_broker'), true, `${row.date} dropped the account it is about`);
      assert.equal(
        ids.includes('acc_late'),
        row.date >= lateFloor,
        `${row.date} disagrees with acc_late's own floor of ${lateFloor}`
      );
    }
  } finally {
    closeDb(db);
  }
});

/* ── The healthy case ──────────────────────────────────────────────────────── */

test('on a ledger nobody edited, the frozen set and the old read-time one agree to the cent', async () => {
  const db = setupDb();
  try {
    // Three days of an ordinary series: balances move, the account set does not.
    const dates = ['2026-07-28', '2026-07-29', '2026-07-30'];
    const balances = [190000, 195000, BROKER];
    const insert = db.prepare(`INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
       covered_accounts, total_accounts, created_at, portfolio_accounts, portfolio_accounts_source)
      VALUES (?,?,?,0,?,?,0,2,2,?,?,'recorded')`);
    dates.forEach((date, i) => {
      insert.run(`s${i}`, date, balances[i] + CASH, balances[i] + CASH,
        JSON.stringify({ acc_broker: balances[i], acc_cash: CASH }), TEST_NOW,
        JSON.stringify(['acc_broker']));
    });

    const frozen = await getReport(db);

    // The same rows with the columns stripped: this is exactly the pre-056 read path, which
    // resolves the set from today's accounts on every request.
    db.prepare('UPDATE net_worth_snapshots SET portfolio_accounts = NULL, portfolio_accounts_source = NULL').run();
    const readTime = await getReport(db);

    assert.deepEqual(
      frozen.history.map((p) => [p.date, p.value, p.covered_accounts, p.estimated]),
      readTime.history.map((p) => [p.date, p.value, p.covered_accounts, p.estimated])
    );
    assert.deepEqual(frozen.history.map((p) => p.value), [1900, 1950, 2000]);
    assert.equal(frozen.portfolio_value, 2000);

    // Nothing in the series is calling itself a reconstruction, so the screen has nothing to say
    // about how the set was arrived at.
    assert.equal(frozen.history.every((p) => p.membership === 'recorded'), true);
  } finally {
    closeDb(db);
  }
});

test('a sync writing today and reconstructing the past leaves one silent, ordinary series', async () => {
  const db = setupDb();
  try {
    insertTransaction(db, { account_id: 'acc_broker', date: midMonth(4), amount: 0 });
    insertTransaction(db, { account_id: 'acc_broker', date: midMonth(2), amount: -5000, category_id: 'cat_inv_transfer' });

    takeSnapshot();
    backfillSnapshots();
    const report = await getReport(db);

    // Every point covers the whole of today's portfolio, so nothing on the chart is a comparison
    // between two different quantities and nothing about provenance needs saying.
    for (const point of report.history) {
      assert.equal(point.covered_accounts, report.portfolio_account_ids.length);
      assert.equal(point.membership, 'recorded');
    }
    assert.equal(report.history.at(-1)!.value, 2000);
    assert.equal(report.history.at(-1)!.estimated, false);
  } finally {
    closeDb(db);
  }
});

/* ── The one edit that must reach backwards ────────────────────────────────── */

test('merging two accounts carries the frozen set with the breakdown it renames', async () => {
  const db = setupDb();
  try {
    insertAccount(db, { id: 'acc_dupe', account_name: 'Fidelity Individual (duplicate)', type: 'brokerage', current_balance: 0 });
    db.prepare(`INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
       covered_accounts, total_accounts, created_at, portfolio_accounts, portfolio_accounts_source)
      VALUES ('s_merge','2026-07-30',?,0,?,?,0,3,3,?,?,'recorded')`)
      .run(BROKER + CASH, BROKER + CASH,
        JSON.stringify({ acc_broker: 50000, acc_dupe: 150000, acc_cash: CASH }), TEST_NOW,
        JSON.stringify(['acc_broker', 'acc_dupe']));

    const before = (await getReport(db)).history.find((p) => p.date === '2026-07-30')!;
    assert.equal(before.value, 2000);

    remapAccountIdInSnapshots(db, 'acc_dupe', 'acc_broker');
    db.prepare("DELETE FROM accounts WHERE id = 'acc_dupe'").run();

    const after = (await getReport(db)).history.find((p) => p.date === '2026-07-30')!;

    // The two rows are one account now, so the month's portfolio value is unchanged and the count
    // drops by one. Leaving the dead id in the set would have taken $1,500.00 out of the point.
    assert.equal(after.value, 2000);
    assert.equal(after.covered_accounts, 1);
    assert.deepEqual(storedPortfolio(db, '2026-07-30').accounts, ['acc_broker']);
  } finally {
    closeDb(db);
  }
});
