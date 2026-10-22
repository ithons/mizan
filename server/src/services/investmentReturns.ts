import type Database from 'better-sqlite3';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { netWorthTimeline } from './netWorthTimeline';
import { portfolioExternalFlows, type PortfolioFlow } from './portfolioFlows';
import { readPortfolioAccounts } from './netWorthHistory';
import { dollarizeFields } from './money';
import type { InvestmentReturn, InvestmentReturns } from '../../../shared/types';

export type { InvestmentReturn, InvestmentReturns };

export const MIN_RETURN_WINDOW_DAYS = 90;

export interface CashFlow {
  date: string;
  /** From the owner's side: negative is money put in, positive is money taken out. */
  amount: number;
}

export type XirrResult = { rate: number; reason: null } | { rate: null; reason: string };

const LOW = -0.99;
const HIGH = 10;
const SCAN_STEPS = 400;

function npv(flows: readonly CashFlow[], rate: number): number {
  const t0 = parseISO(flows[0].date);
  return flows.reduce((sum, f) => sum + f.amount / Math.pow(1 + rate, differenceInCalendarDays(parseISO(f.date), t0) / 365), 0);
}

function bisect(flows: readonly CashFlow[], lo: number, hi: number): number {
  if (lo === hi) return lo;
  let fLo = npv(flows, lo);
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(flows, mid);
    if (fMid === 0) return mid;
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The annual rate r solving sum(amount / (1 + r)^(days / 365)) = 0, bracketed in [-99%, 1000%]. */
export function xirr(flows: readonly CashFlow[]): XirrResult {
  const sorted = [...flows].filter((f) => f.amount !== 0).sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return { rate: null, reason: 'no money moved and nothing was held' };
  if (sorted.every((f) => f.amount > 0) || sorted.every((f) => f.amount < 0)) {
    return { rate: null, reason: 'the flows all run one way, so no rate balances them' };
  }
  // A grid scan finds every sign change, so a series with two rates is refused rather than resolved by whichever a solver hit first.
  const brackets: Array<[number, number]> = [];
  let prev = LOW;
  let fPrev = npv(sorted, prev);
  for (let i = 1; i <= SCAN_STEPS; i++) {
    const r = LOW + ((HIGH - LOW) * i) / SCAN_STEPS;
    const f = npv(sorted, r);
    if (f === 0) brackets.push([r, r]);
    else if (fPrev !== 0 && Math.sign(f) !== Math.sign(fPrev)) brackets.push([prev, r]);
    prev = r;
    fPrev = f;
  }
  if (brackets.length === 0) return { rate: null, reason: 'no rate between -99% and 1000% a year balances the flows' };
  if (brackets.length > 1) return { rate: null, reason: 'the flows are balanced by more than one rate' };
  return { rate: bisect(sorted, ...brackets[0]), reason: null };
}

function windowFlows(flows: readonly PortfolioFlow[], from: string, to: string): PortfolioFlow[] {
  return flows.filter((f) => f.date > from && f.date <= to);
}

/**
 * Days of the window the money was held: from the first day the value was not zero. A start of
 * zero drops out of the rate, so the rate compounds over only those days, and gating on the
 * window alone annualized a 30-day-old account inside a 1-year window. A value never above zero
 * leaves the window's length, so the refusal that follows says nothing was held.
 */
function heldDays<P extends { date: string }>(window: { to: string; days: number }, points: readonly P[], valueOf: (point: P) => number | undefined): number {
  const held = points.find((point) => (valueOf(point) ?? 0) !== 0);
  return held ? differenceInCalendarDays(parseISO(window.to), parseISO(held.date)) : window.days;
}

function judge(
  base: Pick<InvestmentReturn, 'account_id' | 'name'>,
  window: { from: string; to: string; days: number; held: number },
  start: { value: number | undefined; estimated: boolean },
  end: { value: number | undefined; estimated: boolean },
  flows: PortfolioFlow[],
): InvestmentReturn {
  const net = flows.reduce((sum, f) => sum + f.amount, 0);
  const row = { ...base, start_value: start.value ?? null, end_value: end.value ?? null, net_flows: net, start_estimated: start.estimated };
  const refuse = (reason: string): InvestmentReturn => ({ ...row, annualized: null, reason });
  if (window.held < MIN_RETURN_WINDOW_DAYS) return refuse('not enough history');
  if (start.value === undefined) return refuse(`no value known on ${window.from}`);
  if (end.value === undefined) return refuse(`no value known on ${window.to}`);
  if (end.estimated) return refuse(`the value on ${window.to} is an estimate`);
  const result = xirr([
    { date: window.from, amount: -start.value },
    ...flows.map((f) => ({ date: f.date, amount: -f.amount })),
    { date: window.to, amount: end.value },
  ]);
  return result.rate === null ? refuse(result.reason) : { ...row, annualized: result.rate, reason: null };
}

/** Coins sent to or received from another wallet in the window. `externalMarketFlow` counts no transfer on a crypto wallet as money in or out, so the rate would treat them as gains or losses. */
function coinMoves(db: Database.Database, accountId: string, from: string, to: string): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n FROM transactions t
    JOIN accounts a ON a.id = t.account_id AND a.type = 'crypto_wallet'
    LEFT JOIN securities s ON s.id = t.security_id
    WHERE t.account_id = ? AND t.pending = 0 AND t.date > ? AND t.date <= ?
      AND t.category_id IN ('cat_xfer_in', 'cat_xfer_out') AND t.quantity IS NOT NULL
      AND COALESCE(s.ticker, 'USD') <> 'USD'
  `).get(accountId, from, to) as { n: number }).n;
}

function nothingIncluded(row: InvestmentReturn): InvestmentReturn {
  return row.reason === 'not enough history' ? row : { ...row, reason: 'every account was left out of the portfolio figure' };
}

/** Money-weighted annualized return per portfolio account and for the portfolio, over one window. In cents. */
export function investmentReturns(
  db: Database.Database,
  options: { from?: string; to?: string; today?: string } = {},
): InvestmentReturns | null {
  const today = options.today ?? format(new Date(), 'yyyy-MM-dd');
  const ids = readPortfolioAccounts(db).map((a) => a.id);
  if (ids.length === 0) return null;
  const timeline = netWorthTimeline(db, { from: options.from, to: options.to, accountIds: ids, today });
  const first = timeline.points[0];
  const last = timeline.points.at(-1);
  if (!first || !last) return null;
  const window = { from: first.date, to: last.date, days: differenceInCalendarDays(parseISO(last.date), parseISO(first.date)) };

  const moved = new Map(timeline.accounts.map((account) => [account.id, coinMoves(db, account.id, window.from, window.to)]));
  const accounts = timeline.accounts.map((account) => {
    const row = judge(
      { account_id: account.id, name: account.name },
      { ...window, held: heldDays(window, timeline.points, (point) => point.by_account[account.id]) },
      { value: first.by_account[account.id], estimated: first.estimated_accounts.includes(account.id) },
      { value: last.by_account[account.id], estimated: last.estimated_accounts.includes(account.id) },
      windowFlows(portfolioExternalFlows(db, [account.id]), window.from, window.to),
    );
    const n = moved.get(account.id) ?? 0;
    return n > 0 && row.reason !== 'not enough history'
      ? { ...row, annualized: null, reason: `${n === 1 ? 'a coin transfer' : `${n} coin transfers`} to or from another wallet ${n === 1 ? 'is' : 'are'} not counted as money in or out` }
      : row;
  });
  const included = ids.filter((id) => (moved.get(id) ?? 0) === 0);
  const excludedNames = timeline.accounts.filter((a) => !included.includes(a.id)).map((a) => a.name);
  const sumOver = (point: typeof first) => (included.every((id) => point.by_account[id] !== undefined)
    ? included.reduce((sum, id) => sum + point.by_account[id], 0) : undefined);
  const estimatedIn = (point: typeof first) => point.estimated_accounts.some((id) => included.includes(id));
  const portfolio = included.length === 0
    ? nothingIncluded(judge({ account_id: null, name: 'Portfolio' }, { ...window, held: window.days }, { value: undefined, estimated: false }, { value: undefined, estimated: false }, []))
    : judge(
    { account_id: null, name: excludedNames.length ? `Portfolio, without ${excludedNames.join(' and ')}` : 'Portfolio' },
    { ...window, held: heldDays(window, timeline.points, sumOver) },
    { value: sumOver(first), estimated: estimatedIn(first) },
    { value: sumOver(last), estimated: estimatedIn(last) },
    windowFlows(portfolioExternalFlows(db, included), window.from, window.to),
  );
  return { ...window, accounts, portfolio, method: METHOD };
}

const MONEY_FIELDS = ['start_value', 'end_value', 'net_flows'] as const;

export function investmentReturnsToDollars(returns: InvestmentReturns): InvestmentReturns {
  return {
    ...returns,
    accounts: returns.accounts.map((row) => dollarizeFields(row, MONEY_FIELDS)),
    portfolio: dollarizeFields(returns.portfolio, MONEY_FIELDS),
  };
}

const METHOD = 'Money-weighted (XIRR): the annual rate at which the value at the start of the window, plus every deposit and less every withdrawal on its date, grows into the value at the end, counting days over 365. Values are the net worth timeline\'s for each account; deposits and withdrawals are the same rows the timeline replays as money moving in or out. Not computed when the money was held for under 90 days of the window (counted from the first day its value was not zero), when the end value is an estimate, when coins moved to or from another wallet (those moves are not counted as money in or out, so a rate would read them as gains or losses; the portfolio figure then leaves that account out), or when no single rate between -99% and 1000% a year balances the flows. A start value that is an estimate is flagged and still used.';
