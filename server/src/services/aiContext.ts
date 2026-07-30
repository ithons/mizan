import { endOfMonth, format, parseISO, startOfMonth, subMonths } from 'date-fns';
import type {
  AdvisorAction,
  AdvisorContextResponse,
  RecurringForecast,
  ReportSummary,
  SyncHealth,
  TransactionReviewSummary,
} from '../../../shared/types';
import { getDb } from '../db/index';
import { toDollars, toDollarsOrNull } from './money';
import { excludedFromTotalsSql, expenseSideSql } from './transactionFilters';
import { calculateGoalProgress } from './goalProgress';
import { buildRecurringForecast } from './recurringForecast';
import { getCashflowReport, getReportSummary } from './reporting';
import { getTransactionReviewSummary } from './transactionReview';
import { getSyncHealth } from './syncHealth';
import { buildAdvisorReadTools } from './advisorTools';
import { getPreference } from './preferences';
import { estimateNote, readSnapshotBefore, readSnapshots } from './netWorthHistory';

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

export function buildFinancialContext(): string {
  const db = getDb();
  const today = new Date();
  const thisMonthStart = format(startOfMonth(today), 'yyyy-MM-dd');
  const sixMonthsAgo = format(startOfMonth(subMonths(today, 6)), 'yyyy-MM-dd');

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
  if (liabilities > 0) lines.push(`  Liabilities:      ${fmt(liabilities)}`);
  lines.push('');
  lines.push('Account breakdown:');
  lines.push(...acctLines);

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
    for (const row of thisMonthSpending) {
      const total = toDollars(row.total);
      const budget = budgetMap.get(row.category);
      const budgetStr = budget ? ` | budget: ${fmt(total)}/${fmt(budget)} (${Math.round((total / budget) * 100)}%)` : '';
      lines.push(`  ${row.category}: ${fmt(total)}${budgetStr}`);
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
    lines.push('');
    lines.push(`### Merchant Rules Already In Place (${merchantRules.length})`);
    lines.push('  Do not propose a rule for a merchant that already has one. To change one, say so explicitly.');
    for (const rule of merchantRules) {
      lines.push(`  ${rule.pattern} -> ${rule.category_name}${rule.source === 'ai' ? ' (set by you)' : ''}`);
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
    // Two different totals for the same money appeared in this prompt with nothing connecting
    // them: the Net Worth section sums ACCOUNT BALANCES while this section sums HOLDING VALUES,
    // and on the live data they differ by $100.00. A model reading both had no way to know whether
    // it was looking at one number twice or two numbers once, so it is told which is which.
    if (Math.abs(totalPortfolio - investments) >= 0.01) {
      lines.push(
        `  Note: the Net Worth section reports investments as ${fmt(investments)} from account balances, while this figure sums individual holdings. The ${fmt(Math.abs(totalPortfolio - investments))} difference is uninvested cash or a provider lag, not two separate pots of money. Do not add them together.`
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

  // ── Net Worth Trend (6 months) ───────────────────────────────────────────
  const nwHistory = readSnapshots(db, { since: sixMonthsAgo, order: 'asc' });

  if (nwHistory.length >= 2) {
    const estimatedCount = nwHistory.filter((snap) => snap.is_estimated).length;
    lines.push('');
    lines.push('### Net Worth Trend (last 6 months)');
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
      lines.push(`  ${tx.date}: ${tx.merchant_name ?? 'Unknown'} - ${sign}${fmt(toDollars(Math.abs(tx.amount)))} (${tx.category ?? 'Uncategorized'})`);
    }
  }

  return lines.join('\n');
}
