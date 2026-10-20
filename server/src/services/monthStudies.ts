import type Database from 'better-sqlite3';
import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns';
import { getCashflowReport, getSpendingReport } from './reporting';
import { excludedFromTotalsSql } from './transactionFilters';
import { toDollars } from './money';
import { MARKET_DRIVEN_TYPES } from '../../../shared/accountTypes';

const ymd = (date: Date) => format(date, 'yyyy-MM-dd');

function monthRange(month: string): { startDate: string; endDate: string } {
  const first = parseISO(`${month}-01`);
  return { startDate: ymd(startOfMonth(first)), endDate: ymd(endOfMonth(first)) };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Below this a category move is noise however unusual it is relative to its own history. */
const MIN_MOVE_CENTS = 2500;
const LARGE_ONE_OFF_CENTS = 50000;

/**
 * Month M against the median of the three months before it. A category is named only when its
 * move clears twice its own median absolute deviation, 15% of its usual level and $25, so a
 * steady month says nothing about categories.
 */
export function explainMonth(db: Database.Database, month: string) {
  const target = parseISO(`${month}-01`);
  if (!/^\d{4}-\d{2}$/.test(month) || Number.isNaN(target.getTime())) return { error: 'month must be YYYY-MM' };
  const priors = [1, 2, 3].map((back) => format(subMonths(target, back), 'yyyy-MM'));
  const spendByCategory = (m: string) => new Map(
    getSpendingReport(db, { ...monthRange(m), parentOnly: true }).categories.map((c) => [c.category_id, { name: c.category_name, amount: c.amount }])
  );
  const now = spendByCategory(month);
  const before = priors.map(spendByCategory);
  const ids = new Set([...now.keys(), ...before.flatMap((map) => [...map.keys()])]);
  const moves = [...ids].flatMap((id) => {
    const history = before.map((map) => map.get(id)?.amount ?? 0);
    const usual = median(history);
    const spread = median(history.map((value) => Math.abs(value - usual)));
    const current = now.get(id)?.amount ?? 0;
    const delta = current - usual;
    const threshold = Math.max(2 * spread, 0.15 * Math.abs(usual), MIN_MOVE_CENTS);
    if (Math.abs(delta) < threshold) return [];
    const name = now.get(id)?.name ?? before.find((map) => map.has(id))?.get(id)?.name ?? id;
    return [{ category: name, this_month: toDollars(current), usual: toDollars(Math.round(usual)), change: toDollars(Math.round(delta)) }];
  }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const flows = getCashflowReport(db, { startDate: monthRange(priors[2]).startDate, endDate: monthRange(month).endDate }).months;
  const flowOf = (m: string) => flows.find((row) => row.month === m) ?? { income: 0, expenses: 0, net: 0 };
  const usualIncome = median(priors.map((m) => flowOf(m).income));
  const usualSpend = median(priors.map((m) => Math.abs(flowOf(m).expenses)));

  const range = monthRange(month);
  const oneOffs = db.prepare(`
    SELECT t.date, COALESCE(t.merchant_name, t.original_name) AS name, t.amount
    FROM transactions t
    WHERE t.pending = 0 AND ${excludedFromTotalsSql('t')}
      AND t.date BETWEEN ? AND ? AND ABS(t.amount) >= ?
      AND NOT EXISTS (SELECT 1 FROM recurring_patterns rp WHERE rp.id = t.recurring_id AND rp.is_active = 1)
      AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.refund_of_id = t.id AND r.amount = -t.amount)
      AND t.refund_of_id IS NULL
    ORDER BY ABS(t.amount) DESC LIMIT 10
  `).all(range.startDate, range.endDate, LARGE_ONE_OFF_CENTS) as Array<{ date: string; name: string; amount: number }>;
  const repriced = db.prepare(`
    SELECT merchant_name, average_amount, amount_changed_from, amount_changed_on FROM recurring_patterns
    WHERE is_active = 1 AND amount_changed_on BETWEEN ? AND ?
  `).all(range.startDate, range.endDate) as Array<{ merchant_name: string; average_amount: number; amount_changed_from: number; amount_changed_on: string }>;

  const spent = Math.abs(flowOf(month).expenses);
  const explained = moves.reduce((sum, move) => sum + Math.round(move.change * 100), 0);
  return {
    month,
    compared_with: priors,
    income: { this_month: toDollars(flowOf(month).income), usual: toDollars(Math.round(usualIncome)) },
    spending: { this_month: toDollars(spent), usual: toDollars(Math.round(usualSpend)) },
    category_moves: moves,
    unexplained_by_named_moves: toDollars(Math.round(spent - usualSpend - explained)),
    large_one_offs: oneOffs.map((row) => ({ ...row, amount: toDollars(row.amount) })),
    repriced_recurring: repriced.map((row) => ({
      name: row.merchant_name,
      now: toDollars(row.average_amount),
      was: toDollars(row.amount_changed_from),
      since: row.amount_changed_on,
    })),
    method: 'Each category against the median of the three months before; a move is named only past twice its usual spread, 15% of its usual level and $25. Refunded purchases and their refunds are left out of the one-offs.',
  };
}

/** Per month: income from recurring patterns, other income, spending, and money moved into investments. */
export function fundingMix(db: Database.Database, months = 6, today = new Date()) {
  const first = startOfMonth(subMonths(today, months));
  const last = endOfMonth(subMonths(today, 1));
  const flows = getCashflowReport(db, { startDate: ymd(first), endDate: ymd(last) }).months;
  const recurringIncome = db.prepare(`
    SELECT substr(t.date, 1, 7) AS month, SUM(t.amount) AS cents
    FROM transactions t JOIN recurring_patterns rp ON rp.id = t.recurring_id
    WHERE t.pending = 0 AND t.amount > 0 AND rp.kind = 'flow' AND ${excludedFromTotalsSql('t')}
      AND t.date BETWEEN ? AND ?
    GROUP BY 1
  `).all(ymd(first), ymd(last)) as Array<{ month: string; cents: number }>;
  const investing = db.prepare(`
    SELECT substr(o.date, 1, 7) AS month, SUM(-o.amount) AS cents
    FROM transactions o
    JOIN transactions i ON i.transfer_pair_id = o.transfer_pair_id AND i.id <> o.id
    JOIN accounts ia ON ia.id = i.account_id
    WHERE o.amount < 0 AND o.transfer_status = 'confirmed'
      AND ia.type IN (${[...MARKET_DRIVEN_TYPES].map(() => '?').join(', ')})
      AND o.date BETWEEN ? AND ?
    GROUP BY 1
  `).all(...MARKET_DRIVEN_TYPES, ymd(first), ymd(last)) as Array<{ month: string; cents: number }>;
  const of = (rows: Array<{ month: string; cents: number }>, month: string) => rows.find((row) => row.month === month)?.cents ?? 0;
  return {
    months: flows.map((row) => {
      const fromPatterns = Math.min(of(recurringIncome, row.month), row.income);
      const spent = Math.abs(row.expenses);
      return {
        month: row.month,
        recurring_income: toDollars(fromPatterns),
        other_income: toDollars(row.income - fromPatterns),
        spending: toDollars(spent),
        invested: toDollars(of(investing, row.month)),
        recurring_income_covers_spending: spent > 0 ? Math.round((fromPatterns / spent) * 100) / 100 : null,
      };
    }),
    method: 'Recurring income is income on rows linked to a detected or confirmed recurring pattern; everything else is other income. Invested is confirmed transfers into brokerage, retirement or crypto accounts.',
  };
}
