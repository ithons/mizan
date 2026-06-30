import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import {
  getCashflowReport,
  getIncomeReport,
  getReportEvidenceDrilldown,
  getReportDrilldown,
  getReportSummary,
  getSpendingReport,
  getSpendingTrendsReport,
} from '../services/reporting';
import type { ReportComparisonMode, ReportEvidenceKind, ReportExcludedFlowSummary } from '../../../shared/types';

const router = Router();

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function splitQueryValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) =>
    typeof entry === 'string'
      ? entry.split(',').map((part) => part.trim()).filter(Boolean)
      : []
  );
}

function reportComparison(value: unknown): ReportComparisonMode | undefined {
  const parsed = firstQueryValue(value);
  if (
    parsed === 'prior_period' ||
    parsed === 'prior_month' ||
    parsed === 'same_month_last_year' ||
    parsed === 'trailing_3' ||
    parsed === 'trailing_12'
  ) {
    return parsed;
  }
  return undefined;
}

function reportEvidenceKind(value: unknown): ReportEvidenceKind | undefined {
  const parsed = firstQueryValue(value);
  if (parsed === 'cashflow_month' || parsed === 'excluded_flow') {
    return parsed;
  }
  return undefined;
}

function excludedFlowType(value: unknown): ReportExcludedFlowSummary['flow_type'] | undefined {
  const parsed = firstQueryValue(value);
  if (parsed === 'transfers' || parsed === 'investments' || parsed === 'crypto') {
    return parsed;
  }
  return undefined;
}

function isReportMonth(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}$/.test(value);
}

// GET /cashflow?startDate&endDate
router.get('/cashflow', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    res.json({ data: getCashflowReport(db, { startDate, endDate }) });
  } catch (err) {
    next(err);
  }
});

// GET /summary?startDate&endDate
router.get('/summary', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const comparison = reportComparison(req.query.comparison);
    res.json({ data: getReportSummary(db, { startDate, endDate, comparison }) });
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
      data: getSpendingReport(db, {
        startDate,
        endDate,
        parentOnly: parentOnly === 'true',
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /income?startDate&endDate
router.get('/income', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    res.json({ data: getIncomeReport(db, { startDate, endDate }) });
  } catch (err) {
    next(err);
  }
});

// GET /trends?startDate&endDate&categoryIds
router.get('/trends', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const parsedCategoryIds = splitQueryValues(req.query.categoryIds);
    res.json({
      data: getSpendingTrendsReport(db, {
        startDate,
        endDate,
        categoryIds: parsedCategoryIds,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /drilldown?kind=spending|income&categoryId&startDate&endDate
router.get('/drilldown', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const kind = firstQueryValue(req.query.kind);
    const categoryId = firstQueryValue(req.query.categoryId);
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);

    if (kind !== 'spending' && kind !== 'income') {
      res.status(400).json({ error: 'Invalid report drilldown kind' });
      return;
    }
    if (!categoryId) {
      res.status(400).json({ error: 'categoryId is required' });
      return;
    }

    res.json({
      data: getReportDrilldown(db, {
        kind,
        categoryId,
        startDate,
        endDate,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /evidence?kind=cashflow_month|excluded_flow&month&flowType&startDate&endDate
router.get('/evidence', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const kind = reportEvidenceKind(req.query.kind);
    const month = firstQueryValue(req.query.month);
    const flowType = excludedFlowType(req.query.flowType);
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);

    if (!kind) {
      res.status(400).json({ error: 'Invalid report evidence kind' });
      return;
    }
    if (kind === 'cashflow_month' && !isReportMonth(month)) {
      res.status(400).json({ error: 'month is required for cash flow evidence' });
      return;
    }
    if (kind === 'excluded_flow' && !flowType) {
      res.status(400).json({ error: 'flowType is required for excluded flow evidence' });
      return;
    }

    res.json({
      data: getReportEvidenceDrilldown(db, {
        kind,
        month,
        flowType,
        startDate,
        endDate,
      }),
    });
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
