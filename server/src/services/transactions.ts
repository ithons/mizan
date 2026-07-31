import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { toCents } from './money';
import { adjustManualAccountBalance } from './manualAccountBalance';
import { applyMerchantRuleToMatchingTransactions, upsertMerchantRule } from './rules';
import {
  recordCategoryRevision,
  recordFieldRevision,
  writeTransactionCategories,
  type FieldRevision,
} from './categoryWrites';
import { recordManualOverrideFeedback } from './aiFeedback';

// All money here is integer cents (the DB contract). Callers dollarize at the
// response boundary. Query-string parsing and the resulting 400s stay in the route;
// these functions take already-typed inputs and own the SQL + business logic.

export type TransactionSortBy = 'date' | 'amount' | 'merchant';
export type TransactionSortDir = 'asc' | 'desc';

export interface TransactionListFilters {
  page: number;
  limit: number;
  sortBy: TransactionSortBy;
  sortDir: TransactionSortDir;
  accountIds: string[];
  categoryIds: string[];
  startDate?: string;
  endDate?: string;
  search?: string;
  minAmount?: number; // dollars, as supplied by the client
  maxAmount?: number; // dollars
  pending?: boolean;
  recurring?: boolean;
  uncategorized?: boolean;
  reviewStatus?: string;
  type?: 'income' | 'expense';
  /**
   * Exactly these rows. The one predicate the ledger cannot write as a column comparison: which
   * rows the model has a still-live proposal about is decided by `draftLiveness`, in TypeScript,
   * over five kinds of premise. Re-expressing that rule in SQL here would make it two rules.
   */
  ids?: string[];
  /** `category_source` values to keep. The literal string 'none' selects rows where it is NULL. */
  categorySources?: string[];
  duplicateStatus?: string;
  transferStatus?: string;
}

export interface TransactionListResult {
  rows: Record<string, unknown>[];
  total: number;
}

function accountExists(db: Database.Database, accountId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId));
}

function categoryExists(db: Database.Database, categoryId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId));
}

// Expand each selected category to itself plus all descendant categories, so a filter
// on a parent category also matches transactions tagged to its children.
export function expandCategoryIds(db: Database.Database, categoryIds: string[]): string[] {
  const categories = db.prepare('SELECT id, parent_id FROM categories').all() as Array<{
    id: string;
    parent_id: string | null;
  }>;
  const childrenByParent = new Map<string, string[]>();

  for (const category of categories) {
    if (!category.parent_id) continue;
    const children = childrenByParent.get(category.parent_id) ?? [];
    children.push(category.id);
    childrenByParent.set(category.parent_id, children);
  }

  const expanded = new Set<string>();
  const addWithDescendants = (categoryId: string): void => {
    if (expanded.has(categoryId)) return;
    expanded.add(categoryId);

    for (const childId of childrenByParent.get(categoryId) ?? []) {
      addWithDescendants(childId);
    }
  };

  for (const categoryId of categoryIds) {
    addWithDescendants(categoryId);
  }

  return Array.from(expanded);
}

function transactionOrderBy(sortBy: TransactionSortBy, sortDir: TransactionSortDir): string {
  const direction = sortDir.toUpperCase();

  switch (sortBy) {
    case 'amount':
      return `t.amount ${direction}, t.date DESC, t.created_at DESC`;
    case 'merchant':
      return `lower(COALESCE(t.merchant_name, t.original_name, '')) ${direction}, t.date DESC, t.created_at DESC`;
    case 'date':
      return `t.date ${direction}, t.created_at ${direction}`;
  }
}

