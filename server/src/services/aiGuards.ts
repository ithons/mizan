import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { addDays, endOfMonth, format, parseISO, startOfMonth } from 'date-fns';
import type { SpendingReport } from '../../../shared/types';
import { revertAction } from './categoryWrites';
import { readLatestSnapshot } from './netWorthHistory';
import { buildRecurringForecast } from './recurringForecast';
import { getIncomeReport, getReportSummary, getSpendingReport } from './reporting';
import { unretireMerchantRule } from './rules';
import { transactionReportInclusion } from './schemaDoc';

/**
 * The harness that makes widening the AI's write authority safe.
 *
 * It snapshots the headline set, runs an autonomous batch, re-runs the set, and reverts the whole
 * batch if the movement is not one the window's own rows can produce.
 *
 * "THE WHOLE BATCH" MEANS EVERY TABLE THE BATCH WROTE, NOT THE ONE THIS FILE FINDS EASIEST TO WALK.
 * The undo used to be `revertAction` per id, which is `transaction_category_revisions` and nothing
 * else, and its completeness check read the same single table. A batch of one categorization plus
 * one retirement of an inert AI rule therefore reverted the categorization, left `retired_at` set,
 * and reported itself 'reverted' with the rule still gone. `merchant_rule_revisions` is the batch's
 * other write log and it is walked here too, so the completeness check sees everything the batch
 * wrote and the word "whole" is one the code establishes.
 *
 * WHY "A FIGURE MOVED" IS THE WRONG BREACH CONDITION. A categorization change is SUPPOSED to move
 * per-category totals. That is its entire purpose. A guard keyed on movement fires on every healthy
 * pass, and a guard that fires on healthy passes gets switched off.
 *
 * THE PROPERTY THAT IS ACTUALLY TRUE. Reclassifying is a reshuffle, not a change in magnitude. A
 * batch that refiles rows cannot change how much money moved; it can only change which line the
 * money is filed under, and by exactly the amounts those rows already carried.
 *
 * THE HONEST RULE, because the naive version of even that is wrong. Some category roots (cat_xfer,
 * cat_inv, cat_crypto) are outside report scope, and `is_income` / `is_investment` decide which side
 * of the ledger a row lands on. So filing a row INTO a transfer category, or across the income
 * boundary, legitimately changes the month's totals, and that is exactly the write most worth
 * watching. What makes it a breach is the total moving by an amount the window's own rows cannot
 * account for. EVERY row in the window is asked, not only the ones whose category id moved: its
 * contribution is recomputed from its BEFORE amount and its before/after classification, so a batch
 * that quietly changed an amount as well as a category produces an expectation that does not match
 * the observed movement, while a pass whose integrity refresh un-paired a transfer reconciles by the
 * row it let back in.
 *
 * EVERY FIGURE COMES FROM THE SERVICE THAT OWNS IT. reporting.ts for spend, income and the savings
 * rate, netWorthHistory.ts for net worth, recurringForecast.ts for the scheduled net, and
 * schemaDoc.transactionReportInclusion for per-row classification, which evaluates the same
 * predicate strings the Reports page uses. There is no SQL in this file that sums money. That is not
 * style: advisorChatTools ran its own aggregates and drifted until the advisor reported $1,695.00 of
 * spending where Reports reported $75.00 on the same data.
 *
 * SCOPE. This guards a batch whose effect on the month is a RECLASSIFICATION of rows that already
 * exist: their category, or which side of the report they land on, or whether they count at all.
 * That covers the autonomous kinds (categorize_transaction, create_merchant_rule,
 * retire_merchant_rule) and it covers the integrity refresh a categorization pass runs as a side
 * effect. It does NOT decide which kinds may apply unattended; `DRAFT_KIND_AUTONOMY` does, and
 * `evaluateAiJobInvariants` enforces it. A batch that inserts a row, deletes one, moves a date or
 * changes an amount is outside the scope and is reported structurally, because no reclassification
 * can produce any of those.
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
 *  - `accounted`: it may move, by exactly what the window's own rows explain and no more.
 *  - `derived`: it is a function of accounted headlines, so it may move only when they did.
 *  - `evidence`: it moves on every healthy pass. Recorded so an incident says what shifted, never
 *    a breach condition.
 *
 * WHAT `accounted` MEASURES AGAINST. `diffWindowLedger` recomputes each window row's contribution
 * from the amount it held BEFORE the batch and its before/after report classification, whether or
 * not its category id moved. A category rewrite is one way to move that classification and it is no
 * longer the only one this check tolerates: a transfer pairing broken as a side effect of an
 * ordinary categorization pass moves a row across the counted boundary with no category rewrite
 * anywhere, and it reconciles here to the cent. The expectation and the headline are computed by two
 * different services over the same rows, so they agree by arithmetic while those services agree with
 * each other. The check fires when they stop, which is the drift this codebase has already paid for
 * once, when advisorChatTools' own aggregates reported $1,695.00 of spending against Reports'
 * $75.00 on the same data. Everything a batch can do that no reclassification can produce is caught
 * upstream of it, as a `ledger_shape` breach, and quantified by this one.
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
  /**
   * What the window's own rows account for, each recomputed from the amount it held before the
   * batch. Null where nothing may explain movement.
   */
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
  /**
   * Merchant rules the revert un-retired. 0 unless `status` is 'reverted'. Counted apart from
   * `reverted_rows` because it is not a row of the owner's ledger, and reported at all because a
   * batch reported "reverted whole" while a rule stayed retired is the defect this exists to stop.
   */
  reverted_rules: number;
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
  /**
   * The row's OWN inputs to whether the reports count it: `pending`, `transfer_status`,
   * `duplicate_status`. Held as one comparable string because only equality is ever asked.
   *
   * These are what separate "this row changed" from "the category changed under this row". Both
   * leave `category_id` alone and both move the month's totals; only the second is a breach.
   */
  flags: string;
}

