import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import type {
  AdvisorDraftAction,
  CategoryTrendReport,
  Insight,
  ReportComparisonMode,
  TransactionReviewQueueId,
  TransactionReviewQueueSummary,
  TransactionReviewSummary,
} from '@shared/types';
import {
  accountsApi,
  aiApi,
  goalsApi,
  insightsApi,
  networthApi,
  recurringApi,
  reportsApi,
  syncApi,
  transactionsApi,
} from '../lib/api';
import { formatCurrency, formatWholeCurrency } from '../lib/formatters';
import { useAppStore } from '../store';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import { QueryState } from '../components/QueryState';
import { SkeletonRows } from '../components/SkeletonLoader';
import {
  BalanceScale,
  Card,
  Figure,
  Screen,
  SectionLabel,
  Select,
  SignedBar,
  TextButton,
  TrendChart,
  signedBarScale,
} from '../components/balance';
import { comparableHistory, readCalibration } from '../components/balance/BalanceScale';
import {
  FREE_STATES,
  INSTRUMENT_WINDOWS,
  afterPayoff,
  bucketsOf,
  describeWeekChange,
  describeWindow,
  formatPayoffFigure,
  formatPointsFigure,
  isWindowId,
  payoffState,
  readCardCredit,
  readComparison,
  readStanding,
  readWeekChange,
  splitSpending,
  windowRange,
  type SheetPoint,
  type WeekChange,
  type WindowId,
} from './instrumentReadings';

/**
 * `/`, the instrument.
 *
 * One surface where there were three. Today, Cash Flow and Reports ran the same query set; Reports
 * and Cash Flow differed only in the WINDOW they ran it over, and Today was that window set to now.
 * Keeping them apart cost 1,121 lines of view code (Today 397, Reports 534, Cash Flow 190, counting
 * lines that are neither blank nor comment) and, more seriously, allowed two screens to disagree
 * about net worth, which `Reports.tsx` carried a comment about having shipped once.
 *
 * The surface has two registers and the rule between them is the whole design:
 *
 *   THE STANDING   what is true at this instant. The beam, net worth, what is free, where it sits.
 *                  No window applies, because none of these is a flow. A period selector over net
 *                  worth would be the screen claiming to measure something it cannot.
 *   THE WINDOW     everything that happened over a stretch of time. One selector reshapes all of
 *                  it and nothing above it.
 *
 * What the owner comes here for is the answer to "am I alright", so the largest thing on the page
 * is the one figure that answers it: what is free after every claim already made. Net worth is a
 * fact about the sheet and sits a step down from it. The app does not grade the reading, here or
 * anywhere: it states it and draws the beam, and the owner judges.
 */

const COMPARISONS: Array<{ id: ReportComparisonMode; label: string }> = [
  { id: 'prior_period', label: 'vs prior period' },
  { id: 'prior_month', label: 'vs prior month' },
  { id: 'same_month_last_year', label: 'vs same month last year' },
  { id: 'trailing_3', label: 'vs trailing 3 months' },
  { id: 'trailing_12', label: 'vs trailing 12 months' },
];

/** Rows shown before the "show the rest" control. Returns are never folded away; see below. */
const SPEND_ROWS = 8;

function RailRow({ to, label, value, tone }: { to: string; label: string; value: string; tone?: string }) {
  return (
    <Link to={to} className="group flex items-baseline justify-between gap-4 text-body">
      <span className={`truncate transition-colors group-hover:text-ink ${tone ?? 'text-muted'}`}>{label}</span>
      <span className={`whitespace-nowrap font-mono tabular-nums ${tone ?? 'text-ink'}`}>{value}</span>
    </Link>
  );
}

/**
 * What is actually waiting, taken from the queues the server counted.
 *
 * The rail used to render ONE row for the whole of review: it was labelled "Uncategorized", it
 * carried `total_open` (every queue summed), and it linked to `/ledger?uncategorized=1`. Measured
 * against a private copy of `.mizan/mizan.db` at migration `054_drop_dead_preferences.sql` on
 * 2026-07-31, via `GET /api/transactions/review`:
 *
 *   total_open 7 · ai_insights 7 · uncategorized 0 · rule_suggestions 0 · pending 0 ·
 *   recurring_candidates 0 · duplicate_candidates 0 · transfer_candidates 0
 *   SELECT COUNT(*) FROM transactions WHERE category_id IS NULL   ->  0
 *
 * So the most prominent call to action on the primary screen named a queue that was empty, counted
 * a different queue, and sent the owner to a filter holding none of it. Each row now carries one
 * queue's own label and its own count and goes where that queue is decided.
 *
 * The map is a total `Record` over the id union rather than a lookup with a fallback: a queue added
 * to `transactionReview.ts` that nothing here can route to is a compile error, not a row that
 * silently lands on `/`.
 */
const QUEUE_DESTINATIONS: Record<TransactionReviewQueueId, string | null> = {
  // Every open draft renders inline on the row it is about, and the ledger's "Suggested" chip is
  // this queue: `filterChips` counts it from the same `ai_drafts` array this count comes from.
  ai_insights: '/ledger',
  // The one deep link the ledger answers (`searchParams.get('uncategorized') === '1'`): it sets the
  // chip and widens the range to all time, because the backlog is older than any default window.
  uncategorized: '/ledger?uncategorized=1',
  // `RulesSection`, inside Settings' "Categories & rules" panel. There is no deep link to that
  // panel, so this lands on the screen that holds it rather than on the list itself.
  rule_suggestions: '/settings',
  // Patterns still awaiting a verdict: the ones with an occurrence in the window sit above today's
  // rule, and `unscheduledCandidates` puts the rest in the schedule block beside it.
  recurring_candidates: '/ledger',
  duplicate_candidates: '/ledger',
  transfer_candidates: '/ledger',
  // Not offered, for the same reason `getTransactionReviewSummary` leaves it out of `total_open`:
  // a pending authorization posts on its own and there is no decision to make about it.
  pending: null,
};

/** Severity to ink. An AI suggestion is not an alarm, and clay is the colour of money going out. */
const QUEUE_TONES: Record<TransactionReviewQueueSummary['severity'], string | undefined> = {
  attention: 'text-clay',
  warning: 'text-gold',
  info: undefined,
};

export interface WaitingRow {
  id: TransactionReviewQueueId;
  label: string;
  count: number;
  to: string;
  tone?: string;
}

/**
 * An empty queue produces no row, so a ledger with nothing outstanding produces no rail at all
 * rather than a strip reading zero: "you are all clear" is a claim, and this screen does not make
 * claims it would have to keep checking.
 */
