import type Database from 'better-sqlite3';
import { addDays, format, parseISO } from 'date-fns';
import { MARKET_DRIVEN_TYPES, bucketOf } from '../../../shared/accountTypes';
import { readMarketAnchors, readRecordedValues } from './marketValuation';
import { externalMarketFlow } from './portfolioFlows';
import type { NetWorthTimelineAccount, NetWorthTimelinePoint, NetWorthTimelineStep } from '../../../shared/types';

export type TimelineStep = NetWorthTimelineStep;
type TimelineAccount = NetWorthTimelineAccount;
type TimelinePoint = NetWorthTimelinePoint;

interface AccountRow {
  id: string;
  account_name: string;
  type: string;
  is_liability: number;
  current_balance: number;
  balance_only: number;
}

interface TxnRow {
  account_id: string;
  date: string;
  amount: number;
  category_id: string | null;
  transfer_status: string | null;
  is_internal_trade: number;
}

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = parseISO(from); format(d, 'yyyy-MM-dd') <= to; d = addDays(d, 1)) out.push(format(d, 'yyyy-MM-dd'));
  return out;
}

function bucketKey(date: string, step: TimelineStep): string {
  if (step === 'day') return date;
  if (step === 'month') return date.slice(0, 7);
  const d = parseISO(date);
  return format(addDays(d, -((d.getDay() + 6) % 7)), 'yyyy-MM-dd');
}

/** Each account's value at the end of every day in [from, to], in cents, signed as an asset. */
function accountSeries(
  account: AccountRow,
  txns: TxnRow[],
  calendar: string[],
  anchors: Array<{ date: string; value: number }>,
  today: string,
): { values: Array<number | null>; observed: boolean[]; first: string | null; opening: number | null } {
  const market = MARKET_DRIVEN_TYPES.has(account.type);
  const first = txns.length ? txns[0].date : null;
  const values: Array<number | null> = new Array(calendar.length).fill(null);
  const observed: boolean[] = new Array(calendar.length).fill(!market);

  if (account.balance_only) {
    // Every change to such a balance is an edit, and every edit writes a sheet, so the value last
    // recorded is the value the app held until the next one.
    const sign = account.is_liability ? -1 : 1;
    const recorded = [...anchors, { date: today, value: account.current_balance }];
    for (let i = 0, r = -1; i < calendar.length; i++) {
      while (r + 1 < recorded.length && recorded[r + 1].date <= calendar[i]) r++;
      if (r >= 0) values[i] = sign * recorded[r].value;
    }
    return { values, observed, first: recorded[0].date, opening: null };
  }

  if (!market) {
    // A liability's balance is owed and moves against the sign; negate both so the walk is one rule.
    const sign = account.is_liability ? -1 : 1;
    let balance = sign * account.current_balance;
    let t = txns.length - 1;
    const end = calendar[calendar.length - 1];
    while (t >= 0 && txns[t].date > end) balance -= txns[t--].amount;
    for (let i = calendar.length - 1; i >= 0; i--) {
      while (t >= 0 && txns[t].date > calendar[i]) balance -= txns[t--].amount;
      values[i] = balance;
    }
    while (t >= 0) balance -= txns[t--].amount;
    const opening = first ? balance : null;
    for (let i = 0; i < calendar.length; i++) {
      if (first && calendar[i] < first) values[i] = opening === 0 ? 0 : null;
    }
    return { values, observed, first, opening };
  }

  const flowsAfter = (from: string, upTo: string) =>
    txns.reduce((sum, txn) => (txn.date > from && txn.date <= upTo ? sum + externalMarketFlow(txn, account.type) : sum), 0);
  const anchorOn = new Map(anchors.map((a) => [a.date, a.value]));
  for (let i = 0; i < calendar.length; i++) {
    const day = calendar[i];
    if (!first || day < first) {
      values[i] = 0;
      observed[i] = true;
      continue;
    }
    if (day === today) {
      values[i] = account.current_balance;
      observed[i] = true;
      continue;
    }
    if (anchorOn.has(day)) {
      values[i] = anchorOn.get(day)!;
      observed[i] = true;
      continue;
    }
    const anchor = anchors.find((a) => a.date > day);
    const base = anchor ? anchor.value - flowsAfter(day, anchor.date) : account.current_balance - flowsAfter(day, '9999-12-31');
    values[i] = Math.max(0, base);
  }
  return { values, observed, first, opening: null };
}