export function listTransactions(db: Database.Database, filters: TransactionListFilters): TransactionListResult {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.accountIds.length > 0) {
    conditions.push(`t.account_id IN (${filters.accountIds.map(() => '?').join(',')})`);
    params.push(...filters.accountIds);
  }

  if (filters.categoryIds.length > 0) {
    const expandedCategoryIds = expandCategoryIds(
      db,
      filters.categoryIds.map((id) => id.trim()).filter(Boolean)
    );

    if (expandedCategoryIds.length > 0) {
      conditions.push(`t.category_id IN (${expandedCategoryIds.map(() => '?').join(',')})`);
      params.push(...expandedCategoryIds);
    }
  }

  if (filters.startDate) {
    conditions.push('t.date >= ?');
    params.push(filters.startDate);
  }
  if (filters.endDate) {
    conditions.push('t.date <= ?');
    params.push(filters.endDate);
  }
  if (filters.search) {
    conditions.push('(t.merchant_name LIKE ? OR t.original_name LIKE ? OR t.notes LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.minAmount !== undefined) {
    conditions.push('t.amount >= ?');
    params.push(toCents(filters.minAmount));
  }
  if (filters.maxAmount !== undefined) {
    conditions.push('t.amount <= ?');
    params.push(toCents(filters.maxAmount));
  }
  if (filters.pending !== undefined) {
    conditions.push('t.pending = ?');
    params.push(filters.pending ? 1 : 0);
  }
  if (filters.recurring !== undefined) {
    conditions.push(filters.recurring ? 't.recurring_id IS NOT NULL' : 't.recurring_id IS NULL');
  }
  if (filters.uncategorized !== undefined) {
    conditions.push(filters.uncategorized ? 't.category_id IS NULL' : 't.category_id IS NOT NULL');
  }
  if (filters.reviewStatus !== undefined) {
    conditions.push('t.review_status = ?');
    params.push(filters.reviewStatus);
  }
  if (filters.type === 'income') {
    conditions.push('t.amount > 0');
  } else if (filters.type === 'expense') {
    conditions.push('t.amount < 0');
  }
  if (filters.ids !== undefined) {
    // An empty id list means "these zero rows", not "no filter". Collapsing it to no filter would
    // answer a request for a specific empty set with the whole ledger.
    if (filters.ids.length === 0) {
      conditions.push('0 = 1');
    } else {
      conditions.push(`t.id IN (${filters.ids.map(() => '?').join(',')})`);
      params.push(...filters.ids);
    }
  }
  if (filters.categorySources !== undefined && filters.categorySources.length > 0) {
    // 'none' is the pre-provenance majority (2,412 of 2,588 rows on the live database at
    // migration 046), and it is a NULL rather than a value, so it cannot ride in the IN list.
    const named = filters.categorySources.filter((s) => s !== 'none');
    const wantsNull = filters.categorySources.length !== named.length;
    const clauses: string[] = [];
    if (named.length > 0) {
      clauses.push(`t.category_source IN (${named.map(() => '?').join(',')})`);
      params.push(...named);
    }
    if (wantsNull) clauses.push('t.category_source IS NULL');
    conditions.push(`(${clauses.join(' OR ')})`);
  }
  if (filters.duplicateStatus !== undefined) {
    conditions.push('t.duplicate_status = ?');
    params.push(filters.duplicateStatus);
  }
  if (filters.transferStatus !== undefined) {
    conditions.push('t.transfer_status = ?');
    params.push(filters.transferStatus);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.limit;

  const countRow = db.prepare(`
    SELECT COUNT(*) as total
    FROM transactions t
    ${where}
  `).get(...params) as { total: number };

  const rows = db.prepare(`
    SELECT
      t.*,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      -- A positive amount inside an expense category is a refund, not income. Without this the
      -- screen has no way to tell a $955.19 Amazon credit from a paycheck and paints both green.
      c.is_income AS category_is_income,
      a.account_name,
      a.institution_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    ${where}
    ORDER BY ${transactionOrderBy(filters.sortBy, filters.sortDir)}
    LIMIT ? OFFSET ?
  `).all(...params, filters.limit, offset) as Record<string, unknown>[];

  return { rows, total: countRow.total };
}

export function getTransactionById(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare(`
    SELECT
      t.*,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      -- A positive amount inside an expense category is a refund, not income. Without this the
      -- screen has no way to tell a $955.19 Amazon credit from a paycheck and paints both green.
      c.is_income AS category_is_income,
      a.account_name,
      a.institution_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.id = ?
  `).get(id) as Record<string, unknown> | undefined;
}

export interface CreateManualTransactionInput {
  account_id: string;
  date: string;
  amount: number; // dollars
  merchant_name?: string;
  original_name: string;
  category_id?: string;
  notes?: string;
}

export type CreateManualTransactionResult =
  | { ok: true; row: Record<string, unknown>; balanceChanged: boolean }
  | { ok: false; reason: 'account_not_found' | 'category_not_found' };

export function createManualTransaction(
  db: Database.Database,
  input: CreateManualTransactionInput
): CreateManualTransactionResult {
  const id = uuidv4();
  const now = new Date().toISOString();
  const categoryId = input.category_id || null;
  const amountCents = toCents(input.amount);

  if (!accountExists(db, input.account_id)) {
    return { ok: false, reason: 'account_not_found' };
  }
  if (categoryId && !categoryExists(db, categoryId)) {
    return { ok: false, reason: 'category_not_found' };
  }

  let balanceChanged = false;
  const insertTransaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO transactions
        (id, account_id, date, amount, merchant_name, original_name,
         category_id, pending, notes, is_manual, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 'manual', ?, ?)
    `).run(
      id,
      input.account_id,
      input.date,
      amountCents,
      input.merchant_name || null,
      input.original_name,
      categoryId,
      input.notes || null,
      now,
      now
    );

    balanceChanged = adjustManualAccountBalance(db, input.account_id, amountCents, now);
  });

  insertTransaction();

  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
  return { ok: true, row, balanceChanged };
}

export interface UpdateTransactionInput {
  category_id?: string | null;
  notes?: string | null;
  date?: string;
  amount?: number; // dollars
  merchant_name?: string | null;
}

export interface TransactionCategorization {
  rule_id: string | null;
  pattern: string | null;
  applied: number;
}

export type UpdateTransactionResult =
  | { ok: true; row: Record<string, unknown>; balanceChanged: boolean; categorization: TransactionCategorization }
  | { ok: false; reason: 'not_found' | 'category_not_found' };

export function updateTransaction(
  db: Database.Database,
  id: string,
  input: UpdateTransactionInput
): UpdateTransactionResult {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as
    | {
        account_id: string;
        amount: number;
        amount_source: string | null;
        date: string;
        date_source: string | null;
        category_id: string | null;
        category_source: string | null;
        category_action_id: string | null;
        is_manual: number;
        merchant_name: string | null;
        merchant_name_source: string | null;
        original_name: string;
      }
    | undefined;

  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }

  const categoryId = input.category_id || null;
  if (input.category_id !== undefined && categoryId && !categoryExists(db, categoryId)) {
    return { ok: false, reason: 'category_not_found' };
  }

  // input.amount arrives in dollars; convert once and reuse for the column write and
  // the manual-account rebalance (existing.amount is already cents).
  const amountCents = input.amount !== undefined ? toCents(input.amount) : undefined;

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.category_id !== undefined) {
    // category_previous_id must be captured before category_id is overwritten, so it comes
    // first in the SET list (SQLite evaluates the right-hand sides against the original row,
    // but keeping the order explicit stops a later reshuffle from breaking it silently).
    updates.push('category_previous_id = category_id');
    updates.push('category_id = ?');
    values.push(categoryId);
    if (categoryId) {
      updates.push("review_status = 'reviewed'");
    }
    // Mark (or unmark) this as a deliberate manual choice so a full re-categorization
    // pass never overwrites it.
    updates.push('manually_categorized = ?');
    values.push(categoryId ? 1 : 0);
    // A hand edit is the highest-authority source, and it detaches the row from whatever AI
    // action previously owned it: undoing that action must not reach back into a human choice.
    updates.push('category_source = ?');
    values.push(categoryId ? 'human' : null);
    updates.push('category_action_id = NULL');
  }
  if (input.notes !== undefined) {
    updates.push('notes = ?');
    values.push(input.notes);
  }

  // Field provenance (migration 048). A field's author changes only when its value does: retyping
  // the value already stored is not an authorship event, and recording one would put a standing
  // owner-versus-provider disagreement on a row where none exists.
  const fieldEdits: FieldRevision[] = [];
  if (input.date !== undefined) {
    updates.push('date = ?');
    values.push(input.date);
    if (input.date !== existing.date) {
      updates.push("date_source = 'human'");
      fieldEdits.push({
        transactionId: id,
        field: 'date',
        fromValue: existing.date,
        toValue: input.date,
        fromSource: existing.date_source,
        toSource: 'human',
        origin: 'owner_edit',
      });
    }
  }
  if (input.amount !== undefined && amountCents !== undefined) {
    updates.push('amount = ?');
    values.push(amountCents);
    if (amountCents !== existing.amount) {
      updates.push("amount_source = 'human'");
      // Integer cents on both sides, stringified only because one log column holds three types.
      fieldEdits.push({
        transactionId: id,
        field: 'amount',
        fromValue: String(existing.amount),
        toValue: String(amountCents),
        fromSource: existing.amount_source,
        toSource: 'human',
        origin: 'owner_edit',
      });
    }
  }
  if (input.merchant_name !== undefined) {
    updates.push('merchant_name = ?');
    values.push(input.merchant_name);
    if (input.merchant_name !== existing.merchant_name) {
      updates.push("merchant_name_source = 'human'");
      fieldEdits.push({
        transactionId: id,
        field: 'merchant_name',
        fromValue: existing.merchant_name,
        toValue: input.merchant_name,
        fromSource: existing.merchant_name_source,
        toSource: 'human',
        origin: 'owner_edit',
      });
    }
  }

  const now = new Date().toISOString();
  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  let balanceChanged = false;
  if (updates.length > 1) {
    const updateTransactionTx = db.transaction(() => {
      // Before the UPDATE, which sets category_action_id = NULL. That clear is what stops undo
      // reaching back through a human decision, and it was also the only thing that ever recorded
      // the model's answer, so the rejection has to be captured while the link still exists
      // (migration 047). Only a genuine disagreement: an edit that lands on the category the model
      // already chose is agreement, and filing it as feedback would teach the opposite.
      if (
        input.category_id !== undefined &&
        existing.category_action_id !== null &&
        categoryId !== existing.category_id
      ) {
        recordManualOverrideFeedback(
          db,
          {
            transactionId: id,
            actionId: existing.category_action_id,
            proposedCategoryId: existing.category_id,
            ownerCategoryId: categoryId,
            merchantName: existing.merchant_name ?? existing.original_name,
          },
          now
        );
      }

      db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      for (const edit of fieldEdits) {
        recordFieldRevision(db, edit, now);
      }

      // A hand edit is a category write like any other and belongs in the revision log, so undo
      // can see that a human decision now sits on top of whatever the AI had done. The write
      // itself stays in the statement above because it is atomic with amount/notes/date.
      if (input.category_id !== undefined) {
        recordCategoryRevision(db, {
          transactionId: id,
          fromCategoryId: existing.category_id,
          toCategoryId: categoryId,
          fromSource: existing.category_source ?? null,
          toSource: categoryId ? 'human' : null,
          now,
        });
      }

      if (amountCents !== undefined && existing.is_manual) {
        balanceChanged = adjustManualAccountBalance(
          db,
          existing.account_id,
          amountCents - existing.amount,
          now
        );
      }
    });

    updateTransactionTx();
  }

  // If the category changed, upsert a merchant rule and apply it to matching rows.
  let categorization: TransactionCategorization = { rule_id: null, pattern: null, applied: 0 };
  if (input.category_id !== undefined && categoryId) {
    const merchantName = existing.merchant_name || existing.original_name;
    const ruleId = upsertMerchantRule(db, merchantName, categoryId, now, { source: 'human' }).ruleId;
    const result = applyMerchantRuleToMatchingTransactions(db, merchantName, categoryId, now);
    categorization = { rule_id: ruleId, pattern: merchantName, applied: result.updated };
  }

  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
  return { ok: true, row, balanceChanged, categorization };
}

export type DeleteTransactionResult =
  | { ok: true; balanceChanged: boolean }
  | { ok: false; reason: 'not_found' | 'not_manual' };

export function deleteTransaction(db: Database.Database, id: string): DeleteTransactionResult {
  const txn = db.prepare('SELECT account_id, amount, is_manual FROM transactions WHERE id = ?').get(id) as
    | { account_id: string; amount: number; is_manual: number }
    | undefined;

  if (!txn) {
    return { ok: false, reason: 'not_found' };
  }
  if (!txn.is_manual) {
    return { ok: false, reason: 'not_manual' };
  }

  let balanceChanged = false;
  const deleteTransactionTx = db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    balanceChanged = adjustManualAccountBalance(db, txn.account_id, -txn.amount, new Date().toISOString());
  });

  deleteTransactionTx();
  return { ok: true, balanceChanged };
}

export function setTransactionReviewStatus(
  db: Database.Database,
  id: string,
  status: 'open' | 'reviewed' | 'dismissed'
): Record<string, unknown> | null {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE transactions
    SET review_status = ?,
        updated_at = ?
    WHERE id = ?
  `).run(status, now, id);

  if (result.changes === 0) {
    return null;
  }

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown>;
}

