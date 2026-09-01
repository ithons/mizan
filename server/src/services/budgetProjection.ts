import type Database from 'better-sqlite3';
import { excludedFromTotalsSql } from './transactionFilters';
import { addMonths, format, isBefore, parseISO, subMonths  } from 'date-fns';
import { occurrenceDate, recentSignedAmounts } from './recurring';
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
  average_amount: number;
  is_income: number | null;
}

interface Occurrence {
  category_id: string;
  amount: number;
  confidence: ForecastConfidence;
}

/** How many occurrences one pattern may contribute to a single month before the walk is cut off. */
const OCCURRENCE_LIMIT = 500;

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
  // Signed, not ABS-behind-a-sign-filter: a returned purchase has to release the budget it
  // consumed. Under the old form a $955.19 Amazon purchase refunded four days later still ate
  // the Shopping budget for the month, with no way to give it back.
  const rows = db.prepare(`
    SELECT substr(date, 1, 7) AS month, COALESCE(SUM(-amount), 0) AS spent
    FROM transactions
    WHERE category_id IN (${placeholders})
      AND date >= ?
      AND date < ?
      AND pending = 0
      AND ${excludedFromTotalsSql()}
    GROUP BY substr(date, 1, 7)
  `).all(
    ...ids,
    `${startMonth}-01`,
    `${endMonthExclusive}-01`
  ) as Array<{ month: string; spent: number }>;

  return new Map(rows.map((row) => [row.month, row.spent]));
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
      rp.average_amount,
      c.is_income
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
  // The forecast and the Bills list quote this same estimate, so a budget cannot project a
  // different figure for the bill it is projecting.
  const signedAmounts = recentSignedAmounts(db, patterns.map((pattern) => pattern.id));

  for (const pattern of patterns) {
    const signedAmount = signedAmounts.get(pattern.id)
      ?? (pattern.is_income === 1 ? pattern.average_amount : -pattern.average_amount);
    if (!pattern.category_id || signedAmount >= 0) continue;

    const anchor = parseISO(pattern.next_expected);
    const confidence = confidenceForPattern(pattern);
    let step = 0;
    let expected = anchor;

    while (format(expected, 'yyyy-MM-dd') < forecastStart && step < OCCURRENCE_LIMIT) {
      step++;
      expected = occurrenceDate(anchor, pattern.frequency, step);
    }

    while (!isBefore(parseISO(endDate), expected) && step < OCCURRENCE_LIMIT) {
      occurrences.push({
        category_id: pattern.category_id,
        amount: Math.abs(signedAmount),
        confidence,
      });
      step++;
      expected = occurrenceDate(anchor, pattern.frequency, step);
    }
  }

  return occurrences;
}

