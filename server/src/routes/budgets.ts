import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { UpsertBudgetSchema } from '../../../shared/schemas';
import { getMonthlyBudgetsWithProjection } from '../services/budgetProjection';

const router = Router();

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// GET / - all budgets JOIN categories
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const budgets = db.prepare(`
      SELECT
        b.*,
        c.name AS category_name,
        c.color AS category_color,
        c.icon AS category_icon
      FROM budgets b
      JOIN categories c ON c.id = b.category_id
      ORDER BY c.name ASC
    `).all();

    res.json({ data: budgets });
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

    res.json({ data: getMonthlyBudgetsWithProjection(db, year, month) });
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

      if (existing) {
        db.prepare(`
          UPDATE budgets
          SET amount = ?, period = ?, rollover = ?, updated_at = ?
          WHERE id = ?
        `).run(body.amount, body.period, body.rollover ? 1 : 0, now, existing.id);

        const updated = db.prepare('SELECT * FROM budgets WHERE id = ?').get(existing.id);
        res.json({ data: updated });
      } else {
        const id = uuidv4();
        db.prepare(`
          INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(id, categoryId, body.amount, body.period, body.rollover ? 1 : 0, now, now);

        const created = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id);
        res.status(201).json({ data: created });
      }
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
