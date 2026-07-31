import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { addDays, endOfMonth, format, parseISO, startOfMonth } from 'date-fns';
import type { SpendingReport } from '../../../shared/types';
import { revertAction } from './categoryWrites';
import { readLatestSnapshot } from './netWorthHistory';
import { buildRecurringForecast } from './recurringForecast';
import { getIncomeReport, getReportSummary, getSpendingReport } from './reporting';
import { transactionReportInclusion } from './schemaDoc';

/**
 * The harness that makes widening the AI's write authority safe.
 *
 * It snapshots the headline set, runs an autonomous batch, re-runs the set, and reverts the whole
 * batch by action id if the movement is not one a category rewrite can produce.
 *
 * WHY "A FIGURE MOVED" IS THE WRONG BREACH CONDITION. A categorization change is SUPPOSED to move
 * per-category totals. That is its entire purpose. A guard keyed on movement fires on every healthy
 * pass, and a guard that fires on healthy passes gets switched off.
 *
 * THE PROPERTY THAT IS ACTUALLY TRUE. Recategorizing is a reshuffle, not a change in magnitude. A
 * batch that only rewrites `category_id` cannot change how much money moved; it can only change
 * which line the money is filed under.
 *
 * THE HONEST RULE, because the naive version of even that is wrong. Some category roots (cat_xfer,
 * cat_inv, cat_crypto) are outside report scope, and `is_income` / `is_investment` decide which side
 * of the ledger a row lands on. So filing a row INTO a transfer category, or across the income
 * boundary, legitimately changes the month's totals, and that is exactly the write most worth
 * watching. What makes it a breach is the total moving by an amount the batch's own rewrites cannot
 * account for. Each rewritten row's contribution is computed from its BEFORE amount and its
 * before/after classification, so a batch that quietly changed an amount as well as a category
 * produces an expectation that does not match the observed movement.
 *
 * EVERY FIGURE COMES FROM THE SERVICE THAT OWNS IT. reporting.ts for spend, income and the savings
 * rate, netWorthHistory.ts for net worth, recurringForecast.ts for the scheduled net, and
 * schemaDoc.transactionReportInclusion for per-row classification, which evaluates the same
 * predicate strings the Reports page uses. There is no SQL in this file that sums money. That is not
 * style: advisorChatTools ran its own aggregates and drifted until the advisor reported $1,695.00 of
 * spending where Reports reported $75.00 on the same data.
 *
 * SCOPE. This guards a batch that rewrites `category_id` and nothing else, which covers both current
 * autonomous kinds (categorize_transaction, create_merchant_rule). A batch that also confirms
 * transfers or resolves duplicates changes `counts` without changing a category, and this harness
 * reports that as a breach rather than absorbing it: those writes need their own conservation rule,
 * not a widened version of this one.
 *
 * EVERY WINDOW IS PINNED BEFORE THE FIRST CAPTURE. The month and the forecast window are both
 * resolved once and handed to both captures. A window either capture resolved for itself would move
 * under a pass that straddles local midnight, and a headline that moved because the clock moved is a
 * breach nothing wrote, auto-reverting a batch that did nothing wrong.
 *
 * COST, measured 2026-07-31 against a copy of .mizan/mizan.db for month 2026-07, whose window holds
 * 120 rows (`SELECT COUNT(*) FROM transactions WHERE date BETWEEN '2026-07-01' AND '2026-07-31'`).
 * Ranges are across three runs of the same script; cold and warm are separated because they differ
 * by six times and only one call per pass is ever cold.
 *  - `captureHeadlines` COLD, the first call on a freshly opened handle with no statement prepared:
 *    13.5 to 15.0 ms.
 *  - `captureHeadlines` WARM: median 2.2 to 2.3 ms over the eleven consecutive calls after it.
 *  - A whole guarded six-row pass that breaches nothing, so two captures and two ledger reads and no
 *    revert: 18.1 to 22.6 ms, over fifteen passes.
 * The cold capture is most of a pass. The ledger read is one `transactionReportInclusion` call per
 * row per capture, so it scales with the month, not the ledger.
 */

/** How many days past the pinned anchor the scheduled-net headline covers. */
export const SCHEDULED_FORECAST_DAYS = 60;

export type HeadlineName =
  | 'net_worth'
  | 'month_spend'
  | 'month_income'
  | 'savings_rate'
  | 'scheduled_net'
  | 'category_totals';

export type MovementPolicy = 'invariant' | 'accounted' | 'derived' | 'evidence';