// Money totals stay in cents here; every consumer (routes, AI context) dollarizes
// at its own response/display boundary.
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
      COALESCE(SUM(-t.amount), 0) AS spent
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    LEFT JOIN budget_categories bc ON bc.root_id = b.category_id
    LEFT JOIN transactions t
      ON t.category_id = bc.category_id
     AND t.date BETWEEN ? AND ?
     AND t.pending = 0
     AND ${excludedFromTotalsSql('t')}
    WHERE b.period = 'monthly' OR b.period = ?
    GROUP BY b.id
    ORDER BY c.name ASC
  `).all(startDate, endDate, `${year}-${monthPart}`) as BudgetRow[];

  const descendants = categoryDescendants(db);
  const occurrences = recurringOccurrencesForMonth(db, startDate, endDate, now);
  const carriedIn = budgets.some((budget) => budget.rollover)
    ? rolloverCarriedIntoMonth(db, `${year}-${monthPart}`, now)
    : new Map<string, number>();

  return budgets.map((budget) => {
    const categoryIds = descendants.get(budget.category_id) ?? new Set([budget.category_id]);
    let expectedRecurring = 0;
    let confidence: ForecastConfidence = 'none';

    for (const occurrence of occurrences) {
      if (!categoryIds.has(occurrence.category_id)) continue;
      expectedRecurring += occurrence.amount;
      confidence = combineConfidence(confidence, occurrence.confidence);
    }

    const rolloverBalance = budget.rollover
      ? carriedIn.get(budget.id) ?? Number(budget.rollover_balance ?? 0)
      : 0;
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

export interface RolloverLedgerOptions {
  budgetId?: string;
  month?: string;
  months?: number;
  now?: Date;
}

function recordedKey(budgetId: string, month: string): string {
  return `${budgetId}:${month}`;
}

/**
 * The budget amount each already-recorded month was walked with, keyed by budget and month.
 *
 * `budgets.amount` is the live figure and nothing versions it, so re-deriving a closed month from
 * it restates the past: raising the Shopping budget from $400 to $500 in August would rewrite
 * July's carryover as though July had always been $500. A month that was recorded while it was
 * open keeps the amount that was actually in force.
 *
 * Keyed on `(budget_id, month)` because that, not `id`, is what the upsert conflicts on. A row
 * written under some other id is still the row the upsert updates, and keying on `id` would miss
 * it and silently fall back to the live amount, which is the defect this whole path exists to fix.
 */
function recordedBudgetAmounts(db: Database.Database, budgetId?: string): Map<string, number> {
  const rows = db.prepare(`
    SELECT budget_id, month, budget_amount FROM budget_rollover_ledger
    ${budgetId ? 'WHERE budget_id = ?' : ''}
  `).all(...(budgetId ? [budgetId] : [])) as Array<{
    budget_id: string;
    month: string;
    budget_amount: number;
  }>;

  return new Map(rows.map((row) => [recordedKey(row.budget_id, row.month), row.budget_amount]));
}

/**
 * Walk the carryover month by month.
 *
 * `windowed` trims the result to the caller's `months` window; the record path needs every month
 * back to the budget's creation, because a month it skips can never be recorded later.
 */
function walkRolloverLedger(
  db: Database.Database,
  options: RolloverLedgerOptions,
  windowed: boolean
): BudgetRolloverLedgerEntry[] {
  const now = options.now ?? new Date();
  const openMonth = format(now, 'yyyy-MM');
  const throughMonth = options.month ?? openMonth;
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

  const recorded = recordedBudgetAmounts(db, options.budgetId);
  const calculatedAt = now.toISOString();
  const entries: BudgetRolloverLedgerEntry[] = [];

  for (const budget of budgets) {
    // `created_at` is a UTC ISO timestamp (`routes/budgets.ts` writes `new Date().toISOString()`)
    // and `throughMonth` is a LOCAL 'yyyy-MM'. Slicing the UTC string compares two calendars: a
    // budget created after 20:00 local on the last day of a month (America/New_York, UTC-4) has a
    // `created_at` in the NEXT month, so `createdMonth > throughMonth` skipped its own first month
    // out of every later carryover figure. Parsed and reformatted locally so both sides are the
    // same calendar.
    const createdMonth = format(parseISO(budget.created_at), 'yyyy-MM');
    if (createdMonth > throughMonth) continue;

    const range = monthRangeForLedger(createdMonth, throughMonth, months);
    const categoryIds = descendants.get(budget.category_id) ?? new Set([budget.category_id]);
    const spending = spendingByMonth(db, categoryIds, range.firstComputedMonth, range.endMonthExclusive);
    let balance = Number(budget.rollover_balance ?? 0);
    let monthKey = range.firstComputedMonth;

    while (monthKey < range.endMonthExclusive) {
      const id = recordedKey(budget.id, monthKey);
      // The month in progress is still being lived in, so it tracks the live budget and freezes
      // only once a later month has opened. Spend is always re-derived: a late-posting or
      // recategorized transaction has to reach the month it belongs to, however old that month is.
      const budgetAmount = monthKey < openMonth
        ? recorded.get(id) ?? budget.amount
        : budget.amount;
      const startingRollover = balance;
      const actualSpend = spending.get(monthKey) ?? 0;
      const endingRollover = startingRollover + budgetAmount - actualSpend;

      if (!windowed || monthKey >= range.firstReturnedMonth) {
        entries.push({
          id,
          budget_id: budget.id,
          category_id: budget.category_id,
          category_name: budget.category_name,
          category_color: budget.category_color,
          category_icon: budget.category_icon,
          month: monthKey,
          starting_rollover: startingRollover,
          budget_amount: budgetAmount,
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

/**
 * What each rollover budget carries into `selectedMonth`, keyed by budget id.
 *
 * The Budget screen's `rollover_balance` and the carryover ledger are the same quantity, so they
 * run the same walk. They used to be two walks, and the second one took the live `budgets.amount`
 * for closed months: on the owner's ledger a single $400 to $500 raise made the Budget screen say
 * $1,703.63 carried into August while the carryover panel said $1,603.63.
 */
function rolloverCarriedIntoMonth(
  db: Database.Database,
  selectedMonth: string,
  now: Date
): Map<string, number> {
  const entries = walkRolloverLedger(db, { month: selectedMonth, months: 1, now }, true);
  return new Map(entries.map((entry) => [entry.budget_id, entry.starting_rollover]));
}

/** Whether any budget carries a balance forward, so callers can skip a walk that has no subject. */
export function hasRolloverBudgets(db: Database.Database): boolean {
  return db.prepare('SELECT 1 AS present FROM budgets WHERE rollover = 1 LIMIT 1').get() !== undefined;
}

/**
 * Read the rollover ledger. Pure: it writes nothing.
 *
 * It used to upsert every month it walked, which made `GET /api/budgets/rollover-ledger` a writer.
 * `localGuard` exempts GET from the cross-origin check on the assumption that a GET cannot mutate,
 * so any page could rewrite the table, and each read also restated every past month from the
 * current budget amount.
 */
export function computeBudgetRolloverLedger(
  db: Database.Database,
  options: RolloverLedgerOptions = {}
): BudgetRolloverLedgerEntry[] {
  return walkRolloverLedger(db, options, true);
}

/**
 * Commit the ledger, from each budget's creation month through the month in progress.
 *
 * The only writer. Called after a sync has settled categories and spend, and after the owner
 * changes a budget, never from a read path.
 */
export function recordBudgetRolloverLedger(
  db: Database.Database,
  options: { budgetId?: string; now?: Date } = {}
): { recorded: number } {
  const entries = walkRolloverLedger(db, { budgetId: options.budgetId, now: options.now }, false);
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

  const write = db.transaction((rows: BudgetRolloverLedgerEntry[]) => {
    for (const row of rows) {
      upsert.run(
        row.id,
        row.budget_id,
        row.month,
        row.starting_rollover,
        row.budget_amount,
        row.actual_spend,
        row.ending_rollover,
        row.calculated_at
      );
    }
  });

  write(entries);
  return { recorded: entries.length };
}
