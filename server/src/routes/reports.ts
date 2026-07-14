import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import {
  getCashflowReport,
  getIncomeReport,
  getReportEvidenceDrilldown,
  getReportNetWorthEvidence,
  getReportDrilldown,
  getReportSummary,
  getSpendingReport,
  getSpendingTrendsReport,
} from '../services/reporting';
import type {
  CashflowReport,
  NetWorthSnapshot,
  ReportCategoryChange,
  ReportComparisonMode,
  ReportDrilldown,
  ReportEvidenceDrilldown,
  ReportEvidenceKind,
  ReportExcludedFlowSummary,
  ReportMetricSummary,
  ReportNetWorthEvidence,
  ReportSummary,
  SpendingReport,
  Transaction,
} from '../../../shared/types';
import type { TrendReport } from '../services/reporting';
import { dollarizeFields, toDollars, toDollarsOrNull } from '../services/money';

const router = Router();

const SNAPSHOT_MONEY_FIELDS = [
  'total_assets',
  'total_liabilities',
  'net_worth',
  'liquid_assets',
  'investment_assets',
  'crypto_assets',
] as const;

// net_worth_snapshots stores totals and the per-account `breakdown` JSON in cents;
// convert numeric columns and restringify breakdown values to the dollar contract.
function dollarizeBreakdownString(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return value;
    const out: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(parsed)) {
      out[id] = typeof v === 'number' ? toDollars(v) : v;
    }
    return JSON.stringify(out);
  } catch {
    return value;
  }
}

function dollarizeSnapshotRow(row: unknown): unknown {
  if (row == null || typeof row !== 'object') return row;
  const converted = dollarizeFields(row as Record<string, unknown>, SNAPSHOT_MONEY_FIELDS);
  if (typeof converted.breakdown === 'string') {
    converted.breakdown = dollarizeBreakdownString(converted.breakdown);
  }
  return converted;
}

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

function transactionsToDollars(rows: Transaction[]): Transaction[] {
  return rows.map(
    (row) => dollarizeFields(row as unknown as Record<string, unknown>, ['amount']) as unknown as Transaction
  );
}

function trendsToDollars(report: TrendReport): TrendReport {
  return {
    months: report.months,
    series: report.series.map((series) => ({
      ...series,
      values: series.values.map(toDollars),
    })),
  };
}

function drilldownToDollars(drilldown: ReportDrilldown): ReportDrilldown {
  return {
    ...drilldown,
    total: toDollars(drilldown.total),
    transactions: transactionsToDollars(drilldown.transactions),
  };
}

function evidenceToDollars(evidence: ReportEvidenceDrilldown): ReportEvidenceDrilldown {
  return {
    ...evidence,
    income: toDollars(evidence.income),
    expenses: toDollars(evidence.expenses),
    net: toDollars(evidence.net),
    total: toDollars(evidence.total),
    transactions: transactionsToDollars(evidence.transactions),
  };
}

function networthEvidenceToDollars(evidence: ReportNetWorthEvidence): ReportNetWorthEvidence {
  return {
    ...evidence,
    snapshot: dollarizeSnapshotRow(evidence.snapshot) as NetWorthSnapshot,
    previous_snapshot: evidence.previous_snapshot
      ? (dollarizeSnapshotRow(evidence.previous_snapshot) as NetWorthSnapshot)
      : null,
    delta: toDollarsOrNull(evidence.delta),
    asset_delta: toDollarsOrNull(evidence.asset_delta),
    liability_delta: toDollarsOrNull(evidence.liability_delta),
    accounts: evidence.accounts.map((account) => ({
      ...account,
      balance: toDollars(account.balance),
    })),
  };
}

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

// GET /income?startDate&endDate
router.get('/income', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    res.json({ data: spendingReportToDollars(getIncomeReport(db, { startDate, endDate })) });
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
      data: trendsToDollars(getSpendingTrendsReport(db, {
        startDate,
        endDate,
        categoryIds: parsedCategoryIds,
      })),
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
      data: drilldownToDollars(getReportDrilldown(db, {
        kind,
        categoryId,
        startDate,
        endDate,
      })),
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
      data: evidenceToDollars(getReportEvidenceDrilldown(db, {
        kind,
        month,
        flowType,
        startDate,
        endDate,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /networth/evidence?snapshotId
router.get('/networth/evidence', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const snapshotId = firstQueryValue(req.query.snapshotId);

    if (!snapshotId) {
      res.status(400).json({ error: 'snapshotId is required' });
      return;
    }

    const evidence = getReportNetWorthEvidence(db, snapshotId);
    if (!evidence) {
      res.status(404).json({ error: 'Net worth snapshot not found' });
      return;
    }

    res.json({ data: networthEvidenceToDollars(evidence) });
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
    `).all(...params).map(dollarizeSnapshotRow);

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
