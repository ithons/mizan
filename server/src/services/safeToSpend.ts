import type Database from 'better-sqlite3';
import { buildRecurringForecast } from './recurringForecast';
import { calculateGoalProgress, type GoalProgressInput } from './goalProgress';
import { excludedFromTotalsSql, expenseSideSql, reportDateSql, spendAmountSql } from './transactionFilters';
import type { RecurringForecastOccurrence } from '../../../shared/types';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';
import { toDollars } from './money';

/** The columns `calculateGoalProgress` needs, plus enough of the linked account to know whether
 * the liquid pool counted it. */
type GoalEarmarkRow = GoalProgressInput & {
  account_id: string | null;
  account_type: string | null;
  account_is_hidden: number | null;
  account_is_liability: number | null;
};

const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);

/** The one definition of the liquid pool, read by both `liquid` and the goal earmark. */
function isInLiquidPool(account: { type: string; is_hidden: number; is_liability: number }): boolean {
  return account.is_hidden === 0 && account.is_liability === 0 && LIQUID_TYPES.has(account.type);
}

/**
 * "Free to spend": what is left after every claim already made on the liquid pool.
 *
 * TWO DEFECTS THIS REPLACES.
 *
 * 1. It ignored credit cards entirely. The old client-side version computed
 *    `liquid - bills - budgets - goals` and never looked at liabilities, so on 2026-07-29 it
 *    rendered "Free to spend $4,226" directly beneath "Owed $5,653.71" against $5,291.49 of liquid
 *    assets. Paying the cards would have left the deposit pool $362.22 negative. The owner's own
 *    advisor profile states they autopay every card in full each statement period, which makes the
 *    card balance the most certain claim on that pool, not an optional one.
 *
 * 2. It clamped at zero. `Math.max(0, ...)` meant "you are $400 short this month" and "you have
 *    exactly nothing spare" rendered identically as $0, hiding the single most important thing this
 *    number can ever say. The shortfall is now returned signed, and it is the caller's job to show
 *    it rather than this function's job to hide it.
 *
 * Lives on the server because the advisor and the Today screen must not be able to disagree about
 * it. The previous client-only implementation carried a docstring claiming it mirrored a
 * server-side metric of the same name; no such metric existed. It was describing a feature deleted
 * in a1412db, and it would have sent anyone trying to reconcile the two on a long walk.
 *
 * Every field is INTEGER CENTS. Dollarization happens at the route boundary.
 */
export interface SafeToSpendBreakdown {
  /** Checking, savings and cash. Not investments, not crypto. */
  liquid: number;
  /** Net owed on liability accounts, treated as a claim on the liquid pool. Negative when the
   * cards are collectively in credit, which is a credit to the pool rather than a claim. */
  cardBalances: number;
  /** Scheduled outflows in the forecast window. */
  upcomingBills: number;
  /** Scheduled income in the forecast window. */
  expectedInflows: number;
  /**
   * Scheduled transfers out of the pool to the owner's other non-card accounts, less any scheduled
   * into it. Card payments are not here: the whole card balance is already a claim.
   */
  recurringTransfers: number;
  /** Scheduled payments to a card from accounts outside the pool, up to what each card owes. */
  cardRelief: number;
  /** Spending in categories no budget covers, at the trailing pace, over the forecast window. */
  estimatedUnbudgeted: number;
  /** Days of history the unbudgeted pace is taken from. */
  unbudgetedBasisDays: number;
  /** Budgeted-but-unspent allocations still expected to be drawn. */
  allocatedBudgets: number;
  /** Money already earmarked against savings goals. */
  allocatedGoals: number;
  /** Signed. Negative means the claims exceed the pool. */
  /** Budgets of the months after this one that fall inside the window, prorated by day. */
  budgetsAhead: number;
  free: number;
  forecastDays: number;
  /** Every dated scheduled item behind inflows, bills, transfers and card relief, as its effect on free, in cents. */
  scheduled: ScheduledEffect[];
}

export interface ScheduledEffect {
  date: string;
  cents: number;
  kind: 'income' | 'bill' | 'transfer' | 'card_relief' | 'budget';
  label: string;
  patternId: string;
}

export interface SafeToSpendInputs {
  /** Budget rows for the current month, in cents, already projected. */
  budgets?: Array<{
    category_id?: string | null;
    projected_remaining?: number | null;
    amount?: number | null;
    rollover_balance?: number | null;
  }>;
  forecastDays?: number;
}

