import type Database from 'better-sqlite3';
import { addDays, addMonths, format, parseISO, startOfMonth, subMonths, endOfMonth } from 'date-fns';
import { computeSafeToSpend, type ScheduledEffect } from './safeToSpend';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';
import { getCashflowReport } from './reporting';
import { calculateGoalProgress } from './goalProgress';
import { toCents, toDollars } from './money';

const ymd = (date: Date) => format(date, 'yyyy-MM-dd');

export type ProjectionAdjustment =
  | { kind: 'one_off'; date: string; amount: number; label?: string }
  | { kind: 'monthly'; amount: number; start_date?: string; label?: string }
  | { kind: 'cancel_recurring'; pattern_id: string }
  | { kind: 'scale_unbudgeted'; percent: number };

interface Curve {
  end: number;
  lowest: number;
  lowestDate: string;
  firstNegativeDate: string | null;
}

function runCurve(start: number, perDay: number, effects: ScheduledEffect[], days: number, today: Date): Curve {
  const byDate = new Map<string, number>();
  for (const item of effects) byDate.set(item.date, (byDate.get(item.date) ?? 0) + item.cents);
  let value = start;
  const todayKey = ymd(today);
  for (const [date, cents] of byDate) if (date < todayKey) value += cents;
  let lowest = Number.POSITIVE_INFINITY;
  let lowestDate = todayKey;
  let firstNegativeDate: string | null = null;
  for (let day = 0; day <= days; day++) {
    const key = ymd(addDays(today, day));
    value += (byDate.get(key) ?? 0) - (day > 0 ? perDay : 0);
    if (value < lowest) { lowest = value; lowestDate = key; }
    if (value < 0 && firstNegativeDate === null) firstNegativeDate = key;
  }
  return { end: Math.round(value), lowest: Math.round(lowest), lowestDate, firstNegativeDate };
}

function adjustedEffects(effects: ScheduledEffect[], adjustments: ProjectionAdjustment[], today: Date, days: number): ScheduledEffect[] {
  const cancelled = new Set(adjustments.flatMap((a) => (a.kind === 'cancel_recurring' ? [a.pattern_id] : [])));
  const out = effects.filter((item) => !cancelled.has(item.patternId));
  const horizon = ymd(addDays(today, days));
  for (const adjustment of adjustments) {
    if (adjustment.kind === 'one_off') {
      out.push({ date: adjustment.date, cents: toCents(adjustment.amount), kind: adjustment.amount >= 0 ? 'income' : 'bill', label: adjustment.label ?? 'One-off', patternId: 'what_if' });
    } else if (adjustment.kind === 'monthly') {
      for (let date = adjustment.start_date ? parseISO(adjustment.start_date) : today; ymd(date) <= horizon; date = addMonths(date, 1)) {
        out.push({ date: ymd(date), cents: toCents(adjustment.amount), kind: adjustment.amount >= 0 ? 'income' : 'bill', label: adjustment.label ?? 'Monthly', patternId: 'what_if' });
      }
    }
  }
  return out;
}

/**
 * What is free, day by day over the window, from the same inputs as the headline figure: claims
 * on the pool are taken on day 0, each scheduled item on its date, unbudgeted spending evenly.
 * Without adjustments, the last day equals the free-to-spend figure exactly.
 */
export function projectFree(db: Database.Database, days: number, adjustments: ProjectionAdjustment[] = [], today = new Date()) {
  const budgets = getMonthlyBudgetsWithProjection(db, today.getFullYear(), today.getMonth() + 1);
  const sheet = computeSafeToSpend(db, { budgets, forecastDays: days });
  const start = sheet.liquid - sheet.cardBalances - sheet.allocatedBudgets - sheet.allocatedGoals;
  const perDay = sheet.estimatedUnbudgeted / days;
  const scale = adjustments.reduce((factor, a) => (a.kind === 'scale_unbudgeted' ? factor * (1 + a.percent / 100) : factor), 1);
  const baseline = runCurve(start, perDay, sheet.scheduled, days, today);
  const scenario = runCurve(start, perDay * scale, adjustedEffects(sheet.scheduled, adjustments, today, days), days, today);
  const dollars = (curve: Curve) => ({
    free_at_end: toDollars(curve.end),
    lowest: toDollars(curve.lowest),
    lowest_on: curve.lowestDate,
    first_short_on: curve.firstNegativeDate,
  });
  return {
    days,
    baseline: dollars(baseline),
    ...(adjustments.length > 0 ? { scenario: dollars(scenario), change_at_end: toDollars(scenario.end - baseline.end) } : {}),
    assumptions: [
      'Card balances, budgets still unspent and goal earmarks are claimed on day 0.',
      'Scheduled income, bills and transfers land on their forecast dates.',
      `Spending outside budgets runs at its trailing ${sheet.unbudgetedBasisDays}-day pace, spread evenly.`,
    ],
  };
}

