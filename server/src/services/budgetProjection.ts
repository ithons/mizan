import type Database from 'better-sqlite3';
import { addDays, addMonths, format, isBefore, parseISO, subMonths } from 'date-fns';
import type { Budget, BudgetRolloverLedgerEntry, RecurringPattern } from '../../../shared/types';

type Frequency = RecurringPattern['frequency'];
type ForecastConfidence = NonNullable<Budget['forecast_confidence']>;

interface BudgetRow extends Omit<Budget, 'rollover'> {
  spent: number;
  rollover: boolean | number;
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
}

interface LedgerBudgetRow extends BudgetRow {
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
}

interface RecurringRow {
  id: string;
  category_id: string | null;
  frequency: Frequency;
  next_expected: string;
  is_confirmed: number;
  transaction_count: number;
  average_signed_amount: number;
}

interface Occurrence {
  category_id: string;
  amount: number;
  confidence: ForecastConfidence;
}

function nextOccurrenceDate(date: Date, frequency: Frequency): Date {
  switch (frequency) {
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
    case 'annual':
      return addMonths(date, 12);
  }
}

function confidenceForPattern(pattern: RecurringRow): ForecastConfidence {
  if (pattern.is_confirmed) return 'confirmed';
  return pattern.transaction_count >= 3 ? 'likely' : 'uncertain';
}

function combineConfidence(current: ForecastConfidence, next: ForecastConfidence): ForecastConfidence {
  if (current === 'none') return next;
  if (current === 'uncertain' || next === 'uncertain') return 'uncertain';
  if (current === 'likely' || next === 'likely') return 'likely';
  return 'confirmed';
}

function categoryDescendants(db: Database.Database): Map<string, Set<string>> {
  const rows = db.prepare('SELECT id, parent_id FROM categories').all() as CategoryRow[];
  const childrenByParent = new Map<string, string[]>();

  for (const row of rows) {
    if (!row.parent_id) continue;
    childrenByParent.set(row.parent_id, [
      ...(childrenByParent.get(row.parent_id) ?? []),
      row.id,
    ]);
  }

  const expand = (categoryId: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(categoryId)) return seen;
    seen.add(categoryId);
    for (const childId of childrenByParent.get(categoryId) ?? []) {
      expand(childId, seen);
    }
    return seen;
  };

  return new Map(rows.map((row) => [row.id, expand(row.id)]));
}

function nextMonthKey(monthKey: string): string {
  return format(addMonths(parseISO(`${monthKey}-01`), 1), 'yyyy-MM');
}

