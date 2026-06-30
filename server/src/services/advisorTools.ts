import type Database from 'better-sqlite3';
import { format, startOfMonth } from 'date-fns';
import type {
  AdvisorAnalysis,
  AdvisorCitation,
  AdvisorCitationKind,
  AdvisorIntent,
  AdvisorToolStatus,
  DataQualityIssue,
  GoalType,
  SubscriptionInsightItem,
} from '../../../shared/types';
import { buildAdvisorDrafts } from './advisorDrafts';
import { calculateGoalProgress } from './goalProgress';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';
import { getReportSummary } from './reporting';
import { buildRecurringForecast } from './recurringForecast';
import { getSyncHealth } from './syncHealth';
import { getTransactionReviewSummary } from './transactionReview';
import { buildSubscriptionInsights } from './subscriptionInsights';
import { getAnomalyInsights } from './anomalyInsights';
import { getDataQualitySummary } from './dataQuality';

interface CountRow {
  count: number;
}

interface GoalAnalysisRow {
  id: string;
  name: string;
  type: GoalType;
  target_amount: number;
  current_amount: number;
  starting_amount: number | null;
  target_date: string | null;
  account_name: string | null;
  institution_name: string | null;
  account_balance: number | null;
}

function fmt(amount: number | null | undefined): string {
  if (amount == null) return 'N/A';
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function availableBudgetAmount(budget: { amount: number; rollover: boolean; rollover_balance: number }): number {
  return budget.amount + (budget.rollover ? budget.rollover_balance : 0);
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as CountRow | undefined;
  return row?.count ?? 0;
}

function monthRange(now: Date): { startDate: string; endDate: string; year: number; month: number } {
  return {
    startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
    endDate: format(now, 'yyyy-MM-dd'),
    year: Number(format(now, 'yyyy')),
    month: Number(format(now, 'M')),
  };
}

function tool(
  id: string,
  label: string,
  status: AdvisorToolStatus['status'],
  countValue: number,
  route: string
): AdvisorToolStatus {
  return { id, label, status, count: countValue, route };
}

export function buildAdvisorReadTools(
  db: Database.Database,
  now = new Date()
): AdvisorToolStatus[] {
  const { startDate, endDate, year, month } = monthRange(now);
  const syncHealth = getSyncHealth(db);
  const reviewSummary = getTransactionReviewSummary(db);
  const reportSummary = getReportSummary(db, { startDate, endDate });
  const forecast = buildRecurringForecast(db, 60);
  const budgets = getMonthlyBudgetsWithProjection(db, year, month, now);
  const hasReportData = reportSummary.income.current !== 0 || reportSummary.expenses.current !== 0;

  const accountCount = count(db, 'SELECT COUNT(*) AS count FROM accounts WHERE is_hidden = 0');
  const transactionCount = count(
    db,
    'SELECT COUNT(*) AS count FROM transactions WHERE date >= ? AND date <= ?',
    startDate,
    endDate
  );
  const goalCount = count(db, 'SELECT COUNT(*) AS count FROM goals WHERE is_archived = 0');

  return [
    tool(
      'sync_health',
      'Sync health',
      syncHealth.status === 'attention' || syncHealth.status === 'stale' ? 'attention' : syncHealth.status === 'empty' ? 'empty' : 'available',
      syncHealth.connection_count,
      '/accounts'
    ),
    tool('accounts', 'Accounts', accountCount > 0 ? 'available' : 'empty', accountCount, '/accounts'),
    tool('transactions', 'Transactions', transactionCount > 0 ? 'available' : 'empty', transactionCount, '/transactions'),
    tool('reports', 'Reports', hasReportData ? 'available' : 'empty', hasReportData ? 1 : 0, '/reports'),
    tool('budgets', 'Budgets', budgets.length > 0 ? 'available' : 'empty', budgets.length, '/budget'),
    tool('goals', 'Goals', goalCount > 0 ? 'available' : 'empty', goalCount, '/goals'),
    tool('recurring', 'Bills and recurring', forecast.occurrences.length > 0 ? 'available' : 'empty', forecast.occurrences.length, '/bills'),
    tool('review', 'Review inbox', reviewSummary.total_open > 0 ? 'attention' : 'available', reviewSummary.total_open, '/review'),
  ];
}

function citation(params: AdvisorCitation): AdvisorCitation {
  return params;
}

function selectIntent(question: string): AdvisorIntent {
  const text = question.toLowerCase();
  if (/\b(sync|stale|connection|institution|plaid|coinbase|reconnect)\b/.test(text)) return 'sync';
  if (/\b(data quality|trustworthy|trust|reliable|believable|invariant|wrong number|numbers wrong)\b/.test(text)) return 'quality';
  if (/\b(subscription|subscriptions|renewal|renewals|price increase|price increases)\b/.test(text)) return 'subscriptions';
  if (/\b(anomaly|anomalies|unusual|spike|spikes|gap|gaps|surge|changed a lot)\b/.test(text)) return 'insights';
  if (/\b(review|uncategorized|duplicate|transfer|rule|pending)\b/.test(text)) return 'review';
  if (/\b(budget|over budget|under budget|rollover)\b/.test(text)) return 'budget';
  if (/\b(goal|goals|target|save|debt payoff)\b/.test(text)) return 'goals';
  if (/\b(bill|bills|recurring|subscription|forecast|upcoming)\b/.test(text)) return 'recurring';
  if (/\b(spend|spending|income|cash flow|cashflow|saving|savings|report|changed|food)\b/.test(text)) return 'reports';
  return 'overview';
}

function citationKindForRoute(route: string): AdvisorCitationKind {
  if (route.startsWith('/accounts')) return 'sync';
  if (route.startsWith('/review')) return 'review';
  if (route.startsWith('/transactions')) return 'transaction';
  if (route.startsWith('/budget')) return 'budget';
  if (route.startsWith('/goals')) return 'goal';
  if (route.startsWith('/bills')) return 'recurring';
  if (route.startsWith('/reports')) return 'report';
  return 'data_quality';
}

function analyzeSync(db: Database.Database): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const syncHealth = getSyncHealth(db);
  const lines = [
    `Sync health is ${syncHealth.status_label.toLowerCase()}: ${syncHealth.status_detail}`,
  ];

  if (syncHealth.last_synced_at) {
    lines.push(`Last successful sync was ${syncHealth.last_synced_at}.`);
  }
  if (syncHealth.connections.length > 0) {
    lines.push(`Mizān is tracking ${syncHealth.connection_count} live connection${syncHealth.connection_count === 1 ? '' : 's'}.`);
  }

  return {
    answer: lines.join('\n\n'),
    citations: syncHealth.connections.slice(0, 6).map((connection) =>
      citation({
        id: `sync:${connection.id}`,
        kind: 'sync',
        label: connection.institution_name,
        detail: connection.status_detail,
        route: '/accounts',
        record_id: connection.id,
        date: connection.last_success_at,
      })
    ),
  };
}

