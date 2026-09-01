import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { calculateGoalProgress, type GoalProgressInput } from './goalProgress';
import type Anthropic from '@anthropic-ai/sdk';
import { format, startOfMonth, subMonths } from 'date-fns';
import { getTransactionById, listTransactions, type TransactionListFilters } from './transactions';
import { getReadOnlyDbPath } from '../db/index';
import { readSnapshots } from './netWorthHistory';
import { dollarizeFields, toDollars, toDollarsOrNull } from './money';
import { getCashflowReport, getSpendingReport } from './reporting';
import { buildRecurringForecast } from './recurringForecast';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';
import { confirmAdvisorDraft, listAdvisorActions } from './advisorDrafts';
import { runGuardedCategoryBatch, type GuardedBatchReport } from './aiGuards';
import { isAutonomousDraftKind } from './draftAutonomy';
import { revertableRevisionsForAction } from './categoryWrites';
import { merchantMatchesRulePattern } from './rules';
import { getHoldingHistory } from './investmentMetadata';
import { getSyncRunDetail, listSyncRuns } from './syncHistory';
import { reconcileAccounts, unreconciledResidual } from './reconciliation';
import { buildSchemaDoc, describeTables, getCategoryProvenance, transactionReportInclusion } from './schemaDoc';
import type { AdvisorToolSpec } from './aiProviders/types';
import type { AdvisorDraftAction, AdvisorDraftPayload } from '../../../shared/types';

/** Stable id per payload, matching advisorDrafts' own scheme, so repeats collapse. */
function draftIdFor(payload: AdvisorDraftPayload): string {
  return `chat_${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 14)}`;
}

// Read-only tools the cloud advisor (routes/ai.ts /chat) can call to query the database
// on demand, instead of relying only on the fixed context snapshot. This is the gap the
// user hit: the snapshot carries the last 15 of hundreds of transactions and current-month
// aggregates, so questions about specific merchants, categories, or past months had no data
// to work from. Every tool here is a pure SELECT and returns DOLLARS (the snapshot and UI
// are dollarized, so the model reasons consistently in dollars). Nothing here writes.
//
// The aggregate tools DELEGATE to the same services the UI renders from (reporting.ts,
// recurringForecast.ts, budgetProjection.ts) rather than running their own SQL. They used to
// hand-roll it, and drifted exactly the way transactionFilters.ts was created to prevent:
// they counted transfer candidates, confirmed duplicates, and pending rows that Reports
// excludes, skipped the cat_inv/cat_crypto exclusion, and resolved "this month" in UTC while
// every other boundary in the app is local. The advisor answered a spending question with a
// different number than the Reports page, and nothing on either screen said which was right.
// Any new aggregate belongs in the shared service, not here.

