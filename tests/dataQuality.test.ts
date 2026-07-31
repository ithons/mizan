import test from 'node:test';
import assert from 'node:assert/strict';
import { format, subDays } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDataQualitySummary, summarizeDataQuality } from '../server/src/services/dataQuality';
import { getReportSummary } from '../server/src/services/reporting';
import {
  insertAccount,
  insertCategory,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';
import type {
  RecurringForecast,
  SyncHealth,
  TransactionReviewSummary,
} from '../shared/types';

function baseSyncHealth(overrides: Partial<SyncHealth> = {}): SyncHealth {
  return {
    status: 'healthy',
    status_label: 'Fresh',
    status_detail: 'All connected institutions are fresh enough for reports and advisor context.',
    connection_count: 1,
    stale_count: 0,
    attention_count: 0,
    fresh_count: 1,
    never_synced_count: 0,
    last_synced_at: '2026-06-30T12:00:00.000Z',
    connections: [],
    ...overrides,
  };
}

const QUEUE_IDS = [
  'uncategorized',
  'rule_suggestions',
  'pending',
  'recurring_candidates',
  'duplicate_candidates',
  'transfer_candidates',
] as const;

type QueueId = (typeof QUEUE_IDS)[number];

function baseReviewSummary(counts: Partial<Record<QueueId, number>> = {}): TransactionReviewSummary {
  // total_open mirrors transactionReview.ts: pending posts on its own and is excluded from it.
  const totalOpen = QUEUE_IDS
    .filter((id) => id !== 'pending')
    .reduce((sum, id) => sum + (counts[id] ?? 0), 0);

  return {
    total_open: totalOpen,
    queues: QUEUE_IDS.map((id) => ({
      id,
      label: id,
      count: counts[id] ?? 0,
      action_label: 'Review',
      severity: 'info' as const,
    })),
    rule_suggestions: [],
    recurring_candidates: [],
    duplicate_candidates: [],
    transfer_candidates: [],
  };
}

function baseForecast(overrides: Partial<RecurringForecast> = {}): RecurringForecast {
  return {
    days: 60,
    income: 0,
    bills: 0,
    net: 0,
    confirmed_income: 0,
    confirmed_bills: 0,
    likely_income: 0,
    likely_bills: 0,
    uncertain_income: 0,
    uncertain_bills: 0,
    overdue_count: 0,
    review_count: 0,
    occurrences: [],
    ...overrides,
  };
}

// ─── Shape ────────────────────────────────────────────────────────────────────

test('the summary carries open conditions and nothing else', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast(),
  });

  // The score and the verdict derived from it were hidden from the panel but still served by
  // GET /api/insights/quality, where the advisor could read them. They are gone from the payload.
  assert.deepEqual(Object.keys(summary), ['issues']);
  assert.deepEqual(summary.issues, []);
});

test('a broken connection is critical and opens the accounts screen', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth({
      status: 'attention',
      status_label: 'Needs attention',
      status_detail: '1 connection needs action.',
      attention_count: 1,
    }),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast(),
  });

  assert.deepEqual(summary.issues.map((issue) => issue.id), ['sync-attention']);
  assert.equal(summary.issues[0].severity, 'critical');
  assert.equal(summary.issues[0].route, '/accounts');
});

test('critical issues sort ahead of warnings and notes', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary({ uncategorized: 8, rule_suggestions: 2, recurring_candidates: 2 }),
    forecast: baseForecast({ review_count: 3, overdue_count: 1 }),
    invariantIssues: [{
      id: 'orphan-holdings',
      label: 'Holdings without an account',
      message: '2 holding rows reference an account that no longer exists.',
      route: '/investments',
      severity: 'critical',
      weight: 30,
    }],
  });

  assert.deepEqual(summary.issues.map((issue) => issue.id), [
    'orphan-holdings',
    'transaction-review',
    'cash-flow-review',
  ]);
  assert.deepEqual(summary.issues.map((issue) => issue.route), [
    '/investments',
    '/review',
    '/bills',
  ]);
  assert.ok(!summary.issues.some((issue) => 'weight' in issue), 'weight must not be serialized');
});

