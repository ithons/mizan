import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { CategorySource } from './rules';

/**
 * The one place a transaction's category is written.
 *
 * Every write appends a row to `transaction_category_revisions` (migration 042). That log exists
 * because the previous design recorded history in a single slot: `category_previous_id` was set to
 * the current category on every write, so a second autonomous pass over the same row overwrote the
 * first pass's memory of the truth. "Previous" degraded to "what the AI guessed last time", and the
 * earlier action ended up with no rows pointing at it and became un-undoable. Real history needs a
 * list, not a slot.
 *
 * The legacy columns (`category_source`, `category_action_id`, `category_previous_id`) are still
 * maintained: they are read all over the app and by migration 041's provenance surfaces. They are
 * now a denormalized view of the newest revision rather than the only record.
 *
 * This module deliberately does not decide WHETHER a write is allowed. Policy (never overwrite a
 * human choice, blast-radius caps) lives in `aiWriteGuards.ts`, so the guards can be tested and
 * reasoned about without a database write in the way.
 */

export interface CategoryWrite {
  transactionId: string;
  /** null clears the category (an undo back to uncategorized). */
  categoryId: string | null;
  source: CategorySource | null;
  actionId?: string | null;
  /** Sets `manually_categorized`, the older marker kept alongside `category_source`. */
  markManual?: boolean;
  reviewStatus?: 'open' | 'reviewed';
  /**
   * Set when this write is undoing a specific revision. Marks the appended row as a revert so it
   * does not itself become the newest revision and bury the action underneath.
   */
  revertOf?: string | null;
}

interface CurrentCategoryRow {
  id: string;
  category_id: string | null;
  category_source: string | null;
}

/**
 * Apply category writes and log each one. Returns the number of rows actually changed: a write
 * whose transaction does not exist, or whose category and source both already match, is skipped
 * rather than counted, so callers never report a blast radius larger than what happened.
 */
export function writeTransactionCategories(
  db: Database.Database,
  writes: readonly CategoryWrite[],
  now = new Date().toISOString()
): number {
  if (writes.length === 0) return 0;

  const current = db.prepare('SELECT id, category_id, category_source FROM transactions WHERE id = ?');
  const update = db.prepare(`
    UPDATE transactions
    SET category_id = ?,
        category_source = ?,
        category_action_id = ?,
        category_previous_id = ?,
        manually_categorized = COALESCE(?, manually_categorized),
        review_status = COALESCE(?, review_status),
        updated_at = ?
    WHERE id = ?
  `);
  const revision = db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, from_category_id, to_category_id, from_source, to_source, action_id, revert_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let changed = 0;
  for (const write of writes) {
    const row = current.get(write.transactionId) as CurrentCategoryRow | undefined;
    if (!row) continue;
    if (row.category_id === write.categoryId && row.category_source === write.source) continue;

    update.run(
      write.categoryId,
      write.source,
      write.actionId ?? null,
      row.category_id,
      write.markManual === undefined ? null : write.markManual ? 1 : 0,
      write.reviewStatus ?? null,
      now,
      write.transactionId
    );
    revision.run(
      uuidv4(),
      write.transactionId,
      row.category_id,
      write.categoryId,
      row.category_source,
      write.source,
      write.actionId ?? null,
      write.revertOf ?? null,
      now
    );
    changed += 1;
  }

  return changed;
}

export function writeTransactionCategory(
  db: Database.Database,
  write: CategoryWrite,
  now = new Date().toISOString()
): number {
  return writeTransactionCategories(db, [write], now);
}

/**
 * Log a category change made by an UPDATE this module did not issue.
 *
 * `updateTransaction` writes the category alongside amount, notes and merchant in one dynamic
 * statement, so routing it through `writeTransactionCategories` would mean splitting a single
 * atomic row update into two. It records its revision here instead. The log stays complete; only
 * the write itself lives elsewhere.
 */
