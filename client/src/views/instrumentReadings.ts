import { differenceInCalendarDays, endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns';
import type { Account, NetWorthSnapshot, ReportSummary, SafeToSpend, SpendingReport } from '@shared/types';
import { isInCredit, signedAccountBalance } from '../lib/accountBalance';
import { bySignedMagnitude, type FigureStates } from '../components/balance';
import { comparableHistory, type BeamHistoryPoint } from '../components/balance/BalanceScale';
import { formatCurrency, formatWholeCurrency } from '../lib/formatters';

/**
 * Everything `/` states, as data.
 *
 * The view renders these; it decides nothing. Two reasons, and the second is the one that matters
 * here. First, a claim this app makes about the owner's money has to be testable without a DOM.
 * Second, this screen replaces three that each computed their own version of the same reading, and
 * `Reports.tsx` carried a comment about having shipped a build where two screens disagreed about
 * net worth. One module, one reading.
 */

/* ── The standing: what is true now, with no window over it ─────────────────── */

/**
 * How many cards owe the owner rather than the other way round.
 *
 * Restricted to `type === 'credit'` so the word "card" is always accurate, and read through
 * `signedAccountBalance` / `isInCredit` rather than a fourth local copy of the sign rule.
 */
export interface CardCreditReading {
  inCredit: number;
  cards: number;
  total: number;
}

export function readCardCredit(accounts: Account[]): CardCreditReading {
  const cards = accounts.filter((a) => a.type === 'credit' && a.is_liability && !a.is_hidden);
  const credited = cards.filter(isInCredit);
  return {
    inCredit: credited.length,
    cards: cards.length,
    total: credited.reduce((sum, card) => sum + signedAccountBalance(card), 0),
  };
}

/**
 * The two directions of `free`, as words.
 *
 * Hazard 4: `free` is signed since the liability sign was fixed, and "short this month" and "free
 * to spend" are two states rather than one number in red. `Figure` renders the MAGNITUDE plus the
 * word, so the sign is spent on the reading instead of being a mark the eye skips.
 */
export const FREE_STATES: FigureStates = {
  positive: 'free to spend',
  negative: 'short this month',
  zero: 'exactly level',
};

export type Standing =
  | { kind: 'free'; value: number; magnitude: number; detail: string }
  | { kind: 'short'; value: number; magnitude: number; detail: string; largestClaim: string | null }
  | { kind: 'level'; value: 0; magnitude: 0; detail: string }
  | { kind: 'unread'; detail: string };

/** The four claims `computeSafeToSpend` subtracts, in the order it subtracts them. */
function claims(breakdown: SafeToSpend): Array<{ label: string; amount: number }> {
  return [
    { label: 'card balances', amount: breakdown.card_balances },
    { label: `the next ${breakdown.forecast_days} days of dated bills`, amount: breakdown.upcoming_bills },
    { label: 'budgeted allocations', amount: breakdown.allocated_budgets },
    { label: 'goal earmarks', amount: breakdown.allocated_goals },
  ];
}

/**
 * What the screen's subject figure says.
 *
 * The largest claim is named only in the short state, because being short is actionable and having
 * room is not: there is nothing to do about the composition of a surplus. A card total in credit is
 * negative and is not a claim at all, so only positive terms are eligible to be the largest one.
 */
export function readStanding(breakdown: SafeToSpend | null | undefined): Standing {
  if (!breakdown) {
    return { kind: 'unread', detail: 'What is free is read from your accounts, and none have been read yet.' };
  }

  const free = breakdown.free;
  const days = breakdown.forecast_days;

  if (free === 0) {
    return { kind: 'level', value: 0, magnitude: 0, detail: 'Every dollar in the liquid pool is already claimed.' };
  }

  if (free > 0) {
    return {
      kind: 'free',
      value: free,
      magnitude: free,
      detail: `Left in the liquid pool after cards, the next ${days} days of dated bills, budgeted allocations and goal earmarks.`,
    };
  }

  const biggest = claims(breakdown)
    .filter((claim) => claim.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0];

  return {
    kind: 'short',
    value: free,
    magnitude: -free,
    detail: `Cards, the next ${days} days of dated bills, budgeted allocations and goal earmarks claim more than the liquid pool holds.`,
    largestClaim: biggest ? `The largest single claim is ${formatCurrency(biggest.amount)} of ${biggest.label}.` : null,
  };
}

/* ── Where the money sits, and what a payoff would do to it ─────────────────── */

export interface Buckets {
  liquid: number;
  equity: number;
  crypto: number;
  other: number;
  liabilities: number;
  netWorth: number;
}

/** Dollars to whole cents. Every figure this file settles is settled here first. */
const cents = (dollars: number): number => Math.round(dollars * 100);

export function bucketsOf(s: NetWorthSnapshot): Buckets {
  const liquid = s.liquid_assets ?? 0;
  const equity = s.investment_assets ?? 0;
  const crypto = s.crypto_assets ?? 0;
  // `other` is settled in cents, like the payoff below and for the same reason.
  //
  // The four figures arrive as four SEPARATELY divided floats: `routes/networth.ts` dollarizes
  // total_assets, liquid_assets, investment_assets and crypto_assets each through `toDollars`, so
  // subtracting them in dollars leaves binary dust. On a sheet that accounts for every cent the
  // residual came out at something like 4.5e-13 rather than 0, `Math.max(0, ...)` kept it, and
  // Instrument's `row.amount !== 0` filter let it through to a BarRow that printed it as "Other
  // $0": a bucket the owner does not have, on a sheet with nothing left over. The same
  // subtraction-in-floats shape is what put "$0 would still be owed, with no cash left to reach
  // it" on Reports, and it is why `cents()` exists twenty lines below this.
  //
  // A genuine "other" bucket is a real account type none of the three named ones covers, and it
  // survives this unchanged: it is whole cents and rounds to itself.
  const otherCents = cents(s.total_assets) - (cents(liquid) + cents(equity) + cents(crypto));
  return {
    liquid,
    equity,
    crypto,
    other: Math.max(0, otherCents) / 100,
    liabilities: s.total_liabilities,
    netWorth: s.net_worth,
  };
}

/**
 * The payoff, decided in the unit the ledger stores.
 *
 * These buckets are API dollars, and a dollar is not representable in binary, so every figure this
 * section prints is settled in cents and divided once on the way out. Only real debt can be paid
 * off, and only out of cash you hold: with liabilities negative (the cards net in credit) the old
 * `b.liquid - b.liabilities` drew an After-payoff cash figure LARGER than now by the credit, money
 * the owner does not have.
 */
function payableCents(b: Buckets): number {
  return Math.max(0, Math.min(cents(b.liabilities), cents(b.liquid)));
}

export function afterPayoff(b: Buckets): Buckets {
  const paid = payableCents(b);
  return { ...b, liquid: (cents(b.liquid) - paid) / 100, liabilities: (cents(b.liabilities) - paid) / 100 };
}

export type PayoffState =
  | { kind: 'payable'; payable: number; remaining: number }
  | { kind: 'no_cash'; owed: number }
  | { kind: 'no_debt' }
  | { kind: 'in_credit'; credit: number };

export function payoffState(b: Buckets): PayoffState {
  const owed = cents(b.liabilities);
  if (owed < 0) return { kind: 'in_credit', credit: -owed / 100 };
  if (owed === 0) return { kind: 'no_debt' };

  // `payable` used to be read back off the payoff as `b.liquid - afterPayoff(b).liquid`, and a
  // subtraction undone by another subtraction does not return its input in float: on a sheet whose
  // cash covers the debt entirely, `remaining` came back as dust instead of 0, so the "still owed"
  // clause fired and rendered "$0 would still be owed, with no cash left to reach it" over a sheet
  // that had cleared the debt with cash to spare. Subtracting once, in cents, is exact.
  const paid = payableCents(b);
  if (paid <= 0) return { kind: 'no_cash', owed: owed / 100 };
  return { kind: 'payable', payable: paid / 100, remaining: (owed - paid) / 100 };
}

/**
 * A payoff figure, printed so it cannot read as nothing.
 *
 * Whole dollars are right for the totals on this screen and wrong for the figures inside the payoff
 * sentence, because each of those is the subject of a clause about itself: a 40 cent remainder
 * printed as "$0 would still be owed" says the opposite of what was measured.
 */
export function formatPayoffFigure(amount: number): string {
  return Math.abs(amount) < 1 ? formatCurrency(amount) : formatWholeCurrency(amount);
}

/* ── The week: a change, and only against a sheet that measured the same thing ── */

/** A recorded sheet, plus the figure the week reading compares. */
export interface SheetPoint extends BeamHistoryPoint {
  /**
   * Carried rather than derived from `assets - liabilities`: the snapshot stores this total, and
   * recomputing a stored total is how two readings of the same sheet start to disagree.
   */
  netWorth: number;
}

/**
 * Hazard 3, in the loudest supporting figure on this screen.
 *
 * The net-worth change under the lead figure used to be `latest.net_worth - weekAgo.net_worth`
 * with `differenceInCalendarDays >= 7` as its only filter, so it compared sheets that had not
 * measured the same thing. Measured against a private copy of `.mizan/mizan.db` at migration
 * `053_drop_budget_groups.sql`:
 *
 *   SELECT date, net_worth, is_estimated, covered_accounts, total_accounts
 *   FROM net_worth_snapshots ORDER BY date;
 *   -- 2026-07-23  309594c  0  11/11
 *   -- 2026-07-24  274939c  0  14/14   <- coverage steps 11 to 14 here
 *   -- 2026-07-30  420286c  0  14/14
 *
 * Every one of the five sheets recorded from 2026-07-24 to 2026-07-30 sits at 14 of 14 while the
 * nearest sheet seven days behind it sits at 11 of 11, so for a full week the rule compared a
 * reading of fourteen accounts against a reading of eleven. On 2026-07-30 that produced
 * 420286 - 309594 = 110692c and the screen rendered "+$1,107" in the positive tone, with no
 * caveat, on a surface whose own beam refuses that exact pair.
 *
 * So the rule here is the beam's rule. `comparableHistory` is CALLED rather than restated: an
 * exact coverage match, never an estimated sheet, and everything refused counted rather than
 * dropped, because "no week to compare" and "a week you may not compare" are different states.
 */
export const WEEK_MIN_DAYS = 7;

export type WeekChange =
  | { kind: 'change'; delta: number; since: string; covered: number; total: number; refused: number }
  | { kind: 'incomparable'; covered: number; total: number; refused: number }
  /** This sheet predates migration 044 and records no coverage, so nothing can be matched to it. */
  | { kind: 'uncounted' }
  | { kind: 'none' };

export function readWeekChange(earlier: SheetPoint[], current: SheetPoint | null): WeekChange {
  if (!current) return { kind: 'none' };

  const eligible = [...earlier]
    .filter((p) => differenceInCalendarDays(parseISO(current.date), parseISO(p.date)) >= WEEK_MIN_DAYS)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (eligible.length === 0) return { kind: 'none' };

  if (current.coveredAccounts === null || current.totalAccounts === null) return { kind: 'uncounted' };
  const covered = current.coveredAccounts;
  const total = current.totalAccounts;

  const comparable = new Set(comparableHistory(eligible, current).marks.map((m) => m.date));
  const refused = eligible.filter((p) => !comparable.has(p.date)).length;
  const baseline = [...eligible].reverse().find((p) => comparable.has(p.date));
  if (!baseline) return { kind: 'incomparable', covered, total, refused };

  // These are API dollars, so the subtraction is settled in cents and divided once, the same way
  // the payoff above is.
  return {
    kind: 'change',
    delta: (cents(current.netWorth) - cents(baseline.netWorth)) / 100,
    since: baseline.date,
    covered,
    total,
    refused,
  };
}

export interface WeekChangeCaption {
  /** The measurement, or the statement that there is none. */
  reading: string;
  /** What the measurement leaves out. Never a qualification of a figure that was not printed. */
  note: string | null;
}

/** The refusal clause, which only ever counts sheets that were otherwise eligible. */
function refusedClause(refused: number): string {
  return refused === 1
    ? 'One earlier sheet reached a different set of accounts and is not comparable to this one.'
    : `${refused} earlier sheets reached a different set of accounts and are not comparable to this one.`;
}

export function describeWeekChange(change: WeekChange): WeekChangeCaption {
  switch (change.kind) {
    case 'change': {
      const figure = `${change.delta < 0 ? '−' : '+'}${formatWholeCurrency(Math.abs(change.delta))}`;
      return {
        reading:
          `${figure} since ${format(parseISO(change.since), 'd MMMM')}, the nearest sheet at least seven days ` +
          `back that reached the same ${change.covered} of ${change.total} accounts.`,
        note: change.refused > 0 ? refusedClause(change.refused) : null,
      };
    }
    case 'incomparable':
      return {
        reading:
          `No sheet at least seven days back reached the same ${change.covered} of ${change.total} accounts, ` +
          'so there is no week to compare.',
        note: refusedClause(change.refused),
      };
    case 'uncounted':
      return {
        reading: 'This sheet does not record how many accounts it reached, so no earlier sheet can be matched to it.',
        note: null,
      };
    case 'none':
      return { reading: 'No earlier sheet recorded to compare against.', note: null };
  }
}

/* ── The window: everything that is a flow rather than a state ──────────────── */

/**
 * Why there are four, and why the balance sheet is not one of them.
 *
 * Reports and Cash Flow were never two screens. They are the same query set over a different
 * window, and Today is that window set to now. But a window only means something for a FLOW. Net
 * worth, what is held, what is owed and what is free are states at an instant; putting a period
 * selector over them would be the screen claiming to measure something it cannot. So the selector
 * governs the lower half of this surface only, and the upper half has no window at all. That is
 * also why `Reports.tsx` ended up with two independent range selectors: it had discovered the same
 * split without naming it.
 *
 * Each window is a different question rather than a different length:
 *   this month   what is happening, in the month a budget and a paycheck live in
 *   last month   what actually happened, in the only month that has a final answer
 *   6 months     the rhythm: long enough to show a season, short enough to still be you
 *   all          everything the ledger reaches
 *
 * 3 months, a year and 2 years are interpolations between those, not further questions, and "this
 * year" is a calendar artifact that means three weeks of data every January.
 */
export const INSTRUMENT_WINDOWS = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'six-months', label: '6 months' },
  { id: 'all', label: 'All' },
] as const;

