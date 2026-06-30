import { format, startOfMonth, subMonths } from 'date-fns';
import type {
  AdvisorAction,
  AdvisorContextResponse,
  RecurringForecast,
  ReportSummary,
  SyncHealth,
  TransactionReviewSummary,
} from '../../../shared/types';
import { getDb } from '../db/index';
import { calculateGoalProgress } from './goalProgress';
import { buildRecurringForecast } from './recurringForecast';
import { getCashflowReport, getReportSummary } from './reporting';
import { getTransactionReviewSummary } from './transactionReview';
import { getSyncHealth } from './syncHealth';

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
      '/transactions',
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
      `Spending is up ${fmt(reportSummary.expenses.delta)} versus the prior comparable period.`,
      reportSummary.expenses.delta_percent !== null && reportSummary.expenses.delta_percent > 20 ? 'warning' : 'info'
    ));
  }

  if (reportSummary.savings_rate.current < 10 && reportSummary.income.current > 0) {
    actions.push(action(
      'improve-savings-rate',
      'Improve savings rate',
      '/reports',
      'What practical changes would improve my savings rate based on this period?',
      `Savings rate is ${reportSummary.savings_rate.current.toFixed(1)}% for the selected period.`,
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
  };
}

export function buildFinancialContext(): string {
  const db = getDb();
  const today = new Date();
  const thisMonthStart = format(startOfMonth(today), 'yyyy-MM-dd');
  const threeMonthsAgo = format(startOfMonth(subMonths(today, 3)), 'yyyy-MM-dd');
  const sixMonthsAgo = format(startOfMonth(subMonths(today, 6)), 'yyyy-MM-dd');

  const lines: string[] = [`## Financial Snapshot - ${format(today, 'MMMM d, yyyy')}`];

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
  const cashflow = getCashflowReport(db, {
    startDate: threeMonthsAgo,
    endDate: format(today, 'yyyy-MM-dd'),
  });
  const cashflowTotals = cashflow.months.reduce(
    (totals, month) => ({
      income: totals.income + month.income,
      expenses: totals.expenses + month.expenses,
    }),
    { income: 0, expenses: 0 }
  );

  const avgIncome = cashflowTotals.income / 3;
  const avgExpenses = cashflowTotals.expenses / 3;
  const avgNet = avgIncome - avgExpenses;

  lines.push('');
  lines.push('### Cash Flow - 3-month average');
  lines.push(`  Income:   ${fmt(avgIncome)}/mo`);
  lines.push(`  Expenses: ${fmt(avgExpenses)}/mo`);
  lines.push(`  Net:      ${fmt(avgNet)}/mo`);

  const reportSummary = getReportSummary(db, {
    startDate: thisMonthStart,
    endDate: format(today, 'yyyy-MM-dd'),
  });
  lines.push('');
  lines.push(`### Report Summary - ${format(today, 'MMMM')}`);
  lines.push(`  Income: ${fmt(reportSummary.income.current)} (${fmt(reportSummary.income.delta)} vs prior period)`);
  lines.push(`  Spending: ${fmt(reportSummary.expenses.current)} (${fmt(reportSummary.expenses.delta)} vs prior period)`);
  lines.push(`  Net cash flow: ${fmt(reportSummary.net.current)} (${fmt(reportSummary.net.delta)} vs prior period)`);
  lines.push(`  Savings rate: ${reportSummary.savings_rate.current.toFixed(1)}% (${reportSummary.savings_rate.delta >= 0 ? '+' : ''}${reportSummary.savings_rate.delta.toFixed(1)} pp)`);
  if (reportSummary.excluded_flows.length > 0) {
    lines.push('  Excluded from income and spending reports:');
    for (const flow of reportSummary.excluded_flows) {
      lines.push(`    ${flow.flow_type}: ${flow.count} transactions, net ${fmt(flow.net)}`);
    }
  }

  const forecastDays = 60;
  const forecast = buildRecurringForecast(db, forecastDays);
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
      const progress = calculateGoalProgress(goal);
      const verb = goal.type === 'debt' ? 'paid down' : 'saved';
      const linked = goal.account_name
        ? ` | linked to ${goal.account_name}${goal.institution_name ? ` at ${goal.institution_name}` : ''}`
        : '';
      const targetDate = goal.target_date ? ` | target: ${goal.target_date}` : '';
      lines.push(
        `  ${goal.name}: ${fmt(progress.progress_amount)} ${verb} of ${fmt(goal.target_amount)} (${Math.round(progress.progress_percent)}%), ${fmt(progress.remaining_amount)} remaining${targetDate}${linked}`
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