/**
 * What a pure category rewrite is allowed to do to each headline. Encoded, not asserted in prose,
 * because this table IS the policy the checks below read.
 *
 *  - `invariant`: a category rewrite cannot reach it. Any movement at all is a breach.
 *  - `accounted`: it may move, by exactly what the rewritten rows explain and no more.
 *  - `derived`: it is a function of accounted headlines, so it may move only when they did.
 *  - `evidence`: it moves on every healthy pass. Recorded so an incident says what shifted, never
 *    a breach condition.
 *
 * WHAT THE `accounted` CHECK ACTUALLY CATCHES, since a batch that rewrote only categories cannot
 * trip it: the expectation and the headline are computed by two different services over the same
 * rows, so they agree by arithmetic while those services agree with each other. The check fires when
 * they stop agreeing, which is the drift this codebase has already paid for once, when
 * advisorChatTools' own aggregates reported $1,695.00 of spending against Reports' $75.00 on the
 * same data. Everything a batch can do that a category rewrite cannot is caught upstream of it, as a
 * `ledger_shape` breach, and quantified by this one.
 */
export const HEADLINE_MOVEMENT_POLICY: Readonly<Record<HeadlineName, MovementPolicy>> = {
  net_worth: 'invariant',
  scheduled_net: 'invariant',
  month_spend: 'accounted',
  month_income: 'accounted',
  savings_rate: 'derived',
  category_totals: 'evidence',
};

export interface HeadlineSnapshot {
  /** `yyyy-MM`, the month the spend/income/savings-rate headlines cover. */
  month: string;
  start_date: string;
  end_date: string;
  /** Null when no balance sheet has ever been recorded. */
  net_worth_cents: number | null;
  month_spend_cents: number;
  month_income_cents: number;
  /** Percentage points, null when the window has no income to compute a rate from. */
  savings_rate_percent: number | null;
  /** The recurring forecast's net over the pinned window below, not over a window read off a clock. */
  scheduled_net_cents: number;
  /** The pinned forecast window, inclusive. Identical on both sides of a guarded pass. */
  scheduled_forecast_start: string;
  scheduled_forecast_end: string;
  scheduled_forecast_days: number;
  /** Keyed `spend:<category_id>` and `income:<category_id>`, cents, children included. */
  category_totals_cents: Record<string, number>;
}

export interface HeadlineBreach {
  headline: HeadlineName | 'ledger_shape';
  policy: MovementPolicy | 'structural';
  /** Cents for money headlines, percentage points for the savings rate, null for structural. */
  before: number | null;
  after: number | null;
  /** after - before. */
  moved: number | null;
  /** What the batch's own category rewrites account for. Null where nothing may explain movement. */
  explained: number | null;
  unit: 'cents' | 'percent' | 'none';
  detail: string;
}

/** A per-category movement. Evidence for the incident row, never a breach. */
export interface CategoryMove {
  key: string;
  before_cents: number;
  after_cents: number;
  moved_cents: number;
}

export interface GuardOptions {
  /** `yyyy-MM`. Defaults to the current local month, which is the month the owner is looking at. */
  month?: string;
  /** ISO timestamp recorded on the incident. */
  now?: string;
  /**
   * `yyyy-MM-dd`, the first day of the scheduled-net window. Defaults to today, which is the only
   * value that makes the figure mean what the forecast panel means. `runGuardedCategoryBatch` pins
   * it once and hands the same one to every capture in the pass.
   */
  forecastAnchor?: string;
}

export interface GuardedBatchOutcome<T> {
  value: T;
  /**
   * Action ids the batch knows it created. Ids that appear in `advisor_actions` while the batch runs
   * are added to these, so a caller that cannot report them (confirmAdvisorDraft does not return
   * one) still gets a revertable batch.
   */
  actionIds?: readonly string[];
}

export interface GuardedCategoryBatch<T> {
  /** Recorded on the incident row. Names the pass, e.g. 'worker_autonomous_pass'. */
  name: string;
  /** Must be synchronous: action-id discovery assumes nothing else writes while it runs. */
  run: () => GuardedBatchOutcome<T>;
}

export type GuardedBatchStatus = 'clean' | 'reverted' | 'revert_failed';

