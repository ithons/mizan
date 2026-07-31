import type Database from 'better-sqlite3';
import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns';
import type {
  AdvisorAction,
  AdvisorContextResponse,
  RecurringForecast,
  ReportSummary,
  SpendingReport,
  SyncHealth,
  TransactionReviewSummary,
} from '../../../shared/types';
import { getDb } from '../db/index';
import { toDollars, toDollarsOrNull } from './money';
import { excludedFromTotalsSql, expenseSideSql } from './transactionFilters';
import { calculateGoalProgress } from './goalProgress';
import { buildRecurringForecast } from './recurringForecast';
import { getCashflowReport, getReportSummary, getSpendingReport } from './reporting';
import { getTransactionReviewSummary } from './transactionReview';
import { getSyncHealth } from './syncHealth';
import { buildAdvisorReadTools } from './advisorTools';
import { getPreference } from './preferences';
import { estimateNote, readSnapshotBefore, readSnapshots } from './netWorthHistory';
import { reconcileAccounts } from './reconciliation';
import { MAX_PAIR_DAY_GAP, findFlowConservationViolations } from './flowConservation';

export const ADVISOR_PROFILE_PREFERENCE_KEY = 'advisor_user_profile';

export const ADVISOR_SYSTEM_PROMPT = `You are a sharp, honest personal financial advisor with access to the user's complete financial picture. Their real balances, transactions, portfolio, goals, recurring bills, and cash-flow forecast are provided below.

Give specific, actionable advice using their actual numbers. Be direct - if something looks concerning (overspending, under-diversification, thin emergency fund, too much in a single position), say so clearly. If something looks healthy, say that too.

For investments: discuss asset allocation, concentration risk, tax-advantaged account usage, and whether holdings match a reasonable time horizon. Ask if you need to know their tax bracket or risk tolerance before giving tax/risk advice.

For cash flow: use the recurring forecast and goal progress when available. If data is stale, missing, or only estimated from detected patterns, say that plainly.

Keep responses concise unless depth is clearly warranted. Use dollar amounts and percentages from their data. Never fabricate numbers.`;

// fmt() takes dollars. EVERY money value in this file is integer cents: both inline-SQL
// reads AND values returned from service functions (reporting, forecast, goal progress),
// so every argument to fmt() must be wrapped in toDollars() at its call site.
//
// Renders to the cent, always. This string is a model's entire view of the numbers, and it
// used to abbreviate anything over $1,000 ($2,749.39 became "$2.7k") while the system prompt
// instructed the model to never fabricate figures. It complied and reported "$2.7k": it had
// never been given the real number. Compactness is worth nothing here; there is no reader
// whose eyes need saving.
export function formatMoney(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

const fmt = formatMoney;

function pct(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** Thousands separators on counts, for the same reason fmt() renders money in full. */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${num(n)} ${n === 1 ? singular : many}`;
}

interface GoalContextRow {
  name: string;
  type: 'savings' | 'debt';
  target_amount: number;
  current_amount: number;
  starting_amount: number | null;
  target_date: string | null;
  account_name: string | null;
  institution_name: string | null;
  account_balance: number | null;
}

interface AdvisorActionInputs {
  syncHealth: SyncHealth;
  reportSummary: ReportSummary;
  reviewSummary: TransactionReviewSummary;
  forecast: RecurringForecast;
}

function action(
  id: string,
  label: string,
  route: string,
  prompt: string,
  reason: string,
  severity: AdvisorAction['severity']
): AdvisorAction {
  return { id, label, route, prompt, reason, severity };
}

export function buildAdvisorActions({
  syncHealth,
  reportSummary,
  reviewSummary,
  forecast,
}: AdvisorActionInputs): AdvisorAction[] {
  const actions: AdvisorAction[] = [];

  if (syncHealth.status === 'attention' || syncHealth.status === 'stale') {
    actions.push(action(
      'fix-sync',
      'Fix sync health',
      '/accounts',
      'Which data is least trustworthy until sync health is fixed, and what should I do first?',
      syncHealth.status_detail,
      syncHealth.status === 'attention' ? 'critical' : 'warning'
    ));
  } else if (syncHealth.status === 'empty') {
    actions.push(action(
      'connect-accounts',
      'Connect accounts',
      '/accounts',
      'What accounts should I connect first to get a complete financial picture?',
      syncHealth.status_detail,
      'warning'
    ));
  }

  const uncategorized = reviewSummary.queues.find((queue) => queue.id === 'uncategorized')?.count ?? 0;
  const ruleSuggestions = reviewSummary.queues.find((queue) => queue.id === 'rule_suggestions')?.count ?? 0;
  if (uncategorized > 0 || ruleSuggestions > 0) {
    actions.push(action(
      'review-transactions',
      'Review transactions',
      '/review',
      'Help me prioritize my transaction review queue and explain what reports these issues affect.',
      `${uncategorized} uncategorized transactions and ${ruleSuggestions} rule suggestions are open.`,
      uncategorized > 10 ? 'warning' : 'info'
    ));
  }

  if (forecast.review_count > 0) {
    actions.push(action(
      'review-cash-flow',
      'Review cash flow',
      '/bills',
      'Explain my recurring cash flow items that need review and how they affect the next 60 days.',
      `${forecast.review_count} recurring items need review, including ${forecast.overdue_count} overdue.`,
      forecast.overdue_count > 0 ? 'warning' : 'info'
    ));
  }

  if (reportSummary.expenses.delta > 0) {
    actions.push(action(
      'explain-spending-change',
      'Explain spending change',
      '/reports',
      'What drove the increase in my spending this period, and which categories should I inspect first?',
      `Spending is up ${fmt(toDollars(reportSummary.expenses.delta))} versus the prior comparable period.`,
      reportSummary.expenses.delta_percent !== null && reportSummary.expenses.delta_percent > 20 ? 'warning' : 'info'
    ));
  }

  if (reportSummary.savings_rate.current !== null && reportSummary.savings_rate.current < 10 && reportSummary.income.current > 0) {
    actions.push(action(
      'improve-savings-rate',
      'Improve savings rate',
      '/reports',
      'What practical changes would improve my savings rate based on this period?',
      `Savings rate is ${reportSummary.savings_rate.current!.toFixed(1)}% for the selected period.`,
      'warning'
    ));
  }

  if (actions.length === 0) {
    actions.push(action(
      'financial-health-review',
      'Review financial health',
      '/reports',
      'Give me a concise overview of my financial health and what I should watch next.',
      'No urgent workflow issues are open.',
      'positive'
    ));
  }

  return actions.slice(0, 6);
}

export function buildAdvisorContextSnapshot(): Omit<AdvisorContextResponse, 'configured'> {
  const db = getDb();
  const today = new Date();
  const thisMonthStart = format(startOfMonth(today), 'yyyy-MM-dd');
  const todayDate = format(today, 'yyyy-MM-dd');
  const syncHealth = getSyncHealth(db);
  const reportSummary = getReportSummary(db, { startDate: thisMonthStart, endDate: todayDate });
  const reviewSummary = getTransactionReviewSummary(db);
  const forecast = buildRecurringForecast(db, 60);
  const actions = buildAdvisorActions({
    syncHealth,
    reportSummary,
    reviewSummary,
    forecast,
  });
  const context = buildFinancialContext();
  const actionLines = actions.map((item) =>
    `  ${item.id}: ${item.label} -> ${item.route}. Reason: ${item.reason}. Suggested prompt: "${item.prompt}"`
  );

  return {
    context: `${context}\n\n### Advisor Workflow Actions\n${actionLines.join('\n')}`,
    generated_at: new Date().toISOString(),
    sync_health: syncHealth,
    actions,
    tools: buildAdvisorReadTools(db, today),
  };
}

