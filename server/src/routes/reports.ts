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

    // Roll up to parent if requested
    if (parentOnly === 'true') {
      const parentTotals = new Map<string, { category_id: string; category_name: string; color: string | null; amount: number }>();

      for (const row of rows) {
        // If the category has a parent, roll up to the parent
        const key = row.parent_id || row.category_id || 'uncategorized';
        const name = row.category_id
          ? row.parent_id
            ? (db.prepare('SELECT name, color FROM categories WHERE id = ?').get(row.parent_id) as { name: string; color: string | null } | undefined)?.name || row.category_name || 'Other'
            : row.category_name || 'Other'
          : 'Uncategorized';
        const color = row.parent_id
          ? (db.prepare('SELECT color FROM categories WHERE id = ?').get(row.parent_id) as { color: string | null } | undefined)?.color || null
          : row.color;

        if (!parentTotals.has(key)) {
          parentTotals.set(key, {
            category_id: key,
            category_name: name as string,
            color: color || null,
            amount: 0,
          });
        }
        parentTotals.get(key)!.amount += row.amount || 0;
      }

      const categories = Array.from(parentTotals.values())
        .sort((a, b) => b.amount - a.amount)
        .map(c => ({
          ...c,
          percentage: total > 0 ? (c.amount / total) * 100 : 0,
        }));

      res.json({ data: { categories, total } });
      return;
    }

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

    if (parsedCategoryIds.length > 0) {
      conditions.push(`t.category_id IN (${parsedCategoryIds.map(() => '?').join(',')})`);
      params.push(...parsedCategoryIds);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

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
    `).all(...params);

    res.json({ data: rows });
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

    // Portfolio value over time (from investment_transactions aggregated)
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

    const transactions = db.prepare(`
      SELECT
        strftime('%Y-%m', date) AS month,
        SUM(ABS(amount)) AS total_volume
      FROM investment_transactions
      ${where}
      GROUP BY month
      ORDER BY month ASC
    `).all(...params);

    // Total portfolio value
    const totalValue = db.prepare(
      'SELECT SUM(institution_value) AS total FROM holdings'
    ).get() as { total: number | null };

    res.json({
      data: {
        total_value: totalValue.total || 0,
        allocation,
        holdings,
        monthly_volume: transactions,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