/**
 * Every row dated inside the window, with the classification the Reports page gives it.
 *
 * Rows outside the window are not captured because they cannot move a headline that reads only this
 * window: a rewrite in March contributes nothing to July's spend either side of the batch.
 */
function captureWindowLedger(db: Database.Database, window: DateWindow): Map<string, LedgerRow> {
  const rows = db
    .prepare(`
      SELECT id, amount, category_id,
             COALESCE(pending, 0) AS pending,
             COALESCE(transfer_status, 'none') AS transfer_status,
             COALESCE(duplicate_status, 'none') AS duplicate_status
      FROM transactions WHERE date BETWEEN ? AND ?
    `)
    .all(window.startDate, window.endDate) as Array<{
      id: string;
      amount: number;
      category_id: string | null;
      pending: number;
      transfer_status: string;
      duplicate_status: string;
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
      flags: `${row.pending}|${row.transfer_status}|${row.duplicate_status}`,
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
 * What the batch explains, row by row, and anything it did that no reclassification can explain.
 *
 * A ROW'S CONTRIBUTION IS RECOMPUTED FROM ITS OWN BEFORE-AMOUNT AND ITS BEFORE/AFTER REPORT
 * CLASSIFICATION, whether or not its category moved. That last clause used to be the opposite: a row
 * whose category was unchanged and whose classification was not was reported as a structural breach,
 * on the reasoning that only a transfer confirmation or a duplicate resolution could do that and
 * neither belongs in an autonomous batch.
 *
 * THAT REASONING WAS WRONG ONCE THE HARNESS HAD A CALLER, and the case that proves it is ordinary.
 * `confirmCategorizeTransaction` re-runs `refreshTransactionIntegrity`, so a categorization pass
 * legitimately pairs and un-pairs transfers as a side effect, and a candidate leg is excluded from
 * every total by `excludedFromTotalsSql`. The owner hand-categorizing one leg of a detected pair is
 * enough: the pair breaks on the next pass, the surviving leg re-enters the month's totals, its
 * category never moved, and the old rule called that a structural breach and auto-reverted a pass
 * that had done nothing wrong. Reverted the good work, too, and could not take back the un-pairing.
 *
 * WHAT REPLACED IT IS NARROWER AND STILL CATCHES THE CASE THAT MATTERED. A classification that
 * changes while NEITHER the category id NOR the row's own pending/transfer/duplicate state moved
 * leaves exactly one culprit: the category was redefined underneath the row, by a merge, a delete or
 * a re-parent into the trees the reports drop wholesale. That is inside the owner's carve-out, it
 * empties a month of spending with no row rewritten, and it is still structural.
 *
 * WHAT IS STILL CAUGHT BESIDES: a row that entered or left the window, or whose amount changed. And
 * the month's totals must still move by exactly the sum of the per-row contributions, which the two
 * sides compute through different services over the same rows; they agree by arithmetic only while
 * those services agree with each other, and the check fires when they stop.
 *
 * WHAT IS NO LONGER CAUGHT HERE: a batch that resolves a duplicate or confirms a transfer now
 * reconciles instead of breaching, because it moves the totals by exactly the row it excluded. That
 * is not this file's question any more. `evaluateAiJobInvariants`' `autonomy_boundary` is what says
 * which kinds may apply unattended, and both of those are proposal-only in `DRAFT_KIND_AUTONOMY`.
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
    const categoryChanged = now.categoryId !== was.categoryId;
    const rowChanged = now.flags !== was.flags;
    const classificationChanged = now.counts !== was.counts || now.side !== was.side;

    // THE ROW DID NOT MOVE AND NEITHER DID ITS CATEGORY ID, AND THE REPORTS COUNT IT DIFFERENTLY.
    // The only thing left that can do that is the CATEGORY's own definition changing underneath it:
    // `is_income`, `is_investment`, or its parent chain moving into or out of the cat_xfer / cat_inv
    // / cat_crypto trees the reports drop wholesale. Every one of those is a category merge, delete
    // or re-parent, which is inside the owner's proposal-only carve-out. It empties a month of
    // spending with no row rewritten and no per-row check anywhere else would see it.
    if (!categoryChanged && !rowChanged && classificationChanged) {
      breaches.push(structuralBreach(`Transaction ${id} changed how the reports count it while neither its category id nor its own pending/transfer/duplicate state moved, so the category "${String(was.categoryId)}" was redefined under it.`));
      continue;
    }

    if (categoryChanged) rewrittenRows += 1;
    // Both sides read `was.amount`, so a row that changed nothing contributes exactly 0 and cannot
    // inflate the expectation.
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
    detail: `Moved ${moved} cents; the window's own rows account for ${explained}. The unexplained ${moved - explained} cents did not come from a row this window holds.`,
  };
}