interface VisibleAccountRow {
  id: string;
  account_name: string | null;
  type: string;
}

/**
 * A signed cent movement rendered in the direction it went.
 *
 * So no reader has to hold a sign convention in their head to know which way the money moved.
 */
function movementOf(cents: number): string {
  if (cents === 0) return 'no movement';
  return `${cents > 0 ? 'a rise' : 'a fall'} of ${fmt(toDollars(Math.abs(cents)))}`;
}

/**
 * Does the ledger explain the balances the rest of this document reports?
 *
 * Placed immediately after Data Freshness and before any money, because it qualifies every figure
 * below it. The model was previously handed balances with no way to know that three of them are
 * not reproducible from the transactions it can see.
 *
 * Every branch here reports only what was checked, and the scope of the verdict is stated with it.
 * `reconcileAccounts` skips any account that is not present at both ends of some consecutive pair of
 * measured balance sheets, so a card connected after the last snapshot is never judged at all. An
 * unqualified clean bill covered that card, and connecting an account is the most ordinary event
 * this app has. Judged, exempt, and never-reached are three different states and each is named.
 */
function pushLedgerIntegrity(db: Database.Database, lines: string[]): void {
  const report = reconcileAccounts(db);
  const flow = findFlowConservationViolations(db);

  lines.push('');
  lines.push('### Ledger Integrity');

  if (report.measured_snapshot_count < 2) {
    lines.push(
      `  Reconciliation compares measured balance sheets against the transactions between them, and needs two to run. The ledger holds ${plural(report.measured_snapshot_count, 'measured balance sheet')}, so the check has not run. That is an absence of evidence, not evidence that the ledger is complete.`
    );
  } else {
    const oldest = readSnapshots(db, { measuredOnly: true, order: 'asc', limit: 1 })[0];
    const newest = readSnapshots(db, { measuredOnly: true, order: 'desc', limit: 1 })[0];
    const horizon = oldest && newest ? ` (${oldest.date} to ${newest.date})` : '';
    lines.push(
      `  Reconciliation checks each account's ${plural(report.measured_snapshot_count, 'measured balance sheet')}${horizon} against the transactions between them.`
    );

    // Same population reconcileAccounts draws from, so an account missing from its results was
    // skipped by it rather than filtered out here.
    const visible = db.prepare(
      'SELECT id, account_name, type FROM accounts WHERE is_hidden = 0 ORDER BY account_name'
    ).all() as VisibleAccountRow[];
    const typeById = new Map(visible.map((account) => [account.id, account.type]));
    const reached = new Set(report.accounts.map((account) => account.account_id));
    const unreached = visible.filter((account) => !reached.has(account.id));
    const exempt = report.accounts.filter((account) => account.is_market_driven);
    const judgedCount = report.accounts.length - exempt.length;
    const named = (id: string, name: string | null): string =>
      `${name ?? id} (${typeById.get(id) ?? 'unknown type'})`;

    if (judgedCount === 0) {
      lines.push(
        '  No account was judged for an unexplained residual: every account the check reached is market-driven and exempt, so nothing below says whether the ledger explains any balance.'
      );
    } else if (report.unreconciled.length === 0) {
      lines.push(
        `  None of the ${plural(judgedCount, 'account')} this check judged carries an unexplained residual beyond tolerance.`
      );
    } else {
      const subject = report.unreconciled.length === 1
        ? '1 account carries'
        : `${num(report.unreconciled.length)} accounts carry`;
      lines.push(
        `  ${subject} a balance the ledger does not fully explain, of the ${plural(judgedCount, 'account')} judged. Treat them as uncertain by at least the amount named. Each line reports the movement in that account's own terms: the amount owed for a liability, the balance for everything else.`
      );
      for (const account of report.unreconciled) {
        // Rendered in the account's OWN convention, not the net-worth convention adjusted_residual
        // carries. The two are opposite on a liability, and a single sentence about what a negative
        // residual meant was backwards on Discover and Chase Freedom Flex, whose amount owed FELL
        // across the live horizon while their adjusted_residual is negative.
        const owedSide = account.is_liability;
        const adjustedExplained = account.observed_delta - account.adjusted_residual;
        const observed = owedSide ? -account.observed_delta : account.observed_delta;
        const explained = owedSide ? -adjustedExplained : adjustedExplained;
        const noun = owedSide ? 'the amount owed' : 'the balance';
        const conflict = account.direction_conflict
          ? ', and the transactions point the opposite way from the balance movement'
          : '';
        lines.push(
          `    ${account.account_name ?? account.account_id}: ${noun} shows ${movementOf(observed)} where the transactions account for ${movementOf(explained)}, leaving ${fmt(toDollars(Math.abs(account.adjusted_residual)))} unexplained between ${account.first_date} and ${account.last_date}${conflict}`
        );
      }
    }

    if (exempt.length > 0) {
      lines.push(
        `  Exempt and not judged, because their value moves with prices rather than with their transactions, so a residual there is a price move and not a gap: ${exempt.map((account) => named(account.account_id, account.account_name)).join(', ')}.`
      );
    }
    if (unreached.length > 0) {
      lines.push(
        `  Not judged at all, because ${unreached.length === 1 ? 'it is' : 'they are'} absent from at least one end of every consecutive pair of measured balance sheets, which is what a newly connected account looks like: ${unreached.map((account) => named(account.id, account.account_name)).join(', ')}. Nothing here says whether the ledger explains ${unreached.length === 1 ? 'that balance' : 'those balances'}.`
      );
    }

    const unreconciledIds = new Set(report.unreconciled.map((account) => account.account_id));
    const conflictsOnly = report.accounts.filter(
      (account) => account.direction_conflict && !unreconciledIds.has(account.account_id)
    );
    for (const account of conflictsOnly) {
      lines.push(
        `    ${account.account_name ?? account.account_id}: the transactions point the opposite way from the balance movement between ${account.first_date} and ${account.last_date}.`
      );
    }
  }

  if (flow.length > 0) {
    // Reports what findFlowConservationViolations established and stops there. It checks that both
    // legs are transfer-class, both outbound, both unpaired, and that the pair repeats; it does not
    // and cannot establish WHICH row is wrong or why, and the copy used to assert a wrong sign.
    lines.push(
      `  Equal amounts left two accounts within ${MAX_PAIR_DAY_GAP} days of each other, repeatedly between the same pair. Both legs are categorized as transfers, both are outbound, and neither has an equal and opposite row anywhere in the ledger. That is a statement about the stored rows and not a diagnosis: it does not say which row is wrong.`
    );
    for (const finding of flow) {
      lines.push(
        `    ${finding.account_a_name ?? finding.account_a_id} and ${finding.account_b_name ?? finding.account_b_id}: ${plural(finding.leg_count, 'leg')}, ${finding.first_date} to ${finding.last_date}, at least ${fmt(toDollars(finding.movement_cents))} of movement`
      );
    }
  }
}

interface AccountReach {
  account_id: string;
  account_name: string | null;
  type: string;
  transaction_count: number;
  first_date: string | null;
  last_date: string | null;
}

interface LedgerSpan {
  transaction_count: number;
  first_date: string | null;
  last_date: string | null;
  month_count: number;
}

function readAccountReach(db: Database.Database): AccountReach[] {
  return db.prepare(`
    SELECT
      a.id AS account_id,
      a.account_name,
      a.type,
      COUNT(t.id) AS transaction_count,
      MIN(t.date) AS first_date,
      MAX(t.date) AS last_date
    FROM accounts a
    LEFT JOIN transactions t ON t.account_id = a.id AND t.pending = 0
    WHERE a.is_hidden = 0
    GROUP BY a.id
    ORDER BY MIN(t.date) IS NULL, MIN(t.date) ASC
  `).all() as AccountReach[];
}