export const ADVISOR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_transactions',
    description:
      'List the user\'s transactions with optional filters. Use for questions about specific merchants, accounts, categories, date ranges, or to inspect history the context snapshot does not include. Amounts are in dollars; negative = expense, positive = income.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Inclusive lower bound, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'Inclusive upper bound, YYYY-MM-DD.' },
        merchant: { type: 'string', description: 'Substring match on merchant/original name/notes.' },
        category_id: { type: 'string', description: 'Category id (matches the category and its children).' },
        account_id: { type: 'string', description: 'Account id.' },
        type: { type: 'string', enum: ['income', 'expense'], description: 'Restrict by sign.' },
        min_amount: { type: 'number', description: 'Minimum signed amount in dollars.' },
        max_amount: { type: 'number', description: 'Maximum signed amount in dollars.' },
        limit: { type: 'integer', description: 'Max rows to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'spending_by_category',
    description:
      'Net spending grouped by top-level category over an optional date range, largest first. Amounts are dollars and are SIGNED: a category whose refunds and credits exceeded its purchases in the window is negative, and `total` is the signed sum of them all. percent_of_total is null whenever any category is negative or the total is not positive, because a share of a signed total does not add to 100; read share_note for which of those it was. Matches the Reports page exactly: transfers, investment and crypto flows, pending rows, and transactions the user resolved as duplicates are all excluded.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Inclusive lower bound, YYYY-MM-DD (optional).' },
        end_date: { type: 'string', description: 'Inclusive upper bound, YYYY-MM-DD (optional).' },
        top: { type: 'integer', description: 'How many categories to return (default 10).' },
      },
    },
  },
  {
    name: 'monthly_cashflow',
    description:
      'Income, expenses, and net per calendar month for the last N months (default 6), newest first. Amounts in dollars. Matches the Cash flow page exactly: transfers, investment and crypto flows, pending rows, and resolved duplicates are excluded. Months are local calendar months.',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'Number of months back to include (default 6, max 36).' },
      },
    },
  },
  {
    name: 'get_budgets',
    description:
      'Each monthly budget for the current local month: limit, actual spending so far, remaining, rollover balance, spend already committed via recurring items, and projected month-end spend. Amounts in dollars.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_goals',
    description:
      'Active savings/debt goals with target, current amount, progress %, and target date. Amounts in dollars.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_holdings',
    description:
      'Every investment holding including crypto and holdings in hidden accounts: ticker, name, type, quantity, market value, cost basis, unrealized gain, and the owning account. Values in dollars; quantity is a share/coin count. Broader than the portfolio block in the context snapshot, which excludes crypto to avoid double-counting it against the crypto net-worth bucket.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_upcoming_bills',
    description:
      'Recurring bills and income expected within the next N days (default 45), soonest first, with scheduled income/bills/net totals for the window. Honors skip, snooze, and amount overrides. Amounts in dollars, signed, so a bill is negative. Check amount_varies: when true the amount is a median of a variable series (a paycheck, a utility bill), not a known figure, so do not quote it as exact. status is "overdue" when the expected date is already past and "upcoming" otherwise, comparing local calendar dates; confirmed = true means the owner accepted the pattern, false means it is only a detection.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Lookahead window in days (default 45, max 180).' },
      },
    },
  },
  {
    name: 'get_net_worth_history',
    description:
      'Net worth, total assets, and total liabilities per snapshot over the last N months (default 12), oldest first. Amounts in dollars. estimated = true means the row was RECONSTRUCTED by replaying transactions backwards off current balances rather than measured, so say "estimated" when quoting one and never narrate the join between an estimated and a measured stretch as an event.',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'Number of months back to include (default 12, max 60).' },
      },
    },
  },
  {
    name: 'get_merchant_rules',
    description:
      'The standing merchant-to-category rules, returned in the order that decides which one wins. Several rules can match one merchant and the FIRST match applies, so this order is the policy: the owner\'s rules outrank the model\'s, and a longer, more specific pattern outranks a vaguer one. "precedence" is a rule\'s rank in that full order, so 1 is tested first. Matching is fuzzy, so a short pattern sweeps in merchants it does not name. Pass "merchant" to see which rule actually wins for a given name, resolved with the same matcher the apply path uses: every rule is tested, and only the ones whose pattern matches are listed back. Retired rules are excluded unless you ask for them; a retired rule still applies to nothing.',
    input_schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: 'Resolve this merchant name against the rules and mark the winner.' },
        include_retired: { type: 'boolean', description: 'Include retired rules (default false).' },
        limit: { type: 'integer', description: 'Max rules to LIST (default 100, max 500). Resolution always considers every rule, and the winner is always included.' },
      },
    },
  },
  {
    name: 'get_provenance_summary',
    description:
      'Who chose the category on each transaction. Read this before proposing any bulk re-categorization. category_source is NULL on most of this ledger because provenance only started being recorded partway through: NULL means nobody recorded who chose, NOT that the count is zero and NOT that the machine did it. Rows the owner chose by hand are never to be overwritten, under either marker. All figures are counted live.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_transaction_full',
    description:
      'Every stored field of one transaction, including the flags that decide whether it counts: transfer_status, duplicate_status, pending, category_source and the AI action that last set the category. Amount is in dollars and negative means money left the account; quantity, when present, is a count of units of a security and is not money. reading.counts_toward_reports answers ONE question, "do the Reports and Cash flow pages include this row", evaluated with the predicates those pages use, and lists the reason whenever they do not. It does not answer it for budgets or reconciliation, which scope rows differently. Use this before making a claim about a specific row.',
    input_schema: {
      type: 'object',
      properties: { transaction_id: { type: 'string', description: 'Transaction id, from list_transactions.' } },
      required: ['transaction_id'],
    },
  },
  {
    name: 'get_my_action_history',
    description:
      'What the AI has already applied to this ledger, newest first, with how many rows each action can still put back. An action stops being revertable once a later action or a hand edit writes the same row, and it reads 0 for an action that changed no categories at all. This is a record of what was DONE, not of whether it was right: nothing yet records a correction, so an action the owner has since fixed by hand looks identical here. Check this before repeating a suggestion.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max actions to return (default 25, max 200).' } },
    },
  },
  {
    name: 'get_holding_history',
    description:
      'Value, quantity and price over time for one holding, oldest first, one point per day the sync recorded it. value and cost_basis are dollars; price is DOLLARS PER UNIT and quantity is a share or coin count, so neither is a total. A NULL cost_basis means the basis is unknown, not zero, so do not present a gain against it.',
    input_schema: {
      type: 'object',
      properties: {
        holding_id: { type: 'string', description: 'Holding id, as returned in the "id" field by list_holdings.' },
        days: { type: 'integer', description: 'Lookback window in days (default 90, max 3650).' },
      },
      required: ['holding_id'],
    },
  },
  {
    name: 'get_sync_runs',
    description:
      'Recent sync attempts, newest first: when each ran, whether it succeeded, and what it counted. A run with no completed_at never finished, which is different from failing. A steady non-zero transactions_modified every hour means the provider keeps rewriting the same rows and is a symptom worth naming. Pass run_id for the per-provider stages and the row-level changes of one run.',
    input_schema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Expand one run into its stages and row-level changes.' },
        limit: { type: 'integer', description: 'Max runs to return (default 10, max 100).' },
      },
    },
  },
  {
    name: 'get_reconciliation',
    description:
      'Does the ledger explain each account\'s balance? Compares measured balance sheets against the transactions between them, cumulatively, in dollars. Read adjusted_residual, not residual: boundary_amount is the part that is an artifact of where the horizon was cut, and it is reported separately rather than hidden. A market-driven account (brokerage, IRA, crypto wallet) moves when prices move with no transaction recording it, so its residual is expected and it is never listed as unreconciled. direction_conflict means the ledger and the balance moved in OPPOSITE directions on an account whose balance only moves when a transaction moves it; it is not a claim that a specific transaction is missing or mis-signed. Every derived field is defined in the "field_meanings" block of the result: read it before quoting one. An empty "unreconciled" list means nothing is unexplained beyond tolerance; it does not mean every number is right.',
    input_schema: {
      type: 'object',
      properties: { since: { type: 'string', description: 'Only use measured snapshots on or after this date, YYYY-MM-DD.' } },
    },
  },
  // ── Write tools ─────────────────────────────────────────────────────────────
  // Scoped to the autonomous domain (see DRAFT_KIND_AUTONOMY in draftAutonomy.ts): categorization
  // and merchant rules only. Budgets, goals, recurring adjustments, and cost basis stay
  // draft-and-confirm, because those are targets the owner set rather than observations.
  // These route through the typed service functions, never through run_sql_query: the read-only
  // connection stays the hard boundary for model-authored SQL.
  {
    name: 'categorize_transactions',
    description:
      'Set the category on one or more transactions. Applies immediately and is recorded as an AI action the user can undo in one click. Use the ids returned by list_transactions. Prefer leaving a genuinely ambiguous merchant alone over guessing.',
    input_schema: {
      type: 'object',
      properties: {
        transaction_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Transaction ids to categorize (max 200 per call).',
        },
        category_id: { type: 'string', description: 'Category id, not its display name.' },
      },
      required: ['transaction_ids', 'category_id'],
    },
  },
  {
    name: 'create_merchant_rule',
    description:
      'Create a standing rule mapping a merchant pattern to a category, so future transactions from that merchant categorize themselves. Optionally apply it to existing uncategorized transactions too. Matching is fuzzy, so a broad pattern can sweep in more than you intend: prefer the specific merchant name.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Merchant name to match.' },
        category_id: { type: 'string', description: 'Category id, not its display name.' },
        apply_existing: {
          type: 'boolean',
          description: 'Also categorize existing uncategorized transactions that match. Defaults to true.',
        },
      },
      required: ['pattern', 'category_id'],
    },
  },
  {
    name: 'describe_schema',
    description:
      'What the columns MEAN, not just what they are called. Call it with NO arguments first: that returns every table with its purpose and its column names, full per-column units and notes for transactions, accounts and categories, the exact predicate text every spend or income query must apply (generated from the shared filter functions, so it is what the Reports page uses), the meaning of each enum value alongside its live distribution, the sign and unit rules, and which series are reconstructions rather than measurements. Call it AGAIN with tables: ["holdings"] to get the column meanings of any other table; that second form returns only those tables, not the whole dictionary again. A table marked detail = "names_only" has had its notes withheld to keep the answer small, which is NOT a statement that none exist, so expand a table before writing SQL against it. Paste the predicates rather than paraphrasing them. It also supplies today\'s LOCAL date, which SQLite\'s date(\'now\') does not agree with.',
    input_schema: {
      type: 'object',
      properties: {
        tables: {
          type: 'array',
          items: { type: 'string' },
          description: 'Table names to expand to full column meanings, e.g. ["holdings", "budgets"].',
        },
      },
    },
  },
  {
    name: 'run_sql_query',
    description:
      'Run a read-only SQL SELECT against the finance database for anything the other tools do not cover (custom aggregates, joins, cohorts, arbitrary questions). Only SELECT is allowed: the connection is read-only and the engine rejects writes. Call describe_schema first, both for names and for the predicates a spend or income query must carry. IMPORTANT: money columns (transactions.amount, accounts.current_balance, budgets.amount, net_worth_snapshots.*, holdings.institution_value) are INTEGER CENTS, so divide by 100.0 for dollars; holdings.institution_price is already dollars per unit and transactions.quantity is a unit count, so neither of those is. Results are capped at "limit" rows, and a query that outruns its wall-clock budget is killed and tells you the budget it exceeded, so you can narrow it and retry.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single read-only SELECT statement.' },
        limit: { type: 'integer', description: 'Max rows to return (default 100, max 500).' },
      },
      required: ['sql'],
    },
  },
];