export type WindowId = (typeof INSTRUMENT_WINDOWS)[number]['id'];

export function isWindowId(value: string | null): value is WindowId {
  return INSTRUMENT_WINDOWS.some((w) => w.id === value);
}

/** Earlier than any consumer ledger reaches, so `all` is bounded by the data and not by this. */
const ALL_WINDOW_MONTHS = 600;

export interface WindowRange {
  startDate: string;
  endDate: string;
}

export function windowRange(id: WindowId, now: Date): WindowRange {
  const day = (d: Date) => format(d, 'yyyy-MM-dd');
  switch (id) {
    case 'this-month':
      return { startDate: day(startOfMonth(now)), endDate: day(endOfMonth(now)) };
    case 'last-month': {
      const prior = subMonths(now, 1);
      return { startDate: day(startOfMonth(prior)), endDate: day(endOfMonth(prior)) };
    }
    case 'six-months':
      return { startDate: day(startOfMonth(subMonths(now, 5))), endDate: day(endOfMonth(now)) };
    case 'all':
      return { startDate: day(startOfMonth(subMonths(now, ALL_WINDOW_MONTHS))), endDate: day(endOfMonth(now)) };
  }
}

/**
 * What the window turned out to be, said from the months that carry activity rather than from the
 * dates that were asked for.
 *
 * `all` asks for fifty years and the ledger holds 35 months; printing the request would be the
 * screen describing its own query instead of the owner's records. Whether the newest month is still
 * running is checked against today, and it is the whole reason "last month" is a separate window:
 * it is the only one whose answer will not change tomorrow.
 */
