import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { UpdateRecurringSchema } from '../../../shared/schemas';
import type { RecurringForecastOccurrence, RecurringPattern } from '../../../shared/types';
import { format, addDays, addMonths, parseISO } from 'date-fns';

const router = Router();

type Frequency = RecurringPattern['frequency'];

function parseDays(value: unknown): number | null {
  if (value === undefined) return 30;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;

  return Math.min(Math.max(parsed, 1), 365);
}

function nextOccurrenceDate(date: Date, frequency: Frequency): Date {
  switch (frequency) {
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
    case 'annual':
      return addMonths(date, 12);
  }
}

// GET / - all active recurring_patterns JOIN categories
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const patterns = db.prepare(`
      SELECT
        rp.*,
        c.name AS category_name,
        c.color AS category_color
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

    const today = format(new Date(), 'yyyy-MM-dd');
    const endDate = format(addDays(new Date(), days), 'yyyy-MM-dd');

    const patterns = db.prepare(`
      SELECT
        rp.*,
        c.name AS category_name,
        c.color AS category_color,
        c.is_income AS category_is_income,
        COALESCE(
          (
            SELECT AVG(t.amount)
            FROM transactions t
            WHERE t.recurring_id = rp.id
          ),
          CASE WHEN COALESCE(c.is_income, 0) = 1 THEN rp.average_amount ELSE -rp.average_amount END
        ) AS average_signed_amount
      FROM recurring_patterns rp
      LEFT JOIN categories c ON c.id = rp.category_id
      WHERE rp.is_active = 1
        AND rp.next_expected <= ?
        AND (rp.is_confirmed = 1 OR rp.transaction_count >= 3)
      ORDER BY rp.next_expected ASC
    `).all(endDate) as Array<RecurringPattern & {
      category_is_income: number | null;
      average_signed_amount: number;
    }>;

    const occurrences: RecurringForecastOccurrence[] = [];

    for (const pattern of patterns) {
      let expected = parseISO(pattern.next_expected);
      let guard = 0;

      while (format(expected, 'yyyy-MM-dd') < today && guard < 500) {
        expected = nextOccurrenceDate(expected, pattern.frequency);
        guard++;
      }

      while (format(expected, 'yyyy-MM-dd') <= endDate && guard < 500) {
        const expectedDate = format(expected, 'yyyy-MM-dd');
        const amount = pattern.average_signed_amount;
        occurrences.push({
          id: `${pattern.id}:${expectedDate}`,
          pattern_id: pattern.id,
          merchant_name: pattern.merchant_name,
          category_id: pattern.category_id,
          category_name: pattern.category_name,
          category_color: pattern.category_color,
          frequency: pattern.frequency,
          expected_date: expectedDate,
          amount,
          is_income: amount > 0,
          is_confirmed: Boolean(pattern.is_confirmed),
        });

        expected = nextOccurrenceDate(expected, pattern.frequency);
        guard++;
      }
    }

    occurrences.sort((a, b) => a.expected_date.localeCompare(b.expected_date));

    const income = occurrences.reduce((sum, occurrence) =>
      occurrence.amount > 0 ? sum + occurrence.amount : sum, 0);
    const bills = occurrences.reduce((sum, occurrence) =>
      occurrence.amount < 0 ? sum + Math.abs(occurrence.amount) : sum, 0);

    res.json({
      data: {
        days,
        income,
        bills,
        net: income - bills,
        occurrences,
      },
    });
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
