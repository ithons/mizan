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

// GET / — all categories as flat array with children nested
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

// POST / — create category
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

// PATCH /:id — update category
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

// DELETE /:id
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

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

    const linked = db.prepare(
      'SELECT COUNT(*) as count FROM transactions WHERE category_id = ?'
    ).get(id) as { count: number };

    if (linked.count > 0) {
      res.status(409).json({
        error: `Cannot delete category with ${linked.count} linked transactions. Merge it first.`,
      });
      return;
    }

    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
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

      const source = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
      if (!source) {
        res.status(404).json({ error: 'Source category not found' });
        return;
      }

      const target = db.prepare('SELECT * FROM categories WHERE id = ?').get(targetId);
      if (!target) {
        res.status(404).json({ error: 'Target category not found' });
        return;
      }

      const now = new Date().toISOString();

      // Move all transactions to target
      db.prepare(
        'UPDATE transactions SET category_id = ?, updated_at = ? WHERE category_id = ?'
      ).run(targetId, now, id);

      // Move all budgets to target
      db.prepare(
        'UPDATE budgets SET category_id = ? WHERE category_id = ?'
      ).run(targetId, id);

      // Re-assign child categories to target
      db.prepare(
        'UPDATE categories SET parent_id = ? WHERE parent_id = ?'
      ).run(targetId, id);

      // Delete source
      db.prepare('DELETE FROM categories WHERE id = ?').run(id);

      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