export function describeWindow(months: string[], range: WindowRange, today: Date): string {
  const pretty = (yearMonth: string) => format(parseISO(`${yearMonth}-01`), 'MMMM yyyy');
  if (months.length === 0) {
    return `${format(parseISO(range.startDate), 'd MMM yyyy')} to ${format(parseISO(range.endDate), 'd MMM yyyy')} · nothing recorded`;
  }

  const first = months[0];
  const last = months[months.length - 1];
  const open = last === format(today, 'yyyy-MM');
  if (first === last) return `${pretty(first)} · ${open ? 'still running' : 'closed'}`;
  return `${pretty(first)} to ${pretty(last)} · ${months.length} months${open ? ', the last still running' : ''}`;
}

export type SpendingCategory = SpendingReport['categories'][number];

export interface SpendingSplit {
  /** Categories that cost money, largest first. */
  spent: SpendingCategory[];
  /** Categories that gave more back than they took, largest return first. */
  returned: SpendingCategory[];
  spentTotal: number;
  /** A magnitude: the sign is spent on the group's name. */
  returnedTotal: number;
}

/**
 * Hazard 1, and it is three defects rather than one.
 *
 * A category total is signed. Measured on the live ledger, July 2026 Shopping is -$1,028.63,
 * because that month's Amazon and REI credits outweigh its purchases:
 *
 *   getSpendingReport(db, { startDate: '2026-07-01', endDate: '2026-07-31' })
 *   -- total 111299c; Food & Drink 73160, Travel 49625, ... , Shopping -102863
 *   -- sum of the eight positive roots 214162c, so 214162 - 102863 = 111299 exactly
 *
 *   1. A negative width is not a width. Every bar on this screen is `SignedBar`, which draws from a
 *      printed zero rule, so a return points the other way instead of clamping to nothing.
 *   2. A share of a signed total is arithmetic nonsense. The report's own `percentage` field puts
 *      Shopping at -92.42%, and the eight categories that cost money at 192.42% of the month
 *      between them. Nothing on this surface prints a percentage of a spend total.
 *   3. Ranking by amount descending puts the single largest movement of money LAST, under a heading
 *      that says top spending. Returns are not small spends; they are a different kind of row, so
 *      they get their own group with its own subtotal, and it leads. It is the most interesting
 *      thing that happened to this money in July and it was falling off the bottom of the list.
 *
 * Ordering inside each group is `bySignedMagnitude`, the primitive that already owns this rule.
 * A category of exactly zero counts as spend, so `spentTotal - returnedTotal` reproduces the
 * report total for every input.
 */