/**
 * The same tools in provider-neutral form, DERIVED from the list above rather than written
 * twice. Each provider renames the schema field its own way (`input_schema` on Anthropic,
 * `parameters` on OpenAI, `parametersJsonSchema` on Gemini), and a second hand-maintained
 * list would be one more pair of things that have to agree by hand.
 *
 * Every name here also satisfies Gemini's stricter rule (leading letter or underscore, then
 * letters, digits, `_`, `.`, `:`, `-`, at most 128 characters); `tests/aiRequestShape.test.ts`
 * asserts it rather than leaving it to a 400 on the first Gemini chat.
 */
export const ADVISOR_TOOL_SPECS: readonly AdvisorToolSpec[] = ADVISOR_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description ?? '',
  parameters: tool.input_schema as unknown as Record<string, unknown>,
}));

type ToolInput = Record<string, unknown>;

/** Local "today" as yyyy-MM-dd. Every date boundary in this app is local (services/dates.ts). */
function todayLocal(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function listTransactionsTool(db: Database.Database, input: ToolInput): unknown {
  const filters: TransactionListFilters = {
    page: 1,
    limit: Math.min(Math.max(Number(input.limit) || 50, 1), 200),
    sortBy: 'date',
    sortDir: 'desc',
    accountIds: str(input.account_id) ? [str(input.account_id)!] : [],
    categoryIds: str(input.category_id) ? [str(input.category_id)!] : [],
    startDate: str(input.start_date),
    endDate: str(input.end_date),
    search: str(input.merchant),
    minAmount: num(input.min_amount),
    maxAmount: num(input.max_amount),
    type: input.type === 'income' || input.type === 'expense' ? input.type : undefined,
  };
  const { rows, total } = listTransactions(db, filters);
  return {
    total,
    returned: rows.length,
    transactions: rows.map((r) => ({
      id: r.id,
      date: r.date,
      merchant: r.merchant_name ?? r.original_name ?? null,
      amount: toDollars(Number(r.amount)),
      category: r.category_name ?? null,
      account: r.account_name ?? null,
    })),
  };
}

/**
 * A share of a signed total is not a share of anything.
 *
 * `SpendingReport.percentage` is `amount / total`, and `total` is the SIGNED sum: a category whose
 * refunds exceeded its purchases subtracts from it. Handing those out as `percent_of_total` made
 * the positive categories' shares sum well past 100. Measured 2026-07-31 against a copy of
 * `.mizan/mizan.db` at migration 054, for 2026-07-01 onward: the total is 111299 cents while
 * Shopping is -102863, so the eight positive categories alone published 192.3% between them.
 *
 * A percentage is therefore emitted only when the denominator is a quantity: a positive total with
 * no negative part. Otherwise every share is null and the payload says which fact made it so, so
 * the model reads an absence rather than inferring one from a missing key.
 */
function spendingByCategoryTool(db: Database.Database, input: ToolInput): unknown {
  const top = Math.min(Math.max(Number(input.top) || 10, 1), 50);
  const report = getSpendingReport(db, {
    startDate: str(input.start_date),
    endDate: str(input.end_date),
    parentOnly: true,
  });

  const negativeCategories = report.categories.filter((category) => category.amount < 0);
  const sharesAreMeaningful = report.total > 0 && negativeCategories.length === 0;
  const shareNote = sharesAreMeaningful
    ? null
    : report.total <= 0
      ? 'percent_of_total is null: the window\'s total spending is not positive, so there is no quantity to take a share of.'
      : `percent_of_total is null: ${negativeCategories
          .map((category) => category.category_name)
          .join(', ')} net negative in this window (refunds and credits exceeded purchases), so the total is a signed sum and shares of it would not add to 100.`;

  return {
    total: toDollars(report.total),
    // Named rather than left to the reader: `total` is the signed sum, so it is smaller than the
    // sum of the positive categories whenever any category netted negative.
    total_is_signed_sum: true,
    negative_categories: negativeCategories.map((category) => ({
      category: category.category_name,
      net: toDollars(category.amount),
    })),
    share_note: shareNote,
    categories: report.categories.slice(0, top).map((category) => ({
      category: category.category_name,
      spent: toDollars(category.amount),
      percent_of_total: sharesAreMeaningful ? Math.round(category.percentage * 10) / 10 : null,
    })),
  };
}

function monthlyCashflowTool(db: Database.Database, input: ToolInput): unknown {
  const months = Math.min(Math.max(Number(input.months) || 6, 1), 36);
  const now = new Date();
  const report = getCashflowReport(db, {
    startDate: format(startOfMonth(subMonths(now, months - 1)), 'yyyy-MM-dd'),
    endDate: todayLocal(),
  });

  // getCashflowReport returns oldest-first; this tool documents newest-first.
  return {
    months: [...report.months].reverse().map((month) => ({
      month: month.month,
      income: toDollars(month.income),
      expenses: toDollars(month.expenses),
      net: toDollars(month.net),
    })),
  };
}

function getBudgetsTool(db: Database.Database): unknown {
  const now = new Date();
  const budgets = getMonthlyBudgetsWithProjection(db, now.getFullYear(), now.getMonth() + 1);

  return {
    month: format(now, 'yyyy-MM'),
    budgets: budgets.map((budget) => ({
      category: budget.category_name ?? 'Unknown category',
      budget: toDollars(budget.amount),
      spent: toDollars(budget.spent ?? 0),
      remaining: toDollars(budget.amount - (budget.spent ?? 0)),
      // Spend already committed for the rest of the month via detected recurring items.
      expected_recurring: toDollars(budget.expected_recurring ?? 0),
      projected_spend: toDollars(budget.projected_spend ?? 0),
      rollover_balance: toDollars(budget.rollover_balance ?? 0),
    })),
  };
}

/**
 * The same goal figures the system prompt is already showing the model.
 *
 * This used to run its own SQL with no `LEFT JOIN accounts` and divide `current_amount` by
 * `target_amount` by hand. `aiContext.ts` builds the prompt through `calculateGoalProgress`, which
 * overrides `current_amount` with the linked account's balance, so the model could read "$0.00
 * saved, $5,000.00 to go" in its own context and then call `list_goals` and be told $1,001.70 at
 * 20%, inside one conversation, about one goal. That is the parallel-SQL drift this file was
 * created to end: it already delegates every aggregate to `reporting.ts` and friends for exactly
 * this reason, and goals were the one thing still computed here.
 */
function listGoalsTool(db: Database.Database): unknown {
  const rows = db.prepare(`
    SELECT g.name, g.type, g.target_amount, g.current_amount, g.starting_amount, g.target_date,
           a.current_balance AS account_balance
    FROM goals g
    LEFT JOIN accounts a ON a.id = g.account_id
    WHERE g.is_archived = 0 ORDER BY g.name
  `).all() as Array<GoalProgressInput & { name: string; target_date: string | null }>;
  return {
    goals: rows.map((r) => {
      const progress = calculateGoalProgress(r);
      return {
        name: r.name,
        type: r.type,
        target: toDollars(r.target_amount),
        current: toDollars(progress.current_amount),
        remaining: toDollars(progress.remaining_amount),
        progress_pct: Math.round(progress.progress_percent),
        target_date: r.target_date,
      };
    }),
  };
}

// Every holding, including crypto and holdings in hidden accounts, with the owning account
// named so the model can separate brokerage from wallet itself. The context snapshot's
// portfolio block deliberately excludes crypto (it is already counted under Net Worth there);
// this tool is the unfiltered view, and its description says so.
//
// A provider basis of 0 reads as unknown (migration 043); reported as a number it would tell the
// model a cash sweep is 100% profit and invite it to say so.
function listHoldingsTool(db: Database.Database): unknown {
  const rows = db.prepare(`
    SELECT h.id AS holding_id, s.ticker, s.name, s.type, h.quantity,
      h.institution_value AS value_cents,
      COALESCE(h.manual_cost_basis, CASE WHEN h.cost_basis > 0 THEN h.cost_basis END) AS basis_cents,
      a.account_name, a.type AS account_type, a.is_hidden
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN accounts a ON a.id = h.account_id
    ORDER BY h.institution_value DESC
  `).all() as Array<{
    holding_id: string; ticker: string | null; name: string; type: string; quantity: number;
    value_cents: number; basis_cents: number | null;
    account_name: string | null; account_type: string | null; is_hidden: number | null;
  }>;
  return {
    holdings: rows.map((r) => ({
      // Carried so get_holding_history has something to be called with.
      id: r.holding_id,
      ticker: r.ticker,
      name: r.name,
      type: r.type,
      quantity: r.quantity,
      value: toDollars(r.value_cents),
      cost_basis: r.basis_cents == null ? null : toDollars(r.basis_cents),
      unrealized_gain: r.basis_cents == null ? null : toDollars(r.value_cents - r.basis_cents),
      account: r.account_name,
      account_type: r.account_type,
      account_hidden: r.is_hidden === 1,
    })),
  };
}

function getUpcomingBillsTool(db: Database.Database, input: ToolInput): unknown {
  const days = Math.min(Math.max(Number(input.days) || 45, 1), 180);
  const forecast = buildRecurringForecast(db, days);

  // The forecast already honors per-occurrence skip/snooze/adjust overrides and projects each
  // pattern forward by its cadence. Reading recurring_patterns.next_expected directly (as this
  // tool used to) reports a single stale date per pattern and ignores every adjustment.
  const bills = forecast.occurrences.filter((o) => o.adjustment_action !== 'skip');

  return {
    window_days: days,
    scheduled_income: toDollars(forecast.income),
    scheduled_bills: toDollars(forecast.bills),
    scheduled_net: toDollars(forecast.net),
    bills: bills.map((o) => ({
      merchant: o.merchant_name,
      amount: toDollars(o.amount),
      // True when the pattern was admitted on cadence alone: the amount is a median, not a
      // known figure, and should not be quoted as if it were exact.
      amount_varies: o.amount_varies,
      frequency: o.frequency,
      due: o.expected_date,
      status: o.status,
      confirmed: o.is_confirmed,
      category: o.category_name,
    })),
  };
}

function getNetWorthHistoryTool(db: Database.Database, input: ToolInput): unknown {
  const months = Math.min(Math.max(Number(input.months) || 12, 1), 60);
  // date('now') is UTC and disagrees with the local month boundaries every other surface uses,
  // so the cutoff is computed in local time here rather than in SQLite.
  const since = format(startOfMonth(subMonths(new Date(), months)), 'yyyy-MM-dd');
  const rows = readSnapshots(db, { since, order: 'asc' });
  return {
    history: rows.map((r) => ({
      date: r.date,
      net_worth: toDollars(r.net_worth),
      assets: toDollars(r.total_assets),
      liabilities: toDollars(r.total_liabilities),
      // A reconstruction, not a measurement. Without this the model narrates the join between the
      // estimated and measured segments as an observed event.
      estimated: r.is_estimated,
    })),
  };
}

interface MerchantRuleRow {
  id: string;
  pattern: string;
  category_id: string;
  category_name: string | null;
  source: string;
  created_at: string;
  retired_at: string | null;
}

// The ORDER BY is the resolution policy, and it is the same one
// `applyMerchantRulesToExistingTransactions` (rules.ts) sorts by before taking the first match:
// owner rules ahead of the model's, longer pattern ahead of shorter, then created_at, then id so
// the order is total and SQLite's sorter never decides. Reporting a different order here would tell
// the model a rule wins that does not.
//
// It is duplicated rather than imported because rules.ts keeps its ordered loader private. The
// duplication is pinned, not trusted: tests/advisorChatTools.test.ts asserts this tool's winner is
// the category the apply path actually writes, so a change to rules.ts that is not mirrored here
// fails rather than drifts. If that loader is ever exported, delete this query and call it.
function getMerchantRulesTool(db: Database.Database, input: ToolInput): unknown {
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const includeRetired = input.include_retired === true;
  const merchant = str(input.merchant);

  // Every rule, unlimited, because resolution has to see all of them. Resolving over one page and
  // reporting "no rule matches" would be a claim the query never checked: on the owner's ledger
  // there are 236 rules and the default page is 100, so the Spotify rule sat off the end and the
  // tool reported no winner for a merchant that has one. The limit applies to the LIST, after the
  // winner is known, and the winner is always carried into it.
  const all = db.prepare(`
    SELECT mr.id, mr.pattern, mr.category_id, c.name AS category_name,
           mr.source, mr.created_at, mr.retired_at
    FROM merchant_rules mr
    LEFT JOIN categories c ON c.id = mr.category_id
    ${includeRetired ? '' : 'WHERE mr.retired_at IS NULL'}
    ORDER BY (mr.source = 'ai') ASC,
             length(mr.pattern) DESC,
             mr.created_at DESC,
             mr.id ASC
  `).all() as MerchantRuleRow[];

  // Asked about ONE merchant, answer about that merchant. Returning the whole rule book alongside
  // the winner cost 28,160 bytes of tool result for a one-merchant question, measured as
  // Buffer.byteLength(JSON.stringify(runAdvisorTool(liveDb, 'get_merchant_rules',
  // { merchant: 'SPOTIFY 877-778-1161, NY' })), 'utf8') on a copy of the owner's database: 101 of
  // the 236 rules came back and exactly ONE of them matched the merchant that was asked about. The
  // same call filtered is 1,136 bytes. Resolution still tests every rule; only the LIST narrows,
  // and a retired rule is listed when it was asked for but never wins.
  const patternMatches = merchant ? all.filter((rule) => merchantMatchesRulePattern(merchant, rule.pattern)) : [];
  const winner = merchant ? patternMatches.find((rule) => rule.retired_at === null) : undefined;

  const shown = merchant ? patternMatches.slice(0, limit) : all.slice(0, limit);
  if (winner && !shown.includes(winner)) shown.push(winner);

  return {
    resolution_order: 'Owner rules before AI rules, then longer pattern first, then newest, then id. First match wins.',
    total_rules: all.length,
    returned: shown.length,
    ...(merchant
      ? {
          merchant,
          listing:
            'Only rules whose pattern matches this merchant are listed, in resolution order, and the first live one is the winner. Every rule in the database was tested against the name; the ones left out cannot match it. Call without "merchant" to page through the whole rule book.',
          winning_rule: winner
            ? { id: winner.id, pattern: winner.pattern, category: winner.category_name, source: winner.source }
            : null,
        }
      : {}),
    rules: shown.map((rule) => ({
      id: rule.id,
      // Rank in the full resolution order, not in this list: rule 1 is the first rule tested.
      precedence: all.indexOf(rule) + 1,
      pattern: rule.pattern,
      category: rule.category_name,
      category_id: rule.category_id,
      source: rule.source,
      created_at: rule.created_at,
      retired: rule.retired_at !== null,
      ...(merchant
        ? {
            matches_merchant: rule.retired_at === null && merchantMatchesRulePattern(merchant, rule.pattern),
            wins: rule === winner,
          }
        : {}),
    })),
  };
}

function getProvenanceSummaryTool(db: Database.Database): unknown {
  return getCategoryProvenance(db);
}

// Named for the reports it answers for, because no single boolean answers "does this count" for
// every surface. Budgets apply excluded_from_totals and pending = 0 but not the category-tree scope
// (budgetProjection.ts), and reconciliation applies pending = 0 and nothing else
// (reconciliation.ts), so a row can legitimately count on one screen and not another.
const COUNTS_TOWARD_REPORTS_DEFINITION =
  'Whether getSpendingReport (the Reports page) and getCashflowReport count this row: it must survive excluded_from_totals, sit outside the cat_xfer / cat_inv / cat_crypto category trees, have pending = 0, and land on the income or expense side. Evaluated with the same predicate strings describe_schema publishes, so it agrees with those two pages and with nothing else: budgets and reconciliation scope rows differently.';

function getTransactionFullTool(db: Database.Database, input: ToolInput): unknown {
  const id = str(input.transaction_id);
  if (!id) return { error: 'Provide a transaction id in "transaction_id".' };
  const row = getTransactionById(db, id);
  if (!row) return { error: `No transaction with id ${id}.` };

  const inclusion = transactionReportInclusion(db, id);
  if (!inclusion) return { error: `Transaction ${id} could not be evaluated against the report predicates.` };

  // `amount` is the only money column on the row. `quantity` is a unit count and stays as stored;
  // dollarizing it would turn 0.0031964 BTC into three ten-thousandths of a coin.
  return {
    transaction: dollarizeFields(row, ['amount']),
    reading: {
      amount: 'Dollars. Negative means money left the account. A positive amount in an expense category is a refund, not income.',
      counts_toward_reports: {
        spending_and_cashflow: inclusion.counts,
        side: inclusion.side,
        excluded_because: inclusion.excluded_because,
        definition: COUNTS_TOWARD_REPORTS_DEFINITION,
      },
      category_source:
        row.category_source == null
          ? 'NULL: categorized before provenance was recorded. Nobody knows who chose it.'
          : `Set by: ${String(row.category_source)}.`,
    },
  };
}

function getMyActionHistoryTool(db: Database.Database, input: ToolInput): unknown {
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 200);
  const actions = listAdvisorActions(db, limit);
  return {
    actions: actions.map((action) => ({
      ...action,
      // Counted, not assumed: a later write on the same row buries this action's revision until the
      // later one is undone, and an action that changed no category has none to begin with.
      rows_still_revertable: revertableRevisionsForAction(db, action.id).length,
    })),
    note: 'Nothing in this database records whether an action was correct, so absence of a complaint is not agreement.',
  };
}

