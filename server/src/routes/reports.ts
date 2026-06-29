import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';

const router = Router();

// GET /cashflow?startDate&endDate
router.get('/cashflow', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate } = req.query as Record<string, string>;

    const conditions: string[] = ['t.pending = 0'];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('t.date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('t.date <= ?');
      params.push(endDate);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m', t.date) AS month,
        SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS income,
        SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS expenses
      FROM transactions t
      ${where}
      GROUP BY month
      ORDER BY month ASC
    `).all(...params) as Array<{ month: string; income: number; expenses: number }>;

    const months = rows.map(r => ({
      month: r.month,
      income: r.income || 0,
      expenses: r.expenses || 0,
      net: (r.income || 0) - (r.expenses || 0),
    }));

    res.json({ data: { months } });
  } catch (err) {
    next(err);
  }
});

// GET /spending?startDate&endDate&parentOnly
router.get('/spending', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate, parentOnly } = req.query as Record<string, string>;

    const conditions: string[] = ['t.amount < 0', 't.pending = 0'];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('t.date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('t.date <= ?');
      params.push(endDate);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    interface SpendingRow {
      category_id: string | null;
      category_name: string | null;
      color: string | null;
      parent_id: string | null;
      amount: number;
    }

    const rows = db.prepare(`
      SELECT
        c.id AS category_id,
        c.name AS category_name,
        c.color,
        c.parent_id,
        SUM(ABS(t.amount)) AS amount
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      ${where}
      GROUP BY t.category_id
      ORDER BY amount DESC
    `).all(...params) as SpendingRow[];

    const total = rows.reduce((sum, r) => sum + (r.amount || 0), 0);

    const categoryRows = db.prepare(`
      SELECT id, name, color, parent_id
      FROM categories
    `).all() as Array<{
      id: string;
      name: string;
      color: string | null;
      parent_id: string | null;
    }>;
    const categoriesById = new Map(categoryRows.map((c) => [c.id, c]));

    interface SpendingCategory {
      category_id: string;
      category_name: string;
      color: string | null;
      amount: number;
      percentage: number;
      children?: SpendingCategory[];
    }

    const rootsById = new Map<string, SpendingCategory & { children: SpendingCategory[] }>();

    const ensureRoot = (
      categoryId: string,
      categoryName: string,
      color: string | null
    ): SpendingCategory & { children: SpendingCategory[] } => {
      const existing = rootsById.get(categoryId);
      if (existing) return existing;

      const root = {
        category_id: categoryId,
        category_name: categoryName,
        color,
        amount: 0,
        percentage: 0,
        children: [],
      };
      rootsById.set(categoryId, root);
      return root;
    };

    for (const row of rows) {
      const amount = row.amount || 0;

      if (!row.category_id) {
        const root = ensureRoot('uncategorized', 'Uncategorized', row.color);
        root.amount += amount;
        continue;
      }

      if (row.parent_id) {
        const parent = categoriesById.get(row.parent_id);
        const root = ensureRoot(
          row.parent_id,
          parent?.name ?? row.category_name ?? 'Other',
          parent?.color ?? row.color
        );
        root.amount += amount;
        root.children.push({
          category_id: row.category_id,
          category_name: row.category_name ?? 'Other',
          color: row.color,
          amount,
          percentage: 0,
        });
        continue;
      }

      const root = ensureRoot(
        row.category_id,
        row.category_name ?? 'Other',
        row.color
      );
      root.amount += amount;
    }

    const categories = Array.from(rootsById.values())
      .map((category) => {
        const children = category.children
          .sort((a, b) => b.amount - a.amount)
          .map((child) => ({
            ...child,
            percentage: total > 0 ? (child.amount / total) * 100 : 0,
          }));

        const result: SpendingCategory = {
          category_id: category.category_id,
          category_name: category.category_name,
          color: category.color,
          amount: category.amount,
          percentage: total > 0 ? (category.amount / total) * 100 : 0,
        };

        if (parentOnly !== 'true' && children.length > 0) {
          result.children = children;
        }

        return result;
      })
      .sort((a, b) => b.amount - a.amount);

    res.json({ data: { categories, total } });
  } catch (err) {
    next(err);
  }
});

// GET /income?startDate&endDate
router.get('/income', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate } = req.query as Record<string, string>;

    const conditions: string[] = ['t.amount > 0', 't.pending = 0'];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('t.date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('t.date <= ?');
      params.push(endDate);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = db.prepare(`
      SELECT
        c.id AS category_id,
        c.name AS category_name,
        c.color,
        SUM(t.amount) AS amount
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      ${where}
      GROUP BY t.category_id
      ORDER BY amount DESC
    `).all(...params) as Array<{ category_id: string | null; category_name: string | null; color: string | null; amount: number }>;

    const total = rows.reduce((sum, r) => sum + (r.amount || 0), 0);

    const categories = rows.map(r => ({
      category_id: r.category_id || 'uncategorized',
      category_name: r.category_name || 'Uncategorized',
      color: r.color,
      amount: r.amount || 0,
      percentage: total > 0 ? ((r.amount || 0) / total) * 100 : 0,
    }));

    res.json({ data: { categories, total } });
  } catch (err) {
    next(err);
  }
});

// GET /trends?startDate&endDate&categoryIds
router.get('/trends', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate, categoryIds } = req.query as Record<string, string>;

    const conditions: string[] = ['t.pending = 0', 't.amount < 0'];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('t.date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('t.date <= ?');
      params.push(endDate);
    }

    const parsedCategoryIds = categoryIds
      ? categoryIds.split(',').map(id => id.trim()).filter(Boolean)
      : [];

    const categoryRows = db.prepare(`
      SELECT id, name, color, parent_id
      FROM categories
    `).all() as Array<{
      id: string;
      name: string;
      color: string | null;
      parent_id: string | null;
    }>;
    const categoriesById = new Map(categoryRows.map((category) => [category.id, category]));
    const childrenByParent = new Map<string, string[]>();
    for (const category of categoryRows) {
      if (!category.parent_id) continue;
      const existing = childrenByParent.get(category.parent_id) ?? [];
      existing.push(category.id);
      childrenByParent.set(category.parent_id, existing);
    }

    const collectDescendants = (categoryId: string): string[] => {
      const children = childrenByParent.get(categoryId) ?? [];
      return children.flatMap((childId) => [childId, ...collectDescendants(childId)]);
    };

    const selectedCategoryIds = new Set(parsedCategoryIds);
    const expandedCategoryIds = new Set(
      parsedCategoryIds.flatMap((categoryId) => [categoryId, ...collectDescendants(categoryId)])
    );

    if (parsedCategoryIds.length > 0) {
      const expandedIds = Array.from(expandedCategoryIds);
      conditions.push(`t.category_id IN (${expandedIds.map(() => '?').join(',')})`);
      params.push(...expandedIds);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    interface TrendRow {
      month: string;
      category_id: string | null;
      category_name: string | null;
      color: string | null;
      amount: number;
    }

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m', t.date) AS month,
        c.id AS category_id,
        c.name AS category_name,
        c.color,
        SUM(ABS(t.amount)) AS amount
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      ${where}
      GROUP BY month, t.category_id
      ORDER BY month ASC, amount DESC
    `).all(...params) as TrendRow[];

    const getSelectedSeriesCategoryId = (categoryId: string | null): string | null => {
      if (!categoryId || selectedCategoryIds.size === 0) return categoryId;

      let currentId: string | null = categoryId;
      while (currentId) {
        if (selectedCategoryIds.has(currentId)) return currentId;
        currentId = categoriesById.get(currentId)?.parent_id ?? null;
      }

      return null;
    };

    // Build sorted month list
    const monthSet = new Set<string>();
    for (const r of rows) monthSet.add(r.month);
    const months = Array.from(monthSet).sort();

    // Build series keyed by category
    const seriesMap = new Map<string, { category_id: string; category_name: string; color: string | null; valuesByMonth: Map<string, number> }>();
    for (const r of rows) {
      const seriesCategoryId = getSelectedSeriesCategoryId(r.category_id);
      if (parsedCategoryIds.length > 0 && !seriesCategoryId) continue;

      const key = seriesCategoryId ?? 'uncategorized';
      const category = categoriesById.get(key);
      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          category_id: key,
          category_name: category?.name ?? r.category_name ?? 'Uncategorized',
          color: category?.color ?? r.color,
          valuesByMonth: new Map(),
        });
      }
      const valuesByMonth = seriesMap.get(key)!.valuesByMonth;
      valuesByMonth.set(r.month, (valuesByMonth.get(r.month) ?? 0) + (r.amount || 0));
    }

    const series = Array.from(seriesMap.values()).map((s) => ({
      category_id: s.category_id,
      category_name: s.category_name,
      color: s.color,
      values: months.map((m) => s.valuesByMonth.get(m) ?? 0),
    }));

    res.json({ data: { months, series } });
  } catch (err) {
    next(err);
  }
});