export function splitSpending(categories: SpendingCategory[]): SpendingSplit {
  const ranked = [...categories].sort((a, b) => bySignedMagnitude(a.amount, b.amount));
  const spent = ranked.filter((c) => c.amount >= 0);
  const returned = ranked.filter((c) => c.amount < 0);
  // Negating an empty sum yields -0, which prints as "-$0" and compares unequal to 0 under
  // Object.is. The group total is a magnitude, so it is negated only when there is one.
  const returnedSum = returned.reduce((sum, c) => sum + c.amount, 0);
  return {
    spent,
    returned,
    spentTotal: spent.reduce((sum, c) => sum + c.amount, 0),
    returnedTotal: returnedSum === 0 ? 0 : -returnedSum,
  };
}

/**
 * A change in the rate kept, in the unit a change in a percentage is actually in.
 *
 * `savings_rate` is a percentage, so `savings_rate.delta` is a difference of two percentages and
 * its unit is points, not percent: on the live `this month` summary it is 195.61, which is not
 * "195.61% more saved". Rounding is held back below one point for the same reason
 * `formatPayoffFigure` holds it back below a dollar: "0 points" printed over a rate that did move
 * says the opposite of what was measured.
 */
export function formatPointsFigure(magnitude: number): string {
  if (magnitude > 0 && magnitude < 0.05) return 'under 0.1 points';
  const rounded = magnitude < 1 ? magnitude.toFixed(1) : String(Math.round(magnitude));
  return `${rounded} ${rounded === '1' ? 'point' : 'points'}`;
}