export type BulkCategorizeResult =
  | { ok: true; updated: number }
  | { ok: false; reason: 'category_not_found' | 'missing_transactions' };

export function bulkCategorizeTransactions(
  db: Database.Database,
  ids: string[],
  categoryId: string
): BulkCategorizeResult {
  const transactionIds = Array.from(new Set(ids));

  if (!categoryExists(db, categoryId)) {
    return { ok: false, reason: 'category_not_found' };
  }

  const placeholders = transactionIds.map(() => '?').join(',');
  const now = new Date().toISOString();

  const updateCategories = db.transaction(() => {
    const selectedTransactions = db.prepare(`
      SELECT id, merchant_name, original_name
      FROM transactions
      WHERE id IN (${placeholders})
    `).all(...transactionIds) as Array<{
      id: string;
      merchant_name: string | null;
      original_name: string;
    }>;

    if (selectedTransactions.length !== transactionIds.length) {
      throw new Error('MISSING_TRANSACTIONS');
    }

    writeTransactionCategories(
      db,
      transactionIds.map((transactionId) => ({
        transactionId,
        categoryId,
        source: 'human' as const,
        actionId: null,
        markManual: true,
        reviewStatus: 'reviewed' as const,
      })),
      now
    );

    const patterns = new Set(
      selectedTransactions
        .map((transaction) => transaction.merchant_name || transaction.original_name)
        .filter((pattern) => pattern.length > 0)
    );

    for (const pattern of patterns) {
      upsertMerchantRule(db, pattern, categoryId, now, { source: 'human' });
    }
  });

  try {
    updateCategories();
  } catch (err) {
    if ((err as Error).message === 'MISSING_TRANSACTIONS') {
      return { ok: false, reason: 'missing_transactions' };
    }
    throw err;
  }

  return { ok: true, updated: transactionIds.length };
}
