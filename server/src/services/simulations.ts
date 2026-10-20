import type Database from 'better-sqlite3';
import { addDays, addMonths, format, parseISO, startOfMonth, subMonths, endOfMonth } from 'date-fns';
import { computeSafeToSpend, overdueIncomeCounted, type ScheduledEffect } from './safeToSpend';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';
import { getCashflowReport, getSpendingReport } from './reporting';
import { calculateGoalProgress } from './goalProgress';
import { toCents, toDollars } from './money';
import { excludedFromTotalsSql, expenseSideSql, inReportScopeSql, reportDateSql, spendAmountSql } from './transactionFilters';

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
  daily: number[];
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
  const daily: number[] = [];
  for (let day = 0; day <= days; day++) {
    const key = ymd(addDays(today, day));
    value += (byDate.get(key) ?? 0) - (day > 0 ? perDay : 0);
    daily.push(value);
    if (value < lowest) { lowest = value; lowestDate = key; }
    if (value < 0 && firstNegativeDate === null) firstNegativeDate = key;
  }
  return { end: Math.round(value), lowest: Math.round(lowest), lowestDate, firstNegativeDate, daily };
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

export type AdjustmentCheck = { ok: true; adjustments: ProjectionAdjustment[] } | { ok: false; errors: string[] };