function getHoldingHistoryTool(db: Database.Database, input: ToolInput): unknown {
  const holdingId = str(input.holding_id);
  if (!holdingId) return { error: 'Provide a holding id in "holding_id".' };
  const days = Math.min(Math.max(Number(input.days) || 90, 1), 3650);

  let points;
  try {
    points = getHoldingHistory(db, holdingId, days);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Holding not found' };
  }

  return {
    holding_id: holdingId,
    window_days: days,
    points: points.map((point) => ({
      date: point.date,
      quantity: point.quantity,
      // Per-unit price is REAL dollars in the DB and is NOT cents (services/money.ts).
      price_per_unit: point.institution_price,
      value: toDollars(point.institution_value),
      cost_basis: toDollarsOrNull(point.cost_basis),
    })),
  };
}

function getSyncRunsTool(db: Database.Database, input: ToolInput): unknown {
  const runId = str(input.run_id);
  if (runId) {
    try {
      return { run: getSyncRunDetail(db, runId) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Sync run not found' };
    }
  }
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 100);
  return { runs: listSyncRuns(db, limit) };
}

const RECONCILIATION_MONEY_FIELDS = [
  'observed_delta',
  'explained_delta',
  'residual',
  'boundary_amount',
  'adjusted_residual',
  'largest_window_residual',
] as const;

