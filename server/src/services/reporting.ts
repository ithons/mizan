import type Database from 'better-sqlite3';
import {
  excludedFromTotalsSql,
  expenseSideSql,
  incomeSideSql,
  spendAmountSql,
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
  ReportDrilldown,
  ReportCategoryChange,
  ReportComparisonMode,
  ReportEvidenceDrilldown,
  ReportEvidenceKind,
  ReportExcludedFlowSummary,
  ReportMetricSummary,
  ReportNetWorthEvidence,
  ReportSummary,
  SpendingReport,
  NetWorthSnapshot,
  NetWorthAttribution,
  TopMerchantsReport,
} from '../../../shared/types';

// Every report object this module returns keeps money TOTALS in integer cents.
// Dollarization happens exclusively at the route boundary (routes/reports.ts) or,
// for AI text, at the fmt() call site. Percentages, counts, and ratios pass through.

interface ReportDateRange {
  startDate?: string;
  endDate?: string;
  comparison?: ReportComparisonMode;
}

interface SpendingReportOptions extends ReportDateRange {
  parentOnly?: boolean;
}

interface ReportDrilldownOptions extends ReportDateRange {
  kind: 'spending' | 'income';
  categoryId: string;
}

interface ReportEvidenceOptions extends ReportDateRange {
  kind: ReportEvidenceKind;
  month?: string;
  flowType?: ReportExcludedFlowSummary['flow_type'];
}

interface NetWorthEvidenceAccountRow {
  id: string;
  account_name: string | null;
  institution_name: string | null;
  type: string | null;
  is_liability: number | null;
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

const EXCLUDED_REPORT_ROOT_CATEGORY_IDS = ['cat_xfer', 'cat_inv', 'cat_crypto'];
const EXCLUDED_ROOT_PLACEHOLDERS = EXCLUDED_REPORT_ROOT_CATEGORY_IDS.map(() => '?').join(',');

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

  if (range.startDate) {
    conditions.push('t.date >= ?');
    params.push(range.startDate);
  }
  if (range.endDate) {
    conditions.push('t.date <= ?');
    params.push(range.endDate);
  }

  return { conditions, params };
}

