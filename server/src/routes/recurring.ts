import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { CreateRecurringSchema, UpsertRecurringAdjustmentSchema } from '../../../shared/schemas';
import { createRecurringPattern } from '../services/recurring';
import { buildRecurringForecast } from '../services/recurringForecast';
import {
  deleteRecurringAdjustment,
  upsertRecurringAdjustment,
} from '../services/recurringAdjustments';
import { dollarizeFields, toDollars, toDollarsOrNull } from '../services/money';
import type {
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringOccurrenceAdjustment,
} from '../../../shared/types';
import { dismissRecurringPattern } from '../services/recurring';

const router = Router();

// recurring_patterns.average_amount (and the computed average_signed_amount), forecast
// totals/occurrence amounts, subscription amounts, and adjusted_amount are all stored/
// computed in integer cents; dollarize each money field at this route boundary.
// Confidence, percentages, counts, days, dates, and ids are not money.
const PATTERN_MONEY_FIELDS = ['average_amount', 'average_signed_amount', 'amount_changed_from'] as const;

function patternToDollars(row: Record<string, unknown>): Record<string, unknown> {
  return dollarizeFields(row, PATTERN_MONEY_FIELDS);
}

function occurrenceToDollars(occurrence: RecurringForecastOccurrence): RecurringForecastOccurrence {
  return {
    ...occurrence,
    amount: toDollars(occurrence.amount),
    amount_change: occurrence.amount_change
      ? { ...occurrence.amount_change, from: toDollars(occurrence.amount_change.from) }
      : null,
    adjusted_amount: toDollarsOrNull(occurrence.adjusted_amount),
  };
}

function forecastToDollars(forecast: RecurringForecast): RecurringForecast {
  return {
    ...forecast,
    income: toDollars(forecast.income),
    bills: toDollars(forecast.bills),
    net: toDollars(forecast.net),
    transfers: toDollars(forecast.transfers),
    occurrences: forecast.occurrences.map(occurrenceToDollars),
  };
}

function adjustmentToDollars(adjustment: RecurringOccurrenceAdjustment): RecurringOccurrenceAdjustment {
  return { ...adjustment, adjusted_amount: toDollarsOrNull(adjustment.adjusted_amount) };
}

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
    `).all() as Record<string, unknown>[];

    res.json({ data: patterns.map(patternToDollars) });
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
    `).get(id) as Record<string, unknown>;
    res.status(201).json({ data: patternToDollars(pattern) });
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

    res.json({ data: forecastToDollars(buildRecurringForecast(db, days)) });
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

      res.json({ data: adjustmentToDollars(upsertRecurringAdjustment(db, id, req.body)) });
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

    const updated = db.prepare('SELECT * FROM recurring_patterns WHERE id = ?').get(id) as Record<string, unknown>;
    res.json({ data: patternToDollars(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/dismiss - deactivate recurring pattern
router.post('/:id/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    if (!dismissRecurringPattern(db, String(id)).ok) {
      res.status(404).json({ error: 'Recurring pattern not found' });
      return;
    }

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
