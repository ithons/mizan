import type Database from 'better-sqlite3';
import { parseBreakdown, transfersInTransit } from './inTransit';
import {
  excludedFromTotalsSql,
  expenseSideSql,
  incomeSideSql,
  reportDateSql,
  spendAmountSql,
  REPORT_SCOPE_ROOT_IDS,
  type ReportBasis,
} from './transactionFilters';
import {
  addDays,
  differenceInCalendarDays,
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
  subDays,
  subMonths,
  subYears,
} from 'date-fns';
import type {
  CashflowReport,
  ReportCategoryChange,
  ReportComparisonMode,
  ReportExcludedFlowSummary,
  ReportMetricSummary,
  NullableMetricSummary,
  ReportSummary,
  SpendingReport,
  NetWorthAttribution,
  TopMerchantsReport,
} from '../../../shared/types';
import { netWorthTimeline } from './netWorthTimeline';

// Every report object this module returns keeps money TOTALS in integer cents.
// Dollarization happens exclusively at the route boundary (routes/reports.ts) or,
// for AI text, at the fmt() call site. Percentages, counts, and ratios pass through.

interface ReportDateRange {
  startDate?: string;
  endDate?: string;
  comparison?: ReportComparisonMode;
  basis?: ReportBasis;
}

interface SpendingReportOptions extends ReportDateRange {
  parentOnly?: boolean;
}

export interface TrendReport {
  months: string[];
  series: Array<{
    category_id: string;
    category_name: string;
    color: string | null;
    values: number[];
  }>;
}

const EXCLUDED_ROOT_PLACEHOLDERS = REPORT_SCOPE_ROOT_IDS.map(() => '?').join(',');

function excludedCategoriesCte(): string {
  return `
    WITH RECURSIVE excluded_report_categories(id) AS (
      SELECT id FROM categories WHERE id IN (${EXCLUDED_ROOT_PLACEHOLDERS})
      UNION ALL
      SELECT c.id
      FROM categories c
      JOIN excluded_report_categories excluded ON c.parent_id = excluded.id
    )
  `;
}

function excludedCategoriesWithRootCte(): string {
  return `
    WITH RECURSIVE excluded_report_categories(id, root_id) AS (
      SELECT id, id FROM categories WHERE id IN (${EXCLUDED_ROOT_PLACEHOLDERS})
      UNION ALL
      SELECT c.id, excluded.root_id
      FROM categories c
      JOIN excluded_report_categories excluded ON c.parent_id = excluded.id
    )
  `;
}

function reportableCategoryCondition(): string {
  return `(
    (t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM excluded_report_categories))
    AND ${excludedFromTotalsSql('t')}
  )`;
}

function incomeCategoryCondition(): string {
  return `(${reportableCategoryCondition()}) AND ${incomeSideSql('t', 'c')}`;
}

function expenseCategoryCondition(): string {
  return `(${reportableCategoryCondition()}) AND ${expenseSideSql('t', 'c')}`;
}

function dateConditions(range: ReportDateRange): { conditions: string[]; params: unknown[] } {
  const conditions = ['t.pending = 0'];
  const params: unknown[] = [];
  const date = reportDateSql('t', range.basis);

  if (range.startDate) {
    conditions.push(`${date} >= ?`);
    params.push(range.startDate);
  }
  if (range.endDate) {
    conditions.push(`${date} <= ?`);
    params.push(range.endDate);
  }

  return { conditions, params };
}

function excludedCategoryParams(): string[] {
  return [...REPORT_SCOPE_ROOT_IDS];
}

function metric(current: number, previous: number): ReportMetricSummary {
  const delta = current - previous;
  return {
    current,
    previous,
    delta,
    delta_percent: previous !== 0 ? (delta / Math.abs(previous)) * 100 : null,
  };
}

function totalsFromCashflow(report: CashflowReport): { income: number; expenses: number; net: number } {
  return report.months.reduce(
    (totals, month) => ({
      income: totals.income + month.income,
      expenses: totals.expenses + month.expenses,
      net: totals.net + month.net,
    }),
    { income: 0, expenses: 0, net: 0 }
  );
}

