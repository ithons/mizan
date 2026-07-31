import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  upsertSimplefinTransaction,
  type SimplefinTransactionValues,
} from '../server/src/services/simplefin';
import { updateTransaction } from '../server/src/services/transactions';
import { migratedTestDb, insertAccount, insertCategory, TEST_NOW } from './helpers/schema';

const PROVIDER_ID = 'sf_txn_1';

interface RevisionRow {
  field: string;
  from_value: string | null;
  to_value: string | null;
  from_source: string | null;
  to_source: string | null;
  origin: string;
}

interface SourceRow {
  id: string;
  date: string;
  date_source: string | null;
  amount: number;
  amount_source: string | null;
  merchant_name: string | null;
  merchant_name_source: string | null;
}

function providerPayload(
  overrides: Partial<SimplefinTransactionValues> = {}
): SimplefinTransactionValues {
  return {
    providerId: PROVIDER_ID,
    date: '2026-07-10',
    amount: -4550,
    merchantName: 'BLUE BOTTLE 0042',
    originalName: 'BLUE BOTTLE 0042 SAN FRANCISCO CA',
    pending: 0,
    ...overrides,
  };
}

function revisions(db: Database.Database): RevisionRow[] {
  return db.prepare(`
    SELECT field, from_value, to_value, from_source, to_source, origin
    FROM transaction_field_revisions
    ORDER BY rowid
  `).all() as RevisionRow[];
}

function row(db: Database.Database): SourceRow {
  return db.prepare(`
    SELECT id, date, date_source, amount, amount_source, merchant_name, merchant_name_source
    FROM transactions WHERE simplefin_transaction_id = ?
  `).get(PROVIDER_ID) as SourceRow;
}

/** A posted provider row, synced once. */
function posted(db: Database.Database): { accountId: string; transactionId: string } {
  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  assert.equal(upsertSimplefinTransaction(db, accountId, providerPayload(), TEST_NOW), 'added');
  return { accountId, transactionId: row(db).id };
}

test('a provider insert stamps every tracked field as provider-authored', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  posted(db);
  const stored = row(db);
  assert.equal(stored.date_source, 'provider');
  assert.equal(stored.amount_source, 'provider');
  assert.equal(stored.merchant_name_source, 'provider');
  assert.deepEqual(revisions(db), [], 'the provider writing its own row is not a revision');
});

test('an owner edit claims the field and logs what it displaced', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId } = posted(db);
  const result = updateTransaction(db, transactionId, {
    merchant_name: 'Blue Bottle Coffee',
    amount: -50,
    date: '2026-07-11',
  });
  assert.equal(result.ok, true);

  const stored = row(db);
  assert.equal(stored.merchant_name_source, 'human');
  assert.equal(stored.amount_source, 'human');
  assert.equal(stored.date_source, 'human');

  const logged = revisions(db);
  assert.equal(logged.length, 3);
  assert.deepEqual(
    logged.map((r) => [r.field, r.origin, r.from_source, r.to_source]),
    [
      ['date', 'owner_edit', 'provider', 'human'],
      ['amount', 'owner_edit', 'provider', 'human'],
      ['merchant_name', 'owner_edit', 'provider', 'human'],
    ]
  );

  const amount = logged.find((r) => r.field === 'amount');
  // Integer cents on both sides of the log, as the column holds them.
  assert.equal(amount?.from_value, '-4550');
  assert.equal(amount?.to_value, '-5000');
});

test('the provider still wins a revised amount, and the owner value survives as evidence', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId, transactionId } = posted(db);
  updateTransaction(db, transactionId, { amount: -50 });

  // A tip adjustment: the institution restates the row it already posted.
  const write = upsertSimplefinTransaction(db, accountId, providerPayload({ amount: -5325 }), TEST_NOW);
  assert.equal(write, 'modified');

  const stored = row(db);
  assert.equal(stored.amount, -5325, 'the ledger still agrees with the balance it reconciles against');
  assert.equal(stored.amount_source, 'provider');

  const providerRevisions = revisions(db).filter((r) => r.origin === 'provider_revision');
  assert.equal(providerRevisions.length, 1);
  assert.deepEqual(providerRevisions[0], {
    field: 'amount',
    from_value: '-5000',
    to_value: '-5325',
    from_source: 'human',
    to_source: 'provider',
    origin: 'provider_revision',
  });
});

