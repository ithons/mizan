import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  BudgetGroupMembersSchema,
  CreateBudgetGroupSchema,
  UpdateBudgetGroupSchema,
  UpsertBudgetSchema,
} from '../../../shared/schemas';
import {
  computeBudgetRolloverLedger,
  getMonthlyBudgetsWithProjection,
  recordBudgetRolloverLedger,
} from '../services/budgetProjection';
import { getBudgetGroupsWithTotals } from '../services/budgetGroups';
import { toCents, dollarizeFields } from '../services/money';
import type { Budget, BudgetGroup, BudgetRolloverLedgerEntry } from '../../../shared/types';

const router = Router();

// Money totals are stored and computed in cents; the API contract is dollars, so
// every money field is dollarized here at the response boundary. Not money:
// projected_percent, pacing_velocity, budget_count, sort_order, rollover flag.
const BUDGET_MONEY_FIELDS = ['amount', 'rollover_balance'] as const;
const PROJECTION_MONEY_FIELDS = [
  'amount',
  'rollover_balance',
  'spent',
  'expected_recurring',
  'projected_spend',
  'projected_remaining',
] as const;
const GROUP_TOTALS_MONEY_FIELDS = [
  'budgeted',
  'spent',
  'rollover_balance',
  'expected_recurring',
  'projected_spend',
  'projected_remaining',
] as const;
const LEDGER_MONEY_FIELDS = [
  'starting_rollover',
  'budget_amount',
  'actual_spend',
  'ending_rollover',
] as const;

function projectionToDollars(budget: Budget): Budget {
  return dollarizeFields(budget as unknown as Record<string, unknown>, PROJECTION_MONEY_FIELDS) as unknown as Budget;
}

function ledgerEntryToDollars(entry: BudgetRolloverLedgerEntry): BudgetRolloverLedgerEntry {
  return dollarizeFields(entry as unknown as Record<string, unknown>, LEDGER_MONEY_FIELDS) as unknown as BudgetRolloverLedgerEntry;
}