/**
 * Compare two headline sets under the movement policy.
 *
 * Exported so a caller can judge a batch it ran itself. `explained.spend` / `explained.income` are
 * the cents the window's own rows account for, which `diffWindowLedger` derives.
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

function maxRuleRevisionRowid(db: Database.Database): number {
  // merchant_rule_revisions is append-only for the same reason its category counterpart is: every
  // create, recategorize, rename, retire and unretire adds a row and none is ever updated. So a
  // rowid above this floor is a rule change the batch made.
  const row = db
    .prepare('SELECT COALESCE(MAX(rowid), 0) AS floor FROM merchant_rule_revisions')
    .get() as { floor: number };
  return row.floor;
}

/**
 * Rules the batch retired that are still retired.
 *
 * The state of the rule is what is asked, not the shape of the log: an un-retire appends its own
 * revision and clears `retired_at`, so a restored rule drops out of this count without the query
 * having to reason about which revision is newest.
 */
function standingRetirementCount(db: Database.Database, ruleRevisionFloor: number): number {
  const row = db
    .prepare(`
      SELECT COUNT(DISTINCT v.rule_id) AS count
      FROM merchant_rule_revisions v
      JOIN merchant_rules m ON m.id = v.rule_id
      WHERE v.rowid > ? AND v.operation = 'retire' AND m.retired_at IS NOT NULL
    `)
    .get(ruleRevisionFloor) as { count: number };
  return row.count;
}

interface RetirementRestore {
  restored: number;
  /** Why a rule could not be put back. Named, never absorbed into a count that reads as success. */
  failures: string[];
}

/**
 * Put back every rule the batch retired.
 *
 * Keyed on the revision floor rather than on the batch's action ids, deliberately. A retirement is
 * undone by clearing `retired_at`, which needs no action id to attribute, so scoping this by id
 * would strand exactly the retirement whose action the harness failed to discover. The floor is the
 * batch, and `standingRetirementCount` afterwards is what decides whether the undo was complete.
 *
 * The one refusal that can survive a healthy batch is `pattern_taken`: a replacement rule now holds
 * the pattern, and reviving the old one would be a second, unasked change to whichever rule the
 * owner has now. That is reported and left standing, which fails the completeness check and rolls
 * the whole undo back, rather than being quietly counted as done.
 */
