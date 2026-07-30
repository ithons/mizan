import Database from 'better-sqlite3';
import { runMigrationsOn } from '../../server/src/db/index';

/**
 * An in-memory database carrying the REAL schema, built by running every migration.
 *
 * Most tests in this repo hand-write a minimal schema with only the tables and columns the service
 * under test needs. That is fast and keeps a test readable, but it cannot catch the one thing a
 * schema test most needs to catch: a divergence between the table the test declares and the table
 * the migrations actually produce. A missing NOT NULL, a missing CHECK, a REAL where production has
 * INTEGER, or a column added by a later migration all pass silently, and the test goes on asserting
 * against a shape production does not have.
 *
 * Use this wherever the test is about persistence, provenance, or anything a constraint could
 * change. Keep the hand-written minimal schemas for pure computation over a couple of columns.
 */
export function migratedTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrationsOn(db);
  return db;
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}

export const TEST_NOW = '2026-07-30T12:00:00.000Z';

/** Insert a category, returning its id. Defaults satisfy every NOT NULL the real schema declares. */
export function insertCategory(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    name: string;
    parent_id: string | null;
    is_income: number;
    is_investment: number;
  }> = {}
): string {
  const id = overrides.id ?? nextId('cat');
  const columns = new Set(
    (db.prepare('PRAGMA table_info(categories)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  const row: Record<string, unknown> = {
    id,
    name: overrides.name ?? id,
    parent_id: overrides.parent_id ?? null,
    is_income: overrides.is_income ?? 0,
    created_at: TEST_NOW,
  };
  if (columns.has('is_investment')) row.is_investment = overrides.is_investment ?? 0;
  if (columns.has('is_system')) row.is_system = 0;
  if (columns.has('sort_order')) row.sort_order = 0;

  const keys = Object.keys(row).filter((k) => columns.has(k));
  db.prepare(
    `INSERT INTO categories (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...keys.map((k) => row[k]));
  return id;
}

/** Insert an account, returning its id. */
export function insertAccount(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    account_name: string;
    type: string;
    connection_type: string;
    current_balance: number;
    is_liability: number;
    is_hidden: number;
    is_manual: number;
  }> = {}
): string {
  const id = overrides.id ?? nextId('acct');
  db.prepare(`
    INSERT INTO accounts
      (id, connection_type, institution_name, account_name, type, current_balance,
       is_liability, is_hidden, is_manual, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.connection_type ?? 'manual',
    overrides.account_name ?? id,
    overrides.type ?? 'checking',
    overrides.current_balance ?? 0,
    overrides.is_liability ?? 0,
    overrides.is_hidden ?? 0,
    overrides.is_manual ?? 1,
    TEST_NOW,
    TEST_NOW
  );
  return id;
}

/** Insert a transaction, returning its id. `amount` is integer cents, negative for spend. */
export function insertTransaction(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    account_id: string;
    date: string;
    amount: number;
    merchant_name: string | null;
    original_name: string;
    category_id: string | null;
    category_source: string | null;
    category_action_id: string | null;
    manually_categorized: number;
    review_status: string;
    pending: number;
    source_type: string;
  }> = {}
): string {
  const id = overrides.id ?? nextId('txn');
  const accountId = overrides.account_id ?? insertAccount(db);
  db.prepare(`
    INSERT INTO transactions
      (id, account_id, date, amount, merchant_name, original_name, category_id,
       category_source, category_action_id, manually_categorized, review_status,
       pending, source_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    accountId,
    overrides.date ?? '2026-07-01',
    overrides.amount ?? -1000,
    overrides.merchant_name ?? null,
    overrides.original_name ?? overrides.merchant_name ?? id,
    overrides.category_id ?? null,
    overrides.category_source ?? null,
    overrides.category_action_id ?? null,
    overrides.manually_categorized ?? 0,
    overrides.review_status ?? 'open',
    overrides.pending ?? 0,
    overrides.source_type ?? 'manual',
    TEST_NOW,
    TEST_NOW
  );
  return id;
}

/** Insert an advisor_actions row, returning its id. */
export function insertAdvisorAction(
  db: Database.Database,
  overrides: Partial<{ id: string; kind: string; source: string }> = {}
): string {
  const id = overrides.id ?? nextId('action');
  const columns = new Set(
    (db.prepare('PRAGMA table_info(advisor_actions)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  const row: Record<string, unknown> = {
    id,
    kind: overrides.kind ?? 'categorize_transaction',
    label: 'test action',
    summary: 'test action',
    payload: '{}',
    source: overrides.source ?? 'worker_auto',
    created_at: TEST_NOW,
  };
  const keys = Object.keys(row).filter((k) => columns.has(k));
  db.prepare(
    `INSERT INTO advisor_actions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...keys.map((k) => row[k]));
  return id;
}
