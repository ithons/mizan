import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { applySimplefinResponse } from '../server/src/services/simplefin';
import {
  getTransactionById,
  listTransactions,
  releaseAmountToProvider,
  updateTransaction,
} from '../server/src/services/transactions';
import { epochSecondsToLocalDate } from '../server/src/services/dates';
import { getIncomeReport, getSpendingReport } from '../server/src/services/reporting';
import { getLedgerBalanceHistory } from '../server/src/services/balanceHistory';
import { _setDbForTesting } from '../server/src/db/index';
import transactionsRouter from '../server/src/routes/transactions';
import { migratedTestDb, insertAccount, insertCategory, TEST_NOW } from './helpers/schema';
import { recordFieldRevision } from '../server/src/services/categoryWrites';

/**
 * The mis-signed brokerage transfers, and the mechanism that makes correcting them stick.
 *
 * Fidelity reports "Electronic Funds Transfer Received" with the sign inverted: money arriving is
 * stored as money leaving. Re-derived on a `.backup` copy of `.mizan/mizan.db` taken 2026-08-01,
 * latest applied migration `055_simplefin_relink_proposals.sql`:
 *
 *   SELECT COUNT(*), SUM(t.amount), SUM(t.amount < 0)
 *     FROM transactions t JOIN accounts a ON a.id = t.account_id
 *    WHERE a.institution_name LIKE '%Fidelity%'
 *      AND (t.original_name LIKE '%Electronic Funds Transfer%'
 *           OR t.merchant_name LIKE '%Electronic Funds%');
 *   -> 14 | -110000 | 14
 *
 * So fourteen rows, every one of them negative, $1,100.00 of ledger error. And none of them is
 * corrected, because nothing could hold a correction:
 *
 *   SELECT COALESCE(amount_source, 'NULL'), COUNT(*) FROM transactions GROUP BY 1;
 *   -> NULL 2588, provider 12
 *   SELECT COUNT(*) FROM transaction_field_revisions;  -> 0
 *
 * The fixture below is the same shape at 1/10 the size, driven through the real sync path.
 */

const PROVIDER_ACCOUNT_ID = 'ACT-fidelity-individual';
const PROVIDER_TXN_ID = 'FID-EFT-1';
// A fixed instant, converted with the same function the sync uses, so the fixture and the write
// path agree about the calendar day whatever the machine's timezone is.
const POSTED_EPOCH = 1_782_000_000;
const POSTED_DATE = epochSecondsToLocalDate(POSTED_EPOCH);
const DAY_BEFORE = epochSecondsToLocalDate(POSTED_EPOCH - 86_400);

/** What Fidelity sends: an inbound transfer, reported negative. */
function response(overrides: { amount?: number | string; pending?: boolean } = {}): unknown {
  return {
    accounts: [
      {
        id: PROVIDER_ACCOUNT_ID,
        name: 'Individual',
        currency: 'USD',
        balance: '2445.89',
        org: { name: 'Fidelity' },
        transactions: [
          {
            id: PROVIDER_TXN_ID,
            posted: POSTED_EPOCH,
            amount: overrides.amount ?? '-100.00',
            payee: 'Electronic Funds Transfer Received',
            description: 'Electronic Funds Transfer Received (Cash)',
            pending: overrides.pending ?? false,
          },
        ],
      },
    ],
  };
}

interface Fixture {
  db: Database.Database;
  accountId: string;
  transactionId: string;
}

/** A Fidelity account carrying one synced, mis-signed inbound transfer. */
function synced(): Fixture {
  const db = migratedTestDb();
  const accountId = insertAccount(db, {
    account_name: 'Fidelity Individual',
    institution_name: 'Fidelity',
    connection_type: 'simplefin',
    type: 'brokerage',
    is_manual: 0,
    current_balance: 244589,
  });
  db.prepare('UPDATE accounts SET simplefin_account_id = ? WHERE id = ?').run(PROVIDER_ACCOUNT_ID, accountId);

  const result = applySimplefinResponse(db, response(), TEST_NOW);
  assert.equal(result.status, 'synced');
  assert.equal(result.added, 1);

  const transactionId = (db.prepare('SELECT id FROM transactions').get() as { id: string }).id;
  return { db, accountId, transactionId };
}

