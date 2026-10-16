import type Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import type { RecurringForecastOccurrence } from '../../../shared/types';
import { buildRecurringForecast } from './recurringForecast';
import { toDollars } from './money';

const ASSET_TYPES = new Set(['checking', 'savings', 'cash']);
const UNSCHEDULED_WINDOW_DAYS = 90;

interface AccountRow {
  id: string;
  account_name: string;
  type: string;
  is_liability: number;
  current_balance: number;
}

interface Movement {
  date: string;
  cents: number;
  label: string;
  patternId: string;
  expectedDate: string;
  overdue: boolean;
}

export type CardCoverage =
  | { card: string; status: 'covered' | 'short'; paid_from: string; due: string; overdue: boolean; scheduled_payment: number; owed_now: number; paying_account_after: number; full_balance_covered: boolean }
  | { card: string; status: 'unjudged'; reason: string; owed_now: number };

function landingAccount(db: Database.Database): (patternId: string) => string | null {
  const latest = db.prepare(`
    SELECT t.account_id FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.recurring_id = ? AND a.type <> 'closed' ORDER BY t.date DESC, t.id DESC LIMIT 1
  `);
  return (patternId) => (latest.get(patternId) as { account_id: string } | undefined)?.account_id ?? null;
}

function movementsByAccount(db: Database.Database, occurrences: readonly RecurringForecastOccurrence[], today: string) {
  const landedOn = landingAccount(db);
  const byAccount = new Map<string, Movement[]>();
  const unplaced: string[] = [];
  const overdueIncome: Array<{ what: string; expected: string; amount: number }> = [];
  const add = (accountId: string, occurrence: RecurringForecastOccurrence, cents: number) => {
    const list = byAccount.get(accountId) ?? [];
    list.push({
      date: occurrence.expected_date < today ? today : occurrence.expected_date,
      cents,
      label: occurrence.merchant_name,
      patternId: occurrence.pattern_id,
      expectedDate: occurrence.expected_date,
      overdue: occurrence.status === 'overdue',
    });
    byAccount.set(accountId, list);
  };
  for (const occurrence of occurrences) {
    if (occurrence.adjustment_action === 'skip' || occurrence.amount === 0) continue;
    if (occurrence.kind === 'transfer') {
      const cents = Math.abs(occurrence.amount);
      if (occurrence.account_id) add(occurrence.account_id, occurrence, -cents);
      if (occurrence.counterparty_account_id) add(occurrence.counterparty_account_id, occurrence, cents);
      continue;
    }
    if (occurrence.amount > 0 && occurrence.status === 'overdue') {
      overdueIncome.push({ what: occurrence.merchant_name, expected: occurrence.expected_date, amount: toDollars(occurrence.amount) });
      continue;
    }
    const landed = landedOn(occurrence.pattern_id);
    if (landed) add(landed, occurrence, occurrence.amount);
    else if (!unplaced.includes(occurrence.merchant_name)) unplaced.push(occurrence.merchant_name);
  }
  return { byAccount, unplaced, overdueIncome };
}

