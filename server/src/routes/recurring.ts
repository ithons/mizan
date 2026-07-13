import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { CreateRecurringSchema, UpdateRecurringSchema, UpsertRecurringAdjustmentSchema } from '../../../shared/schemas';
import { createRecurringPattern } from '../services/recurring';
import { buildRecurringForecast } from '../services/recurringForecast';
import { buildSubscriptionInsights } from '../services/subscriptionInsights';
import {
  deleteRecurringAdjustment,
  listRecurringAdjustments,
  upsertRecurringAdjustment,
} from '../services/recurringAdjustments';
import { format, addDays } from 'date-fns';

const router = Router();

function parseDays(value: unknown): number | null {
  if (value === undefined) return 30;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;

  return Math.min(Math.max(parsed, 1), 365);
}

function routeParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// GET / - all active recurring_patterns JOIN categories
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const patterns = db.prepare(`
      SELECT
        rp.*,
        c.name AS category_name,
        c.color AS category_color,
        CASE WHEN c.is_income = 1 THEN rp.average_amount ELSE -rp.average_amount END AS average_signed_amount
      FROM recurring_patterns rp
      LEFT JOIN categories c ON c.id = rp.category_id
      WHERE rp.is_active = 1
      ORDER BY rp.merchant_name ASC
    `).all();

    res.json({ data: patterns });
  } catch (err) {
    next(err);
  }
});

// POST / - create a user-defined recurring pattern
router.post('/', validate(CreateRecurringSchema), (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = createRecurringPattern(db, req.body);
    const pattern = db.prepare(`
      SELECT
        rp.*,
        c.name AS category_name,
        c.color AS category_color,
        CASE WHEN c.is_income = 1 THEN rp.average_amount ELSE -rp.average_amount END AS average_signed_amount
      FROM recurring_patterns rp
      LEFT JOIN categories c ON c.id = rp.category_id
      WHERE rp.id = ?
    `).get(id);
    res.status(201).json({ data: pattern });
  } catch (err) {
    next(err);
  }
});

// GET /upcoming?days=30
router.get('/upcoming', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const days = parseDays(req.query.days);
    if (days === null) {
      res.status(400).json({ error: 'Invalid days filter' });
      return;
    }

    const endDate = format(addDays(new Date(), days), 'yyyy-MM-dd');

    const patterns = db.prepare(`
      SELECT
        rp.*,
        c.name AS category_name,
        c.color AS category_color
      FROM recurring_patterns rp
      LEFT JOIN categories c ON c.id = rp.category_id
      WHERE rp.is_active = 1
        AND rp.next_expected <= ?
        AND (rp.is_confirmed = 1 OR rp.transaction_count >= 3)
      ORDER BY rp.next_expected ASC
    `).all(endDate);

    res.json({ data: patterns });
  } catch (err) {
    next(err);
  }
});

// GET /forecast?days=60 - recurring income and bills expanded into dates
router.get('/forecast', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const days = parseDays(req.query.days ?? '60');
    if (days === null) {
      res.status(400).json({ error: 'Invalid days filter' });
      return;
    }

    res.json({ data: buildRecurringForecast(db, days) });
  } catch (err) {
    next(err);
  }
});

router.get('/subscriptions', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const days = parseDays(req.query.days ?? '60');
    if (days === null) {
      res.status(400).json({ error: 'Invalid days filter' });
      return;
    }

    res.json({ data: buildSubscriptionInsights(db, days) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/adjustments', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = routeParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid recurring pattern id' });
      return;
    }

    res.json({ data: listRecurringAdjustments(db, id) });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/:id/adjustments',
  validate(UpsertRecurringAdjustmentSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const id = routeParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid recurring pattern id' });
        return;
      }

      res.json({ data: upsertRecurringAdjustment(db, id, req.body) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id/adjustments/:adjustmentId', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = routeParam(req.params.id);
    const adjustmentId = routeParam(req.params.adjustmentId);
    if (!id || !adjustmentId) {
      res.status(400).json({ error: 'Invalid recurring adjustment id' });
      return;
    }

    const deleted = deleteRecurringAdjustment(db, id, adjustmentId);
    if (!deleted) {
      res.status(404).json({ error: 'Recurring adjustment not found' });
      return;
    }

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// POST /:id/confirm - confirm recurring pattern
router.post('/:id/confirm', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    const pattern = db.prepare('SELECT id FROM recurring_patterns WHERE id = ?').get(id);
    if (!pattern) {
      res.status(404).json({ error: 'Recurring pattern not found' });
      return;
    }

    db.prepare(
      'UPDATE recurring_patterns SET is_confirmed = 1, updated_at = ? WHERE id = ?'
    ).run(new Date().toISOString(), id);

    const updated = db.prepare('SELECT * FROM recurring_patterns WHERE id = ?').get(id);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /:id/dismiss - deactivate recurring pattern
router.post('/:id/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    const pattern = db.prepare('SELECT id FROM recurring_patterns WHERE id = ?').get(id);
    if (!pattern) {
      res.status(404).json({ error: 'Recurring pattern not found' });
      return;
    }

    const now = new Date().toISOString();
    const dismissPattern = db.transaction(() => {
      db.prepare(
        'UPDATE recurring_patterns SET is_active = 0, is_confirmed = 0, updated_at = ? WHERE id = ?'
      ).run(now, id);

      db.prepare(
        'UPDATE transactions SET recurring_id = NULL, updated_at = ? WHERE recurring_id = ?'
      ).run(now, id);
    });

    dismissPattern();

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id - update category_id
router.patch(
  '/:id',
  validate(UpdateRecurringSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { id } = req.params;
      const body = req.body as { category_id?: string | null };
      const categoryId = body.category_id || null;

      const pattern = db.prepare('SELECT id FROM recurring_patterns WHERE id = ?').get(id);
      if (!pattern) {
        res.status(404).json({ error: 'Recurring pattern not found' });
        return;
      }

      if (categoryId) {
        const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
        if (!category) {
          res.status(404).json({ error: 'Category not found' });
          return;
        }
      }

      db.prepare(
        'UPDATE recurring_patterns SET category_id = ?, updated_at = ? WHERE id = ?'
      ).run(categoryId, new Date().toISOString(), id);

      const updated = db.prepare('SELECT * FROM recurring_patterns WHERE id = ?').get(id);
      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