function excludedCategoryParams(): string[] {
  return [...EXCLUDED_REPORT_ROOT_CATEGORY_IDS];
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

function savingsRate(income: number, expenses: number): number {
  return income > 0 ? ((income - expenses) / income) * 100 : 0;
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

function rootIdsForFlowType(flowType: ReportExcludedFlowSummary['flow_type']): string[] {
  if (flowType === 'investments') return ['cat_inv'];
  if (flowType === 'crypto') return ['cat_crypto'];
  return ['cat_xfer'];
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
      strftime('%Y-%m', t.date) AS month,
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

function categoryName(db: Database.Database, categoryId: string): string {
  if (categoryId === 'uncategorized') return 'Uncategorized';
  const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(categoryId) as { name: string } | undefined;
  return row?.name ?? 'Unknown category';
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

export function getReportDrilldown(
  db: Database.Database,
  options: ReportDrilldownOptions
): ReportDrilldown {
  const { conditions, params } = dateConditions(options);
  const categoryParams: unknown[] = [];

  if (options.kind === 'spending') {
    conditions.push(expenseCategoryCondition());
  } else {
    conditions.push(incomeCategoryCondition());
  }

  if (options.categoryId === 'uncategorized') {
    conditions.push('t.category_id IS NULL');
  } else {
    const categoryIds = [
      options.categoryId,
      ...collectDescendants(childrenByParent(db), options.categoryId),
    ];
    conditions.push(`t.category_id IN (${categoryIds.map(() => '?').join(',')})`);
    categoryParams.push(...categoryIds);
  }

  const rows = db.prepare(`
    ${excludedCategoriesCte()}
    SELECT
      t.*,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      a.account_name,
      a.institution_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.date DESC, t.created_at DESC
  `).all(...excludedCategoryParams(), ...params, ...categoryParams) as ReportDrilldown['transactions'];

  const total = rows.reduce((sum, transaction) =>
    sum + (options.kind === 'spending' ? Math.abs(transaction.amount) : transaction.amount), 0);

  return {
    kind: options.kind,
    category_id: options.categoryId,
    category_name: categoryName(db, options.categoryId),
    start_date: options.startDate,
    end_date: options.endDate,
    total,
    count: rows.length,
    transactions: rows,
  };
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
      strftime('%Y-%m', t.date) AS month,
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

function transactionEvidenceSelect(): string {
  return `
    SELECT
      t.*,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      a.account_name,
      a.institution_name
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts a ON a.id = t.account_id
  `;
}

function evidenceTotals(rows: ReportEvidenceDrilldown['transactions']): Pick<
  ReportEvidenceDrilldown,
  'income' | 'expenses' | 'net' | 'total' | 'count'
> {
  const income = rows.reduce((sum, transaction) => sum + (transaction.amount > 0 ? transaction.amount : 0), 0);
  const expenses = rows.reduce((sum, transaction) => sum + (transaction.amount < 0 ? Math.abs(transaction.amount) : 0), 0);
  const net = rows.reduce((sum, transaction) => sum + transaction.amount, 0);

  return {
    income,
    expenses,
    net,
    total: income + expenses,
    count: rows.length,
  };
}

function monthRangeFromYearMonth(month: string): ReportDateRange | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;

  const monthStart = parseISO(`${month}-01`);
  if (Number.isNaN(monthStart.getTime())) return null;

  return {
    startDate: format(startOfMonth(monthStart), 'yyyy-MM-dd'),
    endDate: format(endOfMonth(monthStart), 'yyyy-MM-dd'),
  };
}

function getCashflowEvidence(
  db: Database.Database,
  options: ReportEvidenceOptions
): ReportEvidenceDrilldown {
  const monthRange = options.month ? monthRangeFromYearMonth(options.month) : null;
  const range = monthRange ?? { startDate: options.startDate, endDate: options.endDate };
  const { conditions, params } = dateConditions(range);
  conditions.push(`(
    ${incomeCategoryCondition()}
    OR ${expenseCategoryCondition()}
  )`);

  const rows = db.prepare(`
    ${excludedCategoriesCte()}
    ${transactionEvidenceSelect()}
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.date DESC, t.created_at DESC
  `).all(...excludedCategoryParams(), ...params) as ReportEvidenceDrilldown['transactions'];

  return {
    kind: 'cashflow_month',
    label: options.month ? `Cash flow for ${options.month}` : 'Cash flow',
    start_date: range.startDate,
    end_date: range.endDate,
    month: options.month,
    ...evidenceTotals(rows),
    transactions: rows,
  };
}

function getExcludedFlowEvidence(
  db: Database.Database,
  options: ReportEvidenceOptions
): ReportEvidenceDrilldown {
  const flowType = options.flowType ?? 'transfers';
  const rootIds = rootIdsForFlowType(flowType);
  const { conditions, params } = dateConditions(options);
  conditions.push(`excluded.root_id IN (${rootIds.map(() => '?').join(',')})`);
  params.push(...rootIds);

  const rows = db.prepare(`
    ${excludedCategoriesWithRootCte()}
    ${transactionEvidenceSelect()}
    JOIN excluded_report_categories excluded ON excluded.id = t.category_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.date DESC, t.created_at DESC
  `).all(...excludedCategoryParams(), ...params) as ReportEvidenceDrilldown['transactions'];

  return {
    kind: 'excluded_flow',
    label: `Excluded ${flowType}`,
    start_date: options.startDate,
    end_date: options.endDate,
    flow_type: flowType,
    ...evidenceTotals(rows),
    transactions: rows,
  };
}

export function getReportEvidenceDrilldown(
  db: Database.Database,
  options: ReportEvidenceOptions
): ReportEvidenceDrilldown {
  if (options.kind === 'cashflow_month') {
    return getCashflowEvidence(db, options);
  }

  return getExcludedFlowEvidence(db, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseNetWorthBreakdown(value: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    );
  } catch {
    return {};
  }
}

function getSnapshotAccounts(
  db: Database.Database,
  snapshot: NetWorthSnapshot
): ReportNetWorthEvidence['accounts'] {
  const breakdown = parseNetWorthBreakdown(snapshot.breakdown);
  const accountIds = Object.keys(breakdown);
  if (accountIds.length === 0) return [];

  const rows = db.prepare(`
    SELECT id, account_name, institution_name, type, is_liability
    FROM accounts
    WHERE id IN (${accountIds.map(() => '?').join(',')})
  `).all(...accountIds) as NetWorthEvidenceAccountRow[];
  const accountRows = new Map(rows.map((row) => [row.id, row]));

  return accountIds
    .map((accountId) => {
      const account = accountRows.get(accountId);
      return {
        account_id: accountId,
        account_name: account?.account_name ?? null,
        institution_name: account?.institution_name ?? null,
        type: account?.type ?? null,
        is_liability: account?.is_liability == null ? null : account.is_liability === 1,
        balance: breakdown[accountId] ?? 0,
      };
    })
    .sort((a, b) => {
      const liabilityRank = Number(a.is_liability ?? false) - Number(b.is_liability ?? false);
      if (liabilityRank !== 0) return liabilityRank;
      return Math.abs(b.balance) - Math.abs(a.balance);
    });
}

export function getReportNetWorthEvidence(
  db: Database.Database,
  snapshotId: string
): ReportNetWorthEvidence | null {
  const snapshot = db.prepare(`
    SELECT * FROM net_worth_snapshots
    WHERE id = ?
  `).get(snapshotId) as NetWorthSnapshot | undefined;

  if (!snapshot) return null;

  const previousSnapshot = db.prepare(`
    SELECT * FROM net_worth_snapshots
    WHERE date < ?
    ORDER BY date DESC
    LIMIT 1
  `).get(snapshot.date) as NetWorthSnapshot | undefined;

  // Snapshots, deltas, and account balances all stay in cents; routes/reports.ts
  // dollarizes the snapshot money columns, the breakdown JSON, and these deltas.
  const accounts = getSnapshotAccounts(db, snapshot);

  return {
    kind: 'networth_snapshot',
    label: `Net worth on ${snapshot.date}`,
    snapshot,
    previous_snapshot: previousSnapshot ?? null,
    delta: previousSnapshot ? snapshot.net_worth - previousSnapshot.net_worth : null,
    asset_delta: previousSnapshot ? snapshot.total_assets - previousSnapshot.total_assets : null,
    liability_delta: previousSnapshot ? snapshot.total_liabilities - previousSnapshot.total_liabilities : null,
    accounts,
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
    ${where}
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

export function getReportSummary(
  db: Database.Database,
  range: ReportDateRange
): ReportSummary {
  const comparison = range.comparison ?? 'prior_period';
  const previous = comparisonRange(range, comparison);

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
    savings_rate: metric(
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
      SUM(ABS(r.amount)) AS total,
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
  `).all(...EXCLUDED_REPORT_ROOT_CATEGORY_IDS, ...params, limit) as Array<{
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
  `).get(...EXCLUDED_REPORT_ROOT_CATEGORY_IDS, ...params) as { total: number };

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
// "What moved net worth over this window." Diffs the per-account `breakdown` map of the first and
// last snapshot in the window. An account missing from one side is treated as 0 there, so accounts
// opened or closed mid-window show their full balance as the delta rather than being dropped.
export function getNetWorthAttribution(
  db: Database.Database,
  options: { startDate?: string; endDate?: string } = {}
): NetWorthAttribution | null {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.startDate) { conditions.push('date >= ?'); params.push(options.startDate); }
  if (options.endDate) { conditions.push('date <= ?'); params.push(options.endDate); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const bounds = db.prepare(`
    SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(*) AS count
    FROM net_worth_snapshots ${where}
  `).get(...params) as { first_date: string | null; last_date: string | null; count: number };

  // One snapshot is a point, not a movement — there is nothing to attribute.
  if (bounds.count < 2 || !bounds.first_date || !bounds.last_date) return null;

  const snapshotAt = (date: string) => db.prepare(`
    SELECT date, net_worth, breakdown FROM net_worth_snapshots WHERE date = ? ORDER BY date LIMIT 1
  `).get(date) as { date: string; net_worth: number; breakdown: string | null } | undefined;

  const start = snapshotAt(bounds.first_date);
  const end = snapshotAt(bounds.last_date);
  if (!start || !end) return null;

  const parse = (raw: string | null): Record<string, number> => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      );
    } catch {
      return {}; // A malformed breakdown degrades to "no attribution", never a 500.
    }
  };

  const startBalances = parse(start.breakdown);
  const endBalances = parse(end.breakdown);

  const accountRows = db.prepare(
    'SELECT id, account_name, institution_name, type, is_liability FROM accounts'
  ).all() as Array<{
    id: string;
    account_name: string | null;
    institution_name: string | null;
    type: string | null;
    is_liability: number | null;
  }>;
  const accountsById = new Map(accountRows.map((row) => [row.id, row]));

  const accounts = Array.from(new Set([...Object.keys(startBalances), ...Object.keys(endBalances)]))
    .map((accountId) => {
      const account = accountsById.get(accountId);
      const isLiability = account ? account.is_liability === 1 : false;
      const startBalance = startBalances[accountId] ?? 0;
      const endBalance = endBalances[accountId] ?? 0;
      const balanceDelta = endBalance - startBalance;
      return {
        account_id: accountId,
        account_name: account?.account_name ?? null,
        institution_name: account?.institution_name ?? null,
        type: account?.type ?? null,
        is_liability: account ? account.is_liability === 1 : null,
        start_balance: startBalance,
        end_balance: endBalance,
        // Contribution to NET WORTH, not the raw balance change. `breakdown` stores a liability as
        // a positive amount owed, so a credit-card balance growing by $100 moves net worth DOWN by
        // $100. Negating here is what makes these deltas sum to the headline net-worth delta —
        // without it a rising card balance rendered as a green gain.
        delta: isLiability ? -balanceDelta : balanceDelta,
      };
    })
    .filter((account) => account.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    start_date: start.date,
    end_date: end.date,
    start_net_worth: start.net_worth,
    end_net_worth: end.net_worth,
    delta: end.net_worth - start.net_worth,
    accounts,
  };
}
