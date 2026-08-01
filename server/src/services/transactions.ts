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

/**
 * What the provider still reports for an amount the owner corrected, in cents, or NULL.
 *
 * Declared once and used by both readers below, because it is the only place the provider's side
 * of a standing disagreement lives. `upsertSimplefinTransaction` keeps an owner-authored amount
 * (`amount_source = 'human'`) and files the provider's offer as a `provider_rejected` revision
 * instead of writing it, so without this the screen would show one number and have no way to say
 * that the institution says another.
 *
 * Two gates, and both are about not asserting a disagreement that is not standing. The revision
 * has to be filed against the value the row CURRENTLY holds (`from_value = t.amount`), so
 * re-correcting to a third number does not leave the previous argument on screen: the next sync
 * files a fresh rejection against the new value, or, if the provider now agrees, files nothing and
 * this reads NULL. And `amount_source` has to still be 'human', so a released field shows nothing
 * even though its rejection rows stay in the append-only log.
 *
 * Integer cents, like the column it comes from. `routes/transactions.ts` dollarizes it beside
 * `amount`, and migration 048 is explicit that `to_value` is TEXT holding whatever the field held,
 * which for `amount` is the same integer cents, so the CAST is a decode and not a conversion.
 *
 * Both sides of the `from_value` comparison are cast to INTEGER rather than the column being cast
 * to TEXT. The text form is not stable across the boundary: better-sqlite3 binds a JS number as a
 * float, so `CAST(? AS TEXT)` on 10000 is '10000.0' and would silently match nothing.
 */
const PROVIDER_AMOUNT_SQL = `
      CASE WHEN t.amount_source = 'human' THEN (
        SELECT CAST(r.to_value AS INTEGER)
        FROM transaction_field_revisions r
        WHERE r.transaction_id = t.id
          AND r.field = 'amount'
          AND r.origin = 'provider_rejected'
          AND CAST(r.from_value AS INTEGER) = t.amount
        ORDER BY r.created_at DESC, r.rowid DESC
        LIMIT 1
      ) END AS provider_amount`;

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
      a.institution_name,
      ${PROVIDER_AMOUNT_SQL}
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
      a.institution_name,
      ${PROVIDER_AMOUNT_SQL}
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
    // The author is recorded because this path knows it. A category on a manual transaction was
    // typed into the form by the owner, row and category together, which is the same act
    // `updateTransaction` records as `human` / `manually_categorized = 1` when they type one onto
    // an existing row. The row used to be written with `category_source` NULL, which migration 041
    // defines as "the author was never recorded". Both markers are set, for the reason every reader
    // of them cites: a bulk pass can clear `manually_categorized` on its own, so a hand-made choice
    // has to survive on either.
    //
    // WHAT THAT COSTS, stated because it is a decision and not a side effect. Four queries read
    // this pair as "do not touch this row": `transferCandidateRows` (transactionIntegrity.ts) and
    // three sweeps in rules.ts. So a hand-entered row WITH a category is not offered as a transfer
    // leg, and a later merchant rule will not overwrite its category. Both follow from the same
    // sentence that gate states, "the owner never made this choice", which here is false: they did.
    // A hand-entered row with NO category sets neither marker and stays eligible for both.
    // `commitCsvImport` deliberately does the opposite, and says why at its own INSERT: a mapped
    // column is one decision about a file, not a decision about each row in it.
    db.prepare(`
      INSERT INTO transactions
        (id, account_id, date, amount, merchant_name, original_name,
         category_id, category_source, manually_categorized, review_status,
         pending, notes, is_manual, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 'manual', ?, ?)
    `).run(
      id,
      input.account_id,
      input.date,
      amountCents,
      input.merchant_name || null,
      input.original_name,
      categoryId,
      categoryId ? 'human' : null,
      categoryId ? 1 : 0,
      categoryId ? 'reviewed' : 'open',
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

export type ReleaseAmountResult =
  | { ok: true; row: Record<string, unknown>; providerAmountAdopted: number | null }
  | { ok: false; reason: 'not_found' | 'not_corrected' | 'not_provider_backed' };

/**
 * Hand a corrected amount back to the institution.
 *
 * This is the half that keeps `upsertSimplefinTransaction`'s amount pin from being a trap.
 * Migration 048 refused an owner-authored amount outright, and its reason was sound: a pin that
 * cannot be released leaves the ledger permanently disagreeing with the balance it reconciles
 * against, with nothing able to end it. So the pin ships with its own exit, and the exit is not
 * "type the provider's number back in": doing that would leave `amount_source = 'human'` and pin
 * the row to a value that merely happens to agree today, silently rejecting the next genuine
 * revision.
 *
 * What it adopts is whatever the provider last offered against the value the row currently holds,
 * which is the same rejection row the screen was showing. When the provider has offered nothing
 * (no sync since the correction, or it now agrees), the amount does not move and only the
 * authorship does; that is not a value change, so nothing is logged for it.
 *
 * Anything but a SimpleFIN row is refused rather than quietly succeeding, and that is narrower
 * than "has a provider" on purpose. A manual row has no institution behind it at all, and the
 * manual-account balance a release would have to keep in step is the owner's own arithmetic. A
 * Coinbase row has an institution but no re-offer: `upsertCoinbaseTransaction` never rewrites the
 * `amount` of a row it has already written, so a corrected one is never reverted, no rejection is
 * ever filed, and stamping `amount_source = 'provider'` onto a number the owner typed would record
 * an authorship that did not happen.
 */
export function releaseAmountToProvider(
  db: Database.Database,
  id: string,
  now = new Date().toISOString()
): ReleaseAmountResult {
  const existing = db.prepare(`
    SELECT id, amount, amount_source, simplefin_transaction_id, is_manual
    FROM transactions WHERE id = ?
  `).get(id) as
    | {
        id: string;
        amount: number;
        amount_source: string | null;
        simplefin_transaction_id: string | null;
        is_manual: number;
      }
    | undefined;

  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.amount_source !== 'human') return { ok: false, reason: 'not_corrected' };
  if (existing.is_manual || !existing.simplefin_transaction_id) {
    return { ok: false, reason: 'not_provider_backed' };
  }

  const offered = db.prepare(`
    SELECT to_value FROM transaction_field_revisions
    WHERE transaction_id = ? AND field = 'amount' AND origin = 'provider_rejected'
      AND CAST(from_value AS INTEGER) = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(existing.id, existing.amount) as { to_value: string | null } | undefined;

  const providerAmount =
    offered?.to_value != null && Number.isInteger(Number(offered.to_value)) ? Number(offered.to_value) : null;
  const adopted = providerAmount !== null && providerAmount !== existing.amount ? providerAmount : null;

  db.transaction(() => {
    if (adopted !== null) {
      // The row now holds the provider's value and this log row is the only remaining record of
      // the owner's, which is exactly what migration 048 defines 'provider_revision' to mean.
      recordFieldRevision(db, {
        transactionId: existing.id,
        field: 'amount',
        fromValue: String(existing.amount),
        toValue: String(adopted),
        fromSource: 'human',
        toSource: 'provider',
        origin: 'provider_revision',
      }, now);
    }
    db.prepare(`
      UPDATE transactions SET amount = ?, amount_source = 'provider', updated_at = ? WHERE id = ?
    `).run(adopted ?? existing.amount, now, existing.id);
  })();

  const row = getTransactionById(db, existing.id) as Record<string, unknown>;
  return { ok: true, row, providerAmountAdopted: adopted };
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
