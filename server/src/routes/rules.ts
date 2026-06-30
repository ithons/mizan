import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  ApplyMerchantRulesSchema,
  CreateMerchantRuleSchema,
  UpdateMerchantRuleSchema,
} from '../../../shared/schemas';
import {
  applyMerchantRulesToExistingTransactions,
  suggestMerchantRules,
  upsertMerchantRule,
} from '../services/rules';

const router = Router();

function categoryExists(db: Database.Database, categoryId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId));
}

function getParamId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function getRule(db: Database.Database, id: string) {
  return db.prepare(`
    SELECT
      mr.*,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      (
        SELECT COUNT(*)
        FROM transactions t
        WHERE lower(COALESCE(t.merchant_name, t.original_name, '')) LIKE '%' || lower(mr.pattern) || '%'
      ) AS match_count
    FROM merchant_rules mr
    JOIN categories c ON c.id = mr.category_id
    WHERE mr.id = ?
  `).get(id);
}

// GET / - list rules
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const rules = db.prepare(`
      SELECT
        mr.*,
        c.name AS category_name,
        c.color AS category_color,
        c.icon AS category_icon,
        (
          SELECT COUNT(*)
          FROM transactions t
          WHERE lower(COALESCE(t.merchant_name, t.original_name, '')) LIKE '%' || lower(mr.pattern) || '%'
        ) AS match_count
      FROM merchant_rules mr
      JOIN categories c ON c.id = mr.category_id
      ORDER BY mr.created_at DESC
    `).all();

    res.json({ data: rules });
  } catch (err) {
    next(err);
  }
});

// GET /suggestions - merchants repeatedly categorized the same way
router.get('/suggestions', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    res.json({ data: suggestMerchantRules(db) });
  } catch (err) {
    next(err);
  }
});

// POST / - create or update a rule by pattern
router.post(
  '/',
  validate(CreateMerchantRuleSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as {
        pattern: string;
        category_id: string;
        apply_existing: boolean;
      };

      if (!categoryExists(db, body.category_id)) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      const now = new Date().toISOString();
      const id = upsertMerchantRule(db, body.pattern, body.category_id, now);
      const applied = body.apply_existing
        ? applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true }).updated
        : 0;

      res.status(201).json({ data: { rule: id ? getRule(db, id) : null, applied } });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /:id - update rule
router.patch(
  '/:id',
  validate(UpdateMerchantRuleSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const id = getParamId(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid rule id' });
        return;
      }

      const existing = db.prepare('SELECT id FROM merchant_rules WHERE id = ?').get(id);
      if (!existing) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }

      const body = req.body as {
        pattern?: string;
        category_id?: string;
      };

      if (body.category_id && !categoryExists(db, body.category_id)) {
        res.status(404).json({ error: 'Category not found' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.pattern !== undefined) {
        updates.push('pattern = ?');
        values.push(body.pattern.trim());
      }
      if (body.category_id !== undefined) {
        updates.push('category_id = ?');
        values.push(body.category_id);
      }

      if (updates.length > 0) {
        values.push(id);
        db.prepare(`UPDATE merchant_rules SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      res.json({ data: getRule(db, id) });
    } catch (err) {
      next(err);
    }
  }
);

// POST /apply - apply rules to existing transactions
router.post(
  '/apply',
  validate(ApplyMerchantRulesSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as { only_uncategorized: boolean };
      const result = applyMerchantRulesToExistingTransactions(db, {
        onlyUncategorized: body.only_uncategorized,
      });

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id - delete rule
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = getParamId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid rule id' });
      return;
    }

    const existing = db.prepare('SELECT id FROM merchant_rules WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    db.prepare('DELETE FROM merchant_rules WHERE id = ?').run(id);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