/** Months to clear a balance at a fixed payment with monthly compounding; null when it never clears. */
export function debtPayoff(balance: number, aprPercent: number, monthlyPayment: number, today = new Date()) {
  const rate = aprPercent / 100 / 12;
  let owed = balance;
  let interest = 0;
  let months = 0;
  while (owed > 0.005 && months < 600) {
    const charge = owed * rate;
    if (monthlyPayment <= charge) return { months: null, payoff_month: null, total_interest: null, note: 'The payment does not cover the monthly interest, so the balance never falls.' };
    interest += charge;
    owed = owed + charge - monthlyPayment;
    months++;
  }
  return {
    months,
    payoff_month: format(addMonths(today, months), 'yyyy-MM'),
    total_interest: Math.round(interest * 100) / 100,
    note: months >= 600 ? 'Stopped at 50 years.' : null,
  };
}

/** Months until a target is reached with a fixed contribution and an optional yearly return. */
export function goalTimeline(target: number, current: number, monthlyContribution: number, annualReturnPercent = 0, today = new Date()) {
  const rate = annualReturnPercent / 100 / 12;
  let saved = current;
  let months = 0;
  while (saved < target && months < 1200) {
    saved = saved * (1 + rate) + monthlyContribution;
    months++;
    if (monthlyContribution <= 0 && rate <= 0) break;
  }
  if (saved < target) return { months: null, reach_month: null, note: 'At this contribution the target is never reached.' };
  return { months, reach_month: format(addMonths(today, months), 'yyyy-MM'), note: null };
}

export function goalTimelineFor(db: Database.Database, goalId: string, monthlyContribution: number, annualReturnPercent = 0) {
  const goal = db.prepare(`
    SELECT g.type, g.target_amount, g.current_amount, g.starting_amount, g.account_id,
           a.current_balance AS account_balance
    FROM goals g LEFT JOIN accounts a ON a.id = g.account_id WHERE g.id = ?
  `).get(goalId) as Parameters<typeof calculateGoalProgress>[0] | undefined;
  if (!goal) return { error: 'No goal with that id' };
  const progress = calculateGoalProgress(goal);
  return { remaining: toDollars(progress.remaining_amount), ...goalTimeline(toDollars(progress.remaining_amount), 0, monthlyContribution, annualReturnPercent) };
}

/** How many months the liquid pool covers at the average spending of the last complete months. */
export function cashRunway(db: Database.Database, months = 3, today = new Date()) {
  const sheet = computeSafeToSpend(db, {});
  const report = getCashflowReport(db, {
    startDate: ymd(startOfMonth(subMonths(today, months))),
    endDate: ymd(endOfMonth(subMonths(today, 1))),
  });
  const spent = report.months.map((month) => Math.abs(month.expenses));
  if (spent.length === 0) return { months: null, note: 'No complete month of spending to measure against.' };
  const average = spent.reduce((sum, value) => sum + value, 0) / spent.length;
  return {
    liquid: toDollars(sheet.liquid),
    average_monthly_spending: toDollars(Math.round(average)),
    months_covered: average > 0 ? Math.round((sheet.liquid / average) * 10) / 10 : null,
    measured_months: report.months.map((month) => month.month),
  };
}

/** Value after a number of years of monthly contributions at a fixed yearly return. */
export function compoundGrowth(principal: number, monthlyContribution: number, annualReturnPercent: number, years: number) {
  const rate = annualReturnPercent / 100 / 12;
  let value = principal;
  for (let month = 0; month < Math.round(years * 12); month++) value = value * (1 + rate) + monthlyContribution;
  const contributed = principal + monthlyContribution * Math.round(years * 12);
  return { final_value: Math.round(value * 100) / 100, contributed: Math.round(contributed * 100) / 100, growth: Math.round((value - contributed) * 100) / 100 };
}