// Every field on an account row is DERIVED, and none of them is a column the model can look up in
// describe_schema, which documents tables. `direction_conflict` reads true on the owner's data right
// now, and a true boolean whose meaning the model has to guess is worse than no boolean: it invites
// a confident wrong sentence. Shipped with the data rather than only in the tool description,
// because the description is read once and the numbers are read every time.
const RECONCILIATION_FIELD_MEANINGS: Record<string, string> = {
  observed_delta:
    'Dollars the account\'s measured balance actually moved across the whole horizon, expressed as a movement in NET WORTH, so a liability\'s balance movement is negated first.',
  explained_delta: 'Dollars the transactions in that horizon account for, same net-worth sign convention.',
  residual: 'observed_delta minus explained_delta. Not the figure to judge: read adjusted_residual.',
  boundary_amount:
    'The part of residual that is an artifact of where the horizon was cut. The window is date > previous AND date <= current, so a row dated on the FIRST snapshot is outside explained_delta while its balance effect is inside the horizon. Reported separately rather than netted away.',
  adjusted_residual: 'residual minus boundary_amount. THIS is the figure judged, and what unreconciled is decided on.',
  direction_conflict:
    'The ledger and the balance point OPPOSITE WAYS: observed_delta and the boundary-adjusted ledger movement (explained_delta + boundary_amount) have different signs, both are non-zero, and the ledger side is over $5.00. It says the transactions claim money came IN while the balance went DOWN, or the reverse. Reported for non-market-driven accounts ONLY, because on a brokerage observed_delta is transfers plus market profit and loss and a deposit during a down month produces opposite signs with nothing wrong at all. It is a direction disagreement, NOT a claim that a transaction is missing or mis-signed, and it does not on its own put the account in unreconciled.',
  largest_window_residual: 'The largest single-window residual, roughly the size of the provider posting lag.',
  residual_ratio:
    'adjusted_residual as a share of the transaction volume through the account (a ratio, not dollars). An account is listed in unreconciled when it is not market-driven, its adjusted_residual exceeds $5.00, and either this ratio exceeds 0.02 or it is NULL because no volume moved at all.',
  is_market_driven:
    'Brokerage, IRA and crypto-wallet accounts, whose balance moves when prices move with no transaction recording it. Their residual is expected and they are never listed as unreconciled.',
  window_count: 'How many measured snapshot pairs this account appears in. Estimated snapshots are excluded entirely.',
  unreconciled:
    'The subset of accounts whose adjusted_residual is beyond tolerance. Empty means nothing is unexplained beyond tolerance; it does not mean every number is right.',
  unreconciled_residual:
    'Dollars of adjusted_residual summed over the accounts in unreconciled, and nothing else, as a MAGNITUDE: each account contributes the absolute size of its own adjusted_residual, so two accounts unexplained in opposite directions add up rather than cancelling. This is the size of what is unexplained, and because every listed account cleared a $5.00 floor to be listed it is 0.00 exactly when unreconciled is empty. It carries no direction; read each account\'s own adjusted_residual for that.',
  residual_all_accounts:
    'Dollars of raw residual summed over EVERY judged account, including the market-driven ones that are never unreconciled and the boundary artifact adjusted_residual removes. It is NOT the size of a gap and is routinely large while unreconciled is empty. Read unreconciled_residual for that.',
};