function analyzeReview(db: Database.Database): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const review = getTransactionReviewSummary(db);
  const activeQueues = review.queues.filter((queue) => queue.count > 0);
  const lines = [
    review.total_open > 0
      ? `There are ${review.total_open} open review item${review.total_open === 1 ? '' : 's'}.`
      : 'The Review Inbox is clear.',
  ];

  if (activeQueues.length > 0) {
    lines.push(activeQueues.map((queue) => `${queue.label}: ${queue.count}`).join('\n'));
  }

  return {
    answer: lines.join('\n\n'),
    citations: review.queues.map((queue) =>
      citation({
        id: `review:${queue.id}`,
        kind: 'review',
        label: queue.label,
        detail: `${queue.count} open`,
        route: `/review?queue=${queue.id}`,
      })
    ),
  };
}

function analyzeBudget(
  db: Database.Database,
  now: Date
): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const { year, month } = monthRange(now);
  const budgets = getMonthlyBudgetsWithProjection(db, year, month, now)
    .sort((a, b) => (b.projected_percent ?? 0) - (a.projected_percent ?? 0));
  if (budgets.length === 0) {
    return {
      answer: 'No monthly budgets are configured yet, so Mizān cannot project budget risk.',
      citations: [],
    };
  }

  const overBudget = budgets.filter((budget) => (budget.projected_remaining ?? 0) < 0);
  const watched = overBudget.length > 0 ? overBudget : budgets.slice(0, 3);
  const lines = [
    overBudget.length > 0
      ? `${overBudget.length} budget ${overBudget.length === 1 ? 'category is' : 'categories are'} projected over budget this month.`
      : 'No configured category is projected over budget right now.',
    watched
      .map((budget) => {
        const availableAmount = availableBudgetAmount(budget);
        return `${budget.category_name ?? 'Uncategorized'}: projected ${fmt(budget.projected_spend)} of ${fmt(availableAmount)}, ${fmt(budget.projected_remaining)} remaining.`;
      })
      .join('\n'),
  ];

  return {
    answer: lines.join('\n\n'),
    citations: watched.map((budget) =>
      citation({
        id: `budget:${budget.id}`,
        kind: 'budget',
        label: budget.category_name ?? 'Budget',
        detail: `${Math.round(budget.projected_percent ?? 0)}% projected`,
        route: '/budget',
        record_id: budget.id,
        amount: budget.projected_spend,
      })
    ),
  };
}

