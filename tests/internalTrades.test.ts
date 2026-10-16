import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { addDays, format, startOfMonth, subMonths } from 'date-fns';
import { isInternalTrade } from '../server/src/services/investmentTrades';
import { applySimplefinResponse } from '../server/src/services/simplefin';
import { getCashflowReport, getSpendingReport } from '../server/src/services/reporting';
import { backfillSnapshots } from '../server/src/services/snapshot';
import { findFlowConservationViolations } from '../server/src/services/flowConservation';
import { _setDbForTesting } from '../server/src/db/index';
import { insertAccount, insertTransaction, migratedTestDb, TEST_NOW } from './helpers/schema';

const TRADES = [
  'YOU BOUGHT PERIODIC INVESTMENT FIDELITY TOTAL MARKET INDEX FUND (FSKAX) (Cash)',
  'PURCHASE INTO CORE ACCOUNT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) MORNING TRADE (Cash)',
  'REDEMPTION FROM CORE ACCOUNT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) MORNING TRADE (Cash)',
  'REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)',
  'YOU SOLD FIDELITY TOTAL MARKET INDEX FUND (FSKAX) (Cash)',
];

const NOT_TRADES = [
  'Electronic Funds Transfer Received (Cash)',
  'DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)',
  'Fidelity contribution',
  'FID BKG SVC LLC MONEYLINE PPD ID: XXXXXX4600',
  'PURCHASE AUTHORIZED ON 09/12 TRADER JOES #512 CAMBRIDGE MA',
];

test('the buy, the sale, the core sweep and the reinvestment are trades; money arriving is not', () => {
  for (const description of TRADES) assert.equal(isInternalTrade(description), true, description);
  for (const description of NOT_TRADES) assert.equal(isInternalTrade(description), false, description);
});

function fidelityWeek(): unknown {
  const row = (id: string, posted: number, amount: string, description: string) => ({
    id, posted, amount, description, payee: 'Fidelity', pending: false,
  });
  return {
    accounts: [{
      id: 'ACT-fidelity', name: 'Individual', currency: 'USD', balance: '3128.83',
      org: { name: 'Fidelity Investments' },
      transactions: [
        row('TRN-eft', 1_791_200_000, '100.00', 'Electronic Funds Transfer Received (Cash)'),
        row('TRN-core-in', 1_791_200_000, '-100.00', TRADES[1]),
        row('TRN-fskax', 1_791_200_000, '-100.00', TRADES[0]),
        row('TRN-core-out', 1_791_286_400, '100.00', TRADES[2]),
      ],
    }],
  };
}

test('a weekly Fidelity cycle imports one arrival and three trades', () => {
  const db = migratedTestDb();
  applySimplefinResponse(db, fidelityWeek(), TEST_NOW);
  const rows = db.prepare(
    'SELECT simplefin_transaction_id AS id, is_internal_trade FROM transactions ORDER BY id'
  ).all();
  assert.deepEqual(rows, [
    { id: 'TRN-core-in', is_internal_trade: 1 },
    { id: 'TRN-core-out', is_internal_trade: 1 },
    { id: 'TRN-eft', is_internal_trade: 0 },
    { id: 'TRN-fskax', is_internal_trade: 1 },
  ]);
});

test('a trade counts toward no spending or cash-flow total, whatever it is categorized as', () => {
  const db = migratedTestDb();
  const brokerage = insertAccount(db, { type: 'brokerage' });
  const checking = insertAccount(db, { type: 'checking' });
  const groceries = insertTransaction(db, { account_id: checking, date: '2026-10-03', amount: -4200, category_id: 'cat_food' });
  const trade = insertTransaction(db, { account_id: brokerage, date: '2026-10-05', amount: -10000, category_id: 'cat_food', original_name: TRADES[0] });
  db.prepare('UPDATE transactions SET is_internal_trade = 1 WHERE id = ?').run(trade);
  assert.ok(groceries);

  const range = { startDate: '2026-10-01', endDate: '2026-10-31' };
  assert.equal(getSpendingReport(db, range).total, 4200);
  const months = getCashflowReport(db, range).months;
  assert.equal(months.reduce((sum, month) => sum + month.expenses, 0), 4200);
});

function midMonth(monthsBack: number): string {
  return format(addDays(startOfMonth(subMonths(new Date(), monthsBack)), 14), 'yyyy-MM-dd');
}

test('an estimated brokerage month holds trades flat and reverses only the money that arrived', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    insertAccount(db, { id: 'fid', type: 'brokerage', current_balance: 312883 });
    insertTransaction(db, { account_id: 'fid', date: midMonth(4), amount: 0 });
    insertTransaction(db, { account_id: 'fid', date: midMonth(1), amount: 10000, category_id: 'cat_xfer_in' });
    db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE amount = 10000").run();
    for (const description of TRADES.slice(0, 3)) {
      const id = insertTransaction(db, {
        account_id: 'fid', date: midMonth(1), amount: description.startsWith('REDEMPTION') ? 10000 : -10000,
        category_id: 'cat_inv_transfer', original_name: description,
      });
      db.prepare('UPDATE transactions SET is_internal_trade = 1 WHERE id = ?').run(id);
    }

    backfillSnapshots();

    const start = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
    const snap = db.prepare('SELECT breakdown FROM net_worth_snapshots WHERE date = ?').get(start) as
      { breakdown: string };
    assert.equal(JSON.parse(snap.breakdown).fid, 302883, 'only the $100 that arrived is undone');
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
});

test('a trade leaving a brokerage is never half of a missing transfer', () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { type: 'checking' });
  const brokerage = insertAccount(db, { type: 'brokerage' });
  for (const [date, checkingDate] of [['2026-09-28', '2026-09-28'], ['2026-10-05', '2026-10-05']]) {
    insertTransaction(db, { account_id: checking, date: checkingDate, amount: -10000, category_id: 'cat_inv_transfer' });
    const trade = insertTransaction(db, { account_id: brokerage, date, amount: -10000, category_id: 'cat_inv_transfer', original_name: TRADES[0] });
    db.prepare('UPDATE transactions SET is_internal_trade = 1 WHERE id = ?').run(trade);
  }
  assert.deepEqual(findFlowConservationViolations(db), []);
});

test('an estimated wallet month undoes the buy, not also the paired deposit that funded it', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    insertAccount(db, { id: 'cb', type: 'crypto_wallet', current_balance: 50000 });
    insertTransaction(db, { account_id: 'cb', date: midMonth(4), amount: 0 });
    const deposit = insertTransaction(db, { account_id: 'cb', date: midMonth(1), amount: 10000, category_id: 'cat_xfer_in' });
    db.prepare("UPDATE transactions SET transfer_status = 'confirmed', transfer_pair_id = 'x' WHERE id = ?").run(deposit);
    insertTransaction(db, { account_id: 'cb', date: midMonth(1), amount: -10000, category_id: 'cat_crypto_buy' });

    backfillSnapshots();

    const start = format(startOfMonth(subMonths(new Date(), 1)), 'yyyy-MM-dd');
    const snap = db.prepare('SELECT breakdown FROM net_worth_snapshots WHERE date = ?').get(start) as { breakdown: string };
    assert.equal(JSON.parse(snap.breakdown).cb, 40000);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
});