export interface GuardedBatchReport<T> {
  status: GuardedBatchStatus;
  /** The batch's own return value. Still returned on a revert: the caller has to log what it tried. */
  value: T;
  action_ids: string[];
  breaches: HeadlineBreach[];
  /** The `ai_incidents` row. Null exactly when nothing breached. */
  incident_id: string | null;
  before: HeadlineSnapshot;
  after: HeadlineSnapshot;
  /** Per-category movement, largest first. Populated on every run, breach or not. */
  category_moves: CategoryMove[];
  /**
   * Category writes the revert took back. 0 unless `status` is 'reverted'. A transaction the batch
   * wrote twice counts twice: the revert had to undo both writes to leave the row where it started.
   */
  reverted_rows: number;
  /** Category writes the batch made that no action id can revert. Non-zero blocks the revert. */
  unrevertable_rows: number;
  /**
   * Whether the headline set came back to its pre-batch values. A separate question from whether the
   * revert worked: reverting categories cannot take back an amount the batch changed or a row it
   * inserted, and a breach always implicates one of those. Null when no revert was attempted.
   */
  headlines_restored: boolean | null;
}

interface DateWindow {
  startDate: string;
  endDate: string;
}

function monthWindow(month: string): DateWindow {
  const anchor = parseISO(`${month}-01`);
  if (Number.isNaN(anchor.getTime())) {
    throw new Error(`Guard month must be yyyy-MM, received "${month}".`);
  }
  return {
    startDate: format(startOfMonth(anchor), 'yyyy-MM-dd'),
    endDate: format(endOfMonth(anchor), 'yyyy-MM-dd'),
  };
}

