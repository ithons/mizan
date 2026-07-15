import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { getCashflowReport, getSpendingReport } from '../services/reporting';
import type { CashflowReport, SpendingReport } from '../../../shared/types';
import { dollarizeFields, toDollars } from '../services/money';

const router = Router();

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

// The reporting service returns money totals in integer cents; dollarize at this boundary.
// Percentages, counts, and dates pass through.
type SpendingCategory = SpendingReport['categories'][number];

function spendingCategoryToDollars(node: SpendingCategory): SpendingCategory {
  return {
    ...node,
    amount: toDollars(node.amount),
    ...(node.children ? { children: node.children.map(spendingCategoryToDollars) } : {}),
  };
}

function spendingReportToDollars(report: SpendingReport): SpendingReport {
  return {
    categories: report.categories.map(spendingCategoryToDollars),
    total: toDollars(report.total),
  };
}

function cashflowToDollars(report: CashflowReport): CashflowReport {
  return {
    months: report.months.map((month) => ({
      month: month.month,
      income: toDollars(month.income),
      expenses: toDollars(month.expenses),
      net: toDollars(month.net),
    })),
  };
}

// GET /cashflow?startDate&endDate
router.get('/cashflow', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    res.json({ data: cashflowToDollars(getCashflowReport(db, { startDate, endDate })) });
  } catch (err) {
    next(err);
  }
});

// GET /spending?startDate&endDate&parentOnly
router.get('/spending', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const parentOnly = firstQueryValue(req.query.parentOnly);
    res.json({
      data: spendingReportToDollars(getSpendingReport(db, {
        startDate,
        endDate,
        parentOnly: parentOnly === 'true',
      })),
    });
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
    const allocation = (db.prepare(`
      SELECT
        s.type AS security_type,
        SUM(h.institution_value) AS total_value
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      GROUP BY s.type
      ORDER BY total_value DESC
    `).all() as Array<Record<string, unknown>>).map((row) =>
      dollarizeFields(row, ['total_value'])
    );

    // P&L table: holdings with cost_basis. institution_price/quantity are per-unit and
    // stay as-is; the value/basis/gain columns are cents and convert to dollars.
    const holdings = (db.prepare(`
      SELECT
        h.*,
        s.ticker,
        s.name AS security_name,
        s.type AS security_type,
        (h.institution_value - COALESCE(h.cost_basis, 0)) AS unrealized_gain
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      ORDER BY h.institution_value DESC
    `).all() as Array<Record<string, unknown>>).map((row) =>
      dollarizeFields(row, ['institution_value', 'cost_basis', 'manual_cost_basis', 'unrealized_gain'])
    );

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
      value: toDollars(snapshot.value),
    }));

    res.json({
      data: {
        total_value: toDollars(totalValue.total || 0),
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