function groupToDollars(group: BudgetGroup): BudgetGroup {
  return {
    ...group,
    totals: dollarizeFields(group.totals as unknown as Record<string, unknown>, GROUP_TOTALS_MONEY_FIELDS) as unknown as BudgetGroup['totals'],
  };
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseMonthQuery(value: unknown): { year: number; month: number } | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [yearText, monthText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function currentMonthParts(): { year: number; month: number; monthKey: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return {
    year,
    month,
    monthKey: `${year}-${String(month).padStart(2, '0')}`,
  };
}

function categoryIdsExist(db: ReturnType<typeof getDb>, ids: string[]): boolean {
  if (ids.length === 0) return true;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id FROM categories WHERE id IN (${placeholders})`).all(...ids) as { id: string }[];
  return rows.length === ids.length;
}

// GET / - all budgets JOIN categories
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const budgets = (db.prepare(`
      SELECT
        b.*,
        c.name AS category_name,
        c.color AS category_color,
        c.icon AS category_icon
      FROM budgets b
      JOIN categories c ON c.id = b.category_id
      ORDER BY c.name ASC
    `).all() as Record<string, unknown>[]).map((budget) => dollarizeFields(budget, BUDGET_MONEY_FIELDS));

    res.json({ data: budgets });
  } catch (err) {
    next(err);
  }
});

router.get('/groups', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const current = currentMonthParts();
    const parsedMonth = req.query.month === undefined
      ? { year: current.year, month: current.month }
      : parseMonthQuery(req.query.month);

    if (!parsedMonth) {
      res.status(400).json({ error: 'Invalid month filter' });
      return;
    }

    res.json({
      data: getBudgetGroupsWithTotals(db, parsedMonth.year, parsedMonth.month).map(groupToDollars),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/groups',
  validate(CreateBudgetGroupSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as { name: string; color?: string | null; sort_order?: number };
      const now = new Date().toISOString();
      const id = uuidv4();
      const nextSort = body.sort_order ?? (
        (db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM budget_groups').get() as { next_sort: number }).next_sort
      );

      db.prepare(`
        INSERT INTO budget_groups (id, name, color, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, body.name.trim(), body.color ?? null, nextSort, now, now);

      const current = currentMonthParts();
      const group = getBudgetGroupsWithTotals(db, current.year, current.month).find((item) => item.id === id);
      res.status(201).json({ data: group ? groupToDollars(group) : group });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/groups/:id',
  validate(UpdateBudgetGroupSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const body = req.body as { name?: string; color?: string | null; sort_order?: number };
      const existing = db.prepare('SELECT id FROM budget_groups WHERE id = ?').get(id);

      if (!existing) {
        res.status(404).json({ error: 'Budget group not found' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      if (body.name !== undefined) {
        updates.push('name = ?');
        values.push(body.name.trim());
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
        updates.push('updated_at = ?');
        values.push(new Date().toISOString(), id);
        db.prepare(`UPDATE budget_groups SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      const current = currentMonthParts();
      const group = getBudgetGroupsWithTotals(db, current.year, current.month).find((item) => item.id === id);
      res.json({ data: group ? groupToDollars(group) : group });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  '/groups/:id/members',
  validate(BudgetGroupMembersSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const body = req.body as { category_ids: string[] };
      const categoryIds = Array.from(new Set(body.category_ids));

      const existing = db.prepare('SELECT id FROM budget_groups WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'Budget group not found' });
        return;
      }
      if (!categoryIdsExist(db, categoryIds)) {
        res.status(404).json({ error: 'One or more categories were not found' });
        return;
      }

      const now = new Date().toISOString();
      const replaceMembers = db.transaction(() => {
        db.prepare('DELETE FROM budget_group_members WHERE group_id = ?').run(id);
        if (categoryIds.length > 0) {
          const placeholders = categoryIds.map(() => '?').join(', ');
          db.prepare(`DELETE FROM budget_group_members WHERE category_id IN (${placeholders})`).run(...categoryIds);
        }
        const insert = db.prepare(`
          INSERT INTO budget_group_members (group_id, category_id, sort_order, created_at)
          VALUES (?, ?, ?, ?)
        `);
        categoryIds.forEach((categoryId, index) => insert.run(id, categoryId, index, now));
        db.prepare('UPDATE budget_groups SET updated_at = ? WHERE id = ?').run(now, id);
      });

      replaceMembers();

      const current = currentMonthParts();
      const group = getBudgetGroupsWithTotals(db, current.year, current.month).find((item) => item.id === id);
      res.json({ data: group ? groupToDollars(group) : group });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/groups/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;
    const existing = db.prepare('SELECT id FROM budget_groups WHERE id = ?').get(id);

    if (!existing) {
      res.status(404).json({ error: 'Budget group not found' });
      return;
    }

    db.prepare('DELETE FROM budget_groups WHERE id = ?').run(id);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/rollover-ledger', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const parsedMonth = req.query.month === undefined ? null : parseMonthQuery(req.query.month);
    if (req.query.month !== undefined && !parsedMonth) {
      res.status(400).json({ error: 'Invalid month filter' });
      return;
    }

    const months = req.query.months === undefined ? undefined : parsePositiveInteger(req.query.months);
    if (req.query.months !== undefined && months === null) {
      res.status(400).json({ error: 'Invalid months filter' });
      return;
    }

    const db = getDb();
    res.json({
      data: computeBudgetRolloverLedger(db, {
        budgetId: typeof req.query.budgetId === 'string' ? req.query.budgetId : undefined,
        month: typeof req.query.month === 'string' ? req.query.month : undefined,
        months: months ?? undefined,
      }).map(ledgerEntryToDollars),
    });
  } catch (err) {
    next(err);
  }
});

// GET /month/:year/:month - budgets with spent amount for that month
router.get('/month/:year/:month', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const year = parsePositiveInteger(req.params['year']);
    const month = parsePositiveInteger(req.params['month']);

    if (year === null || month === null || month > 12) {
      res.status(400).json({ error: 'Invalid year or month' });
      return;
    }

    res.json({ data: getMonthlyBudgetsWithProjection(db, year, month).map(projectionToDollars) });
  } catch (err) {
    next(err);
  }
});

// PUT /:categoryId - upsert budget
router.put(
  '/:categoryId',
  validate(UpsertBudgetSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { categoryId } = req.params;
      const body = req.body as {
        amount: number;
        period: string;
        rollover: boolean;
      };

      const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
      if (!category) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      const now = new Date().toISOString();

      const existing = db.prepare(
        'SELECT id FROM budgets WHERE category_id = ?'
      ).get(categoryId) as { id: string } | undefined;

      // The write and the carryover record are one transaction. Split, a failing record returned
      // 500 for an amount change that had already landed, and the owner had no way to tell which.
      const upsert = db.transaction((): Record<string, unknown> => {
        const id = existing?.id ?? uuidv4();

        if (existing) {
          db.prepare(`
            UPDATE budgets
            SET amount = ?, period = ?, rollover = ?, updated_at = ?
            WHERE id = ?
          `).run(toCents(body.amount), body.period, body.rollover ? 1 : 0, now, id);
        } else {
          db.prepare(`
            INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
          `).run(id, categoryId, toCents(body.amount), body.period, body.rollover ? 1 : 0, now, now);
        }

        recordBudgetRolloverLedger(db, { budgetId: id });
        return db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as Record<string, unknown>;
      });

      const budget = dollarizeFields(upsert(), BUDGET_MONEY_FIELDS);
      res.status(existing ? 200 : 201).json({ data: budget });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    const budget = db.prepare('SELECT id FROM budgets WHERE id = ?').get(id);
    if (!budget) {
      res.status(404).json({ error: 'Budget not found' });
      return;
    }

    db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