function forecastWindow(anchor: string): DateWindow {
  const start = parseISO(anchor);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Guard forecast anchor must be yyyy-MM-dd, received "${anchor}".`);
  }
  return {
    startDate: format(start, 'yyyy-MM-dd'),
    endDate: format(addDays(start, SCHEDULED_FORECAST_DAYS), 'yyyy-MM-dd'),
  };
}

/**
 * The recurring forecast's net over a PINNED window.
 *
 * `buildRecurringForecast` resolves `now` and `now + days` from `new Date()` on every call, so two
 * captures either side of a batch cover different days whenever the pass straddles local midnight.
 * That moves `scheduled_net` with nothing written, which under an `invariant` policy is a breach
 * that auto-reverts a legitimate batch and records a cause that did not happen. Keeping only the
 * occurrences dated inside the pinned window makes both captures read the same days.
 *
 * The amount, its sign and the skip rule all still come from the forecast service; the only thing
 * done here is dropping occurrences outside the window, which is what a pinned `days` argument would
 * have done if the service took one. Occurrences dated before the window start are dropped rather
 * than counted as overdue: the service emits at most one overdue occurrence per pattern and WHICH
 * one it emits depends on the local date, so counting them would reintroduce the dependence this
 * exists to pin out.
 */
function scheduledNetCents(db: Database.Database, window: DateWindow): number {
  const forecast = buildRecurringForecast(db, SCHEDULED_FORECAST_DAYS);
  let net = 0;
  for (const occurrence of forecast.occurrences) {
    if (occurrence.adjustment_action === 'skip') continue;
    if (occurrence.expected_date < window.startDate) continue;
    if (occurrence.expected_date > window.endDate) continue;
    net += occurrence.amount;
  }
  return net;
}

function collectCategoryTotals(
  prefix: 'spend' | 'income',
  report: SpendingReport,
  into: Record<string, number>
): void {
  const walk = (nodes: SpendingReport['categories']): void => {
    for (const node of nodes) {
      into[`${prefix}:${node.category_id}`] = node.amount;
      if (node.children) walk(node.children);
    }
  };
  walk(report.categories);
}

/**
 * The headline set, every figure read from the service that owns it.
 *
 * Safe to call at any time: nothing here writes. `getReportSummary` also computes a comparison
 * window this does not use, which is the price of not re-deriving the savings rate here.
 */
export function captureHeadlines(db: Database.Database, options: GuardOptions = {}): HeadlineSnapshot {
  const month = options.month ?? format(new Date(), 'yyyy-MM');
  const window = monthWindow(month);
  const forecast = forecastWindow(options.forecastAnchor ?? format(new Date(), 'yyyy-MM-dd'));

  const summary = getReportSummary(db, window);
  const categoryTotals: Record<string, number> = {};
  collectCategoryTotals('spend', getSpendingReport(db, window), categoryTotals);
  collectCategoryTotals('income', getIncomeReport(db, window), categoryTotals);
  const snapshot = readLatestSnapshot(db);

  return {
    month,
    start_date: window.startDate,
    end_date: window.endDate,
    net_worth_cents: snapshot === null ? null : snapshot.net_worth,
    month_spend_cents: summary.expenses.current,
    month_income_cents: summary.income.current,
    savings_rate_percent: summary.savings_rate.current,
    scheduled_net_cents: scheduledNetCents(db, forecast),
    scheduled_forecast_start: forecast.startDate,
    scheduled_forecast_end: forecast.endDate,
    scheduled_forecast_days: SCHEDULED_FORECAST_DAYS,
    category_totals_cents: categoryTotals,
  };
}

interface LedgerRow {
  amount: number;
  categoryId: string | null;
  counts: boolean;
  side: 'expense' | 'income' | null;
}

/**
 * Every row dated inside the window, with the classification the Reports page gives it.
 *
 * Rows outside the window are not captured because they cannot move a headline that reads only this
 * window: a rewrite in March contributes nothing to July's spend either side of the batch.
 */
function captureWindowLedger(db: Database.Database, window: DateWindow): Map<string, LedgerRow> {
  const rows = db
    .prepare('SELECT id, amount, category_id FROM transactions WHERE date BETWEEN ? AND ?')
    .all(window.startDate, window.endDate) as Array<{
      id: string;
      amount: number;
      category_id: string | null;
    }>;

  const ledger = new Map<string, LedgerRow>();
  for (const row of rows) {
    const inclusion = transactionReportInclusion(db, row.id);
    if (inclusion === null) {
      throw new Error(`Transaction ${row.id} disappeared while the guard was reading the ledger.`);
    }
    ledger.set(row.id, {
      amount: row.amount,
      categoryId: row.category_id,
      counts: inclusion.counts,
      side: inclusion.side,
    });
  }
  return ledger;
}

// The row's contribution to each total, in the same arithmetic getCashflowReport uses: a counted
// expense-side row contributes -amount to spend, a counted income-side row contributes +amount to
// income, and anything the reports drop contributes nothing.
//
// `amount` is a parameter rather than read off the classification on purpose. Both sides of the
// expectation are computed from the amount the row held BEFORE the batch, so a batch that changed an
// amount as well as a category produces an expectation the observed movement cannot match.
function spendContribution(row: LedgerRow, amount: number): number {
  return row.counts && row.side === 'expense' ? -amount : 0;
}

function incomeContribution(row: LedgerRow, amount: number): number {
  return row.counts && row.side === 'income' ? amount : 0;
}

function structuralBreach(detail: string): HeadlineBreach {
  return {
    headline: 'ledger_shape',
    policy: 'structural',
    before: null,
    after: null,
    moved: null,
    explained: null,
    unit: 'none',
    detail,
  };
}

interface LedgerDiff {
  breaches: HeadlineBreach[];
  explainedSpend: number;
  explainedIncome: number;
  rewrittenRows: number;
}

/**
 * What the batch's rewrites explain, and anything it did that a category rewrite cannot do.
 *
 * A row whose category is unchanged but whose classification is not is a structural breach: its
 * `pending`, `transfer_status`, `duplicate_status` or its category's own `is_income` changed under
 * it, and every one of those is either outside this batch's remit or inside the owner's
 * proposal-only carve-out.
 */
function diffWindowLedger(before: Map<string, LedgerRow>, after: Map<string, LedgerRow>): LedgerDiff {
  const breaches: HeadlineBreach[] = [];
  let explainedSpend = 0;
  let explainedIncome = 0;
  let rewrittenRows = 0;

  for (const [id, was] of before) {
    const now = after.get(id);
    if (now === undefined) {
      breaches.push(structuralBreach(`Transaction ${id} left the window: a category rewrite cannot delete a row or move its date.`));
      continue;
    }
    if (now.amount !== was.amount) {
      breaches.push(structuralBreach(`Transaction ${id} changed amount from ${was.amount} to ${now.amount} cents: a category rewrite does not touch money.`));
      continue;
    }
    if (now.categoryId === was.categoryId) {
      if (now.counts !== was.counts || now.side !== was.side) {
        breaches.push(structuralBreach(`Transaction ${id} changed how the reports count it without its category changing, from ${describeClassification(was)} to ${describeClassification(now)}.`));
      }
      continue;
    }
    rewrittenRows += 1;
    explainedSpend += spendContribution(now, was.amount) - spendContribution(was, was.amount);
    explainedIncome += incomeContribution(now, was.amount) - incomeContribution(was, was.amount);
  }

  for (const id of after.keys()) {
    if (!before.has(id)) {
      breaches.push(structuralBreach(`Transaction ${id} entered the window: a category rewrite cannot insert a row or move its date.`));
    }
  }

  return { breaches, explainedSpend, explainedIncome, rewrittenRows };
}

function describeClassification(row: LedgerRow): string {
  if (!row.counts) return 'not counted';
  return row.side === null ? 'counted on no side' : `counted as ${row.side}`;
}

function sameRate(before: number | null, after: number | null): boolean {
  return Object.is(before, after);
}

function categoryMoves(before: HeadlineSnapshot, after: HeadlineSnapshot): CategoryMove[] {
  const keys = new Set([
    ...Object.keys(before.category_totals_cents),
    ...Object.keys(after.category_totals_cents),
  ]);

  return Array.from(keys)
    .map((key) => {
      const beforeCents = before.category_totals_cents[key] ?? 0;
      const afterCents = after.category_totals_cents[key] ?? 0;
      return { key, before_cents: beforeCents, after_cents: afterCents, moved_cents: afterCents - beforeCents };
    })
    .filter((move) => move.moved_cents !== 0)
    .sort((a, b) => Math.abs(b.moved_cents) - Math.abs(a.moved_cents));
}

function invariantBreach(
  headline: HeadlineName,
  before: number | null,
  after: number | null,
  detail: string
): HeadlineBreach | null {
  if (before === after) return null;
  return {
    headline,
    policy: HEADLINE_MOVEMENT_POLICY[headline],
    before,
    after,
    moved: before === null || after === null ? null : after - before,
    explained: 0,
    unit: 'cents',
    detail,
  };
}

function accountedBreach(
  headline: HeadlineName,
  before: number,
  after: number,
  explained: number
): HeadlineBreach | null {
  const moved = after - before;
  if (moved === explained) return null;
  return {
    headline,
    policy: HEADLINE_MOVEMENT_POLICY[headline],
    before,
    after,
    moved,
    explained,
    unit: 'cents',
    detail: `Moved ${moved} cents; the batch's category rewrites account for ${explained}. The unexplained ${moved - explained} cents did not come from a row this batch refiled.`,
  };
}