// GET /networth?startDate&endDate
router.get('/networth', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate } = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('date <= ?');
      params.push(endDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const snapshots = db.prepare(`
      SELECT * FROM net_worth_snapshots
      ${where}
      ORDER BY date ASC
    `).all(...params);

    res.json({ data: { snapshots } });
  } catch (err) {
    next(err);
  }
});

// GET /investments?startDate&endDate
router.get('/investments', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate } = req.query as Record<string, string>;

    // Current allocation by security type
    const allocation = db.prepare(`
      SELECT
        s.type AS security_type,
        SUM(h.institution_value) AS total_value
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      GROUP BY s.type
      ORDER BY total_value DESC
    `).all();

    // P&L table: holdings with cost_basis
    const holdings = db.prepare(`
      SELECT
        h.*,
        s.ticker,
        s.name AS security_name,
        s.type AS security_type,
        (h.institution_value - COALESCE(h.cost_basis, 0)) AS unrealized_gain
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      ORDER BY h.institution_value DESC
    `).all();

    // Portfolio value over time from net worth snapshots. Investment transaction
    // volume is not portfolio value and should not drive a value-history chart.
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('date <= ?');
      params.push(endDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const snapshots = db.prepare(`
      SELECT
        date,
        COALESCE(investment_assets, 0) AS value
      FROM net_worth_snapshots
      ${where}
      ORDER BY date ASC
    `).all(...params);

    // Total portfolio value
    const totalValue = db.prepare(
      'SELECT SUM(institution_value) AS total FROM holdings'
    ).get() as { total: number | null };

    const history = (snapshots as Array<{ date: string; value: number }>).map((snapshot) => ({
      date: snapshot.date,
      value: snapshot.value,
    }));

    res.json({
      data: {
        total_value: totalValue.total || 0,
        allocation,
        holdings,
        history,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