export interface ComparisonReading {
  /** True when the comparison window recorded something to compare against. */
  comparable: boolean;
  note: string;
}

/**
 * Whether the deltas mean anything, and what they are against either way.
 *
 * A delta with an unstated baseline is unreadable, and a delta against a window that recorded
 * nothing is not a change. `all` reaches back past the ledger, so its prior period holds no rows
 * and every metric reports its own value as the change. Measured against a private copy of
 * `.mizan/mizan.db` at migration `053_drop_budget_groups.sql`, with today 2026-07-31:
 *
 *   getReportSummary(db, { ...windowRange('all', new Date(2026, 6, 31)), comparison: 'prior_period' })
 *   -- window      1976-07-01 to 2026-07-31   (ALL_WINDOW_MONTHS = 600 months back)
 *   -- comparison  1926-06-01 to 1976-06-30
 *   -- income.previous 0c, expenses.previous 0c, savings_rate.previous null
 *
 * Both `previous` terms being zero is the check, because a window with income or expenses in it
 * cannot produce that pair.
 */
export function readComparison(summary: ReportSummary): ComparisonReading {
  const window =
    summary.comparison_start_date && summary.comparison_end_date
      ? ` (${summary.comparison_start_date} to ${summary.comparison_end_date})`
      : '';
  const comparable = summary.income.previous !== 0 || summary.expenses.previous !== 0;
  return {
    comparable,
    note: comparable
      ? `Compared with ${summary.comparison_label.toLowerCase()}${window}.`
      : `Nothing is recorded in ${summary.comparison_label.toLowerCase()}${window}, so there is no change to state.`,
  };
}