function spendingByMonth(
  db: Database.Database,
  categoryIds: Set<string>,
  startMonth: string,
  endMonthExclusive: string
): Map<string, number> {
  if (categoryIds.size === 0 || startMonth >= endMonthExclusive) return new Map();

  const ids = Array.from(categoryIds);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT substr(date, 1, 7) AS month, COALESCE(SUM(ABS(amount)), 0) AS spent
    FROM transactions
    WHERE category_id IN (${placeholders})
      AND date >= ?
      AND date < ?
      AND amount < 0
      AND pending = 0
    GROUP BY substr(date, 1, 7)
  `).all(
    ...ids,
    `${startMonth}-01`,
    `${endMonthExclusive}-01`
  ) as Array<{ month: string; spent: number }>;

  return new Map(rows.map((row) => [row.month, row.spent]));
}

function rolloverBalanceForBudget(
  db: Database.Database,
  budget: BudgetRow,
  categoryIds: Set<string>,
  selectedMonth: string
): number {
  if (!budget.rollover) return 0;

  const createdMonth = budget.created_at.slice(0, 7);
  const seed = Number(budget.rollover_balance ?? 0);
  if (createdMonth >= selectedMonth) return seed;

  const spending = spendingByMonth(db, categoryIds, createdMonth, selectedMonth);
  let balance = seed;
  let monthKey = createdMonth;

  while (monthKey < selectedMonth) {
    balance += budget.amount - (spending.get(monthKey) ?? 0);
    monthKey = nextMonthKey(monthKey);
  }

  return balance;
}

function monthRangeForLedger(createdMonth: string, throughMonth: string, months: number): {
  firstComputedMonth: string;
  firstReturnedMonth: string;
  endMonthExclusive: string;
} {
  const firstReturnedMonth = format(
    subMonths(parseISO(`${throughMonth}-01`), Math.max(0, months - 1)),
    'yyyy-MM'
  );

  return {
    firstComputedMonth: createdMonth,
    firstReturnedMonth: createdMonth > firstReturnedMonth ? createdMonth : firstReturnedMonth,
    endMonthExclusive: nextMonthKey(throughMonth),
  };
}

function recurringRows(db: Database.Database, endDate: string): RecurringRow[] {
  return db.prepare(`
    SELECT
      rp.id,
      rp.category_id,
      rp.frequency,
      rp.next_expected,
      rp.is_confirmed,
      rp.transaction_count,
      COALESCE(
        (
          SELECT AVG(t.amount)
          FROM transactions t
          WHERE t.recurring_id = rp.id
        ),
        CASE WHEN COALESCE(c.is_income, 0) = 1 THEN rp.average_amount ELSE -rp.average_amount END
      ) AS average_signed_amount
    FROM recurring_patterns rp
    LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.is_active = 1
      AND rp.category_id IS NOT NULL
      AND rp.next_expected <= ?
      AND (rp.is_confirmed = 1 OR rp.transaction_count >= 3)
  `).all(endDate) as RecurringRow[];
}

function monthForecastStart(startDate: string, endDate: string, now: Date): string | null {
  const today = format(now, 'yyyy-MM-dd');
  if (today > endDate) return null;
  return today > startDate ? today : startDate;
}

function recurringOccurrencesForMonth(
  db: Database.Database,
  startDate: string,
  endDate: string,
  now: Date
): Occurrence[] {
  const forecastStart = monthForecastStart(startDate, endDate, now);
  if (!forecastStart) return [];

  const occurrences: Occurrence[] = [];
  const patterns = recurringRows(db, endDate);

  for (const pattern of patterns) {
    if (!pattern.category_id || pattern.average_signed_amount >= 0) continue;

    let expected = parseISO(pattern.next_expected);
    const confidence = confidenceForPattern(pattern);
    let guard = 0;

    while (format(expected, 'yyyy-MM-dd') < forecastStart && guard < 500) {
      expected = nextOccurrenceDate(expected, pattern.frequency);
      guard++;
    }

    while (!isBefore(parseISO(endDate), expected) && guard < 500) {
      occurrences.push({
        category_id: pattern.category_id,
        amount: Math.abs(pattern.average_signed_amount),
        confidence,
      });
      expected = nextOccurrenceDate(expected, pattern.frequency);
      guard++;
    }
  }

  return occurrences;
}

export function getMonthlyBudgetsWithProjection(
  db: Database.Database,
  year: number,
  month: number,
  now = new Date()
): Budget[] {
  const monthPart = String(month).padStart(2, '0');
  const startDate = `${year}-${monthPart}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${monthPart}-${String(lastDay).padStart(2, '0')}`;

  const budgets = db.prepare(`
    WITH RECURSIVE budget_categories(root_id, category_id) AS (
      SELECT id, id FROM categories
      UNION ALL
      SELECT bc.root_id, c.id
      FROM categories c
      JOIN budget_categories bc ON c.parent_id = bc.category_id
    )
    SELECT
      b.*,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      COALESCE(SUM(ABS(t.amount)), 0) AS spent
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    LEFT JOIN budget_categories bc ON bc.root_id = b.category_id
    LEFT JOIN transactions t
      ON t.category_id = bc.category_id
     AND t.date BETWEEN ? AND ?
     AND t.amount < 0
     AND t.pending = 0
    WHERE b.period = 'monthly' OR b.period = ?
    GROUP BY b.id
    ORDER BY c.name ASC
  `).all(startDate, endDate, `${year}-${monthPart}`) as BudgetRow[];

  const descendants = categoryDescendants(db);
  const occurrences = recurringOccurrencesForMonth(db, startDate, endDate, now);

  return budgets.map((budget) => {
    const categoryIds = descendants.get(budget.category_id) ?? new Set([budget.category_id]);
    let expectedRecurring = 0;
    let confidence: ForecastConfidence = 'none';

    for (const occurrence of occurrences) {
      if (!categoryIds.has(occurrence.category_id)) continue;
      expectedRecurring += occurrence.amount;
      confidence = combineConfidence(confidence, occurrence.confidence);
    }

    const rolloverBalance = rolloverBalanceForBudget(db, budget, categoryIds, `${year}-${monthPart}`);
    const availableAmount = budget.amount + rolloverBalance;
    const projectedSpend = (budget.spent ?? 0) + expectedRecurring;
    const projectedRemaining = availableAmount - projectedSpend;
    
    let pacingVelocity = 0;
    if (availableAmount > 0) {
      const daysInMonth = new Date(year, month, 0).getDate();
      const currentDay = Math.min(now.getDate(), daysInMonth);
      const isPastMonth = now.getFullYear() > year || (now.getFullYear() === year && now.getMonth() + 1 > month);
      const isFutureMonth = now.getFullYear() < year || (now.getFullYear() === year && now.getMonth() + 1 < month);
      
      const timeElapsedRatio = isPastMonth ? 1 : isFutureMonth ? 0 : currentDay / daysInMonth;
      const spendRatio = (budget.spent ?? 0) / availableAmount;
      
      if (timeElapsedRatio > 0) {
        pacingVelocity = spendRatio / timeElapsedRatio;
      }
    }

    return {
      ...budget,
      rollover: Boolean(budget.rollover),
      rollover_balance: rolloverBalance,
      expected_recurring: expectedRecurring,
      projected_spend: projectedSpend,
      projected_remaining: projectedRemaining,
      projected_percent: availableAmount > 0 ? (projectedSpend / availableAmount) * 100 : 0,
      pacing_velocity: pacingVelocity,
      forecast_confidence: confidence,
    };
  });
}

export function getBudgetRolloverLedger(
  db: Database.Database,
  options: {
    budgetId?: string;
    month?: string;
    months?: number;
    now?: Date;
  } = {}
): BudgetRolloverLedgerEntry[] {
  const throughMonth = options.month ?? format(options.now ?? new Date(), 'yyyy-MM');
  const months = Math.min(Math.max(options.months ?? 12, 1), 120);
  const descendants = categoryDescendants(db);
  const where = options.budgetId ? 'WHERE b.id = ? AND b.rollover = 1' : 'WHERE b.rollover = 1';
  const params = options.budgetId ? [options.budgetId] : [];
  const budgets = db.prepare(`
    SELECT
      b.*,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      0 AS spent
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    ${where}
    ORDER BY c.name ASC
  `).all(...params) as LedgerBudgetRow[];

  const calculatedAt = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO budget_rollover_ledger (
      id, budget_id, month, starting_rollover, budget_amount, actual_spend, ending_rollover, calculated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(budget_id, month) DO UPDATE SET
      starting_rollover = excluded.starting_rollover,
      budget_amount = excluded.budget_amount,
      actual_spend = excluded.actual_spend,
      ending_rollover = excluded.ending_rollover,
      calculated_at = excluded.calculated_at
  `);
  const entries: BudgetRolloverLedgerEntry[] = [];

  for (const budget of budgets) {
    const createdMonth = budget.created_at.slice(0, 7);
    if (createdMonth > throughMonth) continue;

    const range = monthRangeForLedger(createdMonth, throughMonth, months);
    const categoryIds = descendants.get(budget.category_id) ?? new Set([budget.category_id]);
    const spending = spendingByMonth(db, categoryIds, range.firstComputedMonth, range.endMonthExclusive);
    let balance = Number(budget.rollover_balance ?? 0);
    let monthKey = range.firstComputedMonth;

    while (monthKey < range.endMonthExclusive) {
      const startingRollover = balance;
      const actualSpend = spending.get(monthKey) ?? 0;
      const endingRollover = startingRollover + budget.amount - actualSpend;
      const id = `${budget.id}:${monthKey}`;

      upsert.run(
        id,
        budget.id,
        monthKey,
        startingRollover,
        budget.amount,
        actualSpend,
        endingRollover,
        calculatedAt
      );

      if (monthKey >= range.firstReturnedMonth) {
        entries.push({
          id,
          budget_id: budget.id,
          category_id: budget.category_id,
          category_name: budget.category_name,
          category_color: budget.category_color,
          category_icon: budget.category_icon,
          month: monthKey,
          starting_rollover: startingRollover,
          budget_amount: budget.amount,
          actual_spend: actualSpend,
          ending_rollover: endingRollover,
          calculated_at: calculatedAt,
        });
      }

      balance = endingRollover;
      monthKey = nextMonthKey(monthKey);
    }
  }

  return entries.sort((a, b) => {
    const categoryCompare = (a.category_name ?? '').localeCompare(b.category_name ?? '');
    return categoryCompare || a.month.localeCompare(b.month);
  });
}