test('a corrected post date is recorded the same way', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId, transactionId } = posted(db);
  updateTransaction(db, transactionId, { date: '2026-07-09' });

  upsertSimplefinTransaction(db, accountId, providerPayload({ date: '2026-07-12' }), TEST_NOW);

  const stored = row(db);
  assert.equal(stored.date, '2026-07-12');
  assert.equal(stored.date_source, 'provider');
  assert.deepEqual(
    revisions(db).filter((r) => r.origin === 'provider_revision').map((r) => [r.from_value, r.to_value]),
    [['2026-07-09', '2026-07-12']]
  );
});

test('a rejected payee is recorded once, not once an hour', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId, transactionId } = posted(db);
  updateTransaction(db, transactionId, { merchant_name: 'Blue Bottle Coffee' });

  // The provider keeps sending its own payee on every pass, which is what an hourly sync does.
  for (let pass = 0; pass < 5; pass++) {
    assert.equal(
      upsertSimplefinTransaction(db, accountId, providerPayload(), TEST_NOW),
      'unchanged',
      'the owner keeps the payee, so nothing on the row moves'
    );
  }

  assert.equal(row(db).merchant_name, 'Blue Bottle Coffee');
  assert.equal(row(db).merchant_name_source, 'human');

  const rejected = revisions(db).filter((r) => r.origin === 'provider_rejected');
  assert.equal(rejected.length, 1, 'a standing disagreement is one row, not five');
  assert.equal(rejected[0].from_value, 'Blue Bottle Coffee');
  assert.equal(rejected[0].to_value, 'BLUE BOTTLE 0042');
});

test('a provider that changes its mind about the payee logs the new disagreement', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId, transactionId } = posted(db);
  updateTransaction(db, transactionId, { merchant_name: 'Blue Bottle Coffee' });

  upsertSimplefinTransaction(db, accountId, providerPayload(), TEST_NOW);
  upsertSimplefinTransaction(db, accountId, providerPayload({ merchantName: 'BLUEBOTTLE.COM' }), TEST_NOW);
  upsertSimplefinTransaction(db, accountId, providerPayload({ merchantName: 'BLUEBOTTLE.COM' }), TEST_NOW);

  assert.deepEqual(
    revisions(db).filter((r) => r.origin === 'provider_rejected').map((r) => r.to_value),
    ['BLUE BOTTLE 0042', 'BLUEBOTTLE.COM']
  );
});

test('an owner-named payee is protected while the row is still pending, and the refusal is logged', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  upsertSimplefinTransaction(db, accountId, providerPayload({ pending: 1 }), TEST_NOW);
  updateTransaction(db, row(db).id, { merchant_name: 'Blue Bottle Coffee' });

  // Naming a payee is a claim over the field even before the row posts, which the pending-state
  // heuristic alone would not honour.
  upsertSimplefinTransaction(db, accountId, providerPayload({ pending: 1 }), TEST_NOW);

  assert.equal(row(db).merchant_name, 'Blue Bottle Coffee');
  assert.deepEqual(
    revisions(db).filter((r) => r.origin === 'provider_rejected').map((r) => r.to_value),
    ['BLUE BOTTLE 0042']
  );
});

test('clearing a payee lets the provider refill it, and the clearing survives as evidence', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId, transactionId } = posted(db);
  updateTransaction(db, transactionId, { merchant_name: null });
  assert.equal(row(db).merchant_name_source, 'human');

  const write = upsertSimplefinTransaction(db, accountId, providerPayload(), TEST_NOW);
  assert.equal(write, 'modified');
  // And the record does not drip: the refill leaves the field provider-authored.
  for (let pass = 0; pass < 4; pass++) {
    assert.equal(upsertSimplefinTransaction(db, accountId, providerPayload(), TEST_NOW), 'unchanged');
  }

  const stored = row(db);
  assert.equal(stored.merchant_name, 'BLUE BOTTLE 0042', 'a cleared name is an absence, not a pin');
  assert.equal(stored.merchant_name_source, 'provider');

  const merchantRevisions = revisions(db).filter((r) => r.field === 'merchant_name');
  assert.deepEqual(merchantRevisions.map((r) => [r.origin, r.from_value, r.to_value]), [
    ['owner_edit', 'BLUE BOTTLE 0042', null],
    ['provider_revision', null, 'BLUE BOTTLE 0042'],
  ]);
});

// The healthy cases. A standing finding on any of these is a finding the owner cannot act on.