interface RevisionRow {
  field: string;
  from_value: string | null;
  to_value: string | null;
  origin: string;
}

function revisions(db: Database.Database): RevisionRow[] {
  return db.prepare(`
    SELECT field, from_value, to_value, origin FROM transaction_field_revisions ORDER BY rowid
  `).all() as RevisionRow[];
}

function storedAmount(db: Database.Database): { amount: number; amount_source: string | null } {
  return db.prepare('SELECT amount, amount_source FROM transactions WHERE simplefin_transaction_id = ?')
    .get(PROVIDER_TXN_ID) as { amount: number; amount_source: string | null };
}

// ─── The mechanism ────────────────────────────────────────────────────────────

test('a corrected amount survives the sync that used to overwrite it', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  assert.equal(storedAmount(db).amount, -10000, 'the provider sends the transfer inverted');

  // The owner flips the sign. $100 arrived; it is not $100 spent.
  assert.equal(updateTransaction(db, transactionId, { amount: 100 }).ok, true);
  assert.deepEqual(storedAmount(db), { amount: 10000, amount_source: 'human' });

  // The next hourly sync re-sends exactly what it sent before. This is the write that reverted
  // every previous repair inside the hour.
  const second = applySimplefinResponse(db, response(), TEST_NOW);
  assert.equal(second.modified, 0, 'a kept amount is not a modification, and the panel must not say it was');

  assert.deepEqual(storedAmount(db), { amount: 10000, amount_source: 'human' });
  assert.deepEqual(
    revisions(db).map((r) => [r.origin, r.from_value, r.to_value]),
    [
      ['owner_edit', '-10000', '10000'],
      ['provider_rejected', '10000', '-10000'],
    ],
    'the provider still disagrees, and that is recorded rather than resolved'
  );
});

test('a standing disagreement is one row, not one row per sync', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  updateTransaction(db, transactionId, { amount: 100 });
  for (let pass = 0; pass < 6; pass++) {
    applySimplefinResponse(db, response(), TEST_NOW);
  }

  assert.equal(
    revisions(db).filter((r) => r.origin === 'provider_rejected').length,
    1,
    'six hours of the same disagreement is one event, not six'
  );
  assert.equal(storedAmount(db).amount, 10000);
});

test('a provider that changes its number files the new disagreement', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  updateTransaction(db, transactionId, { amount: 100 });
  applySimplefinResponse(db, response(), TEST_NOW);
  applySimplefinResponse(db, response({ amount: '-120.00' }), TEST_NOW);
  applySimplefinResponse(db, response({ amount: '-120.00' }), TEST_NOW);

  assert.deepEqual(
    revisions(db).filter((r) => r.origin === 'provider_rejected').map((r) => r.to_value),
    ['-10000', '-12000'],
    'a different offer is a different event; the same offer twice is not'
  );
  assert.equal(storedAmount(db).amount, 10000, 'neither offer displaces the correction');
});

test('the row carries what the provider still says, so both figures are readable', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  assert.equal(getTransactionById(db, transactionId)?.provider_amount, null, 'nothing is in dispute yet');

  updateTransaction(db, transactionId, { amount: 100 });
  assert.equal(
    getTransactionById(db, transactionId)?.provider_amount,
    null,
    'a correction the provider has not yet answered is not a disagreement'
  );

  applySimplefinResponse(db, response(), TEST_NOW);
  assert.equal(getTransactionById(db, transactionId)?.provider_amount, -10000);
  // The list is the ledger's own reader and must not need a second query to say the same thing.
  const listed = listTransactions(db, {
    page: 1, limit: 50, sortBy: 'date', sortDir: 'desc', accountIds: [], categoryIds: [],
  }).rows[0];
  assert.equal(listed.provider_amount, -10000);
  assert.equal(listed.amount, 10000);
});

