import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import {
  getCashflowReport,
  getNetWorthAttribution,
  getReportSummary,
  getSpendingReport,
  getSpendingTrendsReport,
  getTopMerchantsReport,
} from '../services/reporting';
import type {
  CashflowReport,
  ReportCategoryChange,
  ReportComparisonMode,
  ReportMetricSummary,
  ReportSummary,
  SpendingReport,
} from '../../../shared/types';
import { dollarizeFields, toDollars } from '../services/money';

const router = Router();

// The reporting service returns every money total in integer cents. These helpers
// dollarize the money fields of each report at this route boundary. Percentages
// (percentage, delta_percent, savings_rate), counts, and dates pass through.
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

function metricToDollars(metric: ReportMetricSummary): ReportMetricSummary {
  return {
    current: toDollars(metric.current),
    previous: toDollars(metric.previous),
    delta: toDollars(metric.delta),
    delta_percent: metric.delta_percent,
  };
}

function categoryChangeToDollars(change: ReportCategoryChange): ReportCategoryChange {
  return {
    ...change,
    current: toDollars(change.current),
    previous: toDollars(change.previous),
    delta: toDollars(change.delta),
  };
}

function summaryToDollars(summary: ReportSummary): ReportSummary {
  return {
    ...summary,
    income: metricToDollars(summary.income),
    expenses: metricToDollars(summary.expenses),
    net: metricToDollars(summary.net),
    // savings_rate is a percentage metric, not money — pass through.
    top_spending: summary.top_spending.map(categoryChangeToDollars),
    top_income: summary.top_income.map(categoryChangeToDollars),
    spending_movers: summary.spending_movers.map(categoryChangeToDollars),
    excluded_flows: summary.excluded_flows.map((flow) => ({
      ...flow,
      inflows: toDollars(flow.inflows),
      outflows: toDollars(flow.outflows),
      net: toDollars(flow.net),
    })),
  };
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
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

// GET /summary?startDate&endDate
router.get('/summary', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const comparison = reportComparison(req.query.comparison);
    res.json({ data: summaryToDollars(getReportSummary(db, { startDate, endDate, comparison })) });
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

// GET /trends?startDate&endDate&categoryIds=a,b
// Per-category monthly spend series. The service existed but had no route, so nothing could reach it.
router.get('/trends', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const rawCategoryIds = firstQueryValue(req.query.categoryIds);
    const categoryIds = rawCategoryIds
      ? rawCategoryIds.split(',').map((id) => id.trim()).filter(Boolean)
      : undefined;

    const report = getSpendingTrendsReport(db, { startDate, endDate, categoryIds });
    res.json({
      data: {
        months: report.months,
        series: report.series.map((s) => ({ ...s, values: s.values.map(toDollars) })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /merchants?startDate&endDate&limit
router.get('/merchants', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const rawLimit = firstQueryValue(req.query.limit);
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

    const report = getTopMerchantsReport(db, { startDate, endDate, limit });
    res.json({
      data: {
        merchants: report.merchants.map((m) => ({ ...m, total: toDollars(m.total) })),
        total: toDollars(report.total),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /networth-attribution?startDate&endDate
// Returns null when the window holds fewer than two snapshots — nothing moved to attribute.
router.get('/networth-attribution', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);

    const report = getNetWorthAttribution(db, { startDate, endDate });
    if (!report) {
      res.json({ data: null });
      return;
    }

    res.json({
      data: {
        ...report,
        start_net_worth: toDollars(report.start_net_worth),
        end_net_worth: toDollars(report.end_net_worth),
        delta: toDollars(report.delta),
        accounts: report.accounts.map((a) => ({
          ...a,
          start_balance: toDollars(a.start_balance),
          end_balance: toDollars(a.end_balance),
          delta: toDollars(a.delta),
        })),
      },
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
        -- COALESCE(cost_basis, 0) would charge the whole market value against a basis of zero and
        -- report an unknown-basis position as 100% gain. A money-market sweep has no basis to
        -- know, so the honest answer is NULL and the caller renders nothing.
        CASE
          WHEN COALESCE(h.manual_cost_basis, h.cost_basis) > 0
          THEN h.institution_value - COALESCE(h.manual_cost_basis, h.cost_basis)
        END AS unrealized_gain
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

    // is_estimated travels with the point. TrendChart already knows how to draw a reconstruction
    // differently from a measurement; this endpoint was the one consumer that never told it.
    const snapshots = db.prepare(`
      SELECT
        date,
        COALESCE(investment_assets, 0) AS value,
        is_estimated
      FROM net_worth_snapshots
      ${where}
      ORDER BY date ASC
    `).all(...params);

    // Total portfolio value
    const totalValue = db.prepare(
      'SELECT SUM(institution_value) AS total FROM holdings'
    ).get() as { total: number | null };

    const history = (snapshots as Array<{ date: string; value: number; is_estimated: number }>).map(
      (snapshot) => ({
        date: snapshot.date,
        value: toDollars(snapshot.value),
        estimated: snapshot.is_estimated === 1,
      })
    );

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