// ─── Agreement at count one ───────────────────────────────────────────────────
//
// The single most likely row the owner will ever see is a count of one, and every one of these
// read "1 thing WERE excluded" / "1 recurring item NEED review" before the counting helper was
// made to hand back the verb along with the noun.

test('a single review item reads with a singular verb', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary({ uncategorized: 1 }),
    forecast: baseForecast(),
  });

  assert.equal(
    summary.issues[0].message,
    '1 uncategorized transaction needs review before reports can be fully trusted.'
  );
});

test('two review items each of count one still take a plural verb', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary({ uncategorized: 1, duplicate_candidates: 1 }),
    forecast: baseForecast(),
  });

  assert.equal(
    summary.issues[0].message,
    '1 uncategorized transaction, 1 possible duplicate need review before reports can be fully trusted.'
  );
});

test('a single recurring item reads with a singular verb, with and without an overdue one', () => {
  const confirmable = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast({ review_count: 1 }),
  });
  assert.equal(
    confirmable.issues[0].message,
    '1 recurring item needs confirmation before the forecast is dependable.'
  );

  const overdue = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary(),
    forecast: baseForecast({ review_count: 1, overdue_count: 1 }),
  });
  assert.equal(
    overdue.issues[0].message,
    '1 recurring item needs review, including 1 overdue item.'
  );
});

test('the unnamed-queue fallback also agrees at count one', () => {
  // total_open counts something no named queue reports: the sentence still has to read.
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: { ...baseReviewSummary(), total_open: 1 },
    forecast: baseForecast(),
  });

  assert.equal(summary.issues[0].message, '1 review item needs attention.');
});

test('plural verbs survive above count one', () => {
  const summary = summarizeDataQuality({
    syncHealth: baseSyncHealth(),
    reviewSummary: baseReviewSummary({ uncategorized: 3 }),
    forecast: baseForecast({ review_count: 2, overdue_count: 2 }),
  });

  assert.equal(
    summary.issues.find((issue) => issue.id === 'transaction-review')?.message,
    '3 uncategorized transactions need review before reports can be fully trusted.'
  );
  assert.equal(
    summary.issues.find((issue) => issue.id === 'cash-flow-review')?.message,
    '2 recurring items need review, including 2 overdue items.'
  );
});

// ─── Silence on ordinary healthy shapes ───────────────────────────────────────
//
// Every case below is a whole ledger driven through getDataQualitySummary, not a hand-built input
// object, because the failure this replaces was a detector firing on data no assembled input ever
// showed: a routine month on the owner's real ledger.

const TODAY = new Date();
const daysAgo = (days: number): string => format(subDays(TODAY, days), 'yyyy-MM-dd');

function freshlySyncedDb(): Database.Database {
  const db = migratedTestDb();
  db.prepare(`
    INSERT INTO simplefin_connections (id, last_synced_at, status, created_at)
    VALUES ('sf_1', ?, 'active', ?)
  `).run(TODAY.toISOString(), TODAY.toISOString());
  return db;
}

function confirmTransferPair(db: Database.Database, pairId: string, ids: string[]): void {
  const update = db.prepare(
    "UPDATE transactions SET transfer_pair_id = ?, transfer_status = 'confirmed' WHERE id = ?"
  );
  for (const id of ids) update.run(pairId, id);
}

test('a routine confirmed transfer raises nothing', (t) => {
  const db = freshlySyncedDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 500000 });
  const savings = insertAccount(db, { account_name: 'Savings', type: 'savings', current_balance: 1200000 });

  // The seeded taxonomy ids, because report exclusion is keyed on the Transfers root, not on a
  // category that merely happens to be named one.
  const out = insertTransaction(db, {
    account_id: checking,
    date: daysAgo(4),
    amount: -50000,
    merchant_name: 'Transfer to Savings',
    category_id: 'cat_xfer_out',
  });
  const into = insertTransaction(db, {
    account_id: savings,
    date: daysAgo(4),
    amount: 50000,
    merchant_name: 'Transfer from Checking',
    category_id: 'cat_xfer_in',
  });
  confirmTransferPair(db, 'pair_1', [out, into]);

  // The exact firing condition of the row this replaces: reports really do exclude these two legs.
  // Excluding them is `excludedFromTotalsSql` working, so it raises nothing here.
  const excluded = getReportSummary(db, { startDate: daysAgo(30), endDate: daysAgo(0) })
    .excluded_flows
    .reduce((sum, flow) => sum + flow.count, 0);
  assert.ok(excluded > 0, 'fixture must actually produce excluded flows for this to prove anything');

  assert.deepEqual(getDataQualitySummary(db).issues, []);
});