test('re-correcting to a third figure does not leave the old argument on screen', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  updateTransaction(db, transactionId, { amount: 100 });
  applySimplefinResponse(db, response(), TEST_NOW);
  assert.equal(getTransactionById(db, transactionId)?.provider_amount, -10000);

  // The owner decides it was $105. The recorded rejection was filed against $100 and no longer
  // describes anything the row holds.
  updateTransaction(db, transactionId, { amount: 105 });
  assert.equal(
    getTransactionById(db, transactionId)?.provider_amount,
    null,
    'a rejection filed against a superseded value is not a standing disagreement'
  );

  applySimplefinResponse(db, response(), TEST_NOW);
  assert.equal(getTransactionById(db, transactionId)?.provider_amount, -10000, 'the next sync re-states it');
});

// ─── The exit, which is what lets the pin exist at all ────────────────────────

test('releasing hands the field back and adopts what the provider now offers', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  updateTransaction(db, transactionId, { amount: 100 });
  applySimplefinResponse(db, response({ amount: '-120.00' }), TEST_NOW);

  const released = releaseAmountToProvider(db, transactionId, TEST_NOW);
  assert.equal(released.ok, true);
  assert.equal(released.ok && released.providerAmountAdopted, -12000);
  assert.deepEqual(storedAmount(db), { amount: -12000, amount_source: 'provider' });

  assert.deepEqual(
    revisions(db).filter((r) => r.field === 'amount').map((r) => [r.origin, r.from_value, r.to_value]),
    [
      ['owner_edit', '-10000', '10000'],
      ['provider_rejected', '10000', '-12000'],
      ['provider_revision', '10000', '-12000'],
    ],
    'the owner value survives as evidence of what the release displaced'
  );

  // And the field is genuinely the provider's again: an ordinary revision lands with no dispute.
  applySimplefinResponse(db, response({ amount: '-130.00' }), TEST_NOW);
  assert.deepEqual(storedAmount(db), { amount: -13000, amount_source: 'provider' });
  assert.equal(getTransactionById(db, transactionId)?.provider_amount, null);
});

test('releasing when the provider has offered nothing moves authorship and not money', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  updateTransaction(db, transactionId, { amount: 100 });
  const released = releaseAmountToProvider(db, transactionId, TEST_NOW);

  assert.equal(released.ok && released.providerAmountAdopted, null);
  assert.deepEqual(storedAmount(db), { amount: 10000, amount_source: 'provider' });
  assert.deepEqual(
    revisions(db).filter((r) => r.origin === 'provider_revision'),
    [],
    'no figure moved, so recording a revision would log an event that did not happen'
  );
});

test('release refuses the rows it has nothing to hand back to', (t) => {
  const { db, accountId, transactionId } = synced();
  t.after(() => db.close());

  assert.deepEqual(releaseAmountToProvider(db, 'no-such-row', TEST_NOW), {
    ok: false, reason: 'not_found',
  });
  assert.deepEqual(releaseAmountToProvider(db, transactionId, TEST_NOW), {
    ok: false, reason: 'not_corrected',
  });

  // A manual row has no institution behind it, and a Coinbase row is never re-offered one, so
  // stamping either as provider-authored would record an authorship that never happened.
  const manualId = insertTransaction(db, accountId, -2500);
  updateTransaction(db, manualId, { amount: 25 });
  assert.deepEqual(releaseAmountToProvider(db, manualId, TEST_NOW), {
    ok: false, reason: 'not_provider_backed',
  });
});