/**
 * Compare two headline sets under the movement policy.
 *
 * Exported so a caller can judge a batch it ran itself. `explainedSpend` / `explainedIncome` are the
 * cents the batch's rewrites account for, which `diffWindowLedger` derives.
 *
 * Throws rather than compares when the two sets cover different windows: every headline here is
 * window-scoped, so a difference between two windows is a difference in the question, not an answer
 * the caller can act on. `runGuardedCategoryBatch` pins both windows, so it cannot reach this.
 */
export function diffHeadlines(
  before: HeadlineSnapshot,
  after: HeadlineSnapshot,
  explained: { spend: number; income: number }
): HeadlineBreach[] {
  if (before.start_date !== after.start_date || before.end_date !== after.end_date) {
    throw new Error(`Headline sets cover different months (${before.start_date}..${before.end_date} and ${after.start_date}..${after.end_date}) and cannot be compared.`);
  }
  if (
    before.scheduled_forecast_start !== after.scheduled_forecast_start ||
    before.scheduled_forecast_end !== after.scheduled_forecast_end
  ) {
    throw new Error(`Headline sets cover different forecast windows (${before.scheduled_forecast_start}..${before.scheduled_forecast_end} and ${after.scheduled_forecast_start}..${after.scheduled_forecast_end}) and cannot be compared.`);
  }

  const breaches: HeadlineBreach[] = [];

  const netWorth = invariantBreach(
    'net_worth',
    before.net_worth_cents,
    after.net_worth_cents,
    'Net worth is read off account balances and recorded balance sheets. A category rewrite cannot reach either.'
  );
  if (netWorth) breaches.push(netWorth);

  const scheduled = invariantBreach(
    'scheduled_net',
    before.scheduled_net_cents,
    after.scheduled_net_cents,
    `The forecast over ${before.scheduled_forecast_start}..${before.scheduled_forecast_end} is built from recurring patterns and their linked amounts. A category rewrite touches neither, and the window is pinned across both captures so the clock cannot have moved it.`
  );
  if (scheduled) breaches.push(scheduled);

  const spend = accountedBreach('month_spend', before.month_spend_cents, after.month_spend_cents, explained.spend);
  if (spend) breaches.push(spend);

  const income = accountedBreach('month_income', before.month_income_cents, after.month_income_cents, explained.income);
  if (income) breaches.push(income);

  const spendMoved = after.month_spend_cents - before.month_spend_cents;
  const incomeMoved = after.month_income_cents - before.month_income_cents;
  if (!sameRate(before.savings_rate_percent, after.savings_rate_percent) && spendMoved === 0 && incomeMoved === 0) {
    breaches.push({
      headline: 'savings_rate',
      policy: HEADLINE_MOVEMENT_POLICY.savings_rate,
      before: before.savings_rate_percent,
      after: after.savings_rate_percent,
      moved: before.savings_rate_percent === null || after.savings_rate_percent === null
        ? null
        : after.savings_rate_percent - before.savings_rate_percent,
      explained: 0,
      unit: 'percent',
      detail: 'The savings rate is derived from the month\'s income and spend, and neither moved. A rate that moves on its own means the derivation changed, not the ledger.',
    });
  }

  return breaches;
}

