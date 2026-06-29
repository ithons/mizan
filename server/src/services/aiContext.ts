import { addDays, addMonths, differenceInCalendarDays, format, parseISO, startOfMonth, subMonths } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';

export const ADVISOR_SYSTEM_PROMPT = `You are a sharp, honest personal financial advisor with access to the user's complete financial picture. Their real balances, transactions, portfolio, goals, recurring bills, and cash-flow forecast are provided below.

Give specific, actionable advice using their actual numbers. Be direct - if something looks concerning (overspending, under-diversification, thin emergency fund, too much in a single position), say so clearly. If something looks healthy, say that too.

For investments: discuss asset allocation, concentration risk, tax-advantaged account usage, and whether holdings match a reasonable time horizon. Ask if you need to know their tax bracket or risk tolerance before giving tax/risk advice.

For cash flow: use the recurring forecast and goal progress when available. If data is stale, missing, or only estimated from detected patterns, say that plainly.

Keep responses concise unless depth is clearly warranted. Use dollar amounts and percentages from their data. Never fabricate numbers.`;

function fmt(n: number | null | undefined, prefix = '$'): string {
  if (n == null) return 'N/A';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${prefix}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${prefix}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${prefix}${abs.toFixed(2)}`;
}

function pct(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual';

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

interface RecurringContextRow {
  id: string;
  merchant_name: string;
  category_name: string | null;
  frequency: Frequency;
  next_expected: string;
  is_confirmed: number;
  average_signed_amount: number;
}

interface ForecastOccurrence {
  merchant_name: string;
  category_name: string | null;
  frequency: Frequency;
  expected_date: string;
  amount: number;
  is_confirmed: boolean;
}

interface RecurringForecastContext {
  income: number;
  bills: number;
  net: number;
  occurrences: ForecastOccurrence[];
}

interface ConnectionContextRow {
  provider: 'plaid' | 'coinbase';
  institution_name: string | null;
  status: string;
  last_synced_at: string | null;
  account_count: number;
}

function ageInDays(iso: string | null): number | null {
  if (!iso) return null;

  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  return differenceInCalendarDays(new Date(), parsed);
}

function nextOccurrenceDate(date: Date, frequency: Frequency): Date {
  switch (frequency) {
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
    case 'annual':
      return addMonths(date, 12);
  }
}

function buildRecurringForecastContext(
  db: Database.Database,
  days: number
): RecurringForecastContext {
  const today = format(new Date(), 'yyyy-MM-dd');
  const endDate = format(addDays(new Date(), days), 'yyyy-MM-dd');
  const patterns = db.prepare(`
    SELECT
      rp.id,
      rp.merchant_name,
      rp.frequency,
      rp.next_expected,
      rp.is_confirmed,
      c.name AS category_name,
      COALESCE(
        (
          SELECT AVG(t.amount)
          FROM transactions t
          WHERE t.recurring_id = rp.id
        ),
        CASE WHEN COALESCE(c.is_income, 0) = 1 THEN rp.average_amount ELSE -rp.average_amount END
      ) AS average_signed_amount
    FROM recurring_patterns rp
    LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.is_active = 1
      AND rp.next_expected <= ?
      AND (rp.is_confirmed = 1 OR rp.transaction_count >= 3)
    ORDER BY rp.next_expected ASC
  `).all(endDate) as RecurringContextRow[];

  const occurrences: ForecastOccurrence[] = [];

  for (const pattern of patterns) {
    let expected = parseISO(pattern.next_expected);
    let guard = 0;

    while (format(expected, 'yyyy-MM-dd') < today && guard < 500) {
      expected = nextOccurrenceDate(expected, pattern.frequency);
      guard++;
    }

    while (format(expected, 'yyyy-MM-dd') <= endDate && guard < 500) {
      const expectedDate = format(expected, 'yyyy-MM-dd');
      occurrences.push({
        merchant_name: pattern.merchant_name,
        category_name: pattern.category_name,
        frequency: pattern.frequency,
        expected_date: expectedDate,
        amount: pattern.average_signed_amount,
        is_confirmed: Boolean(pattern.is_confirmed),
      });

      expected = nextOccurrenceDate(expected, pattern.frequency);
      guard++;
    }
  }

  occurrences.sort((a, b) => a.expected_date.localeCompare(b.expected_date));

  const income = occurrences.reduce((sum, occurrence) =>
    occurrence.amount > 0 ? sum + occurrence.amount : sum, 0);
  const bills = occurrences.reduce((sum, occurrence) =>
    occurrence.amount < 0 ? sum + Math.abs(occurrence.amount) : sum, 0);

  return {
    income,
    bills,
    net: income - bills,
    occurrences,
  };
}

function goalProgress(row: GoalContextRow): {
  progress: number;
  remaining: number;
  percent: number;
} {
  let progress = row.current_amount;

  if (row.account_balance !== null) {
    if (row.type === 'savings') {
      progress = Math.max(row.account_balance, 0);
    } else {
      const startingAmount = row.starting_amount ?? row.target_amount;
      progress = Math.max(startingAmount - row.account_balance, 0);
    }
  }

  const cappedProgress = Math.min(progress, row.target_amount);
  return {
    progress: cappedProgress,
    remaining: Math.max(row.target_amount - cappedProgress, 0),
    percent: row.target_amount > 0
      ? Math.min((cappedProgress / row.target_amount) * 100, 100)
      : 0,
  };
}

export function buildFinancialContext(): string {
  const db = getDb();
  const today = new Date();
  const thisMonthStart = format(startOfMonth(today), 'yyyy-MM-dd');
  const threeMonthsAgo = format(startOfMonth(subMonths(today, 3)), 'yyyy-MM-dd');
  const sixMonthsAgo = format(startOfMonth(subMonths(today, 6)), 'yyyy-MM-dd');

  const lines: string[] = [`## Financial Snapshot - ${format(today, 'MMMM d, yyyy')}`];

  const plaidConnections = db.prepare(`
    SELECT
      'plaid' AS provider,
      institution_name,
      status,
      last_synced_at,
      (
        SELECT COUNT(*)
        FROM accounts a
        WHERE a.connection_id = pi.id
          AND a.connection_type = 'plaid'
          AND a.is_hidden = 0
      ) AS account_count
    FROM plaid_items pi
    WHERE status != 'removed'
  `).all() as ConnectionContextRow[];

  const coinbaseConnections = db.prepare(`
    SELECT
      'coinbase' AS provider,
      display_name AS institution_name,
      status,
      last_synced_at,
      (
        SELECT COUNT(*)
        FROM accounts a
        WHERE a.connection_id = cc.id
          AND a.connection_type = 'coinbase'
          AND a.is_hidden = 0
      ) AS account_count
    FROM coinbase_connections cc
    WHERE status != 'disconnected'
  `).all() as ConnectionContextRow[];

  const connections = [...plaidConnections, ...coinbaseConnections];
  const staleConnections = connections.filter((connection) => {
    if (connection.status !== 'active') return false;
    return (ageInDays(connection.last_synced_at) ?? 999) >= 3;
  });
  const attentionConnections = connections.filter((connection) => connection.status !== 'active');
  const syncedDates = connections
    .map((connection) => connection.last_synced_at)
    .filter((date): date is string => Boolean(date))
    .sort();

  lines.push('');
  lines.push('### Data Freshness');
  if (connections.length === 0) {
    lines.push('  No live institution connections. Balances and transactions may be manual or empty.');
  } else {
    lines.push(`  Connections: ${connections.length}`);
    lines.push(`  Last successful sync: ${syncedDates.at(-1) ?? 'Never'}`);
    lines.push(`  Stale connections: ${staleConnections.length}`);
    lines.push(`  Connections needing attention: ${attentionConnections.length}`);
    for (const connection of connections.slice(0, 6)) {
      const age = ageInDays(connection.last_synced_at);
      const name = connection.institution_name || (connection.provider === 'plaid' ? 'Bank connection' : 'Coinbase');
      const ageLabel = age === null ? 'never synced' : `${age}d ago`;
      lines.push(`  ${name}: ${connection.status}, ${ageLabel}, ${connection.account_count} accounts`);
    }
  }

  // ── Accounts & Net Worth ─────────────────────────────────────────────────
  const accounts = db.prepare(`
    SELECT type, current_balance, available_balance, is_liability, is_hidden, account_name, institution_name
    FROM accounts
    WHERE is_hidden = 0
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
    const bal = a.current_balance;
    if (a.is_liability) {
      liabilities += Math.abs(bal);
      acctLines.push(`  ${a.account_name} (${a.institution_name || a.type}): ${fmt(bal)} owed`);
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

  // Net worth vs last month
  const lastMonthSnapshot = db.prepare(`
    SELECT net_worth FROM net_worth_snapshots
    WHERE date < ? ORDER BY date DESC LIMIT 1
  `).get(thisMonthStart) as { net_worth: number } | undefined;

  const nwDelta = lastMonthSnapshot ? netWorth - lastMonthSnapshot.net_worth : null;

  lines.push('');
  lines.push(`### Net Worth: ${fmt(netWorth)}${nwDelta != null ? ` (${nwDelta >= 0 ? '+' : ''}${fmt(nwDelta)} vs last month)` : ''}`);
  lines.push(`  Liquid assets:    ${fmt(liquid)}`);
  if (investments > 0) lines.push(`  Investments:      ${fmt(investments)}`);
  if (crypto > 0) lines.push(`  Crypto:           ${fmt(crypto)}`);
  if (otherAssets > 0) lines.push(`  Other assets:     ${fmt(otherAssets)}`);
  if (liabilities > 0) lines.push(`  Liabilities:      ${fmt(liabilities)}`);
  lines.push('');
  lines.push('Account breakdown:');
  lines.push(...acctLines);

  // ── Cash Flow (3-month average) ──────────────────────────────────────────
  const cashflow = db.prepare(`
    SELECT
      SUM(CASE WHEN t.amount > 0 AND COALESCE(c.is_investment, 0) = 0 THEN t.amount ELSE 0 END) AS total_income,
      SUM(CASE WHEN t.amount < 0 AND COALESCE(c.is_investment, 0) = 0 THEN ABS(t.amount) ELSE 0 END) AS total_expenses
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.date >= ? AND t.pending = 0
  `).get(threeMonthsAgo) as { total_income: number; total_expenses: number };

  const avgIncome = (cashflow?.total_income ?? 0) / 3;
  const avgExpenses = (cashflow?.total_expenses ?? 0) / 3;
  const avgNet = avgIncome - avgExpenses;

  lines.push('');
  lines.push('### Cash Flow - 3-month average');
  lines.push(`  Income:   ${fmt(avgIncome)}/mo`);
  lines.push(`  Expenses: ${fmt(avgExpenses)}/mo`);
  lines.push(`  Net:      ${fmt(avgNet)}/mo`);

  const forecastDays = 60;
  const forecast = buildRecurringForecastContext(db, forecastDays);
  if (forecast.occurrences.length > 0) {
    lines.push('');
    lines.push(`### Forward Cash Flow - next ${forecastDays} days`);
    lines.push(`  Scheduled income: ${fmt(forecast.income)}`);
    lines.push(`  Scheduled bills:  ${fmt(forecast.bills)}`);
    lines.push(`  Scheduled net:    ${fmt(forecast.net)}`);
    lines.push(`  Liquid after scheduled net: ${fmt(liquid + forecast.net)}`);
    lines.push('  Next scheduled items:');
    for (const occurrence of forecast.occurrences.slice(0, 10)) {
      const sign = occurrence.amount >= 0 ? '+' : '-';
      const status = occurrence.is_confirmed ? 'confirmed' : 'detected';
      const category = occurrence.category_name ?? 'Uncategorized';
      lines.push(
        `    ${occurrence.expected_date}: ${occurrence.merchant_name} ${sign}${fmt(Math.abs(occurrence.amount))} (${category}, ${occurrence.frequency}, ${status})`
      );
    }
  }

  // ── Top Spending Categories (this month) ────────────────────────────────
  const thisMonthSpending = db.prepare(`
    SELECT
      COALESCE(pc.name, c.name, 'Uncategorized') AS category,
      SUM(ABS(t.amount)) AS total
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    WHERE t.date >= ?
      AND t.pending = 0
      AND t.amount < 0
      AND COALESCE(c.is_income, 0) = 0
      AND COALESCE(c.is_investment, 0) = 0
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
  const budgetMap = new Map(budgets.map((b) => [b.parent_category || b.category_name, b.amount]));

  if (thisMonthSpending.length > 0) {
    lines.push('');
    lines.push(`### Top Spending - ${format(today, 'MMMM')}`);
    for (const row of thisMonthSpending) {
      const budget = budgetMap.get(row.category);
      const budgetStr = budget ? ` | budget: ${fmt(row.total)}/${fmt(budget)} (${Math.round((row.total / budget) * 100)}%)` : '';
      lines.push(`  ${row.category}: ${fmt(row.total)}${budgetStr}`);
    }
  }

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
      const progress = goalProgress(goal);
      const verb = goal.type === 'debt' ? 'paid down' : 'saved';
      const linked = goal.account_name
        ? ` | linked to ${goal.account_name}${goal.institution_name ? ` at ${goal.institution_name}` : ''}`
        : '';
      const targetDate = goal.target_date ? ` | target: ${goal.target_date}` : '';
      lines.push(
        `  ${goal.name}: ${fmt(progress.progress)} ${verb} of ${fmt(goal.target_amount)} (${Math.round(progress.percent)}%), ${fmt(progress.remaining)} remaining${targetDate}${linked}`
      );
    }
  }

  const reviewQueue = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM transactions WHERE pending = 0) AS posted_transactions,
      (SELECT COUNT(*) FROM transactions WHERE pending = 0 AND category_id IS NULL) AS uncategorized_transactions,
      (SELECT COUNT(*) FROM merchant_rules) AS merchant_rules,
      (
        SELECT COUNT(*)
        FROM recurring_patterns
        WHERE is_active = 1 AND is_confirmed = 0 AND transaction_count >= 3
      ) AS detected_recurring
  `).get() as {
    posted_transactions: number;
    uncategorized_transactions: number;
    merchant_rules: number;
    detected_recurring: number;
  };

  if (
    reviewQueue.posted_transactions > 0 ||
    reviewQueue.merchant_rules > 0 ||
    reviewQueue.detected_recurring > 0
  ) {
    const uncategorizedPct = reviewQueue.posted_transactions > 0
      ? (reviewQueue.uncategorized_transactions / reviewQueue.posted_transactions) * 100
      : 0;
    lines.push('');
    lines.push('### Review Queue');
    lines.push(`  Posted transactions: ${reviewQueue.posted_transactions}`);
    lines.push(
      `  Uncategorized: ${reviewQueue.uncategorized_transactions} (${uncategorizedPct.toFixed(1)}%)`
    );
    lines.push(`  Categorization rules: ${reviewQueue.merchant_rules}`);
    lines.push(`  Detected recurring patterns needing confirmation: ${reviewQueue.detected_recurring}`);
  }

  // ── Investment Portfolio ─────────────────────────────────────────────────
  const holdings = db.prepare(`
    SELECT
      s.ticker, s.name AS sec_name, s.type AS sec_type,
      h.quantity, h.institution_value, h.cost_basis
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    JOIN accounts a ON a.id = h.account_id
    WHERE a.is_hidden = 0
    ORDER BY h.institution_value DESC
    LIMIT 15
  `).all() as Array<{
    ticker: string | null; sec_name: string; sec_type: string;
    quantity: number; institution_value: number; cost_basis: number | null;
  }>;

  if (holdings.length > 0) {
    const totalPortfolio = holdings.reduce((s, h) => s + h.institution_value, 0);
    const totalCostBasis = holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
    const totalGain = totalCostBasis > 0 ? totalPortfolio - totalCostBasis : null;
    const totalReturn = totalCostBasis > 0 ? ((totalPortfolio - totalCostBasis) / totalCostBasis) * 100 : null;

    // Asset type allocation
    const byType = new Map<string, number>();
    for (const h of holdings) {
      byType.set(h.sec_type, (byType.get(h.sec_type) ?? 0) + h.institution_value);
    }

    lines.push('');
    lines.push(`### Investment Portfolio - ${fmt(totalPortfolio)}${totalReturn != null ? ` (${pct(totalReturn)} total return)` : ''}`);
    if (totalGain != null) lines.push(`  Unrealized gain/loss: ${fmt(totalGain)}`);

    lines.push('  Asset mix:');
    for (const [type, val] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${type}: ${fmt(val)} (${Math.round((val / totalPortfolio) * 100)}%)`);
    }

    lines.push('  Top holdings:');
    for (const h of holdings.slice(0, 10)) {
      const gain = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
      const ret = h.cost_basis != null && h.cost_basis > 0
        ? ((h.institution_value - h.cost_basis) / h.cost_basis) * 100
        : null;
      const gainStr = gain != null ? ` (${gain >= 0 ? '+' : ''}${fmt(gain)}, ${pct(ret)})` : '';
      lines.push(`    ${h.ticker ?? h.sec_name}: ${fmt(h.institution_value)}${gainStr}`);
    }
  }

  // ── Net Worth Trend (6 months) ───────────────────────────────────────────
  const nwHistory = db.prepare(`
    SELECT date, net_worth FROM net_worth_snapshots
    WHERE date >= ? ORDER BY date ASC
  `).all(sixMonthsAgo) as Array<{ date: string; net_worth: number }>;

  if (nwHistory.length >= 2) {
    lines.push('');
    lines.push('### Net Worth Trend (last 6 months)');
    for (const snap of nwHistory) {
      lines.push(`  ${snap.date}: ${fmt(snap.net_worth)}`);
    }
  }

  // ── Recent Transactions ──────────────────────────────────────────────────
  const recent = db.prepare(`
    SELECT t.date, t.merchant_name, t.amount, c.name AS category, c.is_income
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
    ORDER BY t.date DESC, t.created_at DESC
    LIMIT 15
  `).all() as Array<{ date: string; merchant_name: string | null; amount: number; category: string | null; is_income: number }>;

  if (recent.length > 0) {
    lines.push('');
    lines.push('### Recent Transactions');
    for (const tx of recent) {
      const sign = tx.amount >= 0 ? '+' : '-';
      lines.push(`  ${tx.date}: ${tx.merchant_name ?? 'Unknown'} - ${sign}${fmt(Math.abs(tx.amount))} (${tx.category ?? 'Uncategorized'})`);
    }
  }

  return lines.join('\n');
}