test('a routine brokerage contribution raises nothing', (t) => {
  const db = freshlySyncedDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 400000 });
  const brokerage = insertAccount(db, { account_name: 'Brokerage', type: 'brokerage', current_balance: 2500000 });

  const out = insertTransaction(db, {
    account_id: checking,
    date: daysAgo(9),
    amount: -100000,
    merchant_name: 'Vanguard Contribution',
    category_id: 'cat_inv_transfer',
  });
  const into = insertTransaction(db, {
    account_id: brokerage,
    date: daysAgo(9),
    amount: 100000,
    merchant_name: 'Vanguard Contribution',
    category_id: 'cat_inv_buy',
  });
  confirmTransferPair(db, 'pair_2', [out, into]);

  const excluded = getReportSummary(db, { startDate: daysAgo(30), endDate: daysAgo(0) })
    .excluded_flows
    .reduce((sum, flow) => sum + flow.count, 0);
  assert.ok(excluded > 0, 'fixture must actually produce excluded flows for this to prove anything');

  assert.deepEqual(getDataQualitySummary(db).issues, []);
});

test('a fully categorized month with a recent successful sync raises nothing', (t) => {
  const db = freshlySyncedDb();
  t.after(() => db.close());

  const groceries = insertCategory(db, { name: 'Groceries' });
  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 300000 });

  for (let index = 0; index < 12; index++) {
    insertTransaction(db, {
      account_id: checking,
      date: daysAgo(index + 1),
      amount: -4200 - index,
      merchant_name: `Market ${index}`,
      category_id: groceries,
      manually_categorized: 1,
    });
  }

  assert.deepEqual(getDataQualitySummary(db).issues, []);
});

test('an install with no budgets raises nothing', (t) => {
  const db = freshlySyncedDb();
  t.after(() => db.close());

  const salary = insertCategory(db, { name: 'Salary', is_income: 1 });
  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 800000 });
  insertTransaction(db, {
    account_id: checking,
    date: daysAgo(3),
    amount: 320000,
    merchant_name: 'Employer',
    category_id: salary,
  });

  const budgets = db.prepare('SELECT COUNT(*) AS count FROM budgets').get() as { count: number };
  assert.equal(budgets.count, 0, 'this case is only meaningful with no budgets defined');
  assert.deepEqual(getDataQualitySummary(db).issues, []);
});

test('a pending charge from yesterday raises nothing', (t) => {
  const db = freshlySyncedDb();
  t.after(() => db.close());

  const dining = insertCategory(db, { name: 'Dining' });
  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 300000 });
  insertTransaction(db, {
    account_id: checking,
    date: daysAgo(1),
    amount: -3400,
    merchant_name: 'Cafe',
    category_id: dining,
    pending: 1,
  });

  assert.deepEqual(getDataQualitySummary(db).issues, []);
});

// ─── The one shape that must not be silent ────────────────────────────────────

test('a single uncategorized transaction is reported, once, and reads correctly', (t) => {
  const db = freshlySyncedDb();
  t.after(() => db.close());

  const groceries = insertCategory(db, { name: 'Groceries' });
  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 300000 });

  for (let index = 0; index < 5; index++) {
    insertTransaction(db, {
      account_id: checking,
      date: daysAgo(index + 2),
      amount: -3100 - index,
      merchant_name: `Market ${index}`,
      category_id: groceries,
    });
  }
  // A merchant seen once cannot also produce a rule suggestion, so this is one condition, not two.
  insertTransaction(db, {
    account_id: checking,
    date: daysAgo(1),
    amount: -2750,
    merchant_name: 'Unfamiliar Shop',
    category_id: null,
  });

  const issues = getDataQualitySummary(db).issues;

  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 'transaction-review');
  assert.equal(
    issues[0].message,
    '1 uncategorized transaction needs review before reports can be fully trusted.'
  );
  assert.equal(issues[0].route, '/review');
});

