import type Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { listTransactions, type TransactionListFilters } from './transactions';
import { toDollars } from './money';

// Read-only tools the cloud advisor (routes/ai.ts /chat) can call to query the database
// on demand, instead of relying only on the fixed context snapshot. This is the gap the
// user hit: the snapshot carries the last 15 of hundreds of transactions and current-month
// aggregates, so questions about specific merchants, categories, or past months had no data
// to work from. Every tool here is a pure SELECT and returns DOLLARS (the snapshot and UI
// are dollarized, so the model reasons consistently in dollars). Nothing here writes.

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
      'Total spending grouped by top-level category over an optional date range, largest first. Transfers are excluded. Amounts are positive dollars spent.',
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
      'Income, expenses, and net per calendar month for the last N months (default 6), newest first. Transfers are excluded. Amounts in dollars.',
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
      'Each monthly budget with its limit, this-month actual spending, and remaining amount. Amounts in dollars.',
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
      'Investment holdings: ticker, name, type, quantity, market value, cost basis, and unrealized gain. Values in dollars; quantity is a share/coin count.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_upcoming_bills',
    description:
      'Recurring bills/subscriptions expected within the next N days (default 45), soonest first. Amounts in dollars.',
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
];

// Transfers (cat_xfer and its children cat_xfer_in/out) are money moving between the
// user's own accounts, not income or spending — excluded from the aggregate tools.
const EXCLUDE_TRANSFERS =
  "(t.category_id IS NULL OR t.category_id NOT IN (SELECT id FROM categories WHERE id = 'cat_xfer' OR parent_id = 'cat_xfer'))";

type ToolInput = Record<string, unknown>;

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
  const conditions = ['t.amount < 0', EXCLUDE_TRANSFERS];
  const params: unknown[] = [];
  if (str(input.start_date)) { conditions.push('t.date >= ?'); params.push(str(input.start_date)); }
  if (str(input.end_date)) { conditions.push('t.date <= ?'); params.push(str(input.end_date)); }
  const top = Math.min(Math.max(Number(input.top) || 10, 1), 50);
  const rows = db.prepare(`
    SELECT COALESCE(parent.name, c.name, 'Uncategorized') AS category, SUM(-t.amount) AS cents
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories parent ON parent.id = c.parent_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY category
    ORDER BY cents DESC
    LIMIT ?
  `).all(...params, top) as Array<{ category: string; cents: number }>;
  return { categories: rows.map((r) => ({ category: r.category, spent: toDollars(r.cents) })) };
}

function monthlyCashflowTool(db: Database.Database, input: ToolInput): unknown {
  const months = Math.min(Math.max(Number(input.months) || 6, 1), 36);
  const rows = db.prepare(`
    SELECT
      substr(t.date, 1, 7) AS month,
      SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS income_cents,
      SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) AS expense_cents
    FROM transactions t
    WHERE ${EXCLUDE_TRANSFERS}
    GROUP BY month
    ORDER BY month DESC
    LIMIT ?
  `).all(months) as Array<{ month: string; income_cents: number; expense_cents: number }>;
  return {
    months: rows.map((r) => ({
      month: r.month,
      income: toDollars(r.income_cents),
      expenses: toDollars(r.expense_cents),
      net: toDollars(r.income_cents - r.expense_cents),
    })),
  };
}

function getBudgetsTool(db: Database.Database): unknown {
  // This-month actual = expenses in the budget's category or any of its direct children.
  const rows = db.prepare(`
    SELECT c.name AS category, b.amount AS budget_cents,
      COALESCE((
        SELECT SUM(-t.amount) FROM transactions t
        LEFT JOIN categories tc ON tc.id = t.category_id
        WHERE t.amount < 0
          AND strftime('%Y-%m', t.date) = strftime('%Y-%m', 'now')
          AND (t.category_id = b.category_id OR tc.parent_id = b.category_id)
      ), 0) AS actual_cents
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    ORDER BY b.amount DESC
  `).all() as Array<{ category: string; budget_cents: number; actual_cents: number }>;
  return {
    budgets: rows.map((r) => ({
      category: r.category,
      budget: toDollars(r.budget_cents),
      spent: toDollars(r.actual_cents),
      remaining: toDollars(r.budget_cents - r.actual_cents),
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

function listHoldingsTool(db: Database.Database): unknown {
  const rows = db.prepare(`
    SELECT s.ticker, s.name, s.type, h.quantity,
      h.institution_value AS value_cents,
      COALESCE(h.manual_cost_basis, h.cost_basis) AS basis_cents
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    ORDER BY h.institution_value DESC
  `).all() as Array<{ ticker: string | null; name: string; type: string; quantity: number; value_cents: number; basis_cents: number | null }>;
  return {
    holdings: rows.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      type: r.type,
      quantity: r.quantity,
      value: toDollars(r.value_cents),
      cost_basis: r.basis_cents == null ? null : toDollars(r.basis_cents),
      unrealized_gain: r.basis_cents == null ? null : toDollars(r.value_cents - r.basis_cents),
    })),
  };
}

function getUpcomingBillsTool(db: Database.Database, input: ToolInput): unknown {
  const days = Math.min(Math.max(Number(input.days) || 45, 1), 180);
  const rows = db.prepare(`
    SELECT merchant_name, average_amount AS cents, frequency, next_expected
    FROM recurring_patterns
    WHERE is_active = 1 AND next_expected <= date('now', '+' || ? || ' days')
    ORDER BY next_expected ASC
  `).all(days) as Array<{ merchant_name: string; cents: number; frequency: string; next_expected: string }>;
  return {
    bills: rows.map((r) => ({
      merchant: r.merchant_name,
      amount: toDollars(r.cents),
      frequency: r.frequency,
      due: r.next_expected,
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

export function runAdvisorTool(db: Database.Database, name: string, input: ToolInput): unknown {
  switch (name) {
    case 'list_transactions': return listTransactionsTool(db, input);
    case 'spending_by_category': return spendingByCategoryTool(db, input);
    case 'monthly_cashflow': return monthlyCashflowTool(db, input);
    case 'get_budgets': return getBudgetsTool(db);
    case 'list_goals': return listGoalsTool(db);
    case 'list_holdings': return listHoldingsTool(db);
    case 'get_upcoming_bills': return getUpcomingBillsTool(db, input);
    case 'get_net_worth_history': return getNetWorthHistoryTool(db, input);
    default: return { error: `Unknown tool: ${name}` };
  }
}
