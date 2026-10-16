import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { computeSafeToSpend, UNBUDGETED_BASIS_DAYS } from '../server/src/services/safeToSpend';
import { detectRecurring } from '../server/src/services/recurring';
import { refreshTransactionIntegrity } from '../server/src/services/transactionIntegrity';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const day = (daysAgo: number) => format(subDays(new Date(), daysAgo), 'yyyy-MM-dd');

function withDb(run: (db: Database.Database, ids: Record<string, string>) => void): void {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const ids = {
      chase: insertAccount(db, { account_name: 'Chase Checking', type: 'checking', current_balance: 583948 }),
      wealthfront: insertAccount(db, { account_name: 'Wealthfront Cash', type: 'savings', current_balance: 500370 }),
      fidelity: insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage', current_balance: 312883 }),
      sapphire: insertAccount(db, { account_name: 'Chase Sapphire', type: 'credit', is_liability: 1, current_balance: 308443 }),
    };
    run(db, ids);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
}

function seedSchedules(db: Database.Database, ids: Record<string, string>): void {
  for (const weeksAgo of [6, 5, 4, 3, 2, 1]) {
    insertTransaction(db, { account_id: ids.chase, date: day(7 * weeksAgo), amount: 54418, merchant_name: 'Mass Inst Payroll', original_name: 'MASS INST PAYROLL PPD ID: 9111111101', category_id: 'cat_income_paycheck' });
    insertTransaction(db, { account_id: ids.chase, date: day(7 * weeksAgo), amount: -10000, original_name: 'FID BKG SVC LLC MONEYLINE PPD ID: XXXXXX4600', category_id: 'cat_inv_transfer', category_source: 'rule' });
    insertTransaction(db, { account_id: ids.fidelity, date: day(7 * weeksAgo), amount: 10000, original_name: 'Electronic Funds Transfer Received (Cash)' });
    insertTransaction(db, { account_id: ids.chase, date: day(7 * weeksAgo + 1), amount: -25000, original_name: 'Wealthfront EDI PYMNTS WEB ID: XXXXXX7207', category_id: 'cat_xfer_out', category_source: 'rule' });
    insertTransaction(db, { account_id: ids.wealthfront, date: day(7 * weeksAgo + 1), amount: 25000, original_name: 'Chase (Account ****6391)' });
  }
  for (const monthsAgo of [4, 3, 2, 1]) {
    insertTransaction(db, { account_id: ids.chase, date: day(30 * monthsAgo + 3), amount: -150000, original_name: 'CHASE CREDIT CRD AUTOPAY PPD ID: XXXXXX9224' });
    insertTransaction(db, { account_id: ids.sapphire, date: day(30 * monthsAgo + 3), amount: 150000, original_name: 'AUTOMATIC PAYMENT - THANK' });
  }
  refreshTransactionIntegrity(db);
  detectRecurring();
}

test('expected pay comes in, the weekly brokerage transfer goes out, and money between the owner\'s cash accounts does neither', () => {
  withDb((db, ids) => {
    seedSchedules(db, ids);
    const sheet = computeSafeToSpend(db, { forecastDays: 30 });

    const paydays = 4;
    assert.ok(sheet.expectedInflows >= paydays * 54418, `inflows ${sheet.expectedInflows}`);
    assert.equal(sheet.recurringTransfers % 10000, 0, 'only the $100 brokerage transfers, never Wealthfront or the card');
    assert.ok(sheet.recurringTransfers >= 40000);
    assert.equal(
      sheet.free,
      sheet.liquid + sheet.expectedInflows - sheet.cardBalances - sheet.upcomingBills - sheet.recurringTransfers
        - sheet.allocatedBudgets - sheet.estimatedUnbudgeted - sheet.allocatedGoals
    );
  });
});

test('unbudgeted spending is claimed at its trailing pace; budgeted, recurring and refunded spend is not', () => {
  withDb((db, ids) => {
    insertTransaction(db, { account_id: ids.sapphire, date: day(10), amount: -9000, merchant_name: 'Chipotle', category_id: 'cat_food_restaurants' });
    insertTransaction(db, { account_id: ids.sapphire, date: day(40), amount: -9000, merchant_name: 'Cava', category_id: 'cat_food_restaurants' });
    insertTransaction(db, { account_id: ids.sapphire, date: day(20), amount: -50000, merchant_name: 'Market Basket', category_id: 'cat_food_groceries' });
    insertTransaction(db, { account_id: ids.sapphire, date: day(UNBUDGETED_BASIS_DAYS + 5), amount: -90000, merchant_name: 'Old', category_id: 'cat_food_restaurants' });
    const purchase = insertTransaction(db, { account_id: ids.sapphire, date: day(30), amount: -249581, merchant_name: 'Apple Store', category_id: 'cat_shop_electronics' });
    insertTransaction(db, { account_id: ids.sapphire, date: day(27), amount: 249581, merchant_name: 'Apple Store', category_id: 'cat_shop_electronics' });
    for (const monthsAgo of [4, 3, 2, 1]) {
      insertTransaction(db, { account_id: ids.sapphire, date: day(30 * monthsAgo), amount: -699, merchant_name: 'Spotify', category_id: 'cat_ent_streaming' });
    }
    refreshTransactionIntegrity(db);
    detectRecurring();
    const linked = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE merchant_name = 'Spotify' AND recurring_id IS NOT NULL").get() as { n: number };
    assert.equal(linked.n, 4, 'Spotify is a recurring bill the forecast already claims');
    assert.ok(purchase);

    const sheet = computeSafeToSpend(db, {
      forecastDays: 30,
      budgets: [{ category_id: 'cat_food_groceries', amount: 60000, projected_remaining: 10000, rollover_balance: 0 }],
    });
    assert.equal(sheet.estimatedUnbudgeted, Math.round((18000 / UNBUDGETED_BASIS_DAYS) * 30));
    assert.equal(sheet.unbudgetedBasisDays, UNBUDGETED_BASIS_DAYS);
  });
});