export function computeSafeToSpend(
  db: Database.Database,
  inputs: SafeToSpendInputs = {}
): SafeToSpendBreakdown {
  const forecastDays = inputs.forecastDays ?? 30;

  const accounts = db.prepare(`
    SELECT id, type, current_balance, is_liability, is_hidden
    FROM accounts
    WHERE is_hidden = 0 AND type != 'closed'
  `).all() as Array<{ id: string; type: string; current_balance: number; is_liability: number; is_hidden: number }>;

  let liquid = 0;
  let cardBalances = 0;
  const pool = new Set(accounts.filter(isInLiquidPool).map((account) => account.id));
  const liabilities = new Set(accounts.filter((account) => account.is_liability).map((account) => account.id));
  for (const account of accounts) {
    if (account.is_liability) {
      // Signed, not absolute. A card can sit in CREDIT (a refund or statement credit larger than
      // the balance), which is stored as a negative amount owed and is money coming back to the
      // pool, not another claim on it. Math.abs() here counted three cards in credit on
      // 2026-07-29 as $852.89 of debt, so the shortfall it reported was $1,705.78 too deep.
      cardBalances += account.current_balance;
    } else if (isInLiquidPool(account)) {
      liquid += account.current_balance;
    }
  }

  const forecast = buildRecurringForecast(db, forecastDays);
  const upcomingBills = Math.abs(forecast.bills);
  const incomeEffects = inflowsIntoPool(db, forecast.occurrences, pool, liabilities);
  const expectedInflows = incomeEffects.reduce((sum, item) => sum + item.cents, 0);
  const owed = new Map(accounts.filter((account) => account.is_liability).map((account) => [account.id, account.current_balance]));
  const cards = new Set((db.prepare('SELECT id FROM accounts WHERE is_liability = 1').all() as Array<{ id: string }>).map((row) => row.id));
  const { transfers: recurringTransfers, cardRelief, effects: transferEffects } = transfersAcrossPool(forecast.occurrences, pool, cards, owed);
  const estimatedUnbudgeted = unbudgetedPace(db, inputs.budgets ?? [], forecastDays);
  const budgetAheadEffects = budgetsAfterThisMonth(db, inputs.budgets ?? [], forecast.occurrences, forecastDays);
  const budgetsAhead = budgetAheadEffects.reduce((sum, item) => sum - item.cents, 0);

  // Clamped to what was actually budgeted. Now that refunds net a category's spend down,
  // `projected_remaining` can legitimately EXCEED the budget: July's Shopping budget is $500 while
  // its spend is -$1,203.63, giving $1,703.63 "remaining". That is a true statement about headroom
  // and a false one about intent, and this metric is about intent. You never earmarked $1,703.63
  // for Shopping.
  const allocatedBudgets = (inputs.budgets ?? []).reduce((sum, budget) => {
    const ceiling = (budget.amount ?? 0) + (budget.rollover_balance ?? 0);
    const remaining = Math.max(0, budget.projected_remaining ?? 0);
    return sum + (ceiling > 0 ? Math.min(remaining, ceiling) : remaining);
  }, 0);

  // Resolved through `calculateGoalProgress`, not by reading `goals.current_amount` raw.
  //
  // A goal linked to an account does not keep its saved amount in `current_amount`; the linked
  // balance IS the saved amount, and `calculateGoalProgress` is the shared definition that says so.
  // `routes/goals.ts`, `routes/insights.ts`, `aiContext.ts` and `advisorTools.ts` all ask it. This
  // function read the column instead, so one goal had two saved amounts and the disagreement landed
  // on the subject numeral of the home screen: on 2026-09-01 the live ledger carried `Emergency
  // Fund` at `current_amount` 100170 against a linked Wealthfront Cash account at `current_balance`
  // 0, so `/plan` and the advisor reported $0.00 saved and $5,000.00 to go while this function
  // subtracted $1,001.70 as already earmarked. The Balance screen read "$1,036.75 short this month"
  // where the honest figure was $35.05, and `readStanding` could name goal earmarks as the largest
  // claim on money nothing else said was spoken for.
  //
  // Reading the linked balance is also the only self-consistent answer: the earmark has to be the
  // part of the liquid pool this function just counted that is already spoken for, and that is the
  // money sitting in the goal's own account. It is bidirectional. A linked account that has grown
  // past `current_amount` was previously UNDERSTATED, so `free` read too high.
  //
  // Savings goals only, deliberately: a debt-payoff goal's progress is already carried by
  // `cardBalances` above, and counting it here would subtract the same money twice.
  //
  // A goal linked to an account the pool did not count earmarks nothing. /plan offers every visible
  // account as a link, and a savings goal linked to a brokerage subtracted brokerage money `liquid`
  // never held (on a copy of the scratch ledger, `free` fell by $2,891.97 with `liquid` unchanged);
  // linked to a card it subtracted the amount owed a second time on top of `cardBalances`. Falling
  // back to `current_amount` would not be right either, because for a linked goal the column is not
  // the saved amount, and wherever the money is, it is not in this pool.
  const goals = db.prepare(`
    SELECT g.type, g.target_amount, g.current_amount, g.starting_amount, g.account_id,
           a.current_balance AS account_balance, a.type AS account_type,
           a.is_hidden AS account_is_hidden, a.is_liability AS account_is_liability
    FROM goals g
    LEFT JOIN accounts a ON a.id = g.account_id
    WHERE g.is_archived = 0 AND g.type = 'savings'
  `).all() as GoalEarmarkRow[];
  const allocatedGoals = goals.reduce((sum, goal) => {
    if (goal.account_id !== null && !earmarksFromPool(goal)) return sum;
    return sum + calculateGoalProgress(goal).current_amount;
  }, 0);

  return {
    liquid,
    cardBalances,
    upcomingBills,
    expectedInflows,
    recurringTransfers,
    cardRelief,
    estimatedUnbudgeted,
    unbudgetedBasisDays: UNBUDGETED_BASIS_DAYS,
    allocatedBudgets,
    allocatedGoals,
    budgetsAhead,
    free: liquid + expectedInflows + cardRelief - cardBalances - upcomingBills - recurringTransfers
      - allocatedBudgets - budgetsAhead - estimatedUnbudgeted - allocatedGoals,
    forecastDays,
    scheduled: [...incomeEffects, ...billEffects(forecast.occurrences), ...transferEffects, ...budgetAheadEffects]
      .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label)),
  };
}