test('a provider that sends no payee at all files no disagreement', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId, transactionId } = posted(db);
  updateTransaction(db, transactionId, { merchant_name: 'Blue Bottle Coffee' });

  // `merchantName` is `txn.payee || null` at the call site. A payload with no payee has reported
  // nothing, and 'provider_rejected' means the provider reported a DIFFERENT value (migration 048).
  upsertSimplefinTransaction(db, accountId, providerPayload({ merchantName: null }), TEST_NOW);

  assert.equal(row(db).merchant_name, 'Blue Bottle Coffee');
  assert.deepEqual(
    revisions(db).filter((r) => r.origin === 'provider_rejected'),
    [],
    'a row claiming the provider offered NULL would be a false record'
  );
});

test('an unchanged hourly resync of an untouched row logs nothing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId } = posted(db);
  for (let pass = 0; pass < 5; pass++) {
    assert.equal(upsertSimplefinTransaction(db, accountId, providerPayload(), TEST_NOW), 'unchanged');
  }
  assert.deepEqual(revisions(db), []);
});

test('a pending row settling into a posted row logs nothing', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const accountId = insertAccount(db, { connection_type: 'simplefin', is_manual: 0 });
  upsertSimplefinTransaction(db, accountId, providerPayload({ pending: 1, amount: -4500 }), TEST_NOW);

  // Settling legitimately sharpens the payee and finalises the amount.
  const write = upsertSimplefinTransaction(
    db,
    accountId,
    providerPayload({ pending: 0, amount: -4550, merchantName: 'BLUE BOTTLE COFFEE 0042' }),
    TEST_NOW
  );
  assert.equal(write, 'modified');

  const stored = row(db);
  assert.equal(stored.amount, -4550);
  assert.equal(stored.merchant_name, 'BLUE BOTTLE COFFEE 0042');
  assert.deepEqual(revisions(db), [], 'the owner was never involved, so nobody disagreed');
});

test('an institution sharpening its own payee after posting is not a disagreement', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId } = posted(db);

  // The existing pending-state heuristic keeps the stored payee here, and it must keep doing so
  // without filing a disagreement: nobody edited this row.
  const write = upsertSimplefinTransaction(
    db,
    accountId,
    providerPayload({ merchantName: 'BLUE BOTTLE 0042 #17' }),
    TEST_NOW
  );
  assert.equal(write, 'unchanged');
  assert.equal(row(db).merchant_name, 'BLUE BOTTLE 0042');
  assert.deepEqual(revisions(db), []);
});

test('the pending-state guard still protects a merchant with no recorded source', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { accountId } = posted(db);
  // Every row written before migration 048 is in this state. Switching to a provenance-only test
  // would hand the provider back the right to overwrite these.
  db.prepare(
    "UPDATE transactions SET merchant_name = 'Blue Bottle Coffee', merchant_name_source = NULL WHERE simplefin_transaction_id = ?"
  ).run(PROVIDER_ID);

  upsertSimplefinTransaction(db, accountId, providerPayload(), TEST_NOW);

  assert.equal(row(db).merchant_name, 'Blue Bottle Coffee');
  assert.deepEqual(revisions(db), [], 'unknown authorship is not a claim of disagreement');
});

test('retyping the value already stored is not an authorship event', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId } = posted(db);
  updateTransaction(db, transactionId, {
    merchant_name: 'BLUE BOTTLE 0042',
    date: '2026-07-10',
    amount: -45.5,
  });

  const stored = row(db);
  assert.equal(stored.merchant_name_source, 'provider');
  assert.equal(stored.date_source, 'provider');
  assert.equal(stored.amount_source, 'provider');
  assert.deepEqual(revisions(db), []);
});

test('a category-only edit leaves every field source alone', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId } = posted(db);
  const categoryId = insertCategory(db, { name: 'Coffee' });

  updateTransaction(db, transactionId, { category_id: categoryId });

  const stored = row(db);
  assert.equal(stored.merchant_name_source, 'provider');
  assert.equal(stored.amount_source, 'provider');
  assert.deepEqual(revisions(db), []);
});

test('the field log survives deleting nothing and cascades with its transaction', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const { transactionId } = posted(db);
  updateTransaction(db, transactionId, { merchant_name: 'Blue Bottle Coffee' });
  assert.equal(revisions(db).length, 1);

  db.prepare('DELETE FROM transactions WHERE id = ?').run(transactionId);
  assert.deepEqual(revisions(db), [], 'no orphan rows are left behind a deleted transaction');
});