function analyzeRecurring(db: Database.Database): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const forecast = buildRecurringForecast(db, 60);
  const nextItems = forecast.occurrences.slice(0, 5);
  const adjustedItems = forecast.occurrences
    .filter((item) => item.adjustment_action)
    .slice(0, 3);
  const adjustmentLabel = (action: string | null | undefined): string =>
    action === 'adjust' ? 'amount adjustment' : `${action} adjustment`;
  const lines = [
    `Over the next 60 days, Mizān projects ${fmt(forecast.income)} income, ${fmt(forecast.bills)} bills, and ${fmt(forecast.net)} net scheduled cash flow.`,
  ];
  if (forecast.review_count > 0) {
    lines.push(`${forecast.review_count} recurring item${forecast.review_count === 1 ? '' : 's'} need review, including ${forecast.overdue_count} overdue.`);
  }
  if (nextItems.length > 0) {
    lines.push(nextItems.map((item) =>
      `${item.expected_date}: ${item.merchant_name} ${item.amount >= 0 ? '+' : '-'}${fmt(Math.abs(item.amount))}`
    ).join('\n'));
  }
  if (adjustedItems.length > 0) {
    lines.push(`Adjusted occurrences: ${adjustedItems.map((item) => {
      const original = item.original_expected_date && item.original_expected_date !== item.expected_date
        ? ` from ${item.original_expected_date}`
        : '';
      return `${item.merchant_name} ${adjustmentLabel(item.adjustment_action)}${original} on ${item.expected_date}`;
    }).join('; ')}.`);
  }

  return {
    answer: lines.join('\n\n'),
    citations: nextItems.map((item) =>
      citation({
        id: `recurring:${item.id}`,
        kind: 'recurring',
        label: item.merchant_name,
        detail: item.adjustment_action
          ? `${item.frequency}, ${item.confidence_label}, ${adjustmentLabel(item.adjustment_action)}`
          : `${item.frequency}, ${item.confidence_label}`,
        route: '/bills',
        record_id: item.pattern_id,
        amount: item.amount,
        date: item.expected_date,
      })
    ),
  };
}

function subscriptionLine(item: SubscriptionInsightItem): string {
  const category = item.category_name ? ` in ${item.category_name}` : '';
  const increase = item.increase_amount && item.increase_amount > 0
    ? `, up ${fmt(item.increase_amount)} from the recent baseline`
    : '';
  return `${item.merchant_name}: ${fmt(item.monthly_amount)}/mo equivalent, next expected ${item.next_expected}${category}${increase}.`;
}