// ─── The manual-only install ──────────────────────────────────────────────────
//
// `sync-empty` is the row here that could never be cleared. An owner who keeps their accounts by
// hand has no live connection and never will, so "No live connections" would sit in their panel
// forever: the standing finding this panel exists to avoid. The signal is what the install is
// doing, since nothing in the schema records "deliberately manual".

test('a manual-only install with a real ledger raises nothing about connections', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const groceries = insertCategory(db, { name: 'Groceries' });
  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 300000 });
  for (let index = 0; index < 6; index++) {
    insertTransaction(db, {
      account_id: checking,
      date: daysAgo(index + 1),
      amount: -2500 - index,
      merchant_name: `Market ${index}`,
      category_id: groceries,
      manually_categorized: 1,
    });
  }

  const connections = db.prepare('SELECT COUNT(*) AS count FROM simplefin_connections').get() as { count: number };
  assert.equal(connections.count, 0, 'this case is only meaningful with no connection at all');
  assert.deepEqual(getDataQualitySummary(db).issues, []);
});

test('an install with nothing in it is told what to do about it, once', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // An account added by hand and never used is not a ledger: there is still nothing to work from.
  insertAccount(db, { account_name: 'Checking', current_balance: 0 });

  const issues = getDataQualitySummary(db).issues;
  assert.deepEqual(issues.map((issue) => issue.id), ['sync-empty']);
  assert.equal(
    issues[0].message,
    'No account holds a settled transaction. Connect an institution, import a statement, or add transactions by hand.'
  );
  assert.equal(issues[0].route, '/accounts');
});

test('a ledger the owner archived is still a ledger, and the row does not claim otherwise', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  // The shape the sentence used to lie about: nothing on the visible side of the ledger, and a
  // closed card, hidden from the accounts screen, still carrying the history it was used for.
  insertAccount(db, { account_name: 'Checking', current_balance: 0 });
  const closedCard = insertAccount(db, {
    account_name: 'Old Card',
    type: 'credit',
    is_liability: 1,
    is_hidden: 1,
    current_balance: 0,
  });
  const groceries = insertCategory(db, { name: 'Groceries' });
  for (let index = 0; index < 5; index++) {
    insertTransaction(db, {
      account_id: closedCard,
      date: daysAgo(index + 30),
      amount: -3100 - index,
      merchant_name: `Market ${index}`,
      category_id: groceries,
      manually_categorized: 1,
    });
  }

  const settled = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE pending = 0').get() as { count: number };
  assert.equal(settled.count, 5, 'the sentence under test is about exactly this count');
  assert.equal(
    getDataQualitySummary(db).issues.some((issue) => issue.id === 'sync-empty'),
    false,
    'five settled transactions is not "no account holds a settled transaction"'
  );
});

test('a pending-only ledger has still settled nothing, so the row stands', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 0 });
  insertTransaction(db, { account_id: checking, date: daysAgo(1), amount: -1200, pending: 1 });

  assert.ok(getDataQualitySummary(db).issues.some((issue) => issue.id === 'sync-empty'));
});

test('a broken connection still reports, ledger or not', (t) => {
  const db = migratedTestDb();
  t.after(() => db.close());

  db.prepare(`
    INSERT INTO simplefin_connections (id, last_synced_at, status, created_at)
    VALUES ('sf_broken', NULL, 'reauth_required', ?)
  `).run(TODAY.toISOString());
  const checking = insertAccount(db, { account_name: 'Checking', current_balance: 100000 });
  insertTransaction(db, { account_id: checking, date: daysAgo(2), amount: -1500, category_id: insertCategory(db, { name: 'Groceries' }) });

  // Silence about `sync-empty` is about an install with no connection, not about ignoring one that
  // is failing: a broken connection is actionable and clears when the owner reconnects.
  assert.deepEqual(getDataQualitySummary(db).issues.map((issue) => issue.id), ['sync-attention']);
});