/** Net worth on every day from `from` to `to`, built per account as METHOD says. Pure read. */
export function netWorthTimeline(
  db: Database.Database,
  options: { from?: string; to?: string; accountIds?: readonly string[]; step?: TimelineStep; today?: string } = {},
) {
  const today = options.today ?? format(new Date(), 'yyyy-MM-dd');
  const step = options.step ?? 'day';
  const wanted = options.accountIds?.length ? new Set(options.accountIds) : null;
  // Naming an account asks for it, so a hidden one is drawn on its own page.
  const all = db.prepare(`
    SELECT id, account_name, type, is_liability, current_balance, balance_only FROM accounts
    ${wanted ? '' : 'WHERE is_hidden = 0'}
  `).all() as AccountRow[];
  const accounts = wanted ? all.filter((a) => wanted.has(a.id)) : all;
  const txnsByAccount = new Map<string, TxnRow[]>();
  for (const txn of db.prepare(`
    SELECT account_id, date, amount, category_id, transfer_status, is_internal_trade
    FROM transactions WHERE pending = 0 AND date <= ? ORDER BY date ASC
  `).all(today) as TxnRow[]) {
    const list = txnsByAccount.get(txn.account_id) ?? [];
    list.push(txn);
    txnsByAccount.set(txn.account_id, list);
  }
  const firstDates = accounts.map((a) => txnsByAccount.get(a.id)?.[0]?.date).filter((d): d is string => Boolean(d)).sort();
  const from = options.from ?? firstDates[0] ?? today;
  const to = options.to && options.to < today ? options.to : today;
  if (from > to) return { from, to, step, accounts: [], points: [], method: METHOD };

  const calendar = days(from, to);
  const anchors = readMarketAnchors(db, accounts.filter((a) => MARKET_DRIVEN_TYPES.has(a.type) && !a.balance_only).map((a) => a.id), today);
  const balanceOnly = accounts.filter((a) => a.balance_only).map((a) => a.id);
  for (const [id, dates] of readRecordedValues(db, new Set(balanceOnly))) {
    anchors.set(id, [...dates].filter(([date]) => date < today).map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)));
  }
  const series = accounts.map((a) => ({ account: a, ...accountSeries(a, txnsByAccount.get(a.id) ?? [], calendar, anchors.get(a.id) ?? [], today) }));

  const points: TimelinePoint[] = calendar.map((date, i) => {
    const point: TimelinePoint = { date, net_worth: 0, assets: 0, liabilities: 0, liquid: 0, invested: 0, crypto: 0, estimated: false, estimated_accounts: [], coverage: 0, by_account: {} };
    for (const s of series) {
      const value = s.values[i];
      if (value === null) continue;
      point.coverage++;
      point.by_account[s.account.id] = value;
      point.net_worth += value;
      if (s.account.is_liability) point.liabilities -= value;
      else point.assets += value;
      const bucket = bucketOf(s.account.type);
      if (bucket !== 'other') point[bucket] += value;
      if (!s.observed[i]) {
        point.estimated = true;
        point.estimated_accounts.push(s.account.id);
      }
    }
    return point;
  });

  const sampled = step === 'day' ? points : points.filter((p, i) => i === points.length - 1 || bucketKey(p.date, step) !== bucketKey(points[i + 1].date, step));
  return {
    from,
    to,
    step,
    accounts: series.map((s): TimelineAccount => ({
      id: s.account.id,
      name: s.account.account_name,
      type: s.account.type,
      is_liability: s.account.is_liability === 1,
      market_driven: MARKET_DRIVEN_TYPES.has(s.account.type),
      first_date: s.first,
      opening_balance: s.opening,
    })),
    points: sampled,
    method: METHOD,
  };
}

const METHOD = 'Checking, savings and cards are walked back day by day from today\'s balance through every posted transaction, so a day reads what the ledger holds for it now; that can differ from the balance recorded when a sync ran, where a transaction posted or arrived after that sync. Investment and crypto accounts are valued at each day\'s positions times that day\'s public closing price, where the ledger states every quantity and the recorded holdings agree with the balance the institution reported; a recorded balance or a statement overrides that on its own day. Days without known positions or prices replay only money moving in or out from the next known value, holding prices flat, and are estimates. An account that holds a balance only carries the value last recorded for it, and is unknown before the first. An account counts as zero before its first transaction when its walk opens at zero, and as unknown otherwise. A week or month step shows the last day of each period.';