/** Refuses anything that would silently change the answer: a missing amount, a date outside the window, an unknown pattern. */
export function checkAdjustments(db: Database.Database, raw: unknown, days: number, today = new Date()): AdjustmentCheck {
  if (raw === undefined) return { ok: true, adjustments: [] };
  if (!Array.isArray(raw)) return { ok: false, errors: ['adjustments must be an array'] };
  const first = ymd(today);
  const last = ymd(addDays(today, days));
  const errors: string[] = [];
  const adjustments: ProjectionAdjustment[] = [];
  const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseISO(value).getTime());
  raw.forEach((item, index) => {
    const a = (item ?? {}) as Record<string, unknown>;
    const amount = Number(a.amount);
    switch (a.kind) {
      case 'one_off':
        if (!Number.isFinite(amount) || amount === 0) errors.push(`${index}: one_off needs a non-zero amount`);
        else if (!isDate(a.date) || a.date < first || a.date > last) errors.push(`${index}: one_off date must fall between ${first} and ${last}`);
        else adjustments.push({ kind: 'one_off', date: a.date, amount, label: typeof a.label === 'string' ? a.label : undefined });
        return;
      case 'monthly':
        if (!Number.isFinite(amount) || amount === 0) errors.push(`${index}: monthly needs a non-zero amount`);
        else if (a.start_date !== undefined && (!isDate(a.start_date) || a.start_date < first || a.start_date > last)) errors.push(`${index}: monthly start_date must fall between ${first} and ${last}`);
        else adjustments.push({ kind: 'monthly', amount, start_date: a.start_date as string | undefined, label: typeof a.label === 'string' ? a.label : undefined });
        return;
      case 'cancel_recurring':
        if (typeof a.pattern_id !== 'string' || !db.prepare('SELECT 1 FROM recurring_patterns WHERE id = ? AND is_active = 1').get(a.pattern_id)) errors.push(`${index}: no active recurring pattern with that pattern_id`);
        else adjustments.push({ kind: 'cancel_recurring', pattern_id: a.pattern_id });
        return;
      case 'scale_unbudgeted': {
        const percent = Number(a.percent);
        if (!Number.isFinite(percent) || percent < -100) errors.push(`${index}: scale_unbudgeted needs a percent of -100 or more`);
        else adjustments.push({ kind: 'scale_unbudgeted', percent });
        return;
      }
      default:
        errors.push(`${index}: unknown kind ${String(a.kind)}`);
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, adjustments };
}

/**
 * What is free, day by day over the window, from the same inputs as the headline figure: claims
 * on the pool are taken on day 0, each scheduled item on its date, unbudgeted spending evenly.
 * Without adjustments, the last day equals the free-to-spend figure exactly.
 */
export function projectFree(db: Database.Database, days: number, adjustments: ProjectionAdjustment[] = [], today = new Date()) {
  const budgets = getMonthlyBudgetsWithProjection(db, today.getFullYear(), today.getMonth() + 1);
  const sheet = computeSafeToSpend(db, { budgets, forecastDays: days, today });
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
  const overdue = sheet.overdueIncome;
  return {
    days,
    baseline: dollars(baseline),
    ...(overdue.length > 0 ? {
      overdue_income_counted: overdueIncomeCounted(sheet),
    } : {}),
    ...(adjustments.length > 0 ? { scenario: dollars(scenario), change_at_end: toDollars(scenario.end - baseline.end) } : {}),
    assumptions: [
      'Card balances, budgets still unspent and goal earmarks are claimed on day 0, so "short" means below those claims, not an overdrawn account.',
      'Scheduled income, bills and transfers land on their forecast dates.',
      `Spending outside budgets runs at its trailing ${sheet.unbudgetedBasisDays}-day pace, spread evenly.`,
      ...(overdue.length > 0 ? ['Income that was expected already but has not posted is counted as arriving today; see overdue_income_counted.'] : []),
    ],
  };
}

/** Months to clear a balance at a fixed payment with monthly compounding; null when it never clears. */
export function debtPayoff(balance: number, aprPercent: number, monthlyPayment: number, today = new Date()) {
  if (!(monthlyPayment > 0)) return { months: null, payoff_month: null, total_interest: null, note: 'A monthly payment above zero is needed.' };
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
  const target = toDollars(progress.progress_amount + progress.remaining_amount);
  return { remaining: toDollars(progress.remaining_amount), ...goalTimeline(target, toDollars(progress.progress_amount), monthlyContribution, annualReturnPercent) };
}

/** How many months the liquid pool, less what the cards owe, covers at the average spending of the last complete months. */
export function cashRunway(db: Database.Database, months = 3, today = new Date()) {
  const sheet = computeSafeToSpend(db, {});
  const report = getCashflowReport(db, {
    startDate: ymd(startOfMonth(subMonths(today, months))),
    endDate: ymd(endOfMonth(subMonths(today, 1))),
  });
  const spent = report.months.map((month) => Math.abs(month.expenses));
  if (spent.length === 0) return { months_covered: null, note: 'No complete month of spending to measure against.' };
  const average = spent.reduce((sum, value) => sum + value, 0) / spent.length;
  const cover = sheet.liquid - sheet.cardBalances;
  return {
    liquid: toDollars(sheet.liquid),
    cards_owed: toDollars(sheet.cardBalances),
    average_monthly_spending: toDollars(Math.round(average)),
    months_covered: average > 0 ? Math.round((cover / average) * 10) / 10 : null,
    measured_months: report.months.map((month) => month.month),
    assumptions: [
      'Card balances are paid from the liquid accounts first.',
      'No income arrives, and spending runs at the average of the measured months.',
      'Money earmarked for goals in those accounts is counted as available.',
    ],
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

export const DEFAULT_ESSENTIAL_CATEGORIES = ['cat_food', 'cat_home', 'cat_transport', 'cat_health', 'cat_pets', 'cat_subscriptions', 'cat_fees', 'cat_education'];

/**
 * A cushion sized from how much essential spending actually varies:
 * months × mean + z × sd × √months, from the last complete months.
 */
export function emergencyFund(
  db: Database.Database,
  options: { months?: number; confidence?: 0.8 | 0.9 | 0.95; categories?: string[]; history?: number } = {},
  today = new Date()
) {
  const cover = options.months ?? 3;
  const z = { 0.8: 0.84, 0.9: 1.28, 0.95: 1.64 }[options.confidence ?? 0.9];
  const categories = new Set(options.categories?.length ? options.categories : DEFAULT_ESSENTIAL_CATEGORIES);
  const history = Math.min(Math.max(options.history ?? 6, 3), 24);
  const totals: number[] = [];
  for (let back = history; back >= 1; back--) {
    const month = subMonths(today, back);
    const report = getSpendingReport(db, { startDate: ymd(startOfMonth(month)), endDate: ymd(endOfMonth(month)), parentOnly: true });
    totals.push(report.categories.filter((c) => categories.has(c.category_id)).reduce((sum, c) => sum + c.amount, 0));
  }
  const measured = totals.filter((value) => value !== 0);
  if (measured.length < 3) return { target: null, note: 'Fewer than three months of essential spending to measure.' };
  const mean = measured.reduce((sum, value) => sum + value, 0) / measured.length;
  const sd = Math.sqrt(measured.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (measured.length - 1));
  const target = cover * mean + z * sd * Math.sqrt(cover);
  const sheet = computeSafeToSpend(db, {});
  const available = sheet.liquid - sheet.cardBalances;
  return {
    target: toDollars(Math.round(target)),
    essential_monthly_mean: toDollars(Math.round(mean)),
    essential_monthly_sd: toDollars(Math.round(sd)),
    liquid_after_cards: toDollars(available),
    months_of_essentials_covered: mean > 0 ? Math.round((available / mean) * 10) / 10 : null,
    assumptions: [
      `Essentials are these categories: ${[...categories].join(', ')}. The owner can change the set.`,
      `${measured.length} complete months measured; ${Math.round((options.confidence ?? 0.9) * 100)}% confidence; ${cover} months of cover.`,
      'Liquid accounts less what the cards owe; goal earmarks are counted as available.',
    ],
  };
}

const BAND_HISTORY_DAYS = 182;
const BAND_MIN_HISTORY_DAYS = 90;
const BAND_BLOCK_DAYS = 7;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Daily non-recurring spend over the history window, oldest first, refunds netted to their purchase date. */
export function dailyDiscretionarySpend(db: Database.Database, today: Date): { daily: number[]; coveredDays: number } {
  const start = ymd(addDays(today, -BAND_HISTORY_DAYS));
  const end = ymd(addDays(today, -1));
  const rows = db.prepare(`
    SELECT ${reportDateSql('t')} AS day, SUM(${spendAmountSql('t')}) AS cents
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0 AND ${excludedFromTotalsSql('t')} AND ${expenseSideSql('t', 'c')} AND ${inReportScopeSql('t')}
      AND ${reportDateSql('t')} BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM recurring_patterns rp WHERE rp.id = t.recurring_id AND rp.is_active = 1)
    GROUP BY 1
  `).all(start, end) as Array<{ day: string; cents: number }>;
  const first = db.prepare('SELECT MIN(date) AS first FROM transactions').get() as { first: string | null };
  const byDay = new Map(rows.map((row) => [row.day, row.cents]));
  const daily: number[] = [];
  for (let day = BAND_HISTORY_DAYS; day >= 1; day--) {
    const key = ymd(addDays(today, -day));
    if (first.first && key >= first.first) daily.push(byDay.get(key) ?? 0);
  }
  return { daily, coveredDays: daily.length };
}

/**
 * The projection as a distribution: non-recurring spending is replayed from the owner's own days
 * in 7-day blocks, and each income occurrence's amount is drawn from that pattern's last twelve.
 * The point projection's own inputs are kept; only these two vary.
 */
export function projectFreeBand(db: Database.Database, days: number, paths = 4000, today = new Date(), seed = 20261016, adjustments: ProjectionAdjustment[] = []) {
  const budgets = getMonthlyBudgetsWithProjection(db, today.getFullYear(), today.getMonth() + 1);
  const sheet = computeSafeToSpend(db, { budgets, forecastDays: days });
  const { daily, coveredDays } = dailyDiscretionarySpend(db, today);
  if (coveredDays < BAND_MIN_HISTORY_DAYS) {
    return { band: null, note: `Only ${coveredDays} days of spending history; a band needs ${BAND_MIN_HISTORY_DAYS}.` };
  }
  const meanDaily = daily.reduce((sum, value) => sum + value, 0) / daily.length;
  const todayKey = ymd(today);
  const recentAmounts = db.prepare('SELECT amount FROM transactions WHERE recurring_id = ? ORDER BY date DESC LIMIT 12');
  const income = sheet.scheduled
    .filter((item) => item.kind === 'income')
    .map((item) => {
      const history = (recentAmounts.all(item.patternId) as Array<{ amount: number }>).map((row) => row.amount).filter((amount) => amount > 0);
      const offset = Math.max(0, Math.round((parseISO(item.date).getTime() - parseISO(todayKey).getTime()) / 86_400_000));
      return { offset, expected: item.cents, history, patternId: item.patternId };
    });
  const start = sheet.liquid - sheet.cardBalances - sheet.allocatedBudgets - sheet.allocatedGoals;
  const scale = adjustments.reduce((factor, a) => (a.kind === 'scale_unbudgeted' ? factor * (1 + a.percent / 100) : factor), 1);
  const baselineCurve = runCurve(start, sheet.estimatedUnbudgeted / days, sheet.scheduled, days, today);
  const cancelled = new Set(adjustments.flatMap((a) => (a.kind === 'cancel_recurring' ? [a.pattern_id] : [])));
  const run = (curve: Curve, spendScale: number, dropped = new Set<string>()) => simulateBand(curve, daily, meanDaily, income, days, paths, seed, spendScale, dropped);
  const baseline = run(baselineCurve, 1);
  const assumptions = [
    `Non-recurring spending is replayed from ${coveredDays} days of history in ${BAND_BLOCK_DAYS}-day blocks around its daily average.`,
    'Each expected income occurrence is drawn from its pattern\'s last twelve amounts; patterns with fewer than three keep the forecast amount.',
    'Everything else (claims, bills, transfers, budgets) is as in the point projection. "Below claims" is not an overdraft.',
  ];
  if (adjustments.length === 0) return { days, paths, ...baseline, assumptions };
  const scenarioCurve = runCurve(start, (sheet.estimatedUnbudgeted / days) * scale, adjustedEffects(sheet.scheduled, adjustments, today, days), days, today);
  return { days, paths, ...baseline, scenario: run(scenarioCurve, scale, cancelled), assumptions };
}

function simulateBand(
  pointEnd: Curve,
  daily: number[],
  meanDaily: number,
  income: Array<{ offset: number; expected: number; history: number[]; patternId: string }>,
  days: number,
  paths: number,
  seed: number,
  spendScale: number,
  dropped: ReadonlySet<string>
) {
  const random = seededRandom(seed);
  const ends: number[] = [];
  let pathsBelowZero = 0;
  for (let path = 0; path < paths; path++) {
    const deviation = new Array<number>(days + 1).fill(0);
    for (let day = 1; day <= days; day += BAND_BLOCK_DAYS) {
      const start = Math.floor(random() * Math.max(1, daily.length - BAND_BLOCK_DAYS + 1));
      for (let k = 0; k < BAND_BLOCK_DAYS && day + k <= days; k++) deviation[day + k] -= (daily[start + k] - meanDaily) * spendScale;
    }
    for (const item of income) {
      if (item.history.length >= 3 && item.offset <= days) {
        const drawn = item.history[Math.floor(random() * item.history.length)];
        if (!dropped.has(item.patternId)) deviation[item.offset] += drawn - item.expected;
      }
    }
    let shift = 0;
    let lowest = Number.POSITIVE_INFINITY;
    for (let day = 0; day <= days; day++) {
      shift += deviation[day];
      lowest = Math.min(lowest, pointEnd.daily[day] + shift);
    }
    ends.push(pointEnd.end + shift);
    if (lowest < 0) pathsBelowZero++;
  }
  ends.sort((a, b) => a - b);
  return {
    point_estimate: toDollars(pointEnd.end),
    band: {
      p10: toDollars(Math.round(quantile(ends, 0.1))),
      p50: toDollars(Math.round(quantile(ends, 0.5))),
      p90: toDollars(Math.round(quantile(ends, 0.9))),
    },
    chance_of_dropping_below_claims: Math.round((pathsBelowZero / paths) * 100) / 100,
  };
}