/**
 * Forecast income that reaches the pool: last paid into a pool account or onto a card counted in
 * the card claims. Income paid anywhere else reaches the pool, or pays down a card the pool owes,
 * only through a transfer, which `transfersAcrossPool` counts. With no deposit on record, or the
 * last one into an account since closed, where it lands is unknown, and it counts unless filed
 * under Investments or Crypto.
 */
function inflowsIntoPool(
  db: Database.Database,
  occurrences: readonly RecurringForecastOccurrence[],
  pool: Set<string>,
  liabilities: Set<string>
): ScheduledEffect[] {
  const landing = db.prepare(`
    SELECT a.id, a.type FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.recurring_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 1
  `);
  const investmentCategory = db.prepare(`
    WITH RECURSIVE invested(id) AS (
      SELECT id FROM categories WHERE id IN ('cat_inv', 'cat_crypto')
      UNION ALL SELECT c.id FROM categories c JOIN invested i ON c.parent_id = i.id
    )
    SELECT 1 FROM invested WHERE id = ?
  `);
  return occurrences.flatMap((occurrence): ScheduledEffect[] => {
    if (occurrence.kind === 'transfer' || occurrence.adjustment_action === 'skip' || occurrence.amount <= 0) return [];
    const landed = landing.get(occurrence.pattern_id) as { id: string; type: string } | undefined;
    const reachesPool = landed && landed.type !== 'closed'
      ? pool.has(landed.id) || liabilities.has(landed.id)
      : occurrence.category_id === null || investmentCategory.get(occurrence.category_id) === undefined;
    return reachesPool ? [effect(occurrence, occurrence.amount, 'income')] : [];
  });
}

function effect(occurrence: RecurringForecastOccurrence, cents: number, kind: ScheduledEffect['kind']): ScheduledEffect {
  return { date: occurrence.expected_date, cents, kind, label: occurrence.merchant_name, patternId: occurrence.pattern_id };
}

/** The forecast's bills, dated: the same occurrences `forecast.bills` sums. */
function billEffects(occurrences: readonly RecurringForecastOccurrence[]): ScheduledEffect[] {
  return occurrences
    .filter((occurrence) => occurrence.kind !== 'transfer' && occurrence.adjustment_action !== 'skip' && occurrence.amount < 0)
    .map((occurrence) => effect(occurrence, occurrence.amount, 'bill'));
}