export function readWaiting(summary: TransactionReviewSummary | undefined): WaitingRow[] {
  return (summary?.queues ?? []).flatMap((queue) => {
    const to = QUEUE_DESTINATIONS[queue.id];
    if (queue.count <= 0 || to === null || to === undefined) return [];
    return [{ id: queue.id, label: queue.label, count: queue.count, to, tone: QUEUE_TONES[queue.severity] }];
  });
}

/** One labelled bar in a list that shares a scale. The numeral is always shown, never a tooltip. */
function BarRow({
  label,
  sub,
  amount,
  extent,
  diverging,
  tone,
  showSign = false,
  to,
}: {
  label: string;
  sub?: string;
  amount: number;
  extent: number;
  diverging: boolean;
  tone?: string;
  /**
   * Off everywhere the list is one direction with exceptions, where a `+` on every ordinary row
   * says nothing. On where the sign IS the reading: in "What moved it" a positive figure and a
   * negative one are both ordinary, and an unmarked positive next to a marked negative reads as a
   * magnitude beside a signed value.
   */
  showSign?: boolean;
  /**
   * Where the rows behind this figure live. Given, the row becomes a real button rather than a
   * `div` with a handler, which is the same rule `components/balance/Row.tsx` states: a bare div
   * with `onClick` is not reachable by keyboard and announces nothing.
   */
  to?: string;
}) {
  const grid = 'grid w-full grid-cols-[minmax(0,1fr)_minmax(72px,140px)_92px] items-center gap-x-5 py-[7px]';
  const body = (
    <>
      <span className="truncate text-left text-body text-ink">
        {label}
        {sub && <span className="text-muted-2"> · {sub}</span>}
      </span>
      <SignedBar value={amount} extent={extent} diverging={diverging} height={8} />
      <span className={`whitespace-nowrap text-right text-body-lg tabular-nums ${tone ?? 'text-ink'}`}>
        {formatWholeCurrency(amount, { showSign })}
      </span>
    </>
  );
  if (!to) return <div className={grid}>{body}</div>;
  return (
    // A `Link`, not a button with `navigate`, matching `RailRow` above: this is navigation, so it
    // should announce as a link, carry a real href, and open in a new tab on the modifier the
    // reader already knows. `Row.tsx`'s "make it a real button" rule is about ACTIONS.
    //
    // No hue and no underline. The row is already a figure the reader is scanning, and making it
    // look like a link would put a second visual system on a list whose whole job is comparison.
    // The affordance is the ground lifting under the cursor, the same one `Row.tsx` uses.
    <Link
      to={to}
      className={`${grid} -mx-2 rounded-md px-2 text-left transition-colors hover:bg-well`}
      aria-label={`${label}, ${formatWholeCurrency(amount, { showSign })}. Open these entries in the ledger.`}
    >
      {body}
    </Link>
  );
}

/**
 * The rows behind a category figure, in the window the figure was read in.
 *
 * Every `WindowId` has a range of the same name on the Ledger, which is why `six-months` was added
 * there rather than mapped onto `three-months`: a drill-down that silently narrowed the window
 * would show a subset of the rows the figure sums, and the two totals would disagree with nothing
 * on screen saying why. `null` category ids do not reach here; "Uncategorized" is its own filter.
 */
function ledgerLinkFor(categoryId: string, windowId: WindowId): string {
  return `/ledger?categoryId=${encodeURIComponent(categoryId)}&range=${windowId}`;
}

/**
 * One category's spend across the window's months, on a scale the whole grid shares.
 *
 * Local to this screen rather than added to `components/balance`, because it is not a general
 * chart: it draws one series whose months are the same months as every other row's, which is
 * exactly the property that makes the rows comparable and exactly what a reusable sparkline could
 * not promise. `BarRow` above is horizontal and answers "how big"; this is the same quantity over
 * time, which is the reading the window's month-by-month section gives net and gives no category.
 *
 * The columns are divs on Tailwind grounds rather than an SVG for the same reason `SignedBar` is:
 * colour has to come from the token layer, and the tokens reach markup through class names.
 * `extent` is the largest single month in the WHOLE grid, so a tall column means a lot of money
 * rather than a lot of money for that row. It is stated in the caption, because a bar with no
 * stated scale is a shape, not a measurement.
 */
