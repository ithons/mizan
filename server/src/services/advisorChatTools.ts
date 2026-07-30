import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { format, startOfMonth, subMonths } from 'date-fns';
import { listTransactions, type TransactionListFilters } from './transactions';
import { getReadOnlyDb } from '../db/index';
import { toDollars } from './money';
import { getCashflowReport, getSpendingReport } from './reporting';
import { buildRecurringForecast } from './recurringForecast';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';
import { confirmAdvisorDraft } from './advisorDrafts';
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
      'Total spending grouped by top-level category over an optional date range, largest first. Amounts are positive dollars spent. Matches the Reports page exactly: transfers, investment and crypto flows, pending rows, and transactions the user resolved as duplicates are all excluded.',
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
      'Recurring bills and income expected within the next N days (default 45), soonest first, with scheduled income/bills/net totals for the window. Honors skip, snooze, and amount overrides. Amounts in dollars. Check amount_varies: when true the amount is a median of a variable series (a paycheck, a utility bill), not a known figure, so do not quote it as exact.',
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
      'Net worth, total assets, and total liabilities per snapshot over the last N months (default 12), oldest first. Amounts in dollars.',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'Number of months back to include (default 12, max 60).' },
      },
    },
  },
  // ── Write tools ─────────────────────────────────────────────────────────────
  // Scoped to the autonomous domain (see AUTONOMOUS_DRAFT_KINDS): categorization and merchant
  // rules only. Budgets, goals, recurring adjustments, and cost basis stay draft-and-confirm,
  // because those are targets the owner set rather than observations about existing data.
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
      'List the database tables and their columns. Call this before run_sql_query to see what you can query. Money columns are stored as INTEGER CENTS (divide by 100 for dollars); dates are TEXT yyyy-MM-dd.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_sql_query',
    description:
      'Run a read-only SQL SELECT against the finance database for anything the other tools do not cover (custom aggregates, joins, cohorts, arbitrary questions). Only SELECT is allowed — the connection is read-only and rejects writes. Call describe_schema first for table/column names. IMPORTANT: money columns (transactions.amount, accounts.current_balance, budgets.amount, net_worth_snapshots.*, holdings.institution_value, etc.) are INTEGER CENTS — divide by 100.0 for dollars. Results are capped at "limit" rows.',
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