/**
 * Money the schedule moves across the pool's edge. A card counted in the card claims is already
 * claimed in full, so a payment to it from the pool or from another card changes nothing; one from
 * outside the pool relieves that claim, never by more than the card owes, and is returned apart
 * from the transfers. Paying a card the claims leave out from the pool is money leaving it. Money from any
 * card is borrowed, so a transfer from a card never adds to what is free.
 */
function transfersAcrossPool(
  occurrences: readonly RecurringForecastOccurrence[],
  pool: Set<string>,
  cards: Set<string>,
  owed: Map<string, number>
): { transfers: number; cardRelief: number; effects: ScheduledEffect[] } {
  const relieved = new Map<string, number>();
  const effects: ScheduledEffect[] = [];
  let transfers = 0;
  for (const occurrence of occurrences) {
    if (occurrence.kind !== 'transfer' || occurrence.adjustment_action === 'skip') continue;
    const from = occurrence.account_id ?? '';
    const to = occurrence.counterparty_account_id ?? '';
    const size = Math.abs(occurrence.amount);
    if (owed.has(to)) {
      if (pool.has(from) || cards.has(from)) continue;
      const room = Math.max(0, (owed.get(to) ?? 0) - (relieved.get(to) ?? 0));
      const relief = Math.min(size, room);
      relieved.set(to, (relieved.get(to) ?? 0) + relief);
      if (relief > 0) effects.push(effect(occurrence, relief, 'card_relief'));
      continue;
    }
    if (cards.has(from) || pool.has(from) === pool.has(to)) continue;
    const leaving = pool.has(from) ? size : -size;
    transfers += leaving;
    effects.push(effect(occurrence, -leaving, 'transfer'));
  }
  return { transfers, cardRelief: [...relieved.values()].reduce((sum, value) => sum + value, 0), effects };
}

/**
 * Each later month's budgets, less that month's forecast bills in the same category (already
 * claimed as bills), for the days of that month the window reaches, spread evenly over those days. Budgeted categories are left out of the unbudgeted pace, so without this their
 * spending after this month ends would be claimed nowhere.
 */
function budgetsAfterThisMonth(
  db: Database.Database,
  budgets: ReadonlyArray<{ category_id?: string | null; amount?: number | null }>,
  occurrences: readonly RecurringForecastOccurrence[],
  forecastDays: number,
  today = new Date()
): ScheduledEffect[] {
  const parents = new Map((db.prepare('SELECT id, parent_id FROM categories').all() as Array<{ id: string; parent_id: string | null }>).map((row) => [row.id, row.parent_id]));
  const covers = (budgetCategory: string | null | undefined, category: string | null) =>
    !!budgetCategory && !!category && (category === budgetCategory || parents.get(category) === budgetCategory);
  const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const billsIn = (month: string, budgetCategory: string | null | undefined) => occurrences
    .filter((o) => o.kind !== 'transfer' && o.adjustment_action !== 'skip' && o.amount < 0 && o.expected_date.startsWith(month) && covers(budgetCategory, o.category_id ?? null))
    .reduce((sum, o) => sum - o.amount, 0);
  const effects: ScheduledEffect[] = [];
  const cursor = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + forecastDays);
  let carried = 0;
  let month = '';
  let monthly = 0;
  for (; cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    if (monthKey(cursor) !== month) {
      month = monthKey(cursor);
      monthly = budgets.reduce((sum, budget) => sum + Math.max(0, (budget.amount ?? 0) - billsIn(month, budget.category_id)), 0);
    }
    if (monthly <= 0) continue;
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const exact = monthly / daysInMonth + carried;
    const cents = Math.round(exact);
    carried = exact - cents;
    const date = `${month}-${String(cursor.getDate()).padStart(2, '0')}`;
    effects.push({ date, cents: -cents, kind: 'budget', label: 'Budgets', patternId: 'budgets' });
  }
  return effects;
}

export const UNBUDGETED_BASIS_DAYS = 90;

/**
 * What the categories without a budget have been costing, per day over the trailing window, times
 * the forecast window. Rows a recurring bill already forecasts are left out so they are not
 * claimed twice, and refunds net down the way they do in reports.
 */