/**
 * Every recorded advisor action id, oldest first.
 *
 * The ORDER BY is load-bearing. `SELECT id FROM advisor_actions` with no ORDER BY plans as
 * `SCAN advisor_actions USING COVERING INDEX sqlite_autoindex_advisor_actions_1`, so ids come back
 * sorted by uuid, and a batch's discovered ids then carried an order that depended on which uuid
 * happened to sort first. Creation order is the only order that means anything about a batch.
 */
function advisorActionIds(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT id FROM advisor_actions ORDER BY created_at, rowid')
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function maxRevisionRowid(db: Database.Database): number {
  // transaction_category_revisions is append-only, so a rowid above this floor is a write the batch
  // made. Timestamps cannot do this job: two writes inside the same millisecond are indistinguishable.
  const row = db
    .prepare('SELECT COALESCE(MAX(rowid), 0) AS floor FROM transaction_category_revisions')
    .get() as { floor: number };
  return row.floor;
}

/** Category writes the batch made that carry no action id in `actionIds`, so no revert can reach them. */
function unrevertableRowCount(db: Database.Database, floor: number, actionIds: readonly string[]): number {
  const placeholders = actionIds.map(() => '?').join(',');
  // With no revertable action, every category write the batch made is unrevertable, including the
  // ones that do carry an action id: no id in the batch's list can reach them.
  const clause = actionIds.length > 0
    ? `(action_id IS NULL OR action_id NOT IN (${placeholders}))`
    : '1 = 1';
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count FROM transaction_category_revisions
      WHERE rowid > ? AND revert_of IS NULL AND ${clause}
    `)
    .get(floor, ...actionIds) as { count: number };
  return row.count;
}

function headlinesMatch(a: HeadlineSnapshot, b: HeadlineSnapshot): boolean {
  return (
    a.net_worth_cents === b.net_worth_cents &&
    a.month_spend_cents === b.month_spend_cents &&
    a.month_income_cents === b.month_income_cents &&
    sameRate(a.savings_rate_percent, b.savings_rate_percent) &&
    a.scheduled_net_cents === b.scheduled_net_cents &&
    JSON.stringify(a.category_totals_cents) === JSON.stringify(b.category_totals_cents)
  );
}

interface IncidentInsert {
  batchName: string;
  detectedAt: string;
  before: HeadlineSnapshot;
  after: HeadlineSnapshot;
  breaches: HeadlineBreach[];
  actionIds: string[];
  unrevertableRows: number;
}

/**
 * Write the incident before the revert is attempted, so it survives a revert that rolls back.
 *
 * Returns the new row's id. The caller must resolve it with `resolveIncident`; a row left 'pending'
 * says the revert never returned, which is a finding in itself.
 */
function openIncident(db: Database.Database, incident: IncidentInsert): string {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO ai_incidents
      (id, batch_name, detected_at, month, start_date, end_date, breaches,
       before_headlines, after_headlines, action_ids, revert_status, unrevertable_rows)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    id,
    incident.batchName,
    incident.detectedAt,
    incident.before.month,
    incident.before.start_date,
    incident.before.end_date,
    JSON.stringify(incident.breaches),
    JSON.stringify(incident.before),
    JSON.stringify(incident.after),
    JSON.stringify(incident.actionIds),
    incident.unrevertableRows
  );
  return id;
}

function resolveIncident(
  db: Database.Database,
  id: string,
  resolution: {
    status: 'reverted' | 'failed';
    revertedActionIds: string[] | null;
    revertedRows: number | null;
    headlinesRestored: boolean | null;
    error: string | null;
    resolvedAt: string;
  }
): void {
  db.prepare(`
    UPDATE ai_incidents
    SET revert_status = ?, reverted_action_ids = ?, reverted_rows = ?,
        headlines_restored = ?, revert_error = ?, resolved_at = ?
    WHERE id = ?
  `).run(
    resolution.status,
    resolution.revertedActionIds === null ? null : JSON.stringify(resolution.revertedActionIds),
    resolution.revertedRows,
    resolution.headlinesRestored === null ? null : resolution.headlinesRestored ? 1 : 0,
    resolution.error,
    resolution.resolvedAt,
    id
  );
}

/** Category writes the batch made that are still standing: not reverts, and not yet reverted. */
function standingWriteCount(db: Database.Database, revisionFloor: number): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count FROM transaction_category_revisions
      WHERE rowid > ? AND revert_of IS NULL AND reverted_at IS NULL
    `)
    .get(revisionFloor) as { count: number };
  return row.count;
}