function getReconciliationTool(db: Database.Database, input: ToolInput): unknown {
  const report = reconcileAccounts(db, { since: str(input.since) });
  const dollarize = (account: (typeof report.accounts)[number]): Record<string, unknown> =>
    dollarizeFields(account as unknown as Record<string, unknown>, RECONCILIATION_MONEY_FIELDS);

  return {
    measured_snapshot_count: report.measured_snapshot_count,
    // `total_residual` used to be published here bare, so the model was handed
    // `total_residual: 1347.48` beside `unreconciled: []` and had to guess which one was the
    // finding. It summed raw `residual` over every account, which is the market-driven price moves
    // and the horizon-cut boundary the `unreconciled` filter removes on purpose. Both populations
    // are now named.
    unreconciled_residual: toDollars(unreconciledResidual(report)),
    residual_all_accounts: toDollars(report.total_residual),
    unreconciled: report.unreconciled.map(dollarize),
    accounts: report.accounts.map(dollarize),
    reading:
      'adjusted_residual is the figure judged; boundary_amount is the part explained by where the horizon was cut and is reported separately rather than netted away silently. Market-driven accounts are never listed as unreconciled because a price move is not a gap in the ledger. unreconciled_residual is the total of what is unexplained; residual_all_accounts is a wider sum that includes both exemptions and is not a gap.',
    field_meanings: RECONCILIATION_FIELD_MEANINGS,
  };
}

// The curated dictionary, composed with the live column list. PRAGMA alone tells the model that
// `amount` is an INTEGER; it does not tell it the integer is cents, that a positive one inside an
// expense category is a refund, or that summing it without excludedFromTotalsSql counts the owner's
// own transfers as spending. schemaDoc.ts carries that, and generates the predicate text from the
// real functions so it cannot drift.
//
// It reads the connection it was HANDED. It used to call getReadOnlyDb() and so described a
// different database from every other tool in this file, which is also what forced its test to open
// the owner's installed .mizan/mizan.db.
function describeSchemaTool(db: Database.Database, input: ToolInput): unknown {
  // A single name arrives as a bare string often enough to be worth accepting; ignoring it would
  // silently answer a narrow question with the whole dictionary.
  const raw = Array.isArray(input.tables) ? input.tables : typeof input.tables === 'string' ? [input.tables] : [];
  const requested = [
    ...new Set(raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())),
  ];
  return requested.length > 0 ? describeTables(db, requested) : buildSchemaDoc(db);
}

/**
 * Model-authored SQL, run OUT OF PROCESS on a read-only copy of the connection.
 *
 * It was already write-proof: the connection is opened `{ readonly: true }`, so the engine itself
 * rejects a write. It was not TIME-proof, and that is the more likely failure. This app is a single
 * process that also serves the UI, better-sqlite3 is synchronous, and one unbounded recursive CTE
 * from the model freezes every screen the owner has open until they kill the server.
 *
 * WHY A CHILD PROCESS, having tried the alternatives:
 *
 *  - There is no in-process kill. better-sqlite3 binds neither `sqlite3_interrupt` nor
 *    `sqlite3_progress_handler`, so nothing can cancel a query from the thread that is blocked
 *    inside `sqlite3_step`.
 *  - Checking a deadline between rows with `stmt.iterate()` looks like it works and does not. The
 *    deadline is only reached when a row is PRODUCED, so a runaway that filters everything out, or
 *    a bare aggregate over a cartesian product, never returns to JS at all.
 *  - A worker thread does not fix it either. `worker.terminate()` cannot preempt a blocked native
 *    call; in testing it segfaulted the whole process, and not terminating leaves a thread spinning
 *    on a core for as long as the query runs, which for an infinite CTE is forever.
 *  - `spawnSync`'s `timeout` is an OS-level SIGKILL. It always lands, it cannot corrupt anything
 *    (the child holds a read-only handle), and it keeps the tool call SYNCHRONOUS, which it must be
 *    because the chat loop calls it inline.
 *
 * The cost is one node process per model-authored query, measured at roughly 85 ms, which is noise
 * beside the model round-trip it sits inside. It buys a hard ceiling on how long the owner's app
 * can be frozen by a question the model asked badly.
 */