export function recordCategoryRevision(
  db: Database.Database,
  params: {
    transactionId: string;
    fromCategoryId: string | null;
    toCategoryId: string | null;
    fromSource: string | null;
    toSource: string | null;
    actionId?: string | null;
    now?: string;
  }
): void {
  if (params.fromCategoryId === params.toCategoryId && params.fromSource === params.toSource) return;
  db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, from_category_id, to_category_id, from_source, to_source, action_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    params.transactionId,
    params.fromCategoryId,
    params.toCategoryId,
    params.fromSource,
    params.toSource,
    params.actionId ?? null,
    params.now ?? new Date().toISOString()
  );
}

export interface RevertableRevision {
  id: string;
  transaction_id: string;
  from_category_id: string | null;
  from_source: string | null;
  to_category_id: string | null;
}

/**
 * The revisions an action can still revert: those that are the NEWEST revision for their
 * transaction.
 *
 * If a later action (or a hand edit) has written the row since, this action's revision is buried
 * and reverting it would silently discard the newer decision. Undo therefore behaves like a stack:
 * undo the later action first, and this one becomes revertable again. That is a real improvement on
 * the old behaviour, where a second pass made the first permanently un-undoable with no way back.
 */
export function revertableRevisionsForAction(
  db: Database.Database,
  actionId: string
): RevertableRevision[] {
  return db.prepare(`
    SELECT r.id, r.transaction_id, r.from_category_id, r.from_source, r.to_category_id
    FROM transaction_category_revisions r
    WHERE r.action_id = ?
      AND r.revert_of IS NULL
      AND r.reverted_at IS NULL
      AND r.id = (
        SELECT r2.id FROM transaction_category_revisions r2
        WHERE r2.transaction_id = r.transaction_id
          AND r2.revert_of IS NULL
          AND r2.reverted_at IS NULL
        ORDER BY r2.created_at DESC, r2.rowid DESC
        LIMIT 1
      )
    ORDER BY r.rowid
  `).all(actionId) as RevertableRevision[];
}

/**
 * The newest revision still standing for a transaction, under the same definition undo uses: the
 * newest row that is neither a revert nor already reverted.
 *
 * A writer that displaces a category temporarily (transfer pairing) needs this to hand the row back
 * as it found it. It returns `to_category_id` as well, so the caller can check the revision is the
 * one IT wrote before reverting it: if a later pass has written the row since, its revision is the
 * newest and reverting that would discard someone else's decision.
 */
export function latestRevertableRevision(
  db: Database.Database,
  transactionId: string
): RevertableRevision | undefined {
  return db.prepare(`
    SELECT id, transaction_id, from_category_id, from_source, to_category_id
    FROM transaction_category_revisions
    WHERE transaction_id = ?
      AND revert_of IS NULL
      AND reverted_at IS NULL
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(transactionId) as RevertableRevision | undefined;
}

/**
 * Restore each revision's prior category and prior source.
 *
 * Restoring the source matters: the old undo wrote `category_source = 'rule'` for every row it
 * touched, so undoing an AI action that had displaced a hand-made choice handed that choice back
 * relabelled as machine-authored, and the next `skipManual` pass was then free to overwrite it.
 */
export function revertRevisions(
  db: Database.Database,
  revisions: readonly RevertableRevision[],
  now = new Date().toISOString()
): number {
  if (revisions.length === 0) return 0;

  const reverted = writeTransactionCategories(
    db,
    revisions.map((r) => ({
      transactionId: r.transaction_id,
      categoryId: r.from_category_id,
      source: (r.from_source as CategorySource | null) ?? null,
      actionId: null,
      revertOf: r.id,
      reviewStatus: r.from_category_id === null ? ('open' as const) : undefined,
    })),
    now
  );

  // Consume the revisions this call undid, so the revision underneath becomes the newest again and
  // the action beneath this one becomes revertable in turn.
  const consume = db.prepare('UPDATE transaction_category_revisions SET reverted_at = ? WHERE id = ?');
  for (const r of revisions) consume.run(now, r.id);

  return reverted;
}

export function revertAction(
  db: Database.Database,
  actionId: string,
  now = new Date().toISOString()
): number {
  return revertRevisions(db, revertableRevisionsForAction(db, actionId), now);
}