function insertTransaction(
  db: Database.Database,
  accountId: string,
  amount: number,
  date = POSTED_DATE
): string {
  const id = `manual_${accountId}_${amount}`;
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, original_name, is_manual, source_type,
                              review_status, pending, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Hand entry', 1, 'manual', 'open', 0, ?, ?)
  `).run(id, accountId, date, amount, TEST_NOW, TEST_NOW);
  return id;
}

// ─── Every reader that sums money ─────────────────────────────────────────────

test('the correction lands on the reports, not just on the ledger', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  const income = insertCategory(db, { name: 'Transfers In', is_income: 1 });
  updateTransaction(db, transactionId, { category_id: income });

  const range = { startDate: POSTED_DATE, endDate: POSTED_DATE };
  assert.equal(getIncomeReport(db, range).total, -10000, 'the inverted sign reads as negative income');
  // The same row also shows up as spending, because a negative amount is what spending is.
  assert.equal(getSpendingReport(db, range).total, 0, 'an income category is not spending either way');

  updateTransaction(db, transactionId, { amount: 100 });
  applySimplefinResponse(db, response(), TEST_NOW);

  assert.equal(getIncomeReport(db, range).total, 10000, 'the report reads the corrected column');
  assert.equal(getSpendingReport(db, range).total, 0);
});

test('the correction lands on the drawn balance line too', (t) => {
  const { db, accountId, transactionId } = synced();
  t.after(() => db.close());

  // The drawn window cannot start before the account's first row, so there has to be one there.
  // This is `getLedgerBalanceHistory`, the basis for an account whose balance IS its ledger; the
  // point being made is about the column every basis reads, not about which basis a brokerage gets.
  insertTransaction(db, accountId, -1, DAY_BEFORE);

  const window = { today: POSTED_DATE, from: DAY_BEFORE };
  const before = getLedgerBalanceHistory(db, accountId, window);
  updateTransaction(db, transactionId, { amount: 100 });
  const after = getLedgerBalanceHistory(db, accountId, window);

  // The series walks back from `current_balance` through each day's net movement, so today is
  // unmoved and the day before the transfer moves by twice it. Cents, as the column holds them.
  assert.deepEqual(before.points.map((p) => p.balance), [254589, 244589]);
  assert.deepEqual(after.points.map((p) => p.balance), [234589, 244589]);
  assert.equal(after.drawn_transaction_count, 2);
});

test('correcting a hand-entered row moves the account balance, which is the net-worth path', (t) => {
  const { db } = synced();
  t.after(() => db.close());

  // Net worth is summed from `accounts.current_balance`, never from `transactions`, so a provider
  // row's amount does not reach it: the institution reports the balance separately and
  // `liabilitySign.ts` is the only thing allowed to argue with a reported number. A MANUAL account
  // is the case where the ledger IS the balance, and there the correction has to carry through.
  const manualAccount = insertAccount(db, { is_manual: 1, current_balance: 50000 });
  const manualId = insertTransaction(db, manualAccount, -10000);
  db.prepare('UPDATE accounts SET current_balance = 40000 WHERE id = ?').run(manualAccount);

  updateTransaction(db, manualId, { amount: 100 });

  const balance = db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(manualAccount) as
    { current_balance: number };
  assert.equal(balance.current_balance, 60000, 'a $100 row flipping sign moves the balance by $200');
});

test('no money reader has to know the revision log exists', () => {
  // The corrected figure IS `transactions.amount`; the log holds only what was displaced or
  // refused. That is what makes "every reader that sums money uses the corrected value" a property
  // of the schema rather than a list of call sites somebody has to keep walking. If a future
  // change parks the correction in a second column and leaves the readers on the first, a summing
  // service will have to start joining this table, and this fails.
  const dir = path.join(import.meta.dirname, '..', 'server', 'src', 'services');
  const allowed = new Set(['categoryWrites.ts', 'transactions.ts', 'simplefin.ts', 'localBackup.ts']);
  const offenders = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !allowed.has(file))
    .filter((file) => fs.readFileSync(path.join(dir, file), 'utf8').includes('transaction_field_revisions'));

  assert.deepEqual(offenders, []);
});

// ─── The healthy cases. Silence is the requirement, not detection. ────────────

test('a row nobody corrected syncs exactly as it did before, and records nothing', (t) => {
  const { db } = synced();
  t.after(() => db.close());

  assert.deepEqual(storedAmount(db), { amount: -10000, amount_source: 'provider' });

  const second = applySimplefinResponse(db, response(), TEST_NOW);
  assert.equal(second.added, 0);
  assert.equal(second.modified, 0);

  // The institution revises its own posted row, which is an ordinary event and nobody's dispute.
  const third = applySimplefinResponse(db, response({ amount: '-105.00' }), TEST_NOW);
  assert.equal(third.modified, 1);
  assert.deepEqual(storedAmount(db), { amount: -10500, amount_source: 'provider' });

  assert.deepEqual(revisions(db), [], 'the owner was never involved, so nobody disagreed');
  assert.equal(getTransactionById(db, (db.prepare('SELECT id FROM transactions').get() as { id: string }).id)
    ?.provider_amount, null);
});

test('editing only the category of a mis-signed row does not claim its amount', (t) => {
  const { db, transactionId } = synced();
  t.after(() => db.close());

  updateTransaction(db, transactionId, { category_id: insertCategory(db, { name: 'Transfers' }) });
  applySimplefinResponse(db, response({ amount: '-105.00' }), TEST_NOW);

  assert.deepEqual(
    storedAmount(db),
    { amount: -10500, amount_source: 'provider' },
    'a category is not a claim over the money, and pinning on one would freeze the ledger by accident'
  );
  assert.deepEqual(revisions(db), []);
});

test('a pending row settling is still the provider settling its own row', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db, {
    institution_name: 'Fidelity', connection_type: 'simplefin', is_manual: 0,
  });
  db.prepare('UPDATE accounts SET simplefin_account_id = ? WHERE id = ?').run(PROVIDER_ACCOUNT_ID, accountId);

  applySimplefinResponse(db, response({ amount: '-95.00', pending: true }), TEST_NOW);
  applySimplefinResponse(db, response({ amount: '-100.00' }), TEST_NOW);

  assert.deepEqual(storedAmount(db), { amount: -10000, amount_source: 'provider' });
  assert.deepEqual(revisions(db), []);
});

test('an amount authored before provenance existed is not read as a claim', (t) => {
  const { db } = synced();
  t.after(() => db.close());

  // Every row written before migration 048 is in this state: 2,588 of 2,600 on the live database
  // at migration 055 (SELECT COALESCE(amount_source,'NULL'), COUNT(*) FROM transactions GROUP BY 1,
  // re-derived 2026-08-01 on a copy). NULL means the author was never recorded, never that the
  // owner claimed it, so reading it as a pin would freeze most of the ledger against its provider.
  db.prepare('UPDATE transactions SET amount_source = NULL').run();
  applySimplefinResponse(db, response({ amount: '-105.00' }), TEST_NOW);

  assert.deepEqual(storedAmount(db), { amount: -10500, amount_source: 'provider' });
  assert.deepEqual(revisions(db), []);
});

// ─── The money boundary, over the real router ────────────────────────────────

async function withServer(db: Database.Database, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

test('both figures cross the API boundary in dollars', async () => {
  const { db, transactionId } = synced();
  await withServer(db, async (baseUrl) => {
    const patched = await fetch(`${baseUrl}/api/transactions/${transactionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(patched.status, 200);

    applySimplefinResponse(db, response(), TEST_NOW);

    const res = await fetch(`${baseUrl}/api/transactions/${transactionId}`);
    const body = (await res.json()) as { data: Record<string, unknown> };
    // 10000 cents -> 100, and -10000 -> -100. A screen that showed one in dollars and the other in
    // cents would be off by a hundred on exactly the comparison the field exists to make.
    assert.equal(body.data.amount, 100);
    assert.equal(body.data.provider_amount, -100);
    assert.equal(body.data.amount_source, 'human');

    const released = await fetch(`${baseUrl}/api/transactions/${transactionId}/amount/release`, {
      method: 'POST',
    });
    assert.equal(released.status, 200);
    const after = (await released.json()) as { data: Record<string, unknown> };
    assert.equal(after.data.amount, -100);
    assert.equal(after.data.provider_amount, null);

    // And it refuses twice rather than silently succeeding on a row it no longer owns.
    const again = await fetch(`${baseUrl}/api/transactions/${transactionId}/amount/release`, {
      method: 'POST',
    });
    assert.equal(again.status, 409);
  });
});