const DEFAULT_SQL_QUERY_TIMEOUT_MS = 5000;
const SQL_QUERY_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Read per call rather than at import, so a test can shorten it and a bigger database can be given
// more room without a rebuild. A value under 250 ms would start killing honest queries, so it is
// floored rather than trusted.
function sqlQueryTimeoutMs(): number {
  const configured = Number(process.env.MIZAN_SQL_QUERY_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SQL_QUERY_TIMEOUT_MS;
  return Math.max(configured, 250);
}

// Runs in a bare `node -e`. argv[1] is the resolved better-sqlite3 entry point and argv[2] is the
// database file; the request arrives on stdin so no SQL is ever placed on a command line.
const SQL_CHILD_SOURCE = `
const Database = require(process.argv[1]);
const request = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
function emit(payload) { process.stdout.write(JSON.stringify(payload)); }
let db;
try {
  db = new Database(process.argv[2], { readonly: true });
} catch (err) {
  emit({ kind: 'error', message: 'Could not open the database read-only: ' + err.message });
  process.exit(0);
}
try {
  const stmt = db.prepare(request.sql);
  if (!stmt.reader) {
    emit({ kind: 'not_reader' });
    process.exit(0);
  }
  const rows = [];
  let truncated = false;
  for (const row of stmt.iterate()) {
    if (rows.length >= request.limit) { truncated = true; break; }
    rows.push(row);
  }
  emit({ kind: 'rows', rows: rows, truncated: truncated });
} catch (err) {
  emit({ kind: 'error', message: err.message });
}
process.exit(0);
`;

type SqlChildResult =
  | { kind: 'rows'; rows: unknown[]; truncated: boolean }
  | { kind: 'not_reader' }
  | { kind: 'error'; message: string };

function runSqlQueryTool(input: ToolInput): unknown {
  const sql = str(input.sql);
  if (!sql) return { error: 'Provide a SQL SELECT statement in "sql".' };
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const timeoutMs = sqlQueryTimeoutMs();

  const child = spawnSync(
    process.execPath,
    ['-e', SQL_CHILD_SOURCE, '--', require.resolve('better-sqlite3'), getReadOnlyDbPath()],
    {
      input: JSON.stringify({ sql, limit }),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: SQL_QUERY_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    }
  );

  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      return {
        error: `Query exceeded the ${timeoutMs} ms budget and was killed. No rows were returned and nothing was changed.`,
        timed_out: true,
        timeout_ms: timeoutMs,
        // Say what to do about it, not just that it failed.
        suggestion:
          'Narrow it before retrying: add a WHERE clause on a date range or an account_id, aggregate instead of listing rows, avoid joins with no ON condition, and bound any recursive CTE.',
      };
    }
    if (code === 'ENOBUFS') {
      return {
        error: 'Query returned more data than can be handled. Lower "limit", select fewer columns, or aggregate.',
      };
    }
    return { error: `Query could not be run: ${child.error.message}` };
  }

  if (!child.stdout) {
    const detail = (child.stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return { error: `Query failed: ${detail || 'the query process produced no output'}` };
  }

  let payload: SqlChildResult;
  try {
    payload = JSON.parse(child.stdout) as SqlChildResult;
  } catch {
    return { error: 'Query failed: the result could not be read back.' };
  }

  if (payload.kind === 'not_reader') {
    return { error: 'Only read-only SELECT queries are allowed.' };
  }
  if (payload.kind === 'error') {
    return { error: `SQL error: ${payload.message}` };
  }
  return {
    row_count: payload.rows.length,
    truncated: payload.truncated,
    rows: payload.rows,
    note: 'Money columns are integer cents, so divide by 100 for dollars. holdings.institution_price and transactions.quantity are not cents; see describe_schema.',
  };
}

/**
 * What a chat-tool write is called in the audit trail.
 *
 * IS A CHAT WRITE UNATTENDED? It is neither that nor the opposite, and that is the problem. The
 * owner is present and asked for it, so it is not the background pass; the owner approved no
 * individual row, so it is not a confirmation either. `categorize_transactions` applies up to 200 rows from one tool call the
 * owner saw as a sentence. `advisor_actions.source` holds exactly two values under a CHECK
 * constraint ('worker_auto', 'user_confirm'), and writing 'user_confirm' here would put a
 * confirmation in the trail that never happened, so this path keeps 'worker_auto' and says which
 * surface it came from in the one field left that the trail carries per action. The column wants a
 * third value; that is a migration, not a rename.
 */
export const CHAT_TOOL_ACTION_PREFIX = 'Advisor chat: ';

/** Every kind the chat write tools may emit. Named so the autonomy check below has a list to test. */
export const CHAT_WRITE_KINDS = ['categorize_transaction', 'create_merchant_rule'] as const;

interface WriteOutcome {
  applied: boolean;
  changed?: number;
  detail?: unknown;
  error?: string;
}