/**
 * The batch's action ids, newest write first.
 *
 * WHY ORDER MATTERS. `revertableRevisionsForAction` returns only revisions that are still the newest
 * for their transaction, so an action a later action wrote over reverts nothing until the later one
 * is peeled off. Undo therefore behaves like a stack, and the stack is the revision log, which is
 * what this ranks by. The order it replaces was the `advisor_actions` ids reversed, and that table
 * is scanned by primary key, so the "newest" it reversed was a uuid sort.
 *
 * Ordering alone is not sufficient, only cheaper: an action that wrote the same transaction twice
 * buries itself, and no ordering of one revert per action reaches its earlier write. That is what
 * the iteration in `revertBatch` is for.
 */
function actionIdsNewestWriteFirst(
  db: Database.Database,
  actionIds: readonly string[],
  revisionFloor: number
): string[] {
  if (actionIds.length === 0) return [];
  const placeholders = actionIds.map(() => '?').join(',');
  const ranked = db
    .prepare(`
      SELECT action_id AS id, MAX(rowid) AS newest
      FROM transaction_category_revisions
      WHERE rowid > ? AND revert_of IS NULL AND action_id IN (${placeholders})
      GROUP BY action_id
      ORDER BY newest DESC
    `)
    .all(revisionFloor, ...actionIds) as Array<{ id: string; newest: number }>;

  // An action that wrote no category during the batch has nothing to unbury, so where it goes cannot
  // change the outcome. It still goes somewhere fixed, so two identical batches stay identical.
  const wrote = new Set(ranked.map((row) => row.id));
  const silent = actionIds.filter((id) => !wrote.has(id));
  return [...ranked.map((row) => row.id), ...silent];
}

/**
 * Undo the whole batch, or none of it.
 *
 * THE UNDO ITERATES TO A FIXPOINT. One `revertAction` per id cannot satisfy the completeness check
 * below: an action that wrote the same transaction twice has only its newer revision revertable, so
 * a single pass leaves the earlier one standing and the whole batch rolls back for a reason nothing
 * about the batch made unavoidable. Each pass peels one layer off the log and exposes the layer
 * underneath, whatever order the layers were written in.
 *
 * THE ITERATION IS BOUNDED BY WHAT IT HAS TO CONSUME. A pass that does not reduce the standing count
 * has stopped making progress and exits, and no more passes are run than there are standing writes,
 * so a log the revert cannot converge on falls through to the completeness check instead of
 * spinning.
 *
 * The completeness check reads the same append-only log the revert walks: afterwards, no category
 * write the batch made may still be standing. If one is, the throw rolls the whole undo back and the
 * batch stays fully applied, which is a state that can at least be reasoned about.
 */
function revertBatch(
  db: Database.Database,
  actionIds: readonly string[],
  revisionFloor: number,
  now: string
): number {
  const undo = db.transaction(() => {
    const order = actionIdsNewestWriteFirst(db, actionIds, revisionFloor);
    let standing = standingWriteCount(db, revisionFloor);
    const maxPasses = standing;
    let rows = 0;

    for (let pass = 0; pass < maxPasses && standing > 0; pass += 1) {
      for (const actionId of order) rows += revertAction(db, actionId, now);
      const remaining = standingWriteCount(db, revisionFloor);
      if (remaining === standing) break;
      standing = remaining;
    }

    if (standing > 0) {
      throw new Error(`The revert left ${standing} of the batch's category writes standing, so it was rolled back and the batch is still fully applied.`);
    }
    return rows;
  });
  return undo();
}

/**
 * Run an autonomous category batch under the conservation guard.
 *
 * Refuses to start inside an open transaction: the incident row has to outlive a revert that rolls
 * back, and a caller's enclosing transaction would take it with it.
 */