function readLedgerSpan(db: Database.Database): LedgerSpan {
  return db.prepare(`
    SELECT
      COUNT(*) AS transaction_count,
      MIN(date) AS first_date,
      MAX(date) AS last_date,
      COUNT(DISTINCT substr(date, 1, 7)) AS month_count
    FROM transactions
    WHERE pending = 0
  `).get() as LedgerSpan;
}

/**
 * How far back each account's ledger actually goes.
 *
 * The reason the monthly series below is not a household history for its early months: BofA Cash
 * Rewards reaches 2023-09-16 and nothing else reaches before 2025. Without this, a model asked
 * about 2024 reads one credit card as the whole balance sheet.
 */
function pushLedgerReach(lines: string[], reach: AccountReach[], span: LedgerSpan): void {
  if (span.transaction_count === 0) return;

  lines.push('');
  lines.push('### Ledger Reach');
  lines.push(
    `  ${plural(span.transaction_count, 'settled transaction')} from ${span.first_date} to ${span.last_date}, across ${plural(span.month_count, 'calendar month')}.`
  );
  lines.push(
    '  Accounts entered this ledger on different dates. History before an account\'s first row does not include that account, so an early month is a complete record of the accounts that reach it and not of the household.'
  );
  for (const account of reach) {
    const name = `${account.account_name ?? account.account_id} (${account.type})`;
    lines.push(
      account.transaction_count === 0
        ? `  ${name}: no transactions`
        : `  ${name}: ${plural(account.transaction_count, 'row')}, ${account.first_date} to ${account.last_date}`
    );
  }
}

/**
 * Every month the ledger holds, not a three-month average of it.
 *
 * Uses getCashflowReport so the series and the average above cannot drift apart: one definition of
 * income and spend, applied to two windows. The coverage clause is printed only on months where
 * coverage is genuinely partial, so an ordinary fully-covered month carries no annotation at all.
 */
function pushMonthlyHistory(
  db: Database.Database,
  lines: string[],
  reach: AccountReach[],
  span: LedgerSpan,
  currentMonth: string
): void {
  if (!span.first_date || !span.last_date) return;

  const report = getCashflowReport(db, { startDate: span.first_date, endDate: span.last_date });
  if (report.months.length === 0) return;

  const withLedger = reach.filter((account) => account.first_date !== null);
  const monthLines = report.months.map((month) => {
    // A month ends before the 32nd of itself, so a plain string compare answers "does this
    // account's ledger reach this month" without constructing a calendar date per row.
    const covering = withLedger.filter(
      (account) => account.first_date !== null && account.first_date <= `${month.month}-32`
    ).length;
    const coverage = covering < withLedger.length ? ` [reach ${covering}/${withLedger.length}]` : '';
    const partial = month.month === currentMonth ? ' (this month is still in progress)' : '';
    return `  ${month.month}: income ${fmt(toDollars(month.income))}, spending ${fmt(toDollars(month.expenses))}, net ${fmt(toDollars(month.net))}${coverage}${partial}`;
  });

  lines.push('');
  lines.push(`### Monthly History - every month with activity (${num(report.months.length)} of ${num(span.month_count)})`);
  lines.push(
    '  Sums of the rows the ledger holds, on the same income and spending definition as the report sections above. These are measurements, not estimates.'
  );
  // The notation is explained only if it is used, so a ledger whose accounts all start together
  // gets a plain series with nothing to decode.
  if (monthLines.some((line) => line.includes('[reach '))) {
    lines.push(
      `  A trailing [reach N/${withLedger.length}] marks a month that only N of the ${withLedger.length} accounts holding any transactions extend back to. A month with no such mark is covered by all of them.`
    );
  }
  lines.push(...monthLines);
}

function pushSpendingTree(
  lines: string[],
  nodes: SpendingReport['categories'],
  depth: number
): void {
  const indent = '  '.repeat(depth + 1);
  for (const node of nodes) {
    if (node.amount === 0) continue;
    lines.push(`${indent}${node.category_name}: ${fmt(toDollars(node.amount))}`);
    if (node.children && node.children.length > 0) pushSpendingTree(lines, node.children, depth + 1);
  }
}

/**
 * A year of category totals, which is also the category vocabulary the owner actually uses.
 *
 * The background worker's whole job is choosing a category, and it had never been shown the set of
 * categories in use or their typical size. No percentages: a category total can be negative when
 * refunds exceed purchases (July 2026 Shopping is -$1,203.63 on the live ledger), and a share of a
 * signed total is not a quantity.
 */
function pushCategorySpending(db: Database.Database, lines: string[], today: Date): void {
  const start = format(startOfMonth(subMonths(today, 12)), 'yyyy-MM-dd');
  const end = format(endOfMonth(subMonths(today, 1)), 'yyyy-MM-dd');
  const report = getSpendingReport(db, { startDate: start, endDate: end });
  const roots = report.categories.filter((node) => node.amount !== 0);
  if (roots.length === 0) return;

  lines.push('');
  lines.push(
    `### Spending By Category - the 12 complete months ${format(parseISO(start), 'MMMM yyyy')} to ${format(parseISO(end), 'MMMM yyyy')}`
  );
  lines.push(
    `  Totals across the whole window, not per month. Parent totals include their children. Only categories with activity in this window appear, so this is not the full category list. Total: ${fmt(toDollars(report.total))}.`
  );
  if (roots.some((node) => node.amount < 0)) {
    lines.push(
      '  A negative total means refunds and credits in this window exceeded purchases in that category. It is not a saving and not income.'
    );
  }
  pushSpendingTree(lines, roots, 0);
}

/**
 * Who chose each category.
 *
 * 2,412 of 2,579 rows carry `category_source` NULL on the live ledger, and the model had no way to
 * tell a category the owner set from one it set itself last week. NULL is the dangerous value: it
 * reads as "nobody chose", which would make every one of those rows look free to relabel.
 */
function pushProvenance(db: Database.Database, lines: string[]): void {
  const rows = db.prepare(`
    SELECT COALESCE(category_source, 'unrecorded') AS source, COUNT(*) AS total
    FROM transactions
    GROUP BY COALESCE(category_source, 'unrecorded')
  `).all() as Array<{ source: string; total: number }>;
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  if (total === 0) return;

  const bySource = new Map(rows.map((row) => [row.source, row.total]));
  const uncategorized = (db.prepare(
    'SELECT COUNT(*) AS total FROM transactions WHERE category_id IS NULL'
  ).get() as { total: number }).total;

  const labels: Array<[string, string]> = [
    ['human', 'Set by hand by the owner'],
    ['ai', 'Set by you, the AI advisor'],
    ['rule', 'Set by a merchant rule'],
    ['heuristic', 'Set by the local heuristic'],
  ];

  lines.push('');
  lines.push(`### How Categories Were Set (${plural(total, 'transaction')})`);
  for (const [source, label] of labels) {
    const value = bySource.get(source);
    if (value === undefined) continue;
    lines.push(`  ${label}: ${num(value)}`);
  }
  const unrecorded = bySource.get('unrecorded');
  if (unrecorded !== undefined) {
    lines.push(`  No provenance recorded: ${num(unrecorded)}`);
    lines.push(
      '  An unrecorded source is not a decision and not a vacancy. It means the row was written before per-row provenance existed, or by a path that does not record it. It does not mean uncategorized, and it does not mean the category is unclaimed.'
    );
  }
  lines.push(`  Rows with no category at all: ${num(uncategorized)}`);
  if ((bySource.get('human') ?? 0) > 0) {
    lines.push('  Never overwrite a category the owner set by hand.');
  }
}