// Both write tools go through confirmAdvisorDraft, the same path a confirmed draft takes, so
// they get the payload validation, the advisor_actions audit row, and the per-row provenance
// stamp for free. A write that skipped it would be invisible to undo.
function applyWriteDraft(
  db: Database.Database,
  payload: AdvisorDraftPayload,
  label: string,
  summary: string
): WriteOutcome {
  // The third enforcement site for the autonomy boundary, after the two in aiJobs.ts. It cannot
  // fire on anything shipped today: both kinds in CHAT_WRITE_KINDS are declared autonomous, and a
  // test pins that. It exists so a third write tool cannot reach a write path this file never
  // checked, which is exactly how this path came to apply 200 rows outside the framework.
  if (!isAutonomousDraftKind(payload.kind)) {
    return {
      applied: false,
      error: `'${payload.kind}' is not in the autonomous domain, so it cannot be applied from a conversation. Propose it as a draft instead.`,
    };
  }

  try {
    const response = confirmAdvisorDraft(
      db,
      {
        id: draftIdFor(payload),
        kind: payload.kind,
        label: `${CHAT_TOOL_ACTION_PREFIX}${label}`,
        summary,
        route: '/transactions',
        payload,
        changes: [],
        citations: [],
        confirmation_required: true,
      } as AdvisorDraftAction,
      true,
      'worker_auto'
    );
    return { applied: true, changed: response.changed, detail: response.result };
  } catch (err) {
    return { applied: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

/**
 * What the model is told when the conservation guard did not come back clean.
 *
 * Two outcomes, and they say opposite things about the ledger, so they are never collapsed into one
 * "something went wrong": a reverted batch is gone and the model must not report it as done, while
 * a failed revert is still standing and the model must not report it as taken back.
 */
interface GuardNote {
  status: 'reverted' | 'revert_failed';
  incident_id: string | null;
  breaches: string[];
  note: string;
}

function guardNote(report: GuardedBatchReport<unknown>): GuardNote | null {
  if (report.status === 'clean') return null;
  const breaches = report.breaches.map((b) => `${b.headline}: ${b.detail}`);
  return {
    status: report.status,
    incident_id: report.incident_id,
    breaches,
    note: report.status === 'reverted'
      ? `The ledger's headline figures moved by more than these writes account for, so the batch was taken back: ${report.reverted_rows} category write(s) reverted. The revert walks category writes only, so a merchant rule this call created still exists and is listed in Settings. Tell the user what stands and what does not, and do not retry it blind.`
      : 'The ledger\'s headline figures moved by more than these writes account for AND the revert did not run, so the writes are still applied and an incident is open. Tell the user to check the incident before doing anything else here.',
  };
}

/**
 * Run one chat tool's writes under the same conservation guard the background pass runs under.
 *
 * WHY THE CHAT PATH IS GUARDED TOO. The guard does not ask who was present, it asks whether the
 * ledger's headline figures moved by more than this batch's own category rewrites account for, and
 * a batch of up to 200 model-authored rewrites can move them whoever asked for it. The owner
 * watching a conversation is not a reading of the month's spend before and after. The pass and the
 * tool call are the same shape of write from the same model against the same ledger, and the only
 * difference was that one of them was measured.
 *
 * The batch boundary is the tool call, for the reason `runGuardedPersist` gives for the pass: the
 * harness reverts whole, and one tool call is one answer to one request. `run` stays synchronous
 * and opens no transaction of its own, which is what the harness requires to attribute action ids.
 */
function guardedChatWrites<T>(
  db: Database.Database,
  batchName: string,
  write: () => T
): { value: T; guard: GuardNote | null } {
  const report = runGuardedCategoryBatch(db, { name: batchName, run: () => ({ value: write() }) });
  const guard = guardNote(report);
  if (guard) {
    console.error(`[advisor-chat] ${batchName}: ${guard.note} ${guard.breaches.join(' ')}`);
  }
  return { value: report.value, guard };
}

function categorizeTransactionsTool(db: Database.Database, input: ToolInput): unknown {
  const rawIds = Array.isArray(input.transaction_ids) ? input.transaction_ids : [];
  const ids = rawIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 200);
  const categoryId = str(input.category_id);
  if (ids.length === 0) return { error: 'Provide at least one transaction id in "transaction_ids".' };
  if (!categoryId) return { error: 'Provide a category id in "category_id".' };

  // One draft per transaction rather than a bulk update: each row gets its own action id, so
  // the user can undo a single bad call without reverting the whole batch.
  const { value: outcomes, guard } = guardedChatWrites(db, 'advisor_chat_categorize', () =>
    ids.map((transactionId) =>
      applyWriteDraft(
        db,
        { kind: 'categorize_transaction', transaction_id: transactionId, category_id: categoryId },
        'categorize transaction',
        `Set category ${categoryId} from the advisor conversation.`
      )
    )
  );

  const applied = outcomes.filter((o) => o.applied).length;
  if (guard?.status === 'reverted') {
    return { requested: ids.length, applied: 0, failed: ids.length, outcomes, guard };
  }
  if (guard) return { requested: ids.length, applied, failed: ids.length - applied, outcomes, guard };
  return { requested: ids.length, applied, failed: ids.length - applied, outcomes };
}

function createMerchantRuleTool(db: Database.Database, input: ToolInput): unknown {
  const pattern = str(input.pattern);
  const categoryId = str(input.category_id);
  if (!pattern) return { error: 'Provide a merchant pattern in "pattern".' };
  if (!categoryId) return { error: 'Provide a category id in "category_id".' };

  // Guarded for the same reason the categorize tool is: with apply_existing the rule sweeps every
  // matching row in the ledger, which is a category batch of a size nobody stated up front.
  const { value: outcome, guard } = guardedChatWrites(db, 'advisor_chat_merchant_rule', () =>
    applyWriteDraft(
      db,
      {
        kind: 'create_merchant_rule',
        pattern,
        category_id: categoryId,
        apply_existing: input.apply_existing === undefined ? true : input.apply_existing === true,
      },
      `create rule for ${pattern}`,
      `Future ${pattern} transactions use category ${categoryId}.`
    )
  );

  if (guard?.status === 'reverted') {
    // Reported as two facts rather than one, because the revert takes back category writes and
    // nothing else: the rows the rule swept in are back where they were and the merchant_rules row
    // is still there. Collapsing that into `applied: false` would claim a deletion that never ran.
    return { rule_created: outcome.applied, rows_applied: 0, detail: outcome.detail, guard };
  }
  if (guard) return { ...outcome, guard };
  return outcome;
}

export function runAdvisorTool(db: Database.Database, name: string, input: ToolInput): unknown {
  switch (name) {
    case 'categorize_transactions': return categorizeTransactionsTool(db, input);
    case 'create_merchant_rule': return createMerchantRuleTool(db, input);
    case 'list_transactions': return listTransactionsTool(db, input);
    case 'spending_by_category': return spendingByCategoryTool(db, input);
    case 'monthly_cashflow': return monthlyCashflowTool(db, input);
    case 'get_budgets': return getBudgetsTool(db);
    case 'list_goals': return listGoalsTool(db);
    case 'list_holdings': return listHoldingsTool(db);
    case 'get_upcoming_bills': return getUpcomingBillsTool(db, input);
    case 'get_net_worth_history': return getNetWorthHistoryTool(db, input);
    case 'get_merchant_rules': return getMerchantRulesTool(db, input);
    case 'get_provenance_summary': return getProvenanceSummaryTool(db);
    case 'get_transaction_full': return getTransactionFullTool(db, input);
    case 'get_my_action_history': return getMyActionHistoryTool(db, input);
    case 'get_holding_history': return getHoldingHistoryTool(db, input);
    case 'get_sync_runs': return getSyncRunsTool(db, input);
    case 'get_reconciliation': return getReconciliationTool(db, input);
    case 'describe_schema': return describeSchemaTool(db, input);
    case 'run_sql_query': return runSqlQueryTool(input);
    default: return { error: `Unknown tool: ${name}` };
  }
}