function unbudgetedPace(
  db: Database.Database,
  budgets: ReadonlyArray<{ category_id?: string | null }>,
  forecastDays: number
): number {
  const budgeted = budgets.map((budget) => budget.category_id).filter((id): id is string => Boolean(id));
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (UNBUDGETED_BASIS_DAYS - 1));
  const iso = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  const row = db.prepare(`
    WITH RECURSIVE out_of_scope(id) AS (
      SELECT id FROM categories WHERE id IN ('cat_xfer', 'cat_inv', 'cat_crypto')
      UNION ALL
      SELECT c.id FROM categories c JOIN out_of_scope s ON c.parent_id = s.id
    ),
    budgeted(id) AS (
      SELECT id FROM categories WHERE id IN (${budgeted.map(() => '?').join(',') || 'NULL'})
      UNION ALL
      SELECT c.id FROM categories c JOIN budgeted b ON c.parent_id = b.id
    )
    SELECT COALESCE(SUM(${spendAmountSql('t')}), 0) AS spent
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
      AND ${excludedFromTotalsSql('t')}
      AND ${expenseSideSql('t', 'c')}
      AND COALESCE(t.category_id, '') NOT IN (SELECT id FROM out_of_scope)
      AND COALESCE(t.category_id, '') NOT IN (SELECT id FROM budgeted)
      AND ${reportDateSql('t')} BETWEEN ? AND ?
      AND NOT EXISTS (
        SELECT 1 FROM recurring_patterns rp
        WHERE rp.id = t.recurring_id AND rp.is_active = 1 AND rp.kind = 'flow'
      )
  `).get(...budgeted, iso(start), iso(end)) as { spent: number };

  return Math.max(0, Math.round((row.spent / UNBUDGETED_BASIS_DAYS) * forecastDays));
}

function earmarksFromPool(goal: GoalEarmarkRow): boolean {
  return goal.account_type !== null && isInLiquidPool({
    type: goal.account_type,
    is_hidden: goal.account_is_hidden ?? 1,
    is_liability: goal.account_is_liability ?? 1,
  });
}

/** The breakdown the screen and the advisor both read, in dollars, for this month's budgets. */
export function readSafeToSpend(db: Database.Database, forecastDays?: number) {
  const now = new Date();
  const budgets = getMonthlyBudgetsWithProjection(db, now.getFullYear(), now.getMonth() + 1);
  const breakdown = computeSafeToSpend(db, { budgets, ...(forecastDays ? { forecastDays } : {}) });
  return {
    liquid: toDollars(breakdown.liquid),
    card_balances: toDollars(breakdown.cardBalances),
    upcoming_bills: toDollars(breakdown.upcomingBills),
    expected_inflows: toDollars(breakdown.expectedInflows),
    recurring_transfers: toDollars(breakdown.recurringTransfers),
    card_relief: toDollars(breakdown.cardRelief),
    estimated_unbudgeted: toDollars(breakdown.estimatedUnbudgeted),
    unbudgeted_basis_days: breakdown.unbudgetedBasisDays,
    allocated_budgets: toDollars(breakdown.allocatedBudgets),
    allocated_goals: toDollars(breakdown.allocatedGoals),
    budgets_ahead: toDollars(breakdown.budgetsAhead),
    free: toDollars(breakdown.free),
    forecast_days: breakdown.forecastDays,
    ...dailyAllowance(breakdown, now),
  };
}

/**
 * What is free before the next expected income, spread over the days until it: claims taken now,
 * every scheduled item dated before that day, and the usual pace for those days. Income after it
 * is not counted, because it has not arrived when this money is being spent.
 */
function dailyAllowance(breakdown: SafeToSpendBreakdown, now: Date): { next_income_date: string | null; per_day_until_next_income: number | null } {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const next = breakdown.scheduled.find((item) => item.kind === 'income' && item.date > today)?.date ?? null;
  if (!next) return { next_income_date: null, per_day_until_next_income: null };
  const days = Math.max(1, Math.round((Date.parse(`${next}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000));
  const scheduledBefore = breakdown.scheduled.filter((item) => item.date < next).reduce((sum, item) => sum + item.cents, 0);
  const available = breakdown.liquid - breakdown.cardBalances - breakdown.allocatedBudgets - breakdown.allocatedGoals
    + scheduledBefore - (breakdown.estimatedUnbudgeted / breakdown.forecastDays) * (days - 1);
  if (available <= 0) return { next_income_date: next, per_day_until_next_income: null };
  return { next_income_date: next, per_day_until_next_income: toDollars(Math.floor(available / days)) };
}