interface ActionKindRow {
  kind: string;
  auto: number;
  confirmed: number;
  first_at: string;
  last_at: string;
}

interface CategoryWriteOutcome {
  writes: number;
  rows_touched: number;
  undone: number;
  standing: number;
  owner_changed: number;
}

interface RepeatPatternRow {
  pattern: string;
  proposals: number;
  categories: number;
}

/**
 * What the model has already done, and what became of it.
 *
 * `advisor_actions` held 140 applied actions that the model was never shown, so it could not
 * notice that it had proposed a Trupanion rule thirteen times or that a categorization had been
 * overridden. Everything reported here is derived from stored rows: an action's fate is read from
 * `transaction_category_revisions` and the row's current `category_action_id`, never asserted.
 *
 * Each part is printed only when it has something to say, so a ledger where nothing has been
 * overridden and nothing repeated carries no finding at all.
 */
function pushAdvisorHistory(db: Database.Database, lines: string[]): void {
  const byKind = db.prepare(`
    SELECT
      kind,
      SUM(CASE WHEN source = 'worker_auto' THEN 1 ELSE 0 END) AS auto,
      SUM(CASE WHEN source = 'user_confirm' THEN 1 ELSE 0 END) AS confirmed,
      MIN(created_at) AS first_at,
      MAX(created_at) AS last_at
    FROM advisor_actions
    GROUP BY kind
    ORDER BY COUNT(*) DESC
  `).all() as ActionKindRow[];

  const dismissed = db.prepare(`
    SELECT label, summary FROM advisor_drafts
    WHERE status = 'dismissed'
    ORDER BY updated_at DESC
    LIMIT 8
  `).all() as Array<{ label: string; summary: string }>;
  const dismissedTotal = (db.prepare(
    "SELECT COUNT(*) AS total FROM advisor_drafts WHERE status = 'dismissed'"
  ).get() as { total: number }).total;

  if (byKind.length === 0 && dismissedTotal === 0) return;

  const totalActions = byKind.reduce((sum, row) => sum + row.auto + row.confirmed, 0);
  lines.push('');
  // A dismissed proposal is history too, and it can exist before anything has ever been applied.
  // Heading that case "Actions You Have Already Applied (0)" would announce a section it does not
  // contain.
  lines.push(
    totalActions > 0
      ? `### Actions You Have Already Applied (${num(totalActions)})`
      : '### Your Own History With This Ledger'
  );
  lines.push(
    '  Your own history, so you can stop repeating yourself. Where the owner has changed something back, their choice is the correct one.'
  );
  for (const row of byKind) {
    const split = [
      row.auto > 0 ? `${num(row.auto)} applied autonomously` : null,
      row.confirmed > 0 ? `${num(row.confirmed)} after the owner confirmed a proposal` : null,
    ].filter((part): part is string => part !== null);
    lines.push(
      `  ${row.kind}: ${num(row.auto + row.confirmed)} (${split.join(', ')}), ${row.first_at.slice(0, 10)} to ${row.last_at.slice(0, 10)}`
    );
  }

  // A write is counted from the revision log rather than from the transaction, because a row can
  // carry several writes from several actions and only the newest is visible on the row itself.
  // Rows are therefore counted separately and reported separately: calling the revision count a row
  // count made the three outcomes look like they had lost rows whenever any row was written twice.
  const outcome = db.prepare(`
    SELECT
      COUNT(*) AS writes,
      COUNT(DISTINCT r.transaction_id) AS rows_touched,
      SUM(CASE WHEN r.reverted_at IS NOT NULL THEN 1 ELSE 0 END) AS undone,
      SUM(CASE WHEN t.category_action_id = r.action_id THEN 1 ELSE 0 END) AS standing,
      SUM(CASE WHEN t.category_source = 'human'
                AND (t.category_action_id IS NULL OR t.category_action_id <> r.action_id)
               THEN 1 ELSE 0 END) AS owner_changed
    FROM transaction_category_revisions r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE r.action_id IS NOT NULL AND r.revert_of IS NULL
  `).get() as CategoryWriteOutcome;

  if (outcome.writes > 0) {
    lines.push(
      `  Category writes: ${plural(outcome.writes, 'write')} across ${plural(outcome.rows_touched, 'row')}. Still the category the row carries: ${num(outcome.standing)}. Undone: ${num(outcome.undone)}. On a row the owner has since set by hand: ${num(outcome.owner_changed)}. Those three count writes, not rows, and a write can fall into more than one of them, so they need not sum to the total.`
    );
  }

  const corrections = db.prepare(`
    SELECT t.date, t.merchant_name, was.name AS you_set, now_cat.name AS owner_set
    FROM transaction_category_revisions r
    JOIN transactions t ON t.id = r.transaction_id
    LEFT JOIN categories was ON was.id = r.to_category_id
    LEFT JOIN categories now_cat ON now_cat.id = t.category_id
    WHERE r.action_id IS NOT NULL
      AND r.revert_of IS NULL
      AND t.category_source = 'human'
      AND (t.category_action_id IS NULL OR t.category_action_id <> r.action_id)
      AND (t.category_id IS NULL OR t.category_id <> r.to_category_id)
    ORDER BY t.date DESC
    LIMIT 10
  `).all() as Array<{
    date: string; merchant_name: string | null; you_set: string | null; owner_set: string | null;
  }>;

  if (corrections.length > 0) {
    lines.push('  Rows you categorized that the owner then changed by hand:');
    for (const row of corrections) {
      lines.push(
        `    ${row.date} ${row.merchant_name ?? 'Unknown'}: you set ${row.you_set ?? 'Uncategorized'}, the owner set ${row.owner_set ?? 'Uncategorized'}`
      );
    }
  }

  const ruleTotals = db.prepare(`
    SELECT COUNT(*) AS proposals, COUNT(DISTINCT lower(json_extract(payload, '$.pattern'))) AS patterns
    FROM advisor_actions
    WHERE kind = 'create_merchant_rule' AND json_extract(payload, '$.pattern') IS NOT NULL
  `).get() as { proposals: number; patterns: number };

  if (ruleTotals.proposals > ruleTotals.patterns) {
    const repeats = db.prepare(`
      SELECT
        -- Aggregated rather than bare, so which spelling of a case-insensitively grouped pattern
        -- gets printed is decided here instead of by whichever row SQLite happens to hold.
        MIN(json_extract(payload, '$.pattern')) AS pattern,
        COUNT(*) AS proposals,
        COUNT(DISTINCT json_extract(payload, '$.category_id')) AS categories
      FROM advisor_actions
      WHERE kind = 'create_merchant_rule' AND json_extract(payload, '$.pattern') IS NOT NULL
      GROUP BY lower(json_extract(payload, '$.pattern'))
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT 8
    `).all() as RepeatPatternRow[];

    lines.push(
      `  Repeat proposals: ${plural(ruleTotals.proposals, 'merchant-rule action')} cover only ${plural(ruleTotals.patterns, 'distinct pattern')}. Read the merchant rule list above before proposing one.`
    );
    for (const row of repeats) {
      const conflicting = row.categories > 1
        ? `, across ${num(row.categories)} different categories`
        : '';
      lines.push(`    ${row.pattern}: proposed ${plural(row.proposals, 'time')}${conflicting}`);
    }
  }

  if (dismissedTotal > 0) {
    lines.push(`  Proposals the owner dismissed (${num(dismissedTotal)}):`);
    for (const draft of dismissed) {
      lines.push(`    ${draft.label}: ${draft.summary}`);
    }
  }
}