function spendingByCategoryTool(db: Database.Database, input: ToolInput): unknown {
  const top = Math.min(Math.max(Number(input.top) || 10, 1), 50);
  const report = getSpendingReport(db, {
    startDate: str(input.start_date),
    endDate: str(input.end_date),
    parentOnly: true,
  });

  return {
    total: toDollars(report.total),
    categories: report.categories.slice(0, top).map((category) => ({
      category: category.category_name,
      spent: toDollars(category.amount),
      percent_of_total: Math.round(category.percentage * 10) / 10,
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

function listGoalsTool(db: Database.Database): unknown {
  const rows = db.prepare(`
    SELECT name, type, target_amount, current_amount, target_date
    FROM goals WHERE is_archived = 0 ORDER BY name
  `).all() as Array<{ name: string; type: string; target_amount: number; current_amount: number; target_date: string | null }>;
  return {
    goals: rows.map((r) => ({
      name: r.name,
      type: r.type,
      target: toDollars(r.target_amount),
      current: toDollars(r.current_amount),
      progress_pct: r.target_amount > 0 ? Math.round((r.current_amount / r.target_amount) * 100) : null,
      target_date: r.target_date,
    })),
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
    SELECT s.ticker, s.name, s.type, h.quantity,
      h.institution_value AS value_cents,
      COALESCE(h.manual_cost_basis, CASE WHEN h.cost_basis > 0 THEN h.cost_basis END) AS basis_cents,
      a.account_name, a.type AS account_type, a.is_hidden
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN accounts a ON a.id = h.account_id
    ORDER BY h.institution_value DESC
  `).all() as Array<{
    ticker: string | null; name: string; type: string; quantity: number;
    value_cents: number; basis_cents: number | null;
    account_name: string | null; account_type: string | null; is_hidden: number | null;
  }>;
  return {
    holdings: rows.map((r) => ({
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
  const rows = db.prepare(`
    SELECT date, net_worth, total_assets, total_liabilities
    FROM net_worth_snapshots
    WHERE date >= date('now', '-' || ? || ' months')
    ORDER BY date ASC
  `).all(months) as Array<{ date: string; net_worth: number; total_assets: number; total_liabilities: number }>;
  return {
    history: rows.map((r) => ({
      date: r.date,
      net_worth: toDollars(r.net_worth),
      assets: toDollars(r.total_assets),
      liabilities: toDollars(r.total_liabilities),
    })),
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function describeSchemaTool(): unknown {
  const rodb = getReadOnlyDb();
  const tables = rodb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const schema: Record<string, string[]> = {};
  for (const { name } of tables) {
    const cols = rodb.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{ name: string; type: string }>;
    schema[name] = cols.map((c) => `${c.name} ${c.type || 'ANY'}`);
  }
  return {
    schema,
    note: 'Money columns are INTEGER CENTS (÷100 for dollars). Dates are TEXT yyyy-MM-dd. Query with run_sql_query (read-only SELECT only).',
  };
}

// Executes model-authored SQL on the READ-ONLY connection (never the read-write singleton), so a
// write can't reach the data. Defense in depth: reject non-reader statements up front, and
// better-sqlite3 only compiles the first statement so a trailing `;DROP ...` is ignored.
function runSqlQueryTool(input: ToolInput): unknown {
  const sql = str(input.sql);
  if (!sql) return { error: 'Provide a SQL SELECT statement in "sql".' };
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const rodb = getReadOnlyDb();

  let stmt: Database.Statement;
  try {
    stmt = rodb.prepare(sql);
  } catch (err) {
    return { error: `SQL error: ${(err as Error).message}` };
  }
  if (!stmt.reader) {
    return { error: 'Only read-only SELECT queries are allowed.' };
  }

  try {
    const rows: unknown[] = [];
    for (const row of stmt.iterate()) {
      rows.push(row);
      if (rows.length > limit) break; // cap memory/time even on a huge cross-join
    }
    const truncated = rows.length > limit;
    if (truncated) rows.length = limit;
    return {
      row_count: rows.length,
      truncated,
      rows,
      note: 'Money columns are integer cents — divide by 100 for dollars.',
    };
  } catch (err) {
    return { error: `Query failed: ${(err as Error).message}` };
  }
}

// Both write tools go through confirmAdvisorDraft, the same path a confirmed draft takes, so
// they get the payload validation, the advisor_actions audit row, and the per-row provenance
// stamp for free. A write that skipped it would be invisible to undo.
function applyWriteDraft(
  db: Database.Database,
  payload: AdvisorDraftPayload,
  label: string,
  summary: string
): unknown {
  try {
    const response = confirmAdvisorDraft(
      db,
      {
        id: draftIdFor(payload),
        kind: payload.kind,
        label,
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

function categorizeTransactionsTool(db: Database.Database, input: ToolInput): unknown {
  const rawIds = Array.isArray(input.transaction_ids) ? input.transaction_ids : [];
  const ids = rawIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 200);
  const categoryId = str(input.category_id);
  if (ids.length === 0) return { error: 'Provide at least one transaction id in "transaction_ids".' };
  if (!categoryId) return { error: 'Provide a category id in "category_id".' };

  // One draft per transaction rather than a bulk update: each row gets its own action id, so
  // the user can undo a single bad call without reverting the whole batch.
  const outcomes = ids.map((transactionId) =>
    applyWriteDraft(
      db,
      { kind: 'categorize_transaction', transaction_id: transactionId, category_id: categoryId },
      'Categorize transaction',
      `Set category ${categoryId} from the advisor conversation.`
    )
  );

  const applied = outcomes.filter((o) => (o as { applied: boolean }).applied).length;
  return { requested: ids.length, applied, failed: ids.length - applied, outcomes };
}

function createMerchantRuleTool(db: Database.Database, input: ToolInput): unknown {
  const pattern = str(input.pattern);
  const categoryId = str(input.category_id);
  if (!pattern) return { error: 'Provide a merchant pattern in "pattern".' };
  if (!categoryId) return { error: 'Provide a category id in "category_id".' };

  return applyWriteDraft(
    db,
    {
      kind: 'create_merchant_rule',
      pattern,
      category_id: categoryId,
      apply_existing: input.apply_existing === undefined ? true : input.apply_existing === true,
    },
    `Create rule for ${pattern}`,
    `Future ${pattern} transactions use category ${categoryId}.`
  );
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
    case 'describe_schema': return describeSchemaTool();
    case 'run_sql_query': return runSqlQueryTool(input);
    default: return { error: `Unknown tool: ${name}` };
  }
}