function unscheduledOutflow(db: Database.Database, accountId: string, today: Date): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(-amount), 0) AS cents FROM transactions
    WHERE account_id = ? AND amount < 0 AND pending = 0 AND recurring_id IS NULL
      AND transfer_pair_id IS NULL AND date > ? AND date <= ?
  `).get(accountId, format(subDays(today, UNSCHEDULED_WINDOW_DAYS), 'yyyy-MM-dd'), format(today, 'yyyy-MM-dd')) as { cents: number };
  return row.cents;
}

function walk(start: number, movements: Movement[]) {
  const sorted = [...movements].sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
  const endOfDay = new Map<string, number>();
  let balance = start;
  for (const movement of sorted) {
    balance += movement.cents;
    endOfDay.set(movement.date, balance);
  }
  let lowest = { date: null as string | null, cents: start };
  let firstBelowZero: { date: string; cents: number; that_day: Movement[] } | null = null;
  for (const [date, cents] of endOfDay) {
    if (cents < lowest.cents) lowest = { date, cents };
    if (cents < 0 && !firstBelowZero) firstBelowZero = { date, cents, that_day: sorted.filter((movement) => movement.date === date) };
  }
  return { sorted, endOfDay, lowest, firstBelowZero, end: balance };
}

function walkCashAccounts(db: Database.Database, days: number, today: Date) {
  const todayStr = format(today, 'yyyy-MM-dd');
  const accounts = db.prepare(`
    SELECT id, account_name, type, is_liability, current_balance FROM accounts
    WHERE is_hidden = 0 AND type <> 'closed'
  `).all() as AccountRow[];
  const { occurrences } = buildRecurringForecast(db, days);
  const { byAccount, unplaced, overdueIncome } = movementsByAccount(db, occurrences, todayStr);
  const cash = accounts.filter((account) => !account.is_liability && ASSET_TYPES.has(account.type));
  const walks = new Map(cash.map((account) => [account.id, walk(account.current_balance, byAccount.get(account.id) ?? [])]));
  return { todayStr, accounts, cash, occurrences, walks, unplaced, overdueIncome };
}

/** Cash accounts the schedule takes below zero within `days`, with what moves on that day. */
export function projectedShortfalls(db: Database.Database, days: number, today = new Date()) {
  const { cash, walks } = walkCashAccounts(db, days, today);
  return cash.flatMap((account) => {
    const below = walks.get(account.id)?.firstBelowZero;
    return below ? [{ account_id: account.id, account_name: account.account_name, balance_now: account.current_balance, ...below }] : [];
  });
}

/**
 * Each cash account walked forward through the schedule that touches it, and each card's next
 * scheduled payment judged against the account it is paid from. A card with no scheduled payment
 * is reported unjudged rather than covered.
 */
export function accountCoverage(db: Database.Database, days = 45, today = new Date()) {
  const { todayStr, accounts, cash: cashAccounts, occurrences, walks, unplaced, overdueIncome } = walkCashAccounts(db, days, today);
  const nameOf = new Map(accounts.map((account) => [account.id, account.account_name]));
  const cash = cashAccounts.map((account) => {
    const result = walks.get(account.id)!;
    return {
      account: account.account_name,
      balance_now: toDollars(account.current_balance),
      scheduled: result.sorted.map((movement) => ({
        date: movement.date,
        amount: toDollars(movement.cents),
        what: movement.label,
        ...(movement.overdue ? { overdue: true } : {}),
      })),
      lowest: result.lowest.date ? { date: result.lowest.date, balance: toDollars(result.lowest.cents) } : null,
      end_of_window: toDollars(result.end),
      first_below_zero: result.firstBelowZero ? { date: result.firstBelowZero.date, balance: toDollars(result.firstBelowZero.cents) } : null,
      unscheduled_outflow_last_90_days: toDollars(unscheduledOutflow(db, account.id, today)),
    };
  });

  const cards: CardCoverage[] = accounts.filter((account) => account.is_liability).map((card) => {
    const payment = occurrences
      .filter((o) => o.kind === 'transfer' && o.counterparty_account_id === card.id && o.adjustment_action !== 'skip')
      .sort((a, b) => a.expected_date.localeCompare(b.expected_date))[0];
    const owed = toDollars(card.current_balance);
    if (!payment) return { card: card.account_name, status: 'unjudged', reason: `no scheduled payment in the next ${days} days`, owed_now: owed };
    const from = payment.account_id ? walks.get(payment.account_id) : undefined;
    if (!payment.account_id || !from) {
      return { card: card.account_name, status: 'unjudged', reason: 'paid from an account this check does not walk', owed_now: owed };
    }
    const due = payment.expected_date < todayStr ? todayStr : payment.expected_date;
    const after = from.endOfDay.get(due) ?? from.end;
    const scheduled = Math.abs(payment.amount);
    return {
      card: card.account_name,
      status: after >= 0 ? 'covered' : 'short',
      paid_from: nameOf.get(payment.account_id) ?? payment.account_id,
      due,
      overdue: payment.status === 'overdue',
      scheduled_payment: toDollars(scheduled),
      owed_now: owed,
      paying_account_after: toDollars(after),
      full_balance_covered: after + scheduled - Math.max(card.current_balance, 0) >= 0,
    };
  });

  return {
    window_days: days,
    cash_accounts: cash,
    cards,
    not_placed_on_any_account: unplaced,
    overdue_income_not_counted: overdueIncome,
    method: 'Each checking, savings or cash account starts at its current balance and takes every scheduled income, bill and transfer that touches it, judged at the end of each day; an overdue payment or transfer counts as due today, overdue income is left out until it posts, and a skipped item counts not at all. Income and bills land on the account their last posting did; ones with no posting are listed as not placed. Unscheduled spending from the account itself is not projected, so its last 90 days are shown beside each account. A card is covered when the account paying it stays at or above zero after its scheduled payment; full_balance_covered asks the same if the whole current balance were paid instead.',
  };
}