function restoreRuleRetirements(
  db: Database.Database,
  ruleRevisionFloor: number,
  now: string
): RetirementRestore {
  const retirements = db
    .prepare(`
      SELECT DISTINCT v.rule_id AS rule_id, v.pattern AS pattern
      FROM merchant_rule_revisions v
      JOIN merchant_rules m ON m.id = v.rule_id
      WHERE v.rowid > ? AND v.operation = 'retire' AND m.retired_at IS NOT NULL
      ORDER BY v.rule_id
    `)
    .all(ruleRevisionFloor) as Array<{ rule_id: string; pattern: string }>;

  const outcome: RetirementRestore = { restored: 0, failures: [] };
  for (const retirement of retirements) {
    const result = unretireMerchantRule(db, retirement.rule_id, { source: 'ai', actionId: null, now });
    if (result.ok) {
      outcome.restored += 1;
      continue;
    }
    if (result.reason === 'pattern_taken') {
      outcome.failures.push(`"${retirement.pattern}" could not be un-retired: another live rule now holds that pattern.`);
    } else if (result.reason === 'not_found') {
      outcome.failures.push(`"${retirement.pattern}" could not be un-retired: the rule row is gone.`);
    }
    // 'not_retired' cannot reach here: the query only returns rules that are still retired.
  }
  return outcome;
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

interface BatchRevert {
  rows: number;
  rules: number;
}

/** "2 category writes", "1 merchant rule retirement", or both, for one sentence about a batch. */
function describeStanding(categoryWrites: number, retirements: number): string {
  const parts: string[] = [];
  if (categoryWrites > 0) {
    parts.push(`${categoryWrites} category write${categoryWrites === 1 ? '' : 's'}`);
  }
  if (retirements > 0) {
    parts.push(`${retirements} merchant rule retirement${retirements === 1 ? '' : 's'}`);
  }
  return parts.join(' and ');
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
 * RULE RETIREMENTS ARE THE BATCH'S OTHER WRITE, and they are undone here rather than left to a
 * caller. `revertAction` walks `transaction_category_revisions` only, so a batch of one
 * categorization and one retirement used to come back 'reverted' with the rule still retired and a
 * completeness check that could not see it. Both logs are consumed, and both are counted.
 *
 * The completeness check reads the same append-only logs the revert walks: afterwards, no category
 * write and no retirement the batch made may still be standing. If one is, the throw rolls the whole
 * undo back and the batch stays fully applied, which is a state that can at least be reasoned about.
 */
function revertBatch(
  db: Database.Database,
  actionIds: readonly string[],
  revisionFloor: number,
  ruleRevisionFloor: number,
  now: string
): BatchRevert {
  const undo = db.transaction((): BatchRevert => {
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

    const retirements = restoreRuleRetirements(db, ruleRevisionFloor, now);
    const standingRules = standingRetirementCount(db, ruleRevisionFloor);

    if (standing > 0 || standingRules > 0) {
      const why = retirements.failures.length > 0 ? ` ${retirements.failures.join(' ')}` : '';
      throw new Error(`The revert left the batch with ${describeStanding(standing, standingRules)} still standing, so it was rolled back and the batch is still fully applied.${why}`);
    }
    return { rows, rules: retirements.restored };
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
  const ruleRevisionFloor = maxRuleRevisionRowid(db);
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
  const standingRetirements = standingRetirementCount(db, ruleRevisionFloor);

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
      reverted_rules: 0,
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
      reverted_rules: 0,
      unrevertable_rows: unrevertableRows,
      headlines_restored: null,
    };
  };

  // What a refusal leaves behind, so the incident names it rather than describing only the half the
  // refusal was about.
  const alsoStanding = standingRetirements > 0
    ? ` ${standingRetirements} merchant rule retirement${standingRetirements === 1 ? '' : 's'} the batch made ${standingRetirements === 1 ? 'is' : 'are'} also left standing.`
    : '';

  if (actionIds.length === 0) {
    // Reverting "by action id" needs an action id. Reporting this as a clean revert because zero
    // actions were undone successfully would be the emptiest kind of true.
    return failed(`The batch created no advisor action, so there is nothing to revert by id and the breach stands.${alsoStanding}`);
  }

  if (unrevertableRows > 0) {
    return failed(`${unrevertableRows} category write${unrevertableRows === 1 ? '' : 's'} carry no action id this harness can revert, so undoing the ${actionIds.length} action${actionIds.length === 1 ? '' : 's'} it can reach would leave the batch half applied. Nothing was reverted.${alsoStanding}`);
  }

  let reverted: BatchRevert;
  try {
    reverted = revertBatch(db, actionIds, revisionFloor, ruleRevisionFloor, now);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  const restored = headlinesMatch(captureHeadlines(db, capture), before);
  // `reverted_rows` is category writes and only category writes, which is what migration 050's
  // column says it is. `ai_incidents` has no column for rules, so the retirement count travels on
  // the report and reaches the record through `ai_runs.invariant_breach`, which aiJobs writes.
  resolveIncident(db, incidentId, {
    status: 'reverted',
    revertedActionIds: actionIds,
    revertedRows: reverted.rows,
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
    reverted_rows: reverted.rows,
    reverted_rules: reverted.rules,
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
