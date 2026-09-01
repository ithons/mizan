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
import { dollarizeFields, toDollars, toDollarsOrNull } from '../services/money';
import type {
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringOccurrenceAdjustment,
  SubscriptionInsightItem,
  SubscriptionInsights,
} from '../../../shared/types';
import { format, addDays } from 'date-fns';

const router = Router();

// recurring_patterns.average_amount (and the computed average_signed_amount), forecast
// totals/occurrence amounts, subscription amounts, and adjusted_amount are all stored/
// computed in integer cents; dollarize each money field at this route boundary.
// Confidence, percentages, counts, days, dates, and ids are not money.
const PATTERN_MONEY_FIELDS = ['average_amount', 'average_signed_amount'] as const;

function patternToDollars(row: Record<string, unknown>): Record<string, unknown> {
  return dollarizeFields(row, PATTERN_MONEY_FIELDS);
}

function occurrenceToDollars(occurrence: RecurringForecastOccurrence): RecurringForecastOccurrence {
  return {
    ...occurrence,
    amount: toDollars(occurrence.amount),
    adjusted_amount: toDollarsOrNull(occurrence.adjusted_amount),
  };
}

function forecastToDollars(forecast: RecurringForecast): RecurringForecast {
  return {
    ...forecast,
    income: toDollars(forecast.income),
    bills: toDollars(forecast.bills),
    net: toDollars(forecast.net),
    confirmed_income: toDollars(forecast.confirmed_income),
    confirmed_bills: toDollars(forecast.confirmed_bills),
    likely_income: toDollars(forecast.likely_income),
    likely_bills: toDollars(forecast.likely_bills),
    uncertain_income: toDollars(forecast.uncertain_income),
    uncertain_bills: toDollars(forecast.uncertain_bills),
    occurrences: forecast.occurrences.map(occurrenceToDollars),
  };
}

function subscriptionItemToDollars(item: SubscriptionInsightItem): SubscriptionInsightItem {
  return {
    ...item,
    average_amount: toDollars(item.average_amount),
    monthly_amount: toDollars(item.monthly_amount),
    upcoming_amount: toDollars(item.upcoming_amount),
    latest_amount: toDollarsOrNull(item.latest_amount),
    previous_amount: toDollarsOrNull(item.previous_amount),
    increase_amount: toDollarsOrNull(item.increase_amount),
    // increase_percent is a ratio, not money.
  };
}

function subscriptionInsightsToDollars(insights: SubscriptionInsights): SubscriptionInsights {
  return {
    ...insights,
    total_monthly_amount: toDollars(insights.total_monthly_amount),
    total_upcoming_amount: toDollars(insights.total_upcoming_amount),
    confirmed_monthly_amount: toDollars(insights.confirmed_monthly_amount),
    unconfirmed_monthly_amount: toDollars(insights.unconfirmed_monthly_amount),
    subscriptions: insights.subscriptions.map(subscriptionItemToDollars),
    increases: insights.increases.map(subscriptionItemToDollars),
    unconfirmed: insights.unconfirmed.map(subscriptionItemToDollars),
    upcoming: insights.upcoming.map(subscriptionItemToDollars),
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
    `).all(endDate) as Record<string, unknown>[];

    res.json({ data: patterns.map(patternToDollars) });
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

router.get('/subscriptions', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const days = parseDays(req.query.days ?? '60');
    if (days === null) {
      res.status(400).json({ error: 'Invalid days filter' });
      return;
    }

    res.json({ data: subscriptionInsightsToDollars(buildSubscriptionInsights(db, days)) });
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

    res.json({ data: listRecurringAdjustments(db, id).map(adjustmentToDollars) });
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

    const pattern = db.prepare('SELECT id FROM recurring_patterns WHERE id = ?').get(id);
    if (!pattern) {
      res.status(404).json({ error: 'Recurring pattern not found' });
      return;
    }

    const now = new Date().toISOString();
    const dismissPattern = db.transaction(() => {
      // `dismissed_at` is what makes this decision durable. Without it the row was deleted by
      // the next detection pass (see migration 057) and the bill came back two syncs later.
      db.prepare(
        'UPDATE recurring_patterns SET is_active = 0, is_confirmed = 0, dismissed_at = ?, updated_at = ? WHERE id = ?'
      ).run(now, now, id);

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

      const updated = db.prepare('SELECT * FROM recurring_patterns WHERE id = ?').get(id) as Record<string, unknown>;
      res.json({ data: patternToDollars(updated) });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