test('an empty ledger claims nothing beyond the balances', () => {
  withDb((db) => {
    const sheet = computeSafeToSpend(db);
    assert.deepEqual(
      [sheet.expectedInflows, sheet.recurringTransfers, sheet.estimatedUnbudgeted],
      [0, 0, 0]
    );
  });
});

test('income that its pattern pays into a brokerage is not counted as coming into the cash pool', () => {
  withDb((db, ids) => {
    seedSchedules(db, ids);
    const before = computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows;
    db.prepare(`
      INSERT INTO recurring_patterns
        (id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
         is_active, is_confirmed, transaction_count, created_at, updated_at)
      VALUES ('p_div', 'dividend', 'cat_inv_dividend', 5000, 'monthly', ?, ?, 1, 0, 5, '2026-01-01', '2026-01-01')
    `).run(day(5), format(new Date(Date.now() + 10 * 86_400_000), 'yyyy-MM-dd'));
    for (const monthsAgo of [5, 4, 3, 2, 1]) {
      const id = insertTransaction(db, { account_id: ids.fidelity, date: day(30 * monthsAgo), amount: 5000, merchant_name: 'Dividend', original_name: 'DIVIDEND RECEIVED', category_id: 'cat_inv_dividend' });
      db.prepare("UPDATE transactions SET recurring_id = 'p_div' WHERE id = ?").run(id);
    }
    assert.equal(computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows, before);
  });
});

test('a recurring credit posted to a card still counts, since the card is a claim on the pool', () => {
  withDb((db, ids) => {
    seedSchedules(db, ids);
    const before = computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows;
    db.prepare(`
      INSERT INTO recurring_patterns
        (id, merchant_name, average_amount, frequency, last_seen, next_expected,
         is_active, is_confirmed, transaction_count, created_at, updated_at)
      VALUES ('p_credit', 'digital entertainment credit', 700, 'monthly', ?, ?, 1, 0, 5, '2026-01-01', '2026-01-01')
    `).run(day(5), format(new Date(Date.now() + 10 * 86_400_000), 'yyyy-MM-dd'));
    for (const monthsAgo of [5, 4, 3, 2, 1]) {
      const id = insertTransaction(db, { account_id: ids.sapphire, date: day(30 * monthsAgo), amount: 700, original_name: 'DIGITAL ENTERTAINMENT CREDIT' });
      db.prepare("UPDATE transactions SET recurring_id = 'p_credit' WHERE id = ?").run(id);
    }
    assert.equal(computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows, before + 700);
  });
});

test('a paycheck last paid into an account since closed still counts, and a typed-in dividend does not', () => {
  withDb((db, ids) => {
    seedSchedules(db, ids);
    const before = computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows;
    db.prepare("UPDATE accounts SET type = 'closed' WHERE id = ?").run(ids.chase);
    assert.equal(computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows, before);
    db.prepare("UPDATE accounts SET type = 'checking' WHERE id = ?").run(ids.chase);

    db.prepare(`
      INSERT INTO recurring_patterns
        (id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
         is_active, is_confirmed, transaction_count, created_at, updated_at)
      VALUES ('p_typed', 'Fidelity dividend', 'cat_inv_dividend', 7000, 'monthly', ?, ?, 1, 1, 0, '2026-01-01', '2026-01-01')
    `).run(day(20), format(new Date(Date.now() + 10 * 86_400_000), 'yyyy-MM-dd'));
    assert.equal(computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows, before);
  });
});

test('uncategorized income last paid into a brokerage is left out by the account alone, and a typed-in crypto reward by its category', () => {
  withDb((db, ids) => {
    seedSchedules(db, ids);
    const before = computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows;
    const soon = format(new Date(Date.now() + 10 * 86_400_000), 'yyyy-MM-dd');
    db.prepare(`
      INSERT INTO recurring_patterns
        (id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
         is_active, is_confirmed, transaction_count, created_at, updated_at)
      VALUES ('p_unfiled', 'core interest', 'cat_income_paycheck', 900, 'monthly', ?, ?, 1, 0, 5, '2026-01-01', '2026-01-01'),
             ('p_reward', 'staking reward', 'cat_crypto_reward', 7000, 'monthly', ?, ?, 1, 1, 0, '2026-01-01', '2026-01-01')
    `).run(day(5), soon, day(20), soon);
    for (const monthsAgo of [5, 4, 3, 2, 1]) {
      const id = insertTransaction(db, { account_id: ids.fidelity, date: day(30 * monthsAgo), amount: 900, original_name: 'INTEREST EARNED' });
      db.prepare("UPDATE transactions SET recurring_id = 'p_unfiled' WHERE id = ?").run(id);
    }
    assert.equal(computeSafeToSpend(db, { forecastDays: 30 }).expectedInflows, before);
  });
});
