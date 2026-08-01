import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  CreateCategorySchema,
  UpdateCategorySchema,
  MergeCategorySchema,
} from '../../../shared/schemas';
import type { Category } from '../../../shared/types';

const router = Router();

// GET / - all categories as flat array with children nested
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const all = db.prepare(
      'SELECT * FROM categories ORDER BY sort_order ASC, name ASC'
    ).all() as Category[];

    // Build nested structure
    const byId = new Map<string, Category>();
    for (const cat of all) {
      byId.set(cat.id, { ...cat, children: [] });
    }

    const roots: Category[] = [];
    for (const cat of all) {
      const node = byId.get(cat.id)!;
      if (cat.parent_id && byId.has(cat.parent_id)) {
        byId.get(cat.parent_id)!.children!.push(node);
      } else {
        roots.push(node);
      }
    }

    res.json({ data: roots });
  } catch (err) {
    next(err);
  }
});

// POST / - create category
router.post(
  '/',
  validate(CreateCategorySchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as {
        name: string;
        icon?: string;
        color?: string;
        parent_id?: string | null;
        is_income: boolean;
        is_investment: boolean;
        sort_order: number;
      };

      const id = uuidv4();

      db.prepare(`
        INSERT INTO categories
          (id, name, icon, color, parent_id, is_income, is_system, is_investment, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        id,
        body.name,
        body.icon || null,
        body.color || null,
        body.parent_id || null,
        body.is_income ? 1 : 0,
        body.is_investment ? 1 : 0,
        body.sort_order
      );

      const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
      res.status(201).json({ data: category });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /:id - update category
router.patch(
  '/:id',
  validate(UpdateCategorySchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const body = req.body as {
        name?: string;
        icon?: string | null;
        color?: string | null;
        sort_order?: number;
      };

      const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.name !== undefined) {
        updates.push('name = ?');
        values.push(body.name);
      }
      if (body.icon !== undefined) {
        updates.push('icon = ?');
        values.push(body.icon);
      }
      if (body.color !== undefined) {
        updates.push('color = ?');
        values.push(body.color);
      }
      if (body.sort_order !== undefined) {
        updates.push('sort_order = ?');
        values.push(body.sort_order);
      }

      if (updates.length > 0) {
        values.push(id);
        db.prepare(
          `UPDATE categories SET ${updates.join(', ')} WHERE id = ?`
        ).run(...values);
      }

      const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

function countReferences(db: ReturnType<typeof getDb>, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

/**
 * Everything a `DELETE FROM categories` would take with it that the owner was never told about.
 *
 * TWO KINDS OF DAMAGE, and neither used to be checked. `merchant_rules.category_id`,
 * `budgets.category_id` and, through the budget, `budget_rollover_ledger.budget_id` are all
 * `ON DELETE CASCADE`, so deleting a category the 409s let through silently destroyed the rules
 * that file that merchant, the budget the owner set for it, and every month of rollover that budget
 * had accrued. The response said `{ success: true }`.
 *
 * The other kind is quieter and worse. `transaction_category_revisions` carries no foreign key at
 * all, so its `from_category_id` and `to_category_id` simply became ids nothing resolves. That log
 * is what `undoAdvisorAction` replays and what the conservation guard's auto-revert walks, so an AI
 * action that had moved a row OUT of the deleted category could no longer be put back: the undo
 * writes the prior category id and the engine rejects it against `transactions.category_id`'s
 * foreign key. Undo and the guard both stopped working for those rows with nothing anywhere saying
 * so. `merchant_rule_revisions` orphans the same way and takes a rule's own history with it.
 *
 * The third kind is an id left pointing at nothing. `transactions.category_previous_id` (the
 * denormalized newest revision, migration 041) and `ai_feedback.proposed_category_id` /
 * `owner_category_id` (migration 047, deliberately unconstrained so evidence outlives what it
 * describes) carry no foreign key either. Nothing cascades them and nothing NULLs them, so a delete
 * leaves them naming an id that resolves to no row. They are blocked here because THE MERGE PATH IN
 * THIS FILE REPOINTS BOTH: a delete that treats as expendable exactly what the merge beside it
 * judged worth carrying is the two halves of one operation disagreeing, and the merge's own comment
 * on `ai_feedback` ("left pointing at a deleted id it silently stops matching anything") is a
 * description of what the delete would do to it.
 *
 * Each is reported as a 409 naming the count and the remedy rather than deleted along with the
 * category, because a merge is the operation that keeps all of it: it repoints every one of these at
 * the surviving category, which is why "merge it instead" is an instruction the owner can act on. A
 * declined proposal has a second remedy, which is why blocking on one is not a dead end: Settings
 * lists every one and can take it back (`restoreDeclinedProposal`), and the row goes with it.
 *
 * MEASURED on a copy of .mizan/mizan.db at migration 054 taken 2026-07-31 with
 * `sqlite3 .mizan/mizan.db ".backup ..."`, one query over all seven counts:
 *   71 categories, 2 of them non-system;
 *   0 non-system categories clear even the two guards that already existed (transactions = 0 AND
 *     subcategories = 0);
 *   0 would be newly blocked by the two added here.
 * So the blast radius of adding them is nothing the owner can delete today. That is a statement
 * about today's ledger, not evidence they are unnecessary: what they name is what a delete does
 * once a category does become deletable, which is exactly the state one reaches after the owner
 * empties it.
 */
interface DeleteBlocker {
  count: number;
  error: string;
}

function deleteBlockers(db: ReturnType<typeof getDb>, id: string): DeleteBlocker[] {
  const blockers: DeleteBlocker[] = [];

  const linked = countReferences(db, 'SELECT COUNT(*) as count FROM transactions WHERE category_id = ?', id);
  if (linked > 0) {
    blockers.push({ count: linked, error: `Cannot delete category with ${linked} linked transactions. Merge it first.` });
  }

  const children = countReferences(db, 'SELECT COUNT(*) as count FROM categories WHERE parent_id = ?', id);
  if (children > 0) {
    blockers.push({ count: children, error: `Cannot delete category with ${children} subcategories. Move or merge them first.` });
  }

  // Retired rules count: the cascade does not spare them, and a retired rule is the only record of
  // what a merchant used to be filed as.
  const rules = countReferences(db, 'SELECT COUNT(*) as count FROM merchant_rules WHERE category_id = ?', id);
  if (rules > 0) {
    blockers.push({
      count: rules,
      error: `Cannot delete category with ${rules} merchant rule${rules === 1 ? '' : 's'} pointing at it: deleting it would delete ${rules === 1 ? 'that rule' : 'those rules'} too. Merge it instead, or repoint ${rules === 1 ? 'the rule' : 'the rules'} first.`,
    });
  }

  const budgets = countReferences(db, 'SELECT COUNT(*) as count FROM budgets WHERE category_id = ?', id);
  if (budgets > 0) {
    const months = countReferences(
      db,
      'SELECT COUNT(*) as count FROM budget_rollover_ledger WHERE budget_id IN (SELECT id FROM budgets WHERE category_id = ?)',
      id
    );
    const ledger = months > 0 ? ` and ${months} recorded month${months === 1 ? '' : 's'} of rollover` : '';
    blockers.push({
      count: budgets,
      error: `Cannot delete category with a budget: deleting it would delete the budget${ledger} with it. Merge it instead, or delete the budget first.`,
    });
  }

  const revisions = countReferences(
    db,
    `SELECT (
       SELECT COUNT(*) FROM transaction_category_revisions
        WHERE from_category_id = ? OR to_category_id = ?
     ) + (
       SELECT COUNT(*) FROM merchant_rule_revisions
        WHERE from_category_id = ? OR to_category_id = ?
     ) AS count`,
    id, id, id, id
  );
  if (revisions > 0) {
    blockers.push({
      count: revisions,
      error: `Cannot delete category with ${revisions} entr${revisions === 1 ? 'y' : 'ies'} in the change history: undo replays that history, so deleting the category would leave those changes unrevertable. Merge it instead, which moves the history to the surviving category.`,
    });
  }

  // Not covered by the revisions blocker above, despite every current writer of this column also
  // appending a revision row: two rows on the owner's ledger carry a `category_previous_id` with no
  // revision naming it, so "the revision blocker catches it too" is a claim the data refutes.
  //   SELECT COUNT(*) FROM transactions t WHERE t.category_previous_id IS NOT NULL
  //     AND NOT EXISTS (SELECT 1 FROM transaction_category_revisions r
  //                      WHERE r.transaction_id = t.id AND r.from_category_id = t.category_previous_id);
  //   -> 2 of 2, on a copy of .mizan/mizan.db at migration 054, 2026-07-31.
  const previous = countReferences(
    db,
    'SELECT COUNT(*) as count FROM transactions WHERE category_previous_id = ?',
    id
  );
  if (previous > 0) {
    blockers.push({
      count: previous,
      error: previous === 1
        ? 'Cannot delete category: 1 transaction records it as the category it was moved out of, and deleting it would leave that record pointing at a category that no longer exists. Merge it instead, which repoints it.'
        : `Cannot delete category: ${previous} transactions record it as the category they were moved out of, and deleting it would leave those records pointing at a category that no longer exists. Merge it instead, which repoints them.`,
    });
  }

  // The record of the owner disagreeing with the model. A dismissal is what `ownerDeclinedProposal`
  // reads to keep the worker from re-applying something the owner refused, and it matches on this
  // id; a delete would not remove the row, it would leave it naming nothing.
  const feedback = countReferences(
    db,
    'SELECT COUNT(*) as count FROM ai_feedback WHERE proposed_category_id = ? OR owner_category_id = ?',
    id,
    id
  );
  if (feedback > 0) {
    blockers.push({
      count: feedback,
      error: `Cannot delete category: ${feedback} recorded AI decision${feedback === 1 ? '' : 's'} name${feedback === 1 ? 's' : ''} it, and deleting it would leave ${feedback === 1 ? 'that record' : 'those records'} pointing at a category that no longer exists. Merge it instead, or clear the declined suggestion${feedback === 1 ? '' : 's'} in Settings first.`,
    });
  }

  return blockers;
}

// DELETE /:id
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
      | { is_system: number }
      | undefined;

    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    if (category.is_system) {
      res.status(403).json({ error: 'Cannot delete system categories' });
      return;
    }

    const blockers = deleteBlockers(db, id);
    if (blockers.length > 0) {
      // The first is the one the owner most likely means, and the rest are named after it: a refusal
      // that reports one reason at a time turns a single decision into four rounds of trying again.
      const [first, ...rest] = blockers;
      res.status(409).json({
        error: rest.length === 0 ? first.error : `${first.error} ${rest.map((b) => b.error).join(' ')}`,
      });
      return;
    }

    const now = new Date().toISOString();

    const deleteCategory = db.transaction(() => {
      db.prepare(
        'UPDATE recurring_patterns SET category_id = NULL, updated_at = ? WHERE category_id = ?'
      ).run(now, id);

      db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    });

    deleteCategory();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// POST /:id/merge
router.post(
  '/:id/merge',
  validate(MergeCategorySchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const { targetId } = req.body as { targetId: string };

      if (id === targetId) {
        res.status(400).json({ error: 'Cannot merge a category into itself' });
        return;
      }

      const source = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
        | { is_system: number }
        | undefined;
      if (!source) {
        res.status(404).json({ error: 'Source category not found' });
        return;
      }

      if (source.is_system) {
        res.status(403).json({ error: 'Cannot merge system categories' });
        return;
      }

      const target = db.prepare('SELECT * FROM categories WHERE id = ?').get(targetId);
      if (!target) {
        res.status(404).json({ error: 'Target category not found' });
        return;
      }

      const descendantTarget = db.prepare(`
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM categories WHERE parent_id = ?
          UNION ALL
          SELECT c.id FROM categories c
          JOIN descendants d ON c.parent_id = d.id
        )
        SELECT id FROM descendants WHERE id = ?
      `).get(id, targetId);

      if (descendantTarget) {
        res.status(409).json({
          error: 'Cannot merge a category into one of its subcategories',
        });
        return;
      }

      const budgetConflict = db.prepare(`
        SELECT COUNT(*) as count
        FROM budgets source_budget
        JOIN budgets target_budget
          ON target_budget.category_id = ?
         AND target_budget.period = source_budget.period
        WHERE source_budget.category_id = ?
      `).get(targetId, id) as { count: number };

      if (budgetConflict.count > 0) {
        res.status(409).json({
          error: 'Cannot merge categories with overlapping budgets. Delete or adjust one budget first.',
        });
        return;
      }

      const now = new Date().toISOString();

      const mergeCategory = db.transaction(() => {
        db.prepare(
          'UPDATE transactions SET category_id = ?, updated_at = ? WHERE category_id = ?'
        ).run(targetId, now, id);

        db.prepare(
          'UPDATE budgets SET category_id = ? WHERE category_id = ?'
        ).run(targetId, id);

        db.prepare(
          'UPDATE merchant_rules SET category_id = ? WHERE category_id = ?'
        ).run(targetId, id);

        db.prepare(
          'UPDATE recurring_patterns SET category_id = ?, updated_at = ? WHERE category_id = ?'
        ).run(targetId, now, id);

        db.prepare(
          'UPDATE categories SET parent_id = ? WHERE parent_id = ?'
        ).run(targetId, id);

        // THE HISTORY MOVES WITH THE ROWS, or the merge breaks undo exactly the way an unguarded
        // delete did. `transaction_category_revisions` has no foreign key, so the source id survived
        // the DELETE below as an id nothing resolves; `undoAdvisorAction` then wrote it back onto
        // `transactions.category_id`, which DOES have one, and the engine rejected the undo. The
        // conservation guard's auto-revert walks the same log and stopped the same way. A merge says
        // the two categories are one thing, so every record of the source becomes a record of the
        // target, and the same undo replays into a category that still exists.
        for (const table of ['transaction_category_revisions', 'merchant_rule_revisions']) {
          db.prepare(`UPDATE ${table} SET from_category_id = ? WHERE from_category_id = ?`).run(targetId, id);
          db.prepare(`UPDATE ${table} SET to_category_id = ? WHERE to_category_id = ?`).run(targetId, id);
        }

        // The denormalized view of the newest revision (migration 041). Left behind it disagrees
        // with the log it is a copy of.
        db.prepare(
          'UPDATE transactions SET category_previous_id = ? WHERE category_previous_id = ?'
        ).run(targetId, id);

        // What the owner told the model, which the write paths now read back
        // (`ownerDeclinedProposal`). A dismissal of "file this as the source category" is a
        // dismissal of "file this as the target" once the two are one, and left pointing at a
        // deleted id it silently stops matching anything.
        db.prepare(
          'UPDATE ai_feedback SET proposed_category_id = ? WHERE proposed_category_id = ?'
        ).run(targetId, id);
        db.prepare(
          'UPDATE ai_feedback SET owner_category_id = ? WHERE owner_category_id = ?'
        ).run(targetId, id);

        db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      });

      mergeCategory();

      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