/**
 * A feed that changes its mind and changes back.
 *
 * `provider_rejected` rows are deduped so a standing disagreement is one row rather than one per
 * hourly sync. That dedupe used to be a bare existence check that never touched `created_at`, while
 * both readers order by `created_at DESC` and mean "what the provider says NOW". So a feed
 * offering A, then B, then A again left B newest: the row read "still reports B", and
 * `releaseAmountToProvider` adopted B, wrote it into `transactions.amount` and stamped it
 * `amount_source = 'provider'`, recording an authorship that never happened.
 */
test('a provider that changes its number and changes back is reported at what it says now', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const txn = insertTransaction(db, account, -10000);

  // The owner corrects the sign, so the row is theirs.
  db.prepare("UPDATE transactions SET amount = 10000, amount_source = 'human' WHERE id = ?").run(txn);

  const offer = (amount: number, at: string) =>
    recordFieldRevision(db, {
      transactionId: txn, field: 'amount', fromValue: '10000', toValue: String(amount),
      fromSource: 'human', toSource: 'provider', origin: 'provider_rejected',
    }, at);

  offer(-10000, '2026-08-01T01:00:00.000Z');
  offer(-10500, '2026-08-01T02:00:00.000Z');
  const refiled = offer(-10000, '2026-08-01T03:00:00.000Z');

  // Still one row per distinct disagreement, so the hourly sync cannot drip.
  const rows = db.prepare(
    "SELECT to_value, created_at FROM transaction_field_revisions WHERE transaction_id = ? AND field = 'amount' ORDER BY created_at DESC"
  ).all(txn) as Array<{ to_value: string; created_at: string }>;
  assert.equal(rows.length, 2, 'a repeat must not file a second row for the same disagreement');
  assert.equal(refiled, false, 'a repeat is not a new filing');

  // And the newest row is the one the provider is ACTUALLY offering, not the one it offered once.
  assert.equal(rows[0].to_value, '-10000', 'the newest disagreement must be the current one');
  assert.equal(rows[0].created_at, '2026-08-01T03:00:00.000Z', 'the repeat must refresh the timestamp');
  db.close();
});

test('HEALTHY: a disagreement that never changes stays one row and keeps its own reading', () => {
  const db = migratedTestDb();
  const account = insertAccount(db, { account_name: 'Fidelity Individual', type: 'brokerage' });
  const txn = insertTransaction(db, account, -10000);
  db.prepare("UPDATE transactions SET amount = 10000, amount_source = 'human' WHERE id = ?").run(txn);

  for (let hour = 1; hour <= 6; hour += 1) {
    recordFieldRevision(db, {
      transactionId: txn, field: 'amount', fromValue: '10000', toValue: '-10000',
      fromSource: 'human', toSource: 'provider', origin: 'provider_rejected',
    }, `2026-08-01T0${hour}:00:00.000Z`);
  }

  const rows = db.prepare(
    "SELECT to_value FROM transaction_field_revisions WHERE transaction_id = ? AND field = 'amount'"
  ).all(txn) as Array<{ to_value: string }>;
  assert.equal(rows.length, 1, 'six syncs over an unchanged disagreement is one row');
  assert.equal(rows[0].to_value, '-10000');
  db.close();
});