/**
 * Null when there is no income in the window.
 *
 * This returned 0, which reads as "you saved nothing" rather than "there is nothing to compute a
 * rate from". Every month reported a 0% savings rate for as long as it took the first paycheck to
 * land, and the advisor's "improve your savings rate" prompt fired on it.
 */
function savingsRate(income: number, expenses: number): number | null {
  return income > 0 ? ((income - expenses) / income) * 100 : null;
}

function nullableMetric(current: number | null, previous: number | null): NullableMetricSummary {
  const delta = current !== null && previous !== null ? current - previous : null;
  return {
    current,
    previous,
    delta,
    delta_percent: delta !== null && previous !== null && previous !== 0
      ? (delta / Math.abs(previous)) * 100
      : null,
  };
}

function previousRange(range: ReportDateRange): ReportDateRange {
  if (!range.startDate || !range.endDate) return {};

  const start = parseISO(range.startDate);
  const end = parseISO(range.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return {};

  const dayCount = differenceInCalendarDays(end, start) + 1;
  const previousEnd = subDays(start, 1);
  const previousStart = addDays(previousEnd, 1 - dayCount);

  return {
    startDate: format(previousStart, 'yyyy-MM-dd'),
    endDate: format(previousEnd, 'yyyy-MM-dd'),
  };
}

function comparisonLabel(comparison: ReportComparisonMode): string {
  if (comparison === 'prior_month') return 'Prior month';
  if (comparison === 'same_month_last_year') return 'Same month last year';
  if (comparison === 'trailing_3') return 'Trailing 3 months';
  if (comparison === 'trailing_12') return 'Trailing 12 months';
  return 'Prior period';
}

function calendarMonthRange(date: Date): ReportDateRange {
  return {
    startDate: format(startOfMonth(date), 'yyyy-MM-dd'),
    endDate: format(endOfMonth(date), 'yyyy-MM-dd'),
  };
}

function comparisonRange(
  range: ReportDateRange,
  comparison: ReportComparisonMode
): ReportDateRange {
  if (!range.startDate || !range.endDate) return {};

  const start = parseISO(range.startDate);
  const end = parseISO(range.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return {};

  if (comparison === 'prior_month') {
    return calendarMonthRange(subMonths(start, 1));
  }

  if (comparison === 'same_month_last_year') {
    return calendarMonthRange(subYears(start, 1));
  }

  if (comparison === 'trailing_3' || comparison === 'trailing_12') {
    const months = comparison === 'trailing_3' ? 3 : 12;
    return {
      startDate: format(subMonths(start, months), 'yyyy-MM-dd'),
      endDate: format(subDays(start, 1), 'yyyy-MM-dd'),
    };
  }

  return previousRange(range);
}

/**
 * Flatten a report's categories into the comparison shape, optionally against a prior period.
 *
 * Without `previous` every row claimed `previous: 0` and `delta: <the whole amount>`, i.e. that
 * every category was brand new this period. `top_spending` and `top_income` on the report summary
 * were built that way and shipped that fiction to anything reading `.delta`. Callers that genuinely
 * have no comparison pass nothing and get nulls, which is the honest shape for "not compared".
 */
function flattenReportCategories(
  report: SpendingReport,
  previous?: SpendingReport
): ReportCategoryChange[] {
  const previousById = previous
    ? new Map(previous.categories.map((category) => [category.category_id, category.amount]))
    : null;

  return report.categories.map((category) => {
    const priorAmount = previousById?.get(category.category_id) ?? (previousById ? 0 : null);
    const delta = priorAmount === null ? null : category.amount - priorAmount;
    return {
      category_id: category.category_id,
      category_name: category.category_name,
      color: category.color,
      current: category.amount,
      previous: priorAmount ?? 0,
      delta: delta ?? 0,
      delta_percent:
        priorAmount === null || priorAmount === 0 || delta === null
          ? null
          : (delta / Math.abs(priorAmount)) * 100,
    };
  });
}

function categoryChanges(
  current: SpendingReport,
  previous: SpendingReport,
  limit: number
): ReportCategoryChange[] {
  const currentById = new Map(flattenReportCategories(current).map((category) => [category.category_id, category]));
  const previousById = new Map(flattenReportCategories(previous).map((category) => [category.category_id, category]));
  const ids = new Set([...currentById.keys(), ...previousById.keys()]);

  return Array.from(ids)
    .map((id) => {
      const currentCategory = currentById.get(id);
      const previousCategory = previousById.get(id);
      const currentAmount = currentCategory?.current ?? 0;
      const previousAmount = previousCategory?.current ?? 0;
      const delta = currentAmount - previousAmount;

      return {
        category_id: id,
        category_name: currentCategory?.category_name ?? previousCategory?.category_name ?? 'Uncategorized',
        color: currentCategory?.color ?? previousCategory?.color,
        current: currentAmount,
        previous: previousAmount,
        delta,
        delta_percent: previousAmount !== 0 ? (delta / Math.abs(previousAmount)) * 100 : null,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

function excludedFlowType(rootId: string): ReportExcludedFlowSummary['flow_type'] {
  if (rootId === 'cat_inv') return 'investments';
  if (rootId === 'cat_crypto') return 'crypto';
  return 'transfers';
}

export interface CompleteMonthsAverage {
  startDate: string;
  endDate: string;
  /** Every month in the window, yyyy-MM, including any with no rows. */
  months: string[];
  /** How many of those months had any counted row. */
  monthsWithRows: number;
  /** Cents per month, signed, divided by the whole window: a refund-heavy month nets spending down and an empty month counts as zero. */
  income: number;
  expenses: number;
}

/** The last `count` complete months of cash flow, averaged over all of them. */
export function averageOfCompleteMonths(db: Database.Database, count: number, today = new Date()): CompleteMonthsAverage {
  const startDate = format(startOfMonth(subMonths(today, count)), 'yyyy-MM-dd');
  const endDate = format(endOfMonth(subMonths(today, 1)), 'yyyy-MM-dd');
  const report = getCashflowReport(db, { startDate, endDate });
  const sum = (field: 'income' | 'expenses') => report.months.reduce((total, month) => total + month[field], 0);
  return {
    startDate,
    endDate,
    months: Array.from({ length: count }, (_, index) => format(subMonths(today, count - index), 'yyyy-MM')),
    monthsWithRows: report.months.length,
    income: sum('income') / count,
    expenses: sum('expenses') / count,
  };
}

export function getCashflowReport(
  db: Database.Database,
  range: ReportDateRange
): CashflowReport {
  const { conditions, params } = dateConditions(range);
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    ${excludedCategoriesCte()}
    SELECT
      strftime('%Y-%m', ${reportDateSql('t', range.basis)}) AS month,
      SUM(CASE WHEN ${incomeCategoryCondition()} THEN t.amount ELSE 0 END) AS income,
      SUM(CASE WHEN ${expenseCategoryCondition()} THEN ${spendAmountSql('t')} ELSE 0 END) AS expenses
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    ${where}
    GROUP BY month
    HAVING income != 0 OR expenses != 0
    ORDER BY month ASC
  `).all(...excludedCategoryParams(), ...params) as Array<{
    month: string;
    income: number;
    expenses: number;
  }>;

  return {
    months: rows.map((row) => ({
      month: row.month,
      income: row.income || 0,
      expenses: row.expenses || 0,
      net: (row.income || 0) - (row.expenses || 0),
    })),
  };
}

interface CategoryRow {
  id: string;
  name: string;
  color: string | null;
  parent_id: string | null;
}

interface SpendingRow {
  category_id: string | null;
  category_name: string | null;
  color: string | null;
  amount: number;
}

type SpendingCategoryNode = SpendingReport['categories'][number] & {
  children: SpendingCategoryNode[];
};

function categoryPath(
  categoriesById: Map<string, CategoryRow>,
  categoryId: string
): CategoryRow[] {
  const path: CategoryRow[] = [];
  const seen = new Set<string>();
  let currentId: string | null = categoryId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const category = categoriesById.get(currentId);
    if (!category) break;
    path.push(category);
    currentId = category.parent_id;
  }

  return path.reverse();
}

function buildSpendingTree(
  rows: SpendingRow[],
  categoriesById: Map<string, CategoryRow>,
  parentOnly: boolean
): SpendingReport {
  const total = rows.reduce((sum, row) => sum + (row.amount || 0), 0);
  const rootsById = new Map<string, SpendingCategoryNode>();
  const nodesById = new Map<string, SpendingCategoryNode>();

  const ensureNode = (
    categoryId: string,
    categoryName: string,
    color: string | null
  ): SpendingCategoryNode => {
    const existing = nodesById.get(categoryId);
    if (existing) return existing;

    const node: SpendingCategoryNode = {
      category_id: categoryId,
      category_name: categoryName,
      color,
      amount: 0,
      percentage: 0,
      children: [],
    };
    nodesById.set(categoryId, node);
    return node;
  };

  const attachChild = (parent: SpendingCategoryNode, child: SpendingCategoryNode): void => {
    if (parent.children.some((existing) => existing.category_id === child.category_id)) return;
    parent.children.push(child);
  };

  for (const row of rows) {
    const amount = row.amount || 0;

    if (!row.category_id) {
      const root = ensureNode('uncategorized', 'Uncategorized', row.color);
      rootsById.set(root.category_id, root);
      root.amount += amount;
      continue;
    }

    const path = categoryPath(categoriesById, row.category_id);
    if (path.length === 0) {
      const root = ensureNode(row.category_id, row.category_name ?? 'Other', row.color);
      rootsById.set(root.category_id, root);
      root.amount += amount;
      continue;
    }

    let parentNode: SpendingCategoryNode | null = null;
    for (const category of path) {
      const node = ensureNode(category.id, category.name, category.color);
      node.amount += amount;

      if (parentNode) {
        attachChild(parentNode, node);
      } else {
        rootsById.set(node.category_id, node);
      }

      parentNode = node;
    }
  }

  const serializeCategory = (category: SpendingCategoryNode): SpendingReport['categories'][number] => {
    const children = category.children
      .sort((a, b) => b.amount - a.amount)
      .map(serializeCategory);

    const result: SpendingReport['categories'][number] = {
      category_id: category.category_id,
      category_name: category.category_name,
      color: category.color,
      amount: category.amount,
      percentage: total > 0 ? (category.amount / total) * 100 : 0,
    };

    if (!parentOnly && children.length > 0) {
      result.children = children;
    }

    return result;
  };

  return {
    categories: Array.from(rootsById.values())
      .map(serializeCategory)
      .sort((a, b) => b.amount - a.amount),
    total,
  };
}

function categoriesById(db: Database.Database): Map<string, CategoryRow> {
  const rows = db.prepare(`
    SELECT id, name, color, parent_id
    FROM categories
  `).all() as CategoryRow[];

  return new Map(rows.map((category) => [category.id, category]));
}

export function getSpendingReport(
  db: Database.Database,
  options: SpendingReportOptions
): SpendingReport {
  const { conditions, params } = dateConditions(options);
  // No sign filter: a refund is a positive row in an expense category and must net the
  // category's spend down rather than be dropped. See transactionFilters.expenseSideSql.
  conditions.push(expenseCategoryCondition());
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    ${excludedCategoriesCte()}
    SELECT
      c.id AS category_id,
      c.name AS category_name,
      c.color,
      SUM(-t.amount) AS amount
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    ${where}
    GROUP BY t.category_id
    ORDER BY amount DESC
  `).all(...excludedCategoryParams(), ...params) as SpendingRow[];

  return buildSpendingTree(rows, categoriesById(db), options.parentOnly ?? false);
}

export function getIncomeReport(
  db: Database.Database,
  range: ReportDateRange
): SpendingReport {
  const { conditions, params } = dateConditions(range);
  conditions.push(incomeCategoryCondition());
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    ${excludedCategoriesCte()}
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
  `).all(...excludedCategoryParams(), ...params) as Array<{
    category_id: string | null;
    category_name: string | null;
    color: string | null;
    amount: number;
  }>;

  const total = rows.reduce((sum, row) => sum + (row.amount || 0), 0);
  return {
    categories: rows.map((row) => ({
      category_id: row.category_id || 'uncategorized',
      category_name: row.category_name || 'Uncategorized',
      color: row.color,
      amount: row.amount || 0,
      percentage: total > 0 ? ((row.amount || 0) / total) * 100 : 0,
    })),
    total,
  };
}

function childrenByParent(db: Database.Database): Map<string, string[]> {
  const rows = db.prepare('SELECT id, parent_id FROM categories').all() as Array<{
    id: string;
    parent_id: string | null;
  }>;
  const children = new Map<string, string[]>();

  for (const category of rows) {
    if (!category.parent_id) continue;
    const existing = children.get(category.parent_id) ?? [];
    existing.push(category.id);
    children.set(category.parent_id, existing);
  }

  return children;
}

function collectDescendants(children: Map<string, string[]>, categoryId: string): string[] {
  return (children.get(categoryId) ?? []).flatMap((childId) => [
    childId,
    ...collectDescendants(children, childId),
  ]);
}

export function getSpendingTrendsReport(
  db: Database.Database,
  range: ReportDateRange & { categoryIds?: string[] }
): TrendReport {
  const { conditions, params } = dateConditions(range);
  conditions.push(expenseCategoryCondition());

  const selectedCategoryIds = new Set(range.categoryIds ?? []);
  const children = childrenByParent(db);
  const expandedCategoryIds = new Set(
    (range.categoryIds ?? []).flatMap((categoryId) => [
      categoryId,
      ...collectDescendants(children, categoryId),
    ])
  );

  if (expandedCategoryIds.size > 0) {
    const expandedIds = Array.from(expandedCategoryIds);
    conditions.push(`t.category_id IN (${expandedIds.map(() => '?').join(',')})`);
    params.push(...expandedIds);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const categories = categoriesById(db);

  const rows = db.prepare(`
    ${excludedCategoriesCte()}
    SELECT
      strftime('%Y-%m', ${reportDateSql('t', range.basis)}) AS month,
      c.id AS category_id,
      c.name AS category_name,
      c.color,
      SUM(-t.amount) AS amount
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    ${where}
    GROUP BY month, t.category_id
    ORDER BY month ASC, amount DESC
  `).all(...excludedCategoryParams(), ...params) as Array<{
    month: string;
    category_id: string | null;
    category_name: string | null;
    color: string | null;
    amount: number;
  }>;

  const selectedSeriesCategoryId = (categoryId: string | null): string | null => {
    if (!categoryId || selectedCategoryIds.size === 0) return categoryId;

    let currentId: string | null = categoryId;
    while (currentId) {
      if (selectedCategoryIds.has(currentId)) return currentId;
      currentId = categories.get(currentId)?.parent_id ?? null;
    }

    return null;
  };

  const months = Array.from(new Set(rows.map((row) => row.month))).sort();
  const seriesMap = new Map<string, {
    category_id: string;
    category_name: string;
    color: string | null;
    valuesByMonth: Map<string, number>;
  }>();

  for (const row of rows) {
    const seriesCategoryId = selectedSeriesCategoryId(row.category_id);
    if ((range.categoryIds?.length ?? 0) > 0 && !seriesCategoryId) continue;

    const key = seriesCategoryId ?? 'uncategorized';
    const category = categories.get(key);
    if (!seriesMap.has(key)) {
      seriesMap.set(key, {
        category_id: key,
        category_name: category?.name ?? row.category_name ?? 'Uncategorized',
        color: category?.color ?? row.color,
        valuesByMonth: new Map(),
      });
    }

    const valuesByMonth = seriesMap.get(key)!.valuesByMonth;
    valuesByMonth.set(row.month, (valuesByMonth.get(row.month) ?? 0) + (row.amount || 0));
  }

  return {
    months,
    series: Array.from(seriesMap.values()).map((series) => ({
      category_id: series.category_id,
      category_name: series.category_name,
      color: series.color,
      values: months.map((month) => series.valuesByMonth.get(month) ?? 0),
    })),
  };
}

function getExcludedFlowSummary(
  db: Database.Database,
  range: ReportDateRange
): ReportExcludedFlowSummary[] {
  const { conditions, params } = dateConditions(range);
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    ${excludedCategoriesWithRootCte()}
    SELECT
      excluded.root_id,
      COUNT(*) AS count,
      SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS inflows,
      SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS outflows,
      SUM(t.amount) AS net
    FROM transactions t
    JOIN excluded_report_categories excluded ON excluded.id = t.category_id
    ${where} AND t.is_internal_trade = 0
    GROUP BY excluded.root_id
  `).all(...excludedCategoryParams(), ...params) as Array<{
    root_id: string;
    count: number;
    inflows: number | null;
    outflows: number | null;
    net: number | null;
  }>;

  const byType = new Map<ReportExcludedFlowSummary['flow_type'], ReportExcludedFlowSummary>();

  for (const row of rows) {
    const flowType = excludedFlowType(row.root_id);
    const existing = byType.get(flowType) ?? {
      flow_type: flowType,
      count: 0,
      inflows: 0,
      outflows: 0,
      net: 0,
    };

    existing.count += row.count;
    existing.inflows += row.inflows ?? 0;
    existing.outflows += row.outflows ?? 0;
    existing.net += row.net ?? 0;
    byType.set(flowType, existing);
  }

  return Array.from(byType.values()).sort((a, b) => b.count - a.count);
}

export class ReportComparisonRangeError extends Error {
  readonly statusCode = 400;
  constructor() {
    super('A report summary needs a valid startDate and endDate to compare against a prior window');
    this.name = 'ReportComparisonRangeError';
  }
}

export function getReportSummary(
  db: Database.Database,
  range: ReportDateRange
): ReportSummary {
  const comparison = range.comparison ?? 'prior_period';
  const previous = { ...comparisonRange(range, comparison), basis: range.basis };
  // An empty range means all time to every query below, so an underivable comparison window
  // compared the ledger with itself (or a bounded window with the whole ledger) and labelled the
  // zero delta "Prior period". Refuse instead of reporting a comparison that was never made.
  if (!previous.startDate || !previous.endDate) throw new ReportComparisonRangeError();

  const currentCashflow = totalsFromCashflow(getCashflowReport(db, range));
  const previousCashflow = totalsFromCashflow(getCashflowReport(db, previous));
  const currentSpending = getSpendingReport(db, { ...range, parentOnly: true });
  const previousSpending = getSpendingReport(db, { ...previous, parentOnly: true });
  const currentIncome = getIncomeReport(db, range);

  return {
    start_date: range.startDate,
    end_date: range.endDate,
    comparison,
    comparison_label: comparisonLabel(comparison),
    comparison_start_date: previous.startDate,
    comparison_end_date: previous.endDate,
    previous_start_date: previous.startDate,
    previous_end_date: previous.endDate,
    income: metric(currentCashflow.income, previousCashflow.income),
    expenses: metric(currentCashflow.expenses, previousCashflow.expenses),
    net: metric(currentCashflow.net, previousCashflow.net),
    savings_rate: nullableMetric(
      savingsRate(currentCashflow.income, currentCashflow.expenses),
      savingsRate(previousCashflow.income, previousCashflow.expenses)
    ),
    top_spending: flattenReportCategories(currentSpending, previousSpending)
      .sort((a, b) => b.current - a.current)
      .slice(0, 3),
    top_income: flattenReportCategories(currentIncome, getIncomeReport(db, previous))
      .sort((a, b) => b.current - a.current)
      .slice(0, 3),
    spending_movers: categoryChanges(currentSpending, previousSpending, 5),
    excluded_flows: getExcludedFlowSummary(db, range),
  };
}

// ── Top merchants ─────────────────────────────────────────────────────────────
// "Where is the money actually going" at a finer grain than category. Merchants are grouped by
// the cleaned `merchant_name`, falling back to `original_name` for rows no cleaner has touched.
export function getTopMerchantsReport(
  db: Database.Database,
  range: ReportDateRange & { limit?: number }
): TopMerchantsReport {
  const { conditions, params } = dateConditions(range);
  conditions.push(expenseCategoryCondition());

  const limit = Math.min(Math.max(range.limit ?? 15, 1), 100);

  // The merchant label is resolved in a CTE rather than a SELECT alias: a correlated subquery
  // cannot reference an outer alias in SQLite ("no such column: merchant").
  const rows = db.prepare(`
    ${excludedCategoriesCte()},
    reportable AS (
      SELECT
        COALESCE(NULLIF(TRIM(t.merchant_name), ''), NULLIF(TRIM(t.original_name), ''), 'Unknown') AS merchant,
        t.amount AS amount,
        t.date AS date,
        t.category_id AS category_id
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${conditions.join(' AND ')}
    )
    SELECT
      r.merchant AS merchant,
      COUNT(*) AS transaction_count,
      SUM(-r.amount) AS total,
      MAX(r.date) AS last_date,
      -- A merchant can span categories; show the one it lands in most often in this window.
      (
        SELECT COALESCE(c2.name, 'Uncategorized')
        FROM reportable r2
        LEFT JOIN categories c2 ON c2.id = r2.category_id
        WHERE r2.merchant = r.merchant
        GROUP BY r2.category_id
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ) AS category_name
    FROM reportable r
    GROUP BY r.merchant
    ORDER BY total DESC
    LIMIT ?
  `).all(...REPORT_SCOPE_ROOT_IDS, ...params, limit) as Array<{
    merchant: string;
    transaction_count: number;
    total: number;
    last_date: string;
    category_name: string | null;
  }>;

  const totalRow = db.prepare(`
    ${excludedCategoriesCte()}
    SELECT COALESCE(SUM(-t.amount), 0) AS total
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE ${conditions.join(' AND ')}
  `).get(...REPORT_SCOPE_ROOT_IDS, ...params) as { total: number };

  return {
    merchants: rows.map((row) => ({
      merchant: row.merchant,
      transaction_count: row.transaction_count,
      total: row.total,
      last_date: row.last_date,
      category_name: row.category_name,
    })),
    total: totalRow.total,
  };
}

// ── Net-worth attribution ─────────────────────────────────────────────────────
// "What moved net worth over this window": each account's line in the net worth timeline at the
// window's first and last day, so the movers and the chart above them are one computation.
export function getNetWorthAttribution(
  db: Database.Database,
  options: { startDate?: string; endDate?: string } = {}
): NetWorthAttribution | null {
  const timeline = netWorthTimeline(db, { from: options.startDate, to: options.endDate });
  const start = timeline.points[0];
  const end = timeline.points.at(-1);
  // One day is a point, not a movement. There is nothing to attribute.
  if (!start || !end || start === end) return null;

  const institutions = new Map((db.prepare('SELECT id, institution_name FROM accounts').all() as Array<{ id: string; institution_name: string | null }>)
    .map((row) => [row.id, row.institution_name]));
  // Stored terms at the ends (a card's balance is what it owes), net-worth terms in the delta.
  const accounts = timeline.accounts
    .map((account) => {
      const startValue = start.by_account[account.id] ?? 0;
      const endValue = end.by_account[account.id] ?? 0;
      const stored = (value: number) => (account.is_liability ? -value : value) || 0;
      return {
        account_id: account.id,
        account_name: account.name,
        institution_name: institutions.get(account.id) ?? null,
        type: account.type,
        is_liability: account.is_liability,
        start_balance: stored(startValue),
        end_balance: stored(endValue),
        delta: endValue - startValue,
      };
    })
    .filter((account) => account.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    start_date: start.date,
    end_date: end.date,
    start_net_worth: start.net_worth,
    end_net_worth: end.net_worth,
    start_estimated: start.estimated,
    end_estimated: end.estimated,
    delta: end.net_worth - start.net_worth,
    accounts,
  };
}