function MonthStrip({ values, extent, label }: { values: number[]; extent: number; label: string }) {
  const span = Math.max(1, extent);
  return (
    <div className="flex h-[26px] items-end gap-[2px]" role="img" aria-label={label}>
      {values.map((value, i) => {
        const height = Math.max(1, Math.round((Math.min(1, Math.abs(value) / span) * 100)));
        return (
          <div key={i} className="relative flex h-full min-w-[3px] flex-1 items-end">
            {/* Money that came back keeps the accent the rest of this screen reserves for it, so a
                month whose refunds outweighed its purchases is not drawn as ordinary spending.
                Both columns are marks and need 3:1 against the paper they sit on: `muted` reads
                7.01:1 light and 7.76:1 dark, `sage-deep` 4.87:1 and 6.89:1, computed from the
                triplets in client/src/index.css. */}
            <div
              className={`w-full rounded-sm ${value < 0 ? 'bg-sage-deep' : 'bg-muted'}`}
              style={{ height: `${height}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The window's per-category series, ranked and capped, with the grid's shared scale.
 *
 * `getSpendingTrendsReport` already emits one value per entry in `months` for every series, so the
 * index alignment holds by construction and the `?? 0` is a guard rather than a fix. Ranked by
 * what the window totals rather than by the last month, because the section it sits under ranks
 * the same categories the same way and two different orders for one set of rows is a screen
 * arguing with itself.
 *
 * `months` is the months the report FOUND rows in, not the calendar months the window spans, so a
 * month nothing was filed in is absent rather than a zero column. The caption names the first and
 * last, and the label counts them, so the grid never implies a month it did not draw.
 */
const TREND_ROWS = 6;

function readTrendGrid(report: CategoryTrendReport | undefined) {
  const months = report?.months ?? [];
  if (months.length < 2) return null;

  const rows = (report?.series ?? [])
    .map((s) => ({
      id: s.category_id,
      name: s.category_name,
      values: months.map((_, i) => s.values[i] ?? 0),
      total: s.values.reduce((sum, v) => sum + v, 0),
    }))
    .filter((row) => row.values.some((v) => v !== 0))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  if (rows.length === 0) return null;

  const shown = rows.slice(0, TREND_ROWS);
  // The extent comes from the rows DRAWN, not from every row the report returned. Taking it from
  // the full set lets a category below the cut set the scale, which leaves a grid where no column
  // reaches full height and a caption citing a figure that is not on screen.
  const extent = Math.max(...shown.flatMap((row) => row.values.map((v) => Math.abs(v))));
  return { months, rows: shown, extent, hidden: rows.length - shown.length };
}

/**
 * A period-over-period change, with the direction's meaning and the unit supplied by the caller.
 *
 * Up is good for income and bad for expenses, so `good` is a parameter rather than a sign test.
 * `format` is one too, because all four summary metrics carry a delta and they are not all money:
 * `savings_rate.delta` is a difference of two percentages, and running it through the currency
 * formatter would have printed the live 195.61 points as "$196". Rendered only where
 * `readComparison` established there is something to compare against.
 */
function Delta({
  delta,
  good,
  format,
}: {
  delta: number | null;
  good: (delta: number) => boolean;
  format: (magnitude: number) => string;
}) {
  if (delta === null || delta === 0) return null;
  return (
    <div className={`mt-1 text-note tabular-nums ${good(delta) ? 'text-sage-deep' : 'text-clay'}`}>
      {delta > 0 ? '↑' : '↓'} {format(Math.abs(delta))}
    </div>
  );
}

/**
 * The week reading's tone.
 *
 * Only a measured change is graded. The three states that print no figure are not good news in a
 * quieter voice, and the old code rendered the "nothing to compare" case in the positive tone.
 */
function weekChangeTone(change: WeekChange): string {
  if (change.kind !== 'change') return 'text-muted';
  return change.delta < 0 ? 'text-clay' : 'text-sage-deep';
}

export function Instrument() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const syncStatus = useAppStore((s) => s.syncStatus);

  // The window lives in the URL so it survives a reload, can be linked to, and gives the retired
  // /cash-flow and /reports routes somewhere honest to land.
  const [params, setParams] = useSearchParams();
  const requested = params.get('window');
  const windowId: WindowId = isWindowId(requested) ? requested : 'this-month';
  const setWindow = (id: WindowId) => {
    const next = new URLSearchParams(params);
    next.set('window', id);
    setParams(next, { replace: true });
  };
  const comparisonParam = params.get('vs');
  const comparison: ReportComparisonMode =
    COMPARISONS.some((c) => c.id === comparisonParam) ? (comparisonParam as ReportComparisonMode) : 'prior_period';
  const setComparison = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('vs', id);
    setParams(next, { replace: true });
  };
  const [showAllSpending, setShowAllSpending] = useState(false);

  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');
  const range = windowRange(windowId, now);

  /* The standing. None of these takes the window. */
  const snapshotQ = useQuery({ queryKey: ['networth', 'snapshot'], queryFn: () => networthApi.snapshot(), retry: false });
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const safeToSpendQ = useQuery({ queryKey: ['insights', 'safe-to-spend'], queryFn: () => insightsApi.safeToSpend() });
  const forecastQ = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const goalsQ = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });
  const insightsQ = useQuery({ queryKey: ['insights'], queryFn: () => insightsApi.list() });
  const reviewQ = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const aiActionsQ = useQuery({ queryKey: ['ai-actions'], queryFn: () => aiApi.listActions(), retry: false });

  // Windowless too, and separate from the window's own history on purpose: it feeds the beam's
  // marks and the net-worth delta, both of which sit above the register rule. Reading the window's
  // series here would put a selector on a reading that is supposed to have none, and would label
  // a 29-day gap between June's two sheets as a week.
  const recentQ = useQuery({
    queryKey: ['networth', 'history', 12],
    queryFn: () => networthApi.history(12),
    retry: false,
  });

  /* The window. Every one of these carries the range in its key, or a tab left open across a month
     boundary serves the old window under the new label. */
  const historyQ = useQuery({
    queryKey: ['networth', 'history', range],
    queryFn: () => networthApi.historyBetween(range.startDate, range.endDate),
    retry: false,
  });
  const summaryQ = useQuery({
    queryKey: ['reports', 'summary', range, comparison],
    queryFn: () => reportsApi.summary({ ...range, comparison }),
  });
  const cashflowQ = useQuery({
    queryKey: ['reports', 'cashflow', range],
    queryFn: () => reportsApi.cashflow(range),
  });
  const spendingQ = useQuery({
    queryKey: ['reports', 'spending', range],
    queryFn: () => reportsApi.spending(range),
  });
  const merchantsQ = useQuery({
    queryKey: ['reports', 'merchants', range],
    queryFn: () => reportsApi.merchants({ ...range, limit: 10 }),
  });
  // Per-category spend by month. No `categoryIds`: unfiltered is every category the window holds,
  // which is the set "Where it went" already ranks, and asking for a subset would mean this screen
  // deciding twice which categories matter.
  const trendsQ = useQuery({
    queryKey: ['reports', 'trends', range],
    queryFn: () => reportsApi.trends(range),
  });
  // Null, not an error, when the window holds fewer than two snapshots: there is no movement to
  // attribute. `retry: false` because a window with one sheet in it will not grow one on a retry.
  const attributionQ = useQuery({
    queryKey: ['reports', 'networth-attribution', range],
    queryFn: () => reportsApi.networthAttribution(range),
    retry: false,
  });
  /*
   * A DEGRADATION THAT ONLY EXISTS DURING THE SESSION THAT SAW IT IS NOT A DEGRADATION.
   *
   * `syncStatus === 'error'` is Zustand state set by the SSE `sync_complete` handler when the run
   * came back 'partial'. It is initialised to 'idle' on mount, so it says nothing at all about a
   * run that finished before this page was opened: reload the app after a partial sync and the beam
   * reads fully calibrated on a sheet a partial run wrote.
   *
   * Measured 2026-07-31 against a copy of `.mizan/mizan.db` at migration 054, taken with
   * `sqlite3 .mizan/mizan.db ".backup /tmp/copy.db"` and queried read-only:
   *
   *   SELECT id, status, completed_at, message FROM sync_runs
   *   WHERE status <> 'running' ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 1;
   *   -- 1ad2346d | partial | 2026-07-31T18:48:51.403Z | Sync finished with issues
   *   SELECT date, is_estimated, covered_accounts, total_accounts, created_at
   *   FROM net_worth_snapshots ORDER BY date DESC LIMIT 1;
   *   -- 2026-07-31 | 0 | 14 | 14 | 2026-07-31T18:48:51.393Z
   *
   * The sheet's `created_at` is ten milliseconds before the run's `completed_at`, so that partial
   * run is the run that wrote it. What failed inside it is why coverage cannot stand in for this:
   *
   *   SELECT provider, status, accounts_seen, error_message FROM sync_run_items
   *   WHERE run_id = '1ad2346d-dd6a-4e4a-856a-f719a1f94db5';
   *   -- simplefin | failed | 0 | Request failed with status code 402
   *   -- coinbase, transaction-integrity, auto-categorization, net-worth-reconstruction | succeeded
   *
   * SimpleFIN returned nothing, so thirteen of the fourteen balances in that sheet are whatever the
   * previous run left, and the sheet still recorded `covered_accounts = total_accounts = 14`,
   * because coverage counts accounts the snapshot included and not accounts a provider refreshed.
   * `sync_runs` is the only place that distinction is durable, so it is read rather than remembered.
   * The live SSE event still counts: it is the only signal during the run that wrote the sheet under
   * the reader's eyes.
   *
   * This query is in `failableQueries` below, and that is load-bearing rather than tidy. A dead
   * `GET /api/sync/health` leaves `last_run` undefined, which reads as "the run finished" and would
   * silently restore the fully-calibrated face this whole comment is about. The banner is what
   * says the check did not run; the beam must not imply it did.
   */
  const syncHealthQ = useQuery({
    queryKey: ['sync', 'health'],
    queryFn: () => syncApi.health(),
    retry: false,
  });

  // A dead request must not render as a quiet zero: the banner names what is missing.
  const failableQueries = [
    { query: snapshotQ, label: 'net worth' },
    { query: accountsQ, label: 'accounts' },
    { query: safeToSpendQ, label: 'what is free' },
    { query: forecastQ, label: 'upcoming bills' },
    { query: goalsQ, label: 'goals' },
    { query: reviewQ, label: 'review queue' },
    { query: recentQ, label: 'recent balance sheets' },
    { query: historyQ, label: 'net worth history' },
    { query: summaryQ, label: 'this window' },
    { query: cashflowQ, label: 'cash flow' },
    { query: spendingQ, label: 'spending by category' },
    { query: merchantsQ, label: 'merchants' },
    { query: trendsQ, label: 'spending by month' },
    { query: attributionQ, label: 'what moved net worth' },
    { query: syncHealthQ, label: 'sync health' },
  ];

  const snapshot = snapshotQ.data;
  const standing = readStanding(safeToSpendQ.data);
  const cardCredit = readCardCredit(accountsQ.data ?? []);

  // The instrument reports nothing until it has a sheet to read. An absent snapshot and a snapshot
  // still in flight are different states, and "no balance sheet has been recorded yet" is false
  // during the second.
  const sheetLoading = snapshotQ.isLoading;
  // `syncIncomplete` is the durable half of the reading; see `syncHealthQ` above for what the two
  // terms are and what a failed health request is allowed to imply (nothing).
  const calibration = readCalibration({
    sheetDate: snapshot?.date ?? null,
    today,
    isEstimated: Boolean(snapshot?.is_estimated),
    coveredAccounts: snapshot?.covered_accounts ?? null,
    totalAccounts: snapshot?.total_accounts ?? null,
    syncIncomplete: syncStatus === 'error' || Boolean(syncHealthQ.data?.last_run?.incomplete),
  });

  // The current sheet and the ones behind it, in the one shape both standing readings take. The
  // beam's marks and the week's change are the same comparison at different resolutions, so they
  // are drawn from the same list and settled by the same rule.
  const currentSheet = useMemo<SheetPoint | null>(
    () =>
      snapshot
        ? {
            date: snapshot.date,
            assets: snapshot.total_assets,
            liabilities: snapshot.total_liabilities,
            netWorth: snapshot.net_worth,
            isEstimated: Boolean(snapshot.is_estimated),
            coveredAccounts: snapshot.covered_accounts ?? null,
            totalAccounts: snapshot.total_accounts ?? null,
          }
        : null,
    [snapshot]
  );
  const earlierSheets = useMemo<SheetPoint[]>(
    () =>
      (recentQ.data ?? [])
        .filter((s) => s.date !== snapshot?.date)
        .map((s) => ({
          date: s.date,
          assets: s.total_assets,
          liabilities: s.total_liabilities,
          netWorth: s.net_worth,
          isEstimated: Boolean(s.is_estimated),
          coveredAccounts: s.covered_accounts ?? null,
          totalAccounts: s.total_accounts ?? null,
        })),
    [recentQ.data, snapshot?.date]
  );

  const beamHistory = useMemo(
    () =>
      comparableHistory(earlierSheets, {
        coveredAccounts: currentSheet?.coveredAccounts ?? null,
        totalAccounts: currentSheet?.totalAccounts ?? null,
      }),
    [earlierSheets, currentSheet]
  );
  const weekChange = useMemo(() => readWeekChange(earlierSheets, currentSheet), [earlierSheets, currentSheet]);
  const weekCaption = describeWeekChange(weekChange);

  const buckets = snapshot ? bucketsOf(snapshot) : null;
  const payoff = buckets ? payoffState(buckets) : null;
  const assetRows = buckets
    ? ([
        { label: 'Cash', amount: buckets.liquid },
        { label: 'Stocks', amount: buckets.equity },
        { label: 'Crypto', amount: buckets.crypto },
        { label: 'Other', amount: buckets.other },
      ] as const).filter((row) => row.amount !== 0)
    : [];
  const assetScale = signedBarScale(assetRows.map((row) => row.amount));
  const assetTotal = assetRows.reduce((sum, row) => sum + row.amount, 0);

  const bills = (forecastQ.data?.occurrences ?? []).filter((o) => !o.is_income && o.adjustment_action !== 'skip');
  const oldestOverdue = bills.find((o) => o.status === 'overdue') ?? null;
  // Split from the overdue one, so a bill that was due last week is not labelled as still ahead.
  const nextBill = bills.find((o) => o.status !== 'overdue') ?? null;
  const topGoal = (goalsQ.data ?? []).find((g) => !g.is_archived && g.target_amount > 0 && g.remaining_amount > 0);
  const draft: AdvisorDraftAction | undefined = reviewQ.data?.ai_drafts?.[0];
  const insight: Insight | undefined = insightsQ.data?.[0];
  const waiting = readWaiting(reviewQ.data);
  const recentAiCount = (aiActionsQ.data ?? []).filter(
    (a) => differenceInCalendarDays(new Date(), parseISO(a.created_at)) <= 1
  ).length;
  // Omitted entirely when nothing is waiting, rather than rendering an empty strip: "you are all
  // clear" is a claim, and absence of a prompt is not one.
  const needsYou = Boolean(topGoal || oldestOverdue || nextBill || draft || insight) || waiting.length > 0;

  const confirmDraft = useMutation({
    mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d),
    onSuccess: (res) => {
      addToast({ type: 'success', message: res.message || 'Applied.' });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      queryClient.invalidateQueries({ queryKey: ['ai-actions'] });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });
  const dismissDraft = useMutation({
    mutationFn: (id: string) => aiApi.dismissDraft(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['transactions', 'review'] }),
  });

  /* ── The window's readings ── */
  const months = cashflowQ.data?.months ?? [];
  const windowCaption = describeWindow(months.map((m) => m.month), range, now);
  const summary = summaryQ.data;
  const comparisonReading = summary ? readComparison(summary) : null;
  const savingsRate = summary?.savings_rate.current ?? null;

  const monthScale = signedBarScale(months.map((m) => m.net));
  const split = splitSpending(spendingQ.data?.categories ?? []);
  const spendShown = showAllSpending ? split.spent : split.spent.slice(0, SPEND_ROWS);
  const spendingScale = signedBarScale([...split.spent, ...split.returned].map((c) => c.amount));
  const merchants = merchantsQ.data?.merchants ?? [];
  const merchantScale = signedBarScale(merchants.map((m) => m.total));
  const trendGrid = readTrendGrid(trendsQ.data);
  const attribution = attributionQ.data ?? null;
  const movers = attribution?.accounts ?? [];
  const moverScale = signedBarScale(movers.map((a) => a.delta));

  const trendPoints = (historyQ.data ?? []).map((s) => ({
    date: s.date,
    value: s.net_worth,
    estimated: Boolean(s.is_estimated),
    // NULL on rows written before migration 044, and undefined there rather than zero: the chart
    // draws a coverage change only where it has two counts to compare.
    coverage: s.covered_accounts ?? undefined,
  }));

  return (
    <Screen size="wide">
      <header className="flex flex-shrink-0 items-baseline justify-between gap-4 border-b border-line-2 pb-5">
        <span className="font-mono text-body-lg font-medium tracking-[0.16em] text-ink">MIZĀN</span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('mizan:open-palette'))}
          className="text-note uppercase tracking-[0.09em] text-muted transition-colors hover:text-ink"
        >
          {format(now, 'EEEE d MMMM')} · <span className="font-mono">⌘K</span>
        </button>
      </header>

      <QueryErrorBanner items={failableQueries} className="mt-6" />

      {/* ── THE STANDING ─────────────────────────────────────────────────────────
          Answer, instrument, evidence, in that order.

          The answer leads because it is what the owner opened the app to ask, and it is the one
          figure set at 44px: net worth is the famous number and this is the useful one. `Figure`
          prints the magnitude and puts the direction in a word, because "short" and "free" are two
          states rather than one figure wearing a different colour, and a sign is the one thing the
          eye skips. */}
      <div className="mt-8 flex flex-col gap-x-14 gap-y-3 sm:flex-row sm:items-baseline">
        {standing.kind === 'unread' ? (
          <p className="text-body-lg text-muted">{standing.detail}</p>
        ) : (
          <>
            <Figure scale="subject" value={standing.value} states={FREE_STATES}>
              {formatCurrency(standing.magnitude)}
            </Figure>
            <div className="max-w-[52ch]">
              <p className="text-body leading-relaxed text-muted">{standing.detail}</p>
              {standing.kind === 'short' && standing.largestClaim && (
                <p className="mt-1.5 text-body leading-relaxed text-clay">{standing.largestClaim}</p>
              )}
            </div>
          </>
        )}
      </div>

      {/* The whole sheet, across the whole measure. The beam gets the full content width because
          the reading is a position on it, and on this instrument width is resolution.

          `Screen size="wide"` is max-w-[1240px] with lg:px-9 / xl:px-12, beside NavRail's w-14 /
          xl:w-[148px], and xl starts at 1280: 1024 - 56 - 72 = 896px of beam at 1024,
          1280 - 148 - 96 = 1036px at 1280, 1440 - 148 - 96 = 1196px at 1440. The 1240 cap only
          binds above about a 1484px window, which is the width this screen is least often at. */}
      {sheetLoading ? (
        <div className="mt-8 space-y-4" aria-hidden>
          <div className="h-[28px] w-1/3 rounded bg-line" />
          <div className="h-[26px] w-full rounded bg-line" />
        </div>
      ) : (
        <BalanceScale
          className="mt-9"
          assets={snapshot?.total_assets ?? 0}
          liabilities={snapshot?.total_liabilities ?? 0}
          calibration={calibration}
          history={beamHistory}
          owedNote={
            cardCredit.inCredit > 0 ? (
              <Link to="/accounts" className="transition-colors hover:text-ink">
                {cardCredit.inCredit} of {cardCredit.cards} cards in credit, {formatCurrency(cardCredit.total)}
              </Link>
            ) : null
          }
        />
      )}

      <div className="mt-11 flex flex-col gap-11 lg:flex-row lg:items-start lg:gap-14">
        <div className="w-full flex-shrink-0 lg:w-[340px]">
          <Figure scale="lead" label="Net worth">
            {formatCurrency(snapshot?.net_worth ?? 0)}
          </Figure>
          {/* The nearest COMPARABLE sheet at least seven days back, not a sheet exactly seven days
              back and not merely the nearest one: snapshots are written by sync, so there is rarely
              one on the day itself, and the nearest one may have reached a different set of
              accounts. See `readWeekChange`; the rule is the beam's own. */}
          <div className={`mt-2 max-w-[46ch] text-note leading-relaxed tabular-nums ${weekChangeTone(weekChange)}`}>
            {weekCaption.reading}
          </div>
          {weekCaption.note && (
            <div className="mt-1 max-w-[46ch] text-note leading-relaxed tabular-nums text-muted-2">
              {weekCaption.note}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <SectionLabel className="mb-2" summary={buckets ? formatCurrency(assetTotal) : undefined}>
            Where it sits
          </SectionLabel>
          {buckets ? (
            <>
              {assetRows.map((row) => (
                <BarRow key={row.label} label={row.label} amount={row.amount} {...assetScale} />
              ))}
              {/* The payoff reading, which is the only thing on this surface that says what the
                  debt would COST rather than what it is. The beam above states its size. */}
              <p className="mt-4 max-w-[62ch] text-body leading-relaxed text-muted">
                {payoff?.kind === 'payable' && (
                  <>
                    Paying off {formatPayoffFigure(payoff.payable)} from cash would leave{' '}
                    <span className="text-ink">{formatPayoffFigure(afterPayoff(buckets).liquid)}</span> in cash and
                    net worth unchanged at <span className="text-ink">{formatWholeCurrency(buckets.netWorth)}</span>:
                    it reshuffles, it does not grow.
                    {payoff.remaining > 0 && (
                      <> {formatPayoffFigure(payoff.remaining)} would still be owed, with no cash left to reach it.</>
                    )}
                  </>
                )}
                {payoff?.kind === 'no_cash' && (
                  <>
                    {formatPayoffFigure(payoff.owed)} is owed and there is no cash to pay it from. This is the balance
                    sheet as it stands.
                  </>
                )}
                {payoff?.kind === 'no_debt' && <>Nothing is owed. This is the balance sheet as it stands.</>}
                {payoff?.kind === 'in_credit' && (
                  <>
                    Nothing to pay off: the liabilities hold{' '}
                    <span className="text-sage-deep">{formatPayoffFigure(payoff.credit)}</span> in credit rather than
                    debt. This is the balance sheet as it stands.
                  </>
                )}
              </p>
            </>
          ) : sheetLoading ? (
            <SkeletonRows rows={4} />
          ) : (
            <p className="text-body text-muted-2">No balance sheet has been recorded yet.</p>
          )}
        </div>
      </div>

      {needsYou && (
        <div className="mt-10 border-t border-line-2 pt-6">
          <SectionLabel className="mb-3">What needs you</SectionLabel>
          <div className="grid gap-x-14 gap-y-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <div className="grid content-start gap-[11px]">
              {oldestOverdue && (
                <RailRow
                  to="/ledger"
                  label={`${oldestOverdue.merchant_name} overdue`}
                  value={formatWholeCurrency(Math.abs(oldestOverdue.adjusted_amount ?? oldestOverdue.amount))}
                  tone="text-clay"
                />
              )}
              {nextBill && (
                <RailRow
                  to="/ledger"
                  label={`Next ${nextBill.merchant_name}`}
                  value={`${formatWholeCurrency(Math.abs(nextBill.adjusted_amount ?? nextBill.amount))} ${
                    nextBill.days_until <= 0 ? 'today' : `in ${nextBill.days_until}d`
                  }`}
                />
              )}
              {topGoal && (
                <RailRow to="/plan" label={topGoal.name} value={`${formatWholeCurrency(topGoal.remaining_amount)} to go`} />
              )}
              {waiting.map((queue) => (
                <RailRow key={queue.id} to={queue.to} label={queue.label} value={`${queue.count}`} tone={queue.tone} />
              ))}
            </div>

            {(draft || insight) && (
              <div className="min-w-0">
                <p className="max-w-[70ch] text-body leading-relaxed text-ink-soft">
                  {draft ? draft.summary : `${insight!.title}. ${insight!.message}`}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                  {draft ? (
                    <>
                      <TextButton variant="primary" onClick={() => confirmDraft.mutate(draft)} disabled={confirmDraft.isPending}>
                        {draft.label}
                      </TextButton>
                      <TextButton onClick={() => dismissDraft.mutate(draft.id)}>Dismiss</TextButton>
                    </>
                  ) : (
                    insight!.action_route && (
                      <TextButton variant="primary" onClick={() => navigate(insight!.action_route!)}>
                        {insight!.action_label ?? 'Take a look'}
                      </TextButton>
                    )
                  )}
                  {recentAiCount > 0 && (
                    <span className="text-note text-muted-2">Advisor set {recentAiCount} in the last day</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── THE WINDOW ───────────────────────────────────────────────────────────
          The doubled rule is structural rather than decorative: it marks where the selector starts
          applying. Everything above it is a state and takes no window; everything below it is a
          flow and takes this one. */}
      <div className="mt-14 border-t-2 border-line-3 pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <div>
            <h2 className="font-serif text-title font-normal leading-tight text-ink">Over this window</h2>
            <div className="mt-1 text-body text-muted">{windowCaption}</div>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 whitespace-nowrap text-body">
            {INSTRUMENT_WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setWindow(w.id)}
                aria-pressed={w.id === windowId}
                className={`transition-colors ${
                  w.id === windowId ? 'border-b border-ink pb-0.5 text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2.5 max-w-[72ch] text-note leading-relaxed text-muted-2">
          Everything below answers to this selector. The balance sheet above it is now, and has no window.
        </p>

        <div className="mt-8 space-y-12">
          {/* What the window did to the money */}
          <section>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
              <SectionLabel>In, out, and what is left</SectionLabel>
              <Select
                value={comparison}
                onChange={setComparison}
                clearable={false}
                placeholder="vs prior period"
                align="right"
                options={COMPARISONS.map((c) => ({ value: c.id, label: c.label }))}
              />
            </div>
            <QueryState
              isLoading={summaryQ.isPending}
              isError={summaryQ.isError}
              error={summaryQ.error}
              onRetry={() => void summaryQ.refetch()}
              label="this window"
            >
              {summary && comparisonReading && (
                <>
                  <Card padding="lg" elevation={2}>
                    <Figure
                      scale="lead"
                      label="Net"
                      value={summary.net.current}
                      states={{
                        positive: 'kept out of what came in',
                        negative: 'spent beyond what came in',
                        zero: 'exactly level',
                      }}
                    >
                      {formatWholeCurrency(Math.abs(summary.net.current))}
                    </Figure>
                    {/* All four summary metrics arrive with a delta and all four are shown. Drawing
                        one for income and expenses only made the pair look like a claim that net
                        and the rate kept have no period-over-period reading, when both were on the
                        wire: on the live `this month` summary, net moved 5,339.70 dollars and the
                        rate kept moved 195.61 points. */}
                    {comparisonReading.comparable && (
                      <Delta delta={summary.net.delta} good={(d) => d > 0} format={formatWholeCurrency} />
                    )}
                  </Card>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:gap-4">
                    {/* Both figures are neutral ink, and that is deliberate.

                        "In" and "Out" are the two halves of an accounting identity: every window
                        has both, and neither is news. Painting them sage and clay was a second
                        label for what the word already says, and it spent the only two semantic
                        hues in the palette on a distinction the layout makes for free. `net`
                        directly above keeps its sign-derived tone, because its sign is the one
                        thing here that genuinely varies and genuinely matters. So the block now
                        carries exactly one coloured figure, the informative one, plus the two
                        deltas, whose colour is conditional on a measured change.

                        The clay half was also wrong on real data. `summary.expenses.current` is a
                        SUM of `spendAmountSql` = `(-t.amount)`, which is SIGNED, so a window whose
                        refunds outweigh its purchases reports negative expenses: money came in, and
                        the screen painted it in the outgoing colour and printed it with a minus.
                        Driving `getReportSummary` over all 156 Monday-anchored weeks the ledger
                        covers, against a copy of `.mizan/mizan.db` on 2026-09-01, 2 come back
                        negative: the week of 2026-07-13 at Out -1,313.17 against In 544.18, and the
                        week of 2024-01-15 at Out -39.65 against In 0.00. `value`/`states` handles
                        that the way `net` does, with the magnitude as children and the word
                        carrying the direction. */}
                    <Card padding="lg">
                      <Figure
                        scale="group"
                        tone="ink"
                        label="In"
                        value={summary.income.current}
                        states={{ positive: 'came in', negative: 'reversed out', zero: 'nothing came in' }}
                      >
                        {formatWholeCurrency(Math.abs(summary.income.current))}
                      </Figure>
                      {comparisonReading.comparable && (
                        <Delta delta={summary.income.delta} good={(d) => d > 0} format={formatWholeCurrency} />
                      )}
                    </Card>
                    <Card padding="lg">
                      <Figure
                        scale="group"
                        tone="ink"
                        label="Out"
                        value={summary.expenses.current}
                        states={{ positive: 'went out', negative: 'came back in refunds', zero: 'nothing went out' }}
                      >
                        {formatWholeCurrency(Math.abs(summary.expenses.current))}
                      </Figure>
                      {comparisonReading.comparable && (
                        <Delta delta={summary.expenses.delta} good={(d) => d < 0} format={formatWholeCurrency} />
                      )}
                    </Card>
                    <Card padding="lg">
                      {/* Nullable on purpose: a rate of "kept out of nothing" has no value, and
                          reporting 0 for it said "you saved nothing" about a window whose pay had
                          not arrived yet. Set with the same minus sign the money formatters use,
                          rather than a hyphen. */}
                      <Figure
                        scale="group"
                        tone={savingsRate == null || savingsRate >= 0 ? 'ink' : 'negative'}
                        label="Kept"
                      >
                        {savingsRate == null ? (
                          <span className="text-body text-muted">no income yet</span>
                        ) : (
                          `${savingsRate < 0 ? '−' : ''}${Math.round(Math.abs(savingsRate))}%`
                        )}
                      </Figure>
                      {/* Points, not percent: this is a difference of two percentages. It is also
                          nullable, which is why `Delta` takes `number | null` rather than being
                          guarded here. */}
                      {comparisonReading.comparable && (
                        <Delta delta={summary.savings_rate.delta} good={(d) => d > 0} format={formatPointsFigure} />
                      )}
                    </Card>
                  </div>
                  <p className="mt-3 text-note text-muted-2">{comparisonReading.note}</p>
                </>
              )}
            </QueryState>
          </section>

          {/* Net worth across the same window: the beam's reading, over time */}
          <section>
            <SectionLabel className="mb-3">Net worth across this window</SectionLabel>
            <QueryState
              isLoading={historyQ.isPending}
              isError={historyQ.isError}
              error={historyQ.error}
              onRetry={() => void historyQ.refetch()}
              label="net worth history"
            >
              {trendPoints.length >= 2 ? (
                <TrendChart history={trendPoints} height={150} label="Net worth" />
              ) : (
                <p className="text-body text-muted-2">
                  This window holds {trendPoints.length === 1 ? 'one recorded sheet' : 'no recorded sheets'}; a trend
                  needs two. They accrue as you sync.
                </p>
              )}
            </QueryState>
          </section>

          {/* What moved net worth, account by account. The chart above says the line went there;
              this says which balances took it. Rendered only where the report had two sheets to
              difference, which is the same condition it returns null under. */}
          {attribution && movers.length > 0 && (
            <section>
              <SectionLabel
                className="mb-2"
                summary={`${formatWholeCurrency(attribution.delta, { showSign: true })} over the window`}
              >
                What moved it
              </SectionLabel>
              {movers.map((account) => (
                <BarRow
                  key={account.account_id}
                  label={account.account_name ?? 'Unnamed account'}
                  sub={account.institution_name ?? undefined}
                  amount={account.delta}
                  tone={account.delta < 0 ? 'text-clay' : 'text-sage-deep'}
                  showSign
                  {...moverScale}
                />
              ))}
              <p className="mt-2.5 max-w-[72ch] text-note leading-relaxed text-muted-2">
                Two recorded balance sheets differenced account by account,{' '}
                {format(parseISO(attribution.start_date), 'MMM d')} to{' '}
                {format(parseISO(attribution.end_date), 'MMM d')}, not the window's own edges: only
                measured sheets are used as endpoints, so a reconstruction is never one end of this
                subtraction. Each figure is the account's effect on net worth, so a card whose
                balance grew reads negative. Accounts that did not move are not listed.
              </p>
            </section>
          )}

          {/* Month by month, only where the window holds more than one month to compare */}
          {months.length >= 2 && (
            <section>
              <SectionLabel className="mb-2" summary={`${months.length} months`}>
                Month by month
              </SectionLabel>
              <div className="min-w-0">
                {months.map((m) => (
                  <div
                    key={m.month}
                    className="grid grid-cols-[92px_minmax(0,1fr)_88px] items-center gap-x-5 border-b border-line py-[7px] sm:grid-cols-[92px_76px_76px_minmax(0,1fr)_88px]"
                  >
                    <span className="truncate text-body text-ink">{format(parseISO(`${m.month}-01`), 'MMM yyyy')}</span>
                    <span className="hidden text-right text-note tabular-nums text-sage-deep sm:block">
                      {formatWholeCurrency(m.income)}
                    </span>
                    <span className="hidden text-right text-note tabular-nums text-muted sm:block">
                      {formatWholeCurrency(m.expenses)}
                    </span>
                    <SignedBar value={m.net} {...monthScale} height={8} />
                    <span
                      className={`whitespace-nowrap text-right text-body-lg tabular-nums ${
                        m.net < 0 ? 'text-clay' : 'text-sage-deep'
                      }`}
                    >
                      {formatWholeCurrency(m.net, { showSign: true })}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2.5 text-note text-muted-2">
                In and out per month, with the bar drawn on what is left of the two. Bars run against the largest net
                month here, {formatWholeCurrency(monthScale.extent)}.
              </p>
            </section>
          )}

          {/* Where it went. Hazard 1 lives here; see splitSpending. */}
          <section>
            <SectionLabel className="mb-2" summary={spendingQ.data ? `net ${formatCurrency(spendingQ.data.total)}` : undefined}>
              Where it went
            </SectionLabel>
            <QueryState
              isLoading={spendingQ.isPending}
              isError={spendingQ.isError}
              error={spendingQ.error}
              onRetry={() => void spendingQ.refetch()}
              label="spending by category"
            >
              {split.spent.length + split.returned.length === 0 ? (
                <p className="text-body text-muted-2">Nothing categorized in this window.</p>
              ) : (
                <>
                  {/* Returns lead. A category whose refunds outweigh its purchases is the single
                      largest movement of money in some months, and ranking by amount put it last. */}
                  {split.returned.length > 0 && (
                    <div className="mb-7">
                      <div className="mb-1 text-rule uppercase tracking-[0.16em] text-sage-deep">
                        Came back · {formatCurrency(split.returnedTotal)} from{' '}
                        {split.returned.length === 1 ? 'one category' : `${split.returned.length} categories`}
                      </div>
                      {split.returned.map((c) => (
                        <BarRow
                          key={c.category_id}
                          label={c.category_name}
                          amount={c.amount}
                          tone="text-sage-deep"
                          to={ledgerLinkFor(c.category_id, windowId)}
                          {...spendingScale}
                        />
                      ))}
                      <p className="mt-1.5 max-w-[72ch] text-note leading-relaxed text-muted">
                        Refunds and credits filed here outweighed the purchases, so the category is net positive for
                        this window and its bar runs left of the zero rule.
                      </p>
                    </div>
                  )}

                  <div className="mb-1 text-rule uppercase tracking-[0.16em] text-muted">
                    Went out · {formatCurrency(split.spentTotal)} across{' '}
                    {split.spent.length === 1 ? 'one category' : `${split.spent.length} categories`}
                  </div>
                  {spendShown.map((c) => (
                    <BarRow
                      key={c.category_id}
                      label={c.category_name}
                      amount={c.amount}
                      to={ledgerLinkFor(c.category_id, windowId)}
                      {...spendingScale}
                    />
                  ))}
                  {split.spent.length > SPEND_ROWS && (
                    <button
                      type="button"
                      onClick={() => setShowAllSpending(!showAllSpending)}
                      className="mt-3 text-body text-muted transition-colors hover:text-ink"
                    >
                      {showAllSpending ? `Show the top ${SPEND_ROWS}` : `Show all ${split.spent.length}`}
                    </button>
                  )}
                  {/* No percentage of the total appears anywhere in this section, on purpose: the
                      total is signed, so a share of it is not a share of anything. Bars are what
                      makes these comparable, so what they are drawn against is stated. */}
                  <p className="mt-3 max-w-[72ch] text-note leading-relaxed text-muted-2">
                    Bars run against the largest figure here, {formatCurrency(spendingScale.extent)}. No share of the
                    total is shown. A category total is signed, so the total a share would divide into is a net of
                    spend and returns rather than a whole.
                  </p>
                </>
              )}
            </QueryState>
          </section>

          {/* The same categories, over time. "Where it went" answers how big; this answers whether
              it is usual, which is the only reading that tells a $731 month of groceries from a
              $731 month of groceries that is double every month before it. Drawn only where the
              window holds at least two months, because one column is not a trend. */}
          {trendGrid && (
            <section>
              <SectionLabel className="mb-2" summary={`${trendGrid.months.length} months`}>
                Each category, month by month
              </SectionLabel>
              <div className="min-w-0">
                {trendGrid.rows.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(72px,140px)_92px] items-center gap-x-5 py-[7px]"
                  >
                    <span className="truncate text-body text-ink">{row.name}</span>
                    <MonthStrip
                      values={row.values}
                      extent={trendGrid.extent}
                      label={`${row.name}, ${trendGrid.months.length} months to ${trendGrid.months[trendGrid.months.length - 1]}`}
                    />
                    <span className="whitespace-nowrap text-right text-body-lg tabular-nums text-ink">
                      {formatWholeCurrency(row.total)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2.5 max-w-[72ch] text-note leading-relaxed text-muted-2">
                One column for each month this window has entries in,{' '}
                {format(parseISO(`${trendGrid.months[0]}-01`), 'MMM yyyy')} to{' '}
                {format(parseISO(`${trendGrid.months[trendGrid.months.length - 1]}-01`), 'MMM yyyy')}, left
                to right. Every column in this grid is drawn against the same figure, the largest single
                month here at {formatWholeCurrency(trendGrid.extent)}, so a taller column is more money
                and not merely more for that row. The figure on the right is the window's total for the
                category. A month drawn in the return colour is one whose refunds outweighed its
                purchases.
                {trendGrid.hidden > 0 &&
                  ` ${trendGrid.hidden} smaller categor${trendGrid.hidden === 1 ? 'y is' : 'ies are'} not shown.`}
              </p>
            </section>
          )}

          {/* Merchants. A different quantity from the categories above, and it says so. */}
          <section>
            <SectionLabel className="mb-2">Busiest merchants</SectionLabel>
            <QueryState
              isLoading={merchantsQ.isPending}
              isError={merchantsQ.isError}
              error={merchantsQ.error}
              onRetry={() => void merchantsQ.refetch()}
              label="merchants"
            >
              {merchants.length === 0 ? (
                <p className="text-body text-muted-2">No merchant activity in this window.</p>
              ) : (
                <>
                  {merchants.map((m) => (
                    <BarRow
                      key={m.merchant}
                      label={m.merchant}
                      sub={`${m.transaction_count}×${m.category_name ? ` · ${m.category_name}` : ''}`}
                      amount={m.total}
                      {...merchantScale}
                    />
                  ))}
                  {/* The report sums ABS(amount) per merchant, so a refund counts as movement. That
                      is a different quantity from the category totals above, which net. Dividing
                      one by the other is what produced a merchant "share" of 161% on July 2026. */}
                  <p className="mt-3 max-w-[72ch] text-note leading-relaxed text-muted-2">
                    Gross activity: a refund counts here as movement rather than against it, so these totals do not
                    net out and do not sum to the figures above. No share of the total is shown.
                  </p>
                </>
              )}
            </QueryState>
          </section>
        </div>
      </div>
    </Screen>
  );
}