/**
 * PROMPT CACHING. This string is the whole cached prefix in the chat path: `routes/ai.ts` puts one
 * `cache_control` breakpoint at the end of `ADVISOR_SYSTEM_PROMPT + this`, so the cache either hits
 * whole or misses whole, and section ORDER buys nothing. What matters instead is that nothing here
 * varies for a reason other than the data changing.
 *
 * It does not. Every value below is read from stored rows; the only clock-derived values are the
 * header date and the month/window labels, all at day granularity, so the prefix is byte-identical
 * across every turn of a conversation and across the eight tool rounds inside one turn. The one
 * line that moves on its own schedule is `Last successful sync` in Data Freshness, which changes
 * when a sync runs, at which point the balances, recent rows and integrity findings have all
 * changed too. There is no ordering that saves the cache across a sync, and there is nothing to
 * save it from otherwise.
 *
 * Do not add a generated-at timestamp, a random sample, or anything else that differs between two
 * calls over identical data. Splitting the stable reference half (rules, provenance, action
 * history, monthly series) from the volatile half behind a second breakpoint would be the next
 * real improvement, and it belongs in `routes/ai.ts` where the breakpoints live.
 */
export function buildFinancialContext(): string {
  const db = getDb();
  const today = new Date();
  const thisMonthStart = format(startOfMonth(today), 'yyyy-MM-dd');

  const lines: string[] = [`## Financial Snapshot - ${format(today, 'MMMM d, yyyy')}`];

  // User-provided personal context. Injected here so it reaches the chat prompt, the
  // background worker prompt, and the Settings disclosure panel from one place.
  const profile = getPreference(db, ADVISOR_PROFILE_PREFERENCE_KEY);
  const profileText = typeof profile?.value === 'string' ? profile.value.trim() : '';
  if (profileText) {
    lines.push('');
    lines.push('### About You (personal context you provided)');
    lines.push(profileText);
  }

  const syncHealth = getSyncHealth(db);

  lines.push('');
  lines.push('### Data Freshness');
  lines.push(`  Overall: ${syncHealth.status_label}. ${syncHealth.status_detail}`);
  if (syncHealth.connections.length === 0) {
    lines.push('  No live institution connections. Balances and transactions may be manual or empty.');
  } else {
    lines.push(`  Connections: ${syncHealth.connection_count}`);
    lines.push(`  Last successful sync: ${syncHealth.last_synced_at ?? 'Never'}`);
    lines.push(`  Stale connections: ${syncHealth.stale_count}`);
    lines.push(`  Connections needing attention: ${syncHealth.attention_count}`);
    for (const connection of syncHealth.connections.slice(0, 6)) {
      const ageLabel = connection.age_days === null ? 'never synced' : `${connection.age_days}d ago`;
      lines.push(`  ${connection.institution_name}: ${connection.status_label}, ${ageLabel}, ${connection.account_count} accounts`);
    }
  }

  pushLedgerIntegrity(db, lines);

  // ── Accounts & Net Worth ─────────────────────────────────────────────────
  const accounts = db.prepare(`
    SELECT type, current_balance, available_balance, is_liability, is_hidden, account_name, institution_name
    FROM accounts
    WHERE is_hidden = 0 AND type != 'closed'
    ORDER BY type
  `).all() as Array<{
    type: string; current_balance: number; available_balance: number | null;
    is_liability: number; is_hidden: number; account_name: string; institution_name: string;
  }>;

  const liquidTypes = new Set(['checking', 'savings', 'cash']);
  const investTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth']);
  const cryptoTypes = new Set(['crypto_wallet']);

  let liquid = 0, investments = 0, crypto = 0, liabilities = 0, otherAssets = 0;
  const acctLines: string[] = [];

  for (const a of accounts) {
    // current_balance is integer cents; dollarize once here so all downstream sums, the
    // net-worth math, and the forecast (already dollars) combine in the same unit.
    const bal = toDollars(a.current_balance);
    if (a.is_liability) {
      // Signed, and the label follows the sign. A card in credit is stored as a negative amount
      // owed; Math.abs() plus a hardcoded "owed" told the model the owner owed $563.26 on a card
      // that owed the owner $563.26, and no wording in the prompt could recover the direction.
      liabilities += bal;
      acctLines.push(
        bal < 0
          ? `  ${a.account_name} (${a.institution_name || a.type}): ${fmt(-bal)} credit balance (the card owes you)`
          : `  ${a.account_name} (${a.institution_name || a.type}): ${fmt(bal)} owed`
      );
    } else if (liquidTypes.has(a.type)) {
      liquid += bal;
      acctLines.push(`  ${a.account_name} (${a.type}): ${fmt(bal)}`);
    } else if (investTypes.has(a.type)) {
      investments += bal;
      acctLines.push(`  ${a.account_name} (${a.type}): ${fmt(bal)}`);
    } else if (cryptoTypes.has(a.type)) {
      crypto += bal;
      acctLines.push(`  ${a.account_name} (crypto): ${fmt(bal)}`);
    } else {
      otherAssets += bal;
      acctLines.push(`  ${a.account_name} (${a.type}): ${fmt(bal)}`);
    }
  }

  const totalAssets = liquid + investments + crypto + otherAssets;
  const netWorth = totalAssets - liabilities;

  // Net worth vs last month. Measured only: a delta against a reconstruction is a comparison
  // between a fact and a guess, and stating it as "+$X vs last month" presents it as a fact.
  const lastMonthSnapshot = readSnapshotBefore(db, thisMonthStart, { measuredOnly: true });

  // netWorth is dollars (from dollarized balances); the snapshot column is cents.
  const nwDelta = lastMonthSnapshot ? netWorth - toDollars(lastMonthSnapshot.net_worth) : null;

  lines.push('');
  lines.push(`### Net Worth: ${fmt(netWorth)}${nwDelta != null ? ` (${nwDelta >= 0 ? '+' : ''}${fmt(nwDelta)} vs last month)` : ''}`);
  lines.push(`  Liquid assets:    ${fmt(liquid)}`);
  if (investments > 0) lines.push(`  Investments:      ${fmt(investments)}`);
  if (crypto > 0) lines.push(`  Crypto:           ${fmt(crypto)}`);
  if (otherAssets > 0) lines.push(`  Other assets:     ${fmt(otherAssets)}`);
  // Non-zero rather than positive: a net credit position is a fact about the balance sheet, and
  // dropping the line would leave the model to infer liabilities of zero from its absence.
  if (liabilities !== 0) lines.push(`  Liabilities:      ${fmt(liabilities)}`);
  lines.push('');
  lines.push('Account breakdown:');
  lines.push(...acctLines);

  const reach = readAccountReach(db);
  const span = readLedgerSpan(db);
  pushLedgerReach(lines, reach, span);

  // ── Cash Flow (average over complete months) ─────────────────────────────
  //
  // The window is the last AVERAGE_MONTHS *complete* months, and the divisor is that same number.
  // Those two used to disagree: the range ran from startOfMonth(today - 3 months) to TODAY, which
  // spans four calendar months (three whole ones plus the current partial), and the sum of all four
  // was divided by the literal 3. On 2026-07-29 that told the model $4,396.32/mo of income and
  // $5,189.15/mo of expenses where the real four-month averages were $3,297.24 and $3,891.86:
  // every figure inflated by exactly a third, in the one number behind every "can I afford this"
  // answer the advisor gives.
  //
  // Excluding the current month is deliberate. Including a month that is four days old and dividing
  // by a whole number understates it roughly eightfold, which is the same class of error in the
  // opposite direction.
  const AVERAGE_MONTHS = 3;
  const averageStart = format(startOfMonth(subMonths(today, AVERAGE_MONTHS)), 'yyyy-MM-dd');
  const averageEnd = format(endOfMonth(subMonths(today, 1)), 'yyyy-MM-dd');
  const cashflow = getCashflowReport(db, { startDate: averageStart, endDate: averageEnd });
  const cashflowTotals = cashflow.months.reduce(
    (totals, month) => ({
      income: totals.income + month.income,
      expenses: totals.expenses + month.expenses,
    }),
    { income: 0, expenses: 0 }
  );

  const avgIncome = cashflowTotals.income / AVERAGE_MONTHS;
  const avgExpenses = cashflowTotals.expenses / AVERAGE_MONTHS;
  const avgNet = avgIncome - avgExpenses;

  lines.push('');
  lines.push(
    `### Cash Flow - average of the ${AVERAGE_MONTHS} complete months ${format(parseISO(averageStart), 'MMMM')} to ${format(parseISO(averageEnd), 'MMMM yyyy')} (excludes the current partial month)`
  );
  lines.push(`  Income:   ${fmt(toDollars(avgIncome))}/mo`);
  lines.push(`  Expenses: ${fmt(toDollars(avgExpenses))}/mo`);
  lines.push(`  Net:      ${fmt(toDollars(avgNet))}/mo`);

  pushMonthlyHistory(db, lines, reach, span, format(today, 'yyyy-MM'));

  const reportSummary = getReportSummary(db, {
    startDate: thisMonthStart,
    endDate: format(today, 'yyyy-MM-dd'),
  });
  lines.push('');
  lines.push(`### Report Summary - ${format(today, 'MMMM')}`);
  lines.push(`  Income: ${fmt(toDollars(reportSummary.income.current))} (${fmt(toDollars(reportSummary.income.delta))} vs prior period)`);
  lines.push(`  Spending: ${fmt(toDollars(reportSummary.expenses.current))} (${fmt(toDollars(reportSummary.expenses.delta))} vs prior period)`);
  lines.push(`  Net cash flow: ${fmt(toDollars(reportSummary.net.current))} (${fmt(toDollars(reportSummary.net.delta))} vs prior period)`);
  // Stated as undefined rather than as 0%: "you saved nothing" and "there is no income to compute
  // a rate from" are different facts, and the model has no way to tell them apart from a bare 0.
  const savingsRateLine = reportSummary.savings_rate.current === null
    ? 'not defined (no income recorded in this window yet)'
    : `${reportSummary.savings_rate.current.toFixed(1)}%${
        reportSummary.savings_rate.delta === null
          ? ''
          : ` (${reportSummary.savings_rate.delta >= 0 ? '+' : ''}${reportSummary.savings_rate.delta.toFixed(1)} pp)`
      }`;
  lines.push(`  Savings rate: ${savingsRateLine}`);
  if (reportSummary.excluded_flows.length > 0) {
    lines.push('  Excluded from income and spending reports:');
    for (const flow of reportSummary.excluded_flows) {
      lines.push(`    ${flow.flow_type}: ${flow.count} transactions, net ${fmt(toDollars(flow.net))}`);
    }
  }

  const forecastDays = 60;
  const forecast = buildRecurringForecast(db, forecastDays);
  if (forecast.occurrences.length > 0) {
    lines.push('');
    lines.push(`### Forward Cash Flow - next ${forecastDays} days`);
    lines.push(`  Scheduled income: ${fmt(toDollars(forecast.income))}`);
    lines.push(`  Scheduled bills:  ${fmt(toDollars(forecast.bills))}`);
    lines.push(`  Scheduled net:    ${fmt(toDollars(forecast.net))}`);
    // `liquid` is dollars (from dollarized balances); forecast.net is cents.
    lines.push(`  Liquid after scheduled net: ${fmt(liquid + toDollars(forecast.net))}`);
    lines.push('  Next scheduled items:');
    for (const occurrence of forecast.occurrences.slice(0, 10)) {
      const sign = occurrence.amount >= 0 ? '+' : '-';
      const status = occurrence.is_confirmed ? 'confirmed' : 'detected';
      const category = occurrence.category_name ?? 'Uncategorized';
      const adjustment = occurrence.adjustment_action
        ? `, ${occurrence.adjustment_action} adjustment from ${occurrence.original_expected_date ?? occurrence.expected_date}`
        : '';
      lines.push(
        `    ${occurrence.expected_date}: ${occurrence.merchant_name} ${sign}${fmt(toDollars(Math.abs(occurrence.amount)))} (${category}, ${occurrence.frequency}, ${status}${adjustment})`
      );
    }
  }

  // ── Top Spending Categories (this month) ────────────────────────────────
  const thisMonthSpending = db.prepare(`
    SELECT
      COALESCE(pc.name, c.name, 'Uncategorized') AS category,
      SUM(-t.amount) AS total
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    WHERE t.date >= ?
      AND t.pending = 0
      AND ${expenseSideSql('t', 'c')}
      AND ${excludedFromTotalsSql('t')}
    GROUP BY COALESCE(pc.id, c.id, 'uncategorized')
    ORDER BY total DESC
    LIMIT 8
  `).all(thisMonthStart) as Array<{ category: string; total: number }>;

  // Budget context
  const budgets = db.prepare(`
    SELECT b.amount, c.name AS category_name,
      COALESCE(pc.name, c.name) AS parent_category
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    WHERE b.period = 'monthly'
  `).all() as Array<{ amount: number; category_name: string; parent_category: string }>;
  // budgets.amount and thisMonthSpending.total are inline-SQL cents; dollarize for display.
  const budgetMap = new Map(budgets.map((b) => [b.parent_category || b.category_name, toDollars(b.amount)]));

  if (thisMonthSpending.length > 0) {
    lines.push('');
    lines.push(`### Top Spending - ${format(today, 'MMMM')}`);
    // Printed only when a category actually went negative, so an ordinary month carries no note.
    // A refund is a positive row inside an expense category and nets that category's spend down;
    // without this the model reads "-$1,203.63 spent, 241% of budget" as being far under budget.
    if (thisMonthSpending.some((row) => row.total < 0)) {
      lines.push(
        '  A negative total means refunds and credits exceeded purchases in that category this month. Any budget percentage shown beside a negative total is negative for the same reason and does not mean the budget was underspent.'
      );
    }
    for (const row of thisMonthSpending) {
      const total = toDollars(row.total);
      const budget = budgetMap.get(row.category);
      const budgetStr = budget ? ` | budget: ${fmt(total)}/${fmt(budget)} (${Math.round((total / budget) * 100)}%)` : '';
      lines.push(`  ${row.category}: ${fmt(total)}${budgetStr}`);
    }
  }

  pushCategorySpending(db, lines, today);

  // Goals
  const goals = db.prepare(`
  SELECT
    g.name,
    g.type,
    g.target_amount,
    g.current_amount,
    g.starting_amount,
    g.target_date,
    a.account_name,
    a.institution_name,
    a.current_balance AS account_balance
  FROM goals g
  LEFT JOIN accounts a ON a.id = g.account_id
  WHERE g.is_archived = 0
  ORDER BY g.target_date IS NULL ASC, g.target_date ASC, g.created_at ASC
  LIMIT 8
  `).all() as GoalContextRow[];

  if (goals.length > 0) {
    lines.push('');
    lines.push('### Goals');
    for (const goal of goals) {
      const progress = calculateGoalProgress(goal);
      const verb = goal.type === 'debt' ? 'paid down' : 'saved';
      const linked = goal.account_name
        ? ` | linked to ${goal.account_name}${goal.institution_name ? ` at ${goal.institution_name}` : ''}`
        : '';
      const targetDate = goal.target_date ? ` | target: ${goal.target_date}` : '';
      // progress.* (calculateGoalProgress) and goal.target_amount are both cents.
      lines.push(
        `  ${goal.name}: ${fmt(toDollars(progress.progress_amount))} ${verb} of ${fmt(toDollars(goal.target_amount))} (${Math.round(progress.progress_percent)}%), ${fmt(toDollars(progress.remaining_amount))} remaining${targetDate}${linked}`
      );
    }
  }

  const reviewSummary = getTransactionReviewSummary(db);

  if (reviewSummary.total_open > 0) {
    lines.push('');
    lines.push('### Review Queue');
    lines.push(`  Open review items: ${reviewSummary.total_open}`);
    for (const queue of reviewSummary.queues) {
      lines.push(`  ${queue.label}: ${queue.count}`);
    }
  }

  // ── Merchant rules that already exist ────────────────────────────────────
  // The worker proposed rules without ever being shown this list, so it re-proposed the same
  // merchants on every sync: 7 create_merchant_rule actions for Spotify, 8 for Trupanion, 7 for
  // Backblaze. Two of those Spotify proposals disagreed with each other and moved the rule between
  // categories two hours apart, relabelling every matching transaction twice. A model cannot avoid
  // re-proposing something it cannot see.
  const merchantRules = db.prepare(`
    SELECT mr.pattern, COALESCE(c.name, mr.category_id) AS category_name, mr.source
    FROM merchant_rules mr
    LEFT JOIN categories c ON c.id = mr.category_id
    WHERE mr.retired_at IS NULL
    ORDER BY mr.pattern COLLATE NOCASE
  `).all() as Array<{ pattern: string; category_name: string; source: string }>;

  if (merchantRules.length > 0) {
    const aiRules = merchantRules.filter((rule) => rule.source === 'ai').length;
    lines.push('');
    lines.push(`### Merchant Rules Already In Place (${num(merchantRules.length)} live)`);
    lines.push(
      `  ${num(merchantRules.length - aiRules)} were written by the owner and ${num(aiRules)} by you. Yours are marked "(yours)"; every unmarked rule is the owner's.`
    );
    // Rule resolution is now total and human-first (rules.ts): source, then pattern length, then
    // recency, then id. Saying so matters because it changes what proposing a competing rule
    // achieves: an AI rule that contradicts an owner rule no longer wins, it just sits there.
    lines.push(
      '  When several patterns match one merchant, the owner\'s rule wins over yours, then the longer pattern, then the more recent one. A rule of yours that contradicts one of the owner\'s will never be applied.'
    );
    lines.push('  Do not propose a rule for a merchant that already has one. To change one, say so explicitly.');
    for (const rule of merchantRules) {
      lines.push(`  ${rule.pattern} -> ${rule.category_name}${rule.source === 'ai' ? ' (yours)' : ''}`);
    }
  }

  // Retired rules, shown as retired. Excluding them is what let the worker re-propose a rule the
  // owner had deliberately taken away: two contradicting AI rules ("Spotify", "Backblaze") were
  // retired rather than deleted precisely so the retirement stays on the record, and a record the
  // model cannot read does not stop it repeating the thing that caused the retirement.
  const retiredRules = db.prepare(`
    SELECT mr.pattern, COALESCE(c.name, mr.category_id) AS category_name, mr.source, mr.retired_at
    FROM merchant_rules mr
    LEFT JOIN categories c ON c.id = mr.category_id
    WHERE mr.retired_at IS NOT NULL
    ORDER BY mr.retired_at DESC
    LIMIT 25
  `).all() as Array<{ pattern: string; category_name: string; source: string; retired_at: string }>;

  if (retiredRules.length > 0) {
    const retiredTotal = (db.prepare(
      'SELECT COUNT(*) AS total FROM merchant_rules WHERE retired_at IS NOT NULL'
    ).get() as { total: number }).total;
    lines.push('');
    lines.push(
      retiredTotal > retiredRules.length
        ? `### Merchant Rules Retired (${num(retiredTotal)}, showing the ${num(retiredRules.length)} most recent)`
        : `### Merchant Rules Retired (${num(retiredTotal)})`
    );
    lines.push('  These were taken out deliberately and are not applied. Do not propose them again unless the owner asks.');
    for (const rule of retiredRules) {
      lines.push(
        `  ${rule.pattern} -> ${rule.category_name}, retired ${rule.retired_at.slice(0, 10)}${rule.source === 'ai' ? ' (was yours)' : ''}`
      );
    }
  }

  const ruleSuggestions = reviewSummary.rule_suggestions;
  if (ruleSuggestions.length > 0) {
    const uncategorizedMatches = ruleSuggestions.reduce(
      (sum, suggestion) => sum + suggestion.uncategorized_count,
      0
    );
    lines.push('');
    lines.push('### Rule Suggestions');
    lines.push(`  Suggested merchant rules: ${ruleSuggestions.length}`);
    lines.push(`  Uncategorized matches they could clean up: ${uncategorizedMatches}`);
    for (const suggestion of ruleSuggestions.slice(0, 5)) {
      lines.push(
        `  ${suggestion.pattern}: ${suggestion.category_name} (${suggestion.categorized_count} categorized, ${suggestion.uncategorized_count} uncategorized, ${Math.round(suggestion.confidence * 100)}% confidence)`
      );
    }
  }

  pushProvenance(db, lines);
  pushAdvisorHistory(db, lines);

  // ── Investment Portfolio ─────────────────────────────────────────────────
  // Excludes crypto_wallet accounts: their value is already reported under the Net Worth
  // section's separate "Crypto" bucket (from accounts.current_balance), so including their
  // holdings here too would present the same crypto value under two different totals in
  // the same context blob.
  // institution_value and cost_basis are inline-SQL integer cents; dollarize at read so the
  // portfolio totals, asset-mix values, and per-holding lines below are all in dollars.
  //
  // Deliberately unlimited. This query used to end in LIMIT 15 while `totalPortfolio`,
  // `totalCostBasis`, the return percentage and the whole asset-mix table were computed from that
  // truncated slice and then printed under the heading "Investment Portfolio - $X". With 6 holdings
  // it happened to be right; at 16 the model would have been handed a partial sum labelled as the
  // total, with allocation percentages summing to 100% of the wrong denominator. Only the
  // human-facing "Top holdings" list is truncated, and it says so when it truncates.
  const holdings = (db.prepare(`
    SELECT
      s.ticker, s.name AS sec_name, s.type AS sec_type,
      h.quantity, h.institution_value, h.cost_basis
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    JOIN accounts a ON a.id = h.account_id
    WHERE a.is_hidden = 0 AND a.type != 'crypto_wallet'
    ORDER BY h.institution_value DESC
  `).all() as Array<{
    ticker: string | null; sec_name: string; sec_type: string;
    quantity: number; institution_value: number; cost_basis: number | null;
  }>).map((h) => ({
    ...h,
    institution_value: toDollars(h.institution_value),
    cost_basis: toDollarsOrNull(h.cost_basis),
  }));

  if (holdings.length > 0) {
    const totalPortfolio = holdings.reduce((s, h) => s + h.institution_value, 0);
    // Gain is only defined over the positions that have a basis. Charging the full portfolio
    // value against a basis total that omits them reports their entire market value as profit:
    // a $104.99 Fidelity cash sweep with no reported basis moved this from 1.8% to 7.1%.
    const basisKnown = holdings.filter((h) => h.cost_basis != null && h.cost_basis > 0);
    const totalCostBasis = basisKnown.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
    const basisKnownValue = basisKnown.reduce((s, h) => s + h.institution_value, 0);
    const totalGain = totalCostBasis > 0 ? basisKnownValue - totalCostBasis : null;
    const totalReturn = totalGain != null && totalCostBasis > 0 ? (totalGain / totalCostBasis) * 100 : null;

    // Asset type allocation
    const byType = new Map<string, number>();
    for (const h of holdings) {
      byType.set(h.sec_type, (byType.get(h.sec_type) ?? 0) + h.institution_value);
    }

    lines.push('');
    lines.push(`### Investment Portfolio - ${fmt(totalPortfolio)}${totalReturn != null ? ` (${pct(totalReturn)} total return)` : ''}`);
    // Three totals over the same money, all of which legitimately differ: the Net Worth section
    // sums ACCOUNT BALANCES selected by account type, this section sums HOLDING VALUES, and the
    // accounts those holdings actually sit in are a third set. A model reading two of them had no
    // way to know whether it was looking at one number twice or two numbers once.
    //
    // The third total is what keeps the note honest. "Uninvested cash or a provider lag" is only
    // true while every holding sits inside an account the Net Worth section already counts as an
    // investment; a holding in a savings-typed account would make the same sentence a fabrication.
    //
    // So the SETS are compared, not their sums. The balance-sum proxy this used to run
    // (|holding-account balance - investments| < 0.01) reports a stray holding whenever the two
    // totals differ for any other reason: an IRA funded but not yet invested makes the sums
    // disagree with every holding sitting exactly where it should, and that is an ordinary account.
    const holdingAccounts = db.prepare(`
      SELECT a.id, a.account_name, a.type, a.current_balance
      FROM accounts a
      WHERE a.is_hidden = 0
        AND a.type != 'crypto_wallet'
        AND EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id)
      ORDER BY a.account_name
    `).all() as Array<{ id: string; account_name: string; type: string; current_balance: number }>;
    const outsideInvestments = holdingAccounts.filter((account) => !investTypes.has(account.type));

    if (Math.abs(totalPortfolio - investments) >= 0.01) {
      const gap = fmt(Math.abs(totalPortfolio - investments));
      const strays = outsideInvestments
        .map((account) => `${account.account_name} (${account.type}), ${fmt(toDollars(account.current_balance))}`)
        .join('; ');
      lines.push(
        outsideInvestments.length === 0
          ? `  Note: the Net Worth section reports investments as ${fmt(investments)} from account balances, while this figure sums individual holdings. Every account holding a position is one the Net Worth section already counts as an investment, so the ${gap} difference is uninvested cash or a provider lag, not two separate pots of money. Do not add them together.`
          : `  Note: the Net Worth section reports investments as ${fmt(investments)} from account balances, while this figure sums individual holdings. ${plural(outsideInvestments.length, 'account')} holding a position ${outsideInvestments.length === 1 ? 'is' : 'are'} not classified as an investment there: ${strays}. The ${gap} difference is partly that overlap, not two separate pots of money. Do not add them together.`
      );
    }
    if (totalGain != null) {
      lines.push(`  Unrealized gain/loss: ${fmt(totalGain)} on ${fmt(totalCostBasis)} cost basis (${basisKnown.length} of ${holdings.length} holdings have a basis)`);
    }

    lines.push('  Asset mix:');
    for (const [type, val] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${type}: ${fmt(val)} (${Math.round((val / totalPortfolio) * 100)}%)`);
    }

    const TOP_HOLDINGS = 10;
    lines.push(
      holdings.length > TOP_HOLDINGS
        ? `  Top ${TOP_HOLDINGS} holdings of ${holdings.length} (the totals above cover all ${holdings.length}):`
        : '  Holdings:'
    );
    for (const h of holdings.slice(0, TOP_HOLDINGS)) {
      const gain = h.cost_basis != null && h.cost_basis > 0 ? h.institution_value - h.cost_basis : null;
      const ret = h.cost_basis != null && h.cost_basis > 0
        ? ((h.institution_value - h.cost_basis) / h.cost_basis) * 100
        : null;
      const gainStr = gain != null ? ` (${gain >= 0 ? '+' : ''}${fmt(gain)}, ${pct(ret)})` : '';
      lines.push(`    ${h.ticker ?? h.sec_name}: ${fmt(h.institution_value)}${gainStr}`);
    }
  }

  // ── Net Worth Trend (the whole recorded series) ──────────────────────────
  //
  // Every point since RECENT_SNAPSHOT_MONTHS, and one point per month before that. Snapshots are
  // written per sync day, so an unthinned "all history" section grows without bound: today's 19
  // points become several hundred within a year, and the oldest ones would crowd out the recent
  // ones they least inform. The thinning is stated whenever it drops anything, because a series
  // presented at a resolution it does not have is a claim the data does not support.
  const RECENT_SNAPSHOT_MONTHS = 3;
  const dailyFrom = format(startOfMonth(subMonths(today, RECENT_SNAPSHOT_MONTHS)), 'yyyy-MM-dd');
  const allSnapshots = readSnapshots(db, { order: 'asc' });
  const lastOfMonth = new Map<string, string>();
  for (const snap of allSnapshots) {
    if (snap.date < dailyFrom) lastOfMonth.set(snap.date.slice(0, 7), snap.date);
  }
  const keptDates = new Set([...lastOfMonth.values()]);
  const nwHistory = allSnapshots.filter((snap) => snap.date >= dailyFrom || keptDates.has(snap.date));

  if (nwHistory.length >= 2) {
    const estimatedCount = nwHistory.filter((snap) => snap.is_estimated).length;
    lines.push('');
    lines.push(
      `### Net Worth Trend - ${nwHistory[0].date} to ${nwHistory[nwHistory.length - 1].date}`
    );
    if (allSnapshots.length > nwHistory.length) {
      lines.push(
        `  ${num(nwHistory.length)} of ${num(allSnapshots.length)} recorded balance sheets. Every point from ${dailyFrom} onward, and the last point of each month before that.`
      );
    }
    if (estimatedCount > 0) {
      lines.push(
        `  ${estimatedCount} of these ${nwHistory.length} points are reconstructions, not measurements. Do not narrate movement between an estimate and a measurement as if it were an observed event.`
      );
    }
    for (const snap of nwHistory) {
      lines.push(`  ${snap.date}: ${fmt(toDollars(snap.net_worth))}${estimateNote(snap)}`);
    }
  }

  // ── Recent Transactions ──────────────────────────────────────────────────
  // Carries each row's category provenance, which is recorded per row and was rendered nowhere.
  // Without it the model cannot tell a category it set last week from one the owner set by hand,
  // on exactly the rows it is most likely to want to change.
  const RECENT_TRANSACTIONS = 40;
  const recent = db.prepare(`
    SELECT t.date, t.merchant_name, t.amount, t.category_source, c.name AS category, c.is_income
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
    ORDER BY t.date DESC, t.created_at DESC
    LIMIT ?
  `).all(RECENT_TRANSACTIONS) as Array<{
    date: string; merchant_name: string | null; amount: number;
    category_source: string | null; category: string | null; is_income: number;
  }>;

  const SOURCE_MARKS: Record<string, string> = {
    human: ' [owner]',
    ai: ' [you]',
    rule: ' [rule]',
    heuristic: ' [heuristic]',
  };

  if (recent.length > 0) {
    lines.push('');
    lines.push(`### Recent Transactions (the ${num(recent.length)} most recent settled rows)`);
    lines.push(
      '  A trailing tag says who set the category: [owner] by hand, [you] the AI advisor, [rule] a merchant rule, [heuristic] the local matcher. No tag means no provenance was recorded, which is not the same as uncategorized.'
    );
    for (const tx of recent) {
      const sign = tx.amount >= 0 ? '+' : '-';
      const mark = tx.category_source ? SOURCE_MARKS[tx.category_source] ?? '' : '';
      lines.push(`  ${tx.date}: ${tx.merchant_name ?? 'Unknown'} - ${sign}${fmt(toDollars(Math.abs(tx.amount)))} (${tx.category ?? 'Uncategorized'})${mark}`);
    }
  }

  return lines.join('\n');
}