function analyzeSubscriptions(db: Database.Database): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const insights = buildSubscriptionInsights(db, 60);
  if (insights.subscription_count === 0) {
    return {
      answer: 'Mizān has not detected any subscription-like recurring bills yet.',
      citations: [
        citation({
          id: 'subscriptions:summary',
          kind: 'recurring',
          label: 'Subscription summary',
          detail: '0 detected',
          route: '/bills',
        }),
      ],
    };
  }

  const lines = [
    `${insights.subscription_count} subscription-like recurring bill${insights.subscription_count === 1 ? '' : 's'} total ${fmt(insights.total_monthly_amount)}/mo equivalent.`,
    `${fmt(insights.total_upcoming_amount)} is scheduled over the next ${insights.days} days.`,
  ];

  if (insights.increase_count > 0) {
    lines.push(`Price increases: ${insights.increases.slice(0, 3).map(subscriptionLine).join('\n')}`);
  }
  if (insights.unconfirmed_count > 0) {
    lines.push(`Needs confirmation: ${insights.unconfirmed.slice(0, 3).map(subscriptionLine).join('\n')}`);
  }
  if (insights.upcoming_renewal_count > 0) {
    lines.push(`Upcoming renewals: ${insights.upcoming.slice(0, 3).map(subscriptionLine).join('\n')}`);
  }

  const citedSubscriptions = new Map<string, SubscriptionInsightItem>();
  for (const item of [
    ...insights.increases,
    ...insights.unconfirmed,
    ...insights.upcoming,
    ...insights.subscriptions,
  ]) {
    if (citedSubscriptions.size >= 6) break;
    citedSubscriptions.set(item.pattern_id, item);
  }

  return {
    answer: lines.join('\n\n'),
    citations: [
      citation({
        id: 'subscriptions:summary',
        kind: 'recurring',
        label: 'Subscription summary',
        detail: `${insights.subscription_count} detected`,
        route: '/bills',
        amount: insights.total_monthly_amount,
      }),
      ...Array.from(citedSubscriptions.values()).map((item) =>
        citation({
          id: `subscription:${item.pattern_id}`,
          kind: 'recurring' as const,
          label: item.merchant_name,
          detail: `${item.frequency}, ${item.confidence_label}`,
          route: '/bills',
          record_id: item.pattern_id,
          amount: item.monthly_amount,
          date: item.next_expected,
        })
      ),
    ],
  };
}

function goalRows(db: Database.Database): GoalAnalysisRow[] {
  return db.prepare(`
    SELECT
      g.id,
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
  `).all() as GoalAnalysisRow[];
}

function analyzeGoals(db: Database.Database): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const goals = goalRows(db).map((goal) => ({
    ...goal,
    progress: calculateGoalProgress(goal),
  }));
  if (goals.length === 0) {
    return {
      answer: 'No active goals are configured yet.',
      citations: [],
    };
  }

  const lines = [
    `There ${goals.length === 1 ? 'is' : 'are'} ${goals.length} active goal${goals.length === 1 ? '' : 's'}.`,
    goals.slice(0, 5).map((goal) =>
      `${goal.name}: ${Math.round(goal.progress.progress_percent)}% complete, ${fmt(goal.progress.remaining_amount)} remaining${goal.target_date ? ` by ${goal.target_date}` : ''}.`
    ).join('\n'),
  ];

  return {
    answer: lines.join('\n\n'),
    citations: goals.slice(0, 5).map((goal) =>
      citation({
        id: `goal:${goal.id}`,
        kind: 'goal',
        label: goal.name,
        detail: `${Math.round(goal.progress.progress_percent)}% complete`,
        route: '/goals',
        record_id: goal.id,
        amount: goal.progress.remaining_amount,
        date: goal.target_date,
      })
    ),
  };
}

function analyzeInsights(
  db: Database.Database,
  now: Date
): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const insights = getAnomalyInsights(db, now);
  if (insights.length === 0) {
    return {
      answer: 'Mizān does not see unusual spending spikes or income gaps in the current 30-day comparison window.',
      citations: [
        citation({
          id: `insights:anomalies:${format(now, 'yyyy-MM-dd')}`,
          kind: 'insight',
          label: 'Anomaly scan',
          detail: 'No active anomaly insights',
          route: '/reports',
        }),
      ],
    };
  }

  return {
    answer: [
      `Mizān found ${insights.length} anomaly insight${insights.length === 1 ? '' : 's'} in the current 30-day comparison window.`,
      insights.map((insight) => `${insight.title}: ${insight.message}${insight.metric ? ` (${insight.metric})` : ''}`).join('\n'),
    ].join('\n\n'),
    citations: insights.slice(0, 6).map((insight) =>
      citation({
        id: `insight:${insight.id}`,
        kind: 'insight',
        label: insight.title,
        detail: insight.metric ?? insight.severity,
        route: insight.action_route ?? '/reports',
        record_id: insight.id,
      })
    ),
  };
}