export function runGuardedCategoryBatch<T>(
  db: Database.Database,
  batch: GuardedCategoryBatch<T>,
  options: GuardOptions = {}
): GuardedBatchReport<T> {
  if (db.inTransaction) {
    throw new Error('runGuardedCategoryBatch must not be called inside an open transaction: a rolled-back revert would take the incident row with it.');
  }

  const nowDate = options.now === undefined ? new Date() : parseISO(options.now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error(`Guard now must be an ISO timestamp, received "${options.now}".`);
  }
  const now = options.now ?? nowDate.toISOString();
  const month = options.month ?? format(nowDate, 'yyyy-MM');
  const window = monthWindow(month);
  // Pinned once, then handed to every capture in the pass. Resolved per capture, the forecast window
  // moves across local midnight on its own and reports an invariant breach nothing wrote.
  const capture: GuardOptions = {
    month,
    forecastAnchor: options.forecastAnchor ?? format(nowDate, 'yyyy-MM-dd'),
  };

  const before = captureHeadlines(db, capture);
  const beforeLedger = captureWindowLedger(db, window);
  const revisionFloor = maxRevisionRowid(db);
  const knownActions = new Set(advisorActionIds(db));

  const outcome = batch.run();

  const discovered = advisorActionIds(db).filter((id) => !knownActions.has(id));
  const actionIds = [...new Set([...(outcome.actionIds ?? []), ...discovered])];

  const after = captureHeadlines(db, capture);
  const afterLedger = captureWindowLedger(db, window);
  const ledgerDiff = diffWindowLedger(beforeLedger, afterLedger);
  const breaches = [
    ...ledgerDiff.breaches,
    ...diffHeadlines(before, after, { spend: ledgerDiff.explainedSpend, income: ledgerDiff.explainedIncome }),
  ];
  const moves = categoryMoves(before, after);
  const unrevertableRows = unrevertableRowCount(db, revisionFloor, actionIds);

  if (breaches.length === 0) {
    return {
      status: 'clean',
      value: outcome.value,
      action_ids: actionIds,
      breaches: [],
      incident_id: null,
      before,
      after,
      category_moves: moves,
      reverted_rows: 0,
      unrevertable_rows: unrevertableRows,
      headlines_restored: null,
    };
  }

  const incidentId = openIncident(db, {
    batchName: batch.name,
    detectedAt: now,
    before,
    after,
    breaches,
    actionIds,
    unrevertableRows,
  });

  const failed = (error: string): GuardedBatchReport<T> => {
    resolveIncident(db, incidentId, {
      status: 'failed',
      revertedActionIds: null,
      revertedRows: null,
      headlinesRestored: null,
      error,
      resolvedAt: new Date().toISOString(),
    });
    return {
      status: 'revert_failed',
      value: outcome.value,
      action_ids: actionIds,
      breaches,
      incident_id: incidentId,
      before,
      after,
      category_moves: moves,
      reverted_rows: 0,
      unrevertable_rows: unrevertableRows,
      headlines_restored: null,
    };
  };

  if (actionIds.length === 0) {
    // Reverting "by action id" needs an action id. Reporting this as a clean revert because zero
    // actions were undone successfully would be the emptiest kind of true.
    return failed('The batch created no advisor action, so there is nothing to revert by id and the breach stands.');
  }

  if (unrevertableRows > 0) {
    return failed(`${unrevertableRows} category write${unrevertableRows === 1 ? '' : 's'} carry no action id this harness can revert, so undoing the ${actionIds.length} action${actionIds.length === 1 ? '' : 's'} it can reach would leave the batch half applied. Nothing was reverted.`);
  }

  let revertedRows: number;
  try {
    revertedRows = revertBatch(db, actionIds, revisionFloor, now);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  const restored = headlinesMatch(captureHeadlines(db, capture), before);
  resolveIncident(db, incidentId, {
    status: 'reverted',
    revertedActionIds: actionIds,
    revertedRows,
    headlinesRestored: restored,
    error: restored
      ? null
      : 'Every category write was taken back and the headline set is still moved, so the batch changed something outside the category domain that no category revert can reach.',
    resolvedAt: new Date().toISOString(),
  });

  return {
    status: 'reverted',
    value: outcome.value,
    action_ids: actionIds,
    breaches,
    incident_id: incidentId,
    before,
    after,
    category_moves: moves,
    reverted_rows: revertedRows,
    unrevertable_rows: unrevertableRows,
    headlines_restored: restored,
  };
}

export interface AiIncidentRow {
  id: string;
  batch_name: string;
  detected_at: string;
  month: string;
  start_date: string;
  end_date: string;
  breaches: string;
  before_headlines: string;
  after_headlines: string;
  action_ids: string;
  revert_status: 'pending' | 'reverted' | 'failed';
  reverted_action_ids: string | null;
  reverted_rows: number | null;
  unrevertable_rows: number;
  headlines_restored: number | null;
  revert_error: string | null;
  resolved_at: string | null;
}

export function listAiIncidents(db: Database.Database, limit = 50): AiIncidentRow[] {
  return db
    .prepare('SELECT * FROM ai_incidents ORDER BY detected_at DESC, rowid DESC LIMIT ?')
    .all(limit) as AiIncidentRow[];
}