function dataQualityCitation(issue: DataQualityIssue): AdvisorCitation {
  return citation({
    id: `data-quality:${issue.id}`,
    kind: citationKindForRoute(issue.route),
    label: issue.label,
    detail: issue.message,
    route: issue.route,
    record_id: issue.id,
  });
}

function analyzeQuality(db: Database.Database): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const quality = getDataQualitySummary(db);
  const lines = [
    `Data quality is ${quality.status_label.toLowerCase()} with a score of ${quality.score}/100.`,
    quality.status_detail,
  ];

  if (quality.issues.length > 0) {
    lines.push(quality.issues.slice(0, 5).map((issue) => `${issue.label}: ${issue.message}`).join('\n'));
  } else {
    lines.push('No active trust issues are blocking the main balances, reports, budgets, or advisor answers.');
  }

  return {
    answer: lines.join('\n\n'),
    citations: [
      citation({
        id: 'data-quality:summary',
        kind: 'data_quality',
        label: 'Data quality summary',
        detail: `${quality.score}/100, ${quality.status}`,
        route: '/',
      }),
      ...quality.issues.slice(0, 6).map(dataQualityCitation),
    ],
  };
}

function analyzeReports(
  db: Database.Database,
  now: Date,
  intent: AdvisorIntent
): Pick<AdvisorAnalysis, 'answer' | 'citations'> {
  const { startDate, endDate } = monthRange(now);
  const report = getReportSummary(db, { startDate, endDate });
  const lines = [
    `For ${format(now, 'MMMM yyyy')}, Mizān sees ${fmt(report.income.current)} income, ${fmt(report.expenses.current)} spending, and ${fmt(report.net.current)} net cash flow.`,
    `Savings rate is ${report.savings_rate.current.toFixed(1)}%. Spending changed by ${fmt(report.expenses.delta)} versus the prior comparable period.`,
  ];

  if (report.top_spending.length > 0) {
    lines.push(`Top spending categories:\n${report.top_spending.slice(0, 3).map((category) =>
      `${category.category_name}: ${fmt(category.current)}`
    ).join('\n')}`);
  }

  const citations: AdvisorCitation[] = [
    citation({
      id: `report:summary:${startDate}:${endDate}`,
      kind: 'report',
      label: 'Current month report summary',
      detail: `${startDate} to ${endDate}`,
      route: '/reports',
      amount: report.net.current,
    }),
    ...report.top_spending.slice(0, 5).map((category) =>
      citation({
        id: `report:spending:${category.category_id}`,
        kind: 'report' as const,
        label: category.category_name,
        detail: 'Top spending category',
        route: '/reports',
        record_id: category.category_id,
        amount: category.current,
      })
    ),
  ];

  return {
    answer: intent === 'overview'
      ? `Here is the current financial overview.\n\n${lines.join('\n\n')}`
      : lines.join('\n\n'),
    citations,
  };
}

export function analyzeAdvisorQuestion(
  db: Database.Database,
  question: string,
  now = new Date()
): AdvisorAnalysis {
  const trimmedQuestion = question.trim();
  const intent = selectIntent(trimmedQuestion);
  const result = (() => {
    switch (intent) {
      case 'sync':
        return analyzeSync(db);
      case 'review':
        return analyzeReview(db);
      case 'budget':
        return analyzeBudget(db, now);
      case 'recurring':
        return analyzeRecurring(db);
      case 'subscriptions':
        return analyzeSubscriptions(db);
      case 'goals':
        return analyzeGoals(db);
      case 'insights':
        return analyzeInsights(db, now);
      case 'quality':
        return analyzeQuality(db);
      case 'reports':
      case 'overview':
        return analyzeReports(db, now, intent);
    }
  })();

  return {
    question: trimmedQuestion,
    intent,
    answer: result.answer,
    generated_at: new Date().toISOString(),
    tools: buildAdvisorReadTools(db, now),
    citations: result.citations,
    drafts: buildAdvisorDrafts(db, trimmedQuestion),
  };
}
