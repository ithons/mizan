import type { AdvisorRoutePrompt } from './advisorRouteState';
import type {
  Account,
  Budget,
  Holding,
  ReportCategoryChange,
  ReportExcludedFlowSummary,
  ReportMetricSummary,
  ReportSummary,
  Transaction,
} from '@shared/types';
import { availableBudgetAmount, budgetProjectedRemaining, budgetProjectedSpend } from './budgetMath';

export type ReportAdvisorTab = 'spending' | 'income' | 'trends' | 'cashflow' | 'networth' | 'investments';

export interface ReportAdvisorPromptContext {
  tab: ReportAdvisorTab;
  startDate: string;
  endDate: string;
}

export type DashboardAdvisorCardKind = 'net_worth' | 'monthly_spend' | 'monthly_income' | 'top_category';

export interface DashboardCardAdvisorPromptContext {
  card: DashboardAdvisorCardKind;
  title: string;
  period: string;
  value: number;
  delta?: number | null;
  deltaLabel?: string | null;
  extraContext?: string | null;
}

function formatMoneyValue(value: number): string {
  const amount = Math.abs(value).toFixed(2);
  return value < 0 ? `-$${amount}` : `$${amount}`;
}

function formatCurrencyValue(value: number, currency: string): string {
  return currency === 'USD' ? formatMoneyValue(value) : `${value.toFixed(2)} ${currency}`;
}

function formatSignedMoneyValue(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatMoneyValue(value)}`;
}

function formatSignedPercentPoints(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)} percentage points`;
}

function reportMetricLine(label: string, metric: ReportMetricSummary, isRate = false): string {
  const current = isRate ? `${metric.current.toFixed(1)}%` : formatMoneyValue(metric.current);
  const delta = isRate ? formatSignedPercentPoints(metric.delta) : formatSignedMoneyValue(metric.delta);
  return `${label} is ${current}, ${delta} versus comparison.`;
}

function summarizeCategoryChanges(changes: ReportCategoryChange[]): string {
  if (changes.length === 0) return 'none';
  return changes
    .slice(0, 3)
    .map((change) => `${change.category_name} ${formatMoneyValue(change.current)} (${formatSignedMoneyValue(change.delta)})`)
    .join('; ');
}

function summarizeExcludedFlows(flows: ReportExcludedFlowSummary[]): string {
  if (flows.length === 0) return 'none';
  return flows
    .map((flow) => `${flow.flow_type}: ${flow.count} transactions, net ${formatSignedMoneyValue(flow.net)}`)
    .join('; ');
}

export function buildReportAdvisorPrompt(
  report: ReportSummary,
  context: ReportAdvisorPromptContext
): AdvisorRoutePrompt {
  const startDate = report.start_date ?? context.startDate;
  const endDate = report.end_date ?? context.endDate;
  const comparisonStartDate = report.comparison_start_date ?? report.previous_start_date ?? null;
  const comparisonEndDate = report.comparison_end_date ?? report.previous_end_date ?? null;
  const comparisonRange = comparisonStartDate && comparisonEndDate
    ? `${comparisonStartDate} to ${comparisonEndDate}`
    : 'no stored comparison range';
  const topSpending = summarizeCategoryChanges(report.top_spending);
  const topIncome = summarizeCategoryChanges(report.top_income);
  const spendingMovers = summarizeCategoryChanges(report.spending_movers);
  const excludedFlows = summarizeExcludedFlows(report.excluded_flows);

  return {
    source: 'reports',
    recordKind: 'report_summary',
    recordId: `${context.tab}:${startDate}:${endDate}`,
    params: {
      tab: context.tab,
      startDate,
      endDate,
      comparison: report.comparison,
      comparisonLabel: report.comparison_label,
      comparisonStartDate,
      comparisonEndDate,
      incomeCurrent: report.income.current,
      incomeDelta: report.income.delta,
      spendingCurrent: report.expenses.current,
      spendingDelta: report.expenses.delta,
      netCurrent: report.net.current,
      netDelta: report.net.delta,
      savingsRateCurrent: report.savings_rate.current,
      savingsRateDelta: report.savings_rate.delta,
      topSpending,
      topIncome,
      spendingMovers,
      excludedFlows,
      excludedFlowCount: report.excluded_flows.reduce((sum, flow) => sum + flow.count, 0),
    },
    prompt: [
      `Explain this ${context.tab} report from ${startDate} to ${endDate}.`,
      `Compared with ${report.comparison_label} (${comparisonRange}).`,
      reportMetricLine('Income', report.income),
      reportMetricLine('Spending', report.expenses),
      reportMetricLine('Net cash flow', report.net),
      reportMetricLine('Savings rate', report.savings_rate, true),
      `Top spending: ${topSpending}.`,
      `Top income: ${topIncome}.`,
      `Spending movers: ${spendingMovers}.`,
      `Excluded flows: ${excludedFlows}.`,
      'Explain the main changes, whether exclusions affect interpretation, and which backing report evidence I should inspect.',
    ].join(' '),
  };
}

export function buildDashboardCardAdvisorPrompt(
  context: DashboardCardAdvisorPromptContext
): AdvisorRoutePrompt {
  const deltaPhrase = context.delta == null
    ? 'No comparison delta is shown on this card.'
    : `The displayed change is ${formatSignedMoneyValue(context.delta)} ${context.deltaLabel ?? 'versus comparison'}.`;
  const extraContext = context.extraContext?.trim() || 'No extra dashboard context is attached.';

  return {
    source: 'dashboard',
    recordKind: 'dashboard_card',
    recordId: `${context.card}:${context.period}`,
    params: {
      card: context.card,
      title: context.title,
      period: context.period,
      currentValue: context.value,
      delta: context.delta ?? null,
      deltaLabel: context.deltaLabel ?? null,
      extraContext,
    },
    prompt: [
      `Analyze my dashboard ${context.title} card for ${context.period}.`,
      `The displayed value is ${formatMoneyValue(context.value)}.`,
      deltaPhrase,
      extraContext,
      'Explain what changed, whether this needs review, and which accounts, transactions, reports, sync runs, or budget rows I should inspect.',
    ].join(' '),
  };
}

export function buildBudgetAdvisorPrompt(budget: Budget, month: string): AdvisorRoutePrompt {
  const spent = budget.spent ?? 0;
  const available = availableBudgetAmount(budget);
  const projectedSpend = budgetProjectedSpend(budget);
  const expectedRecurring = budget.expected_recurring ?? 0;
  const projectedRemaining = budgetProjectedRemaining(budget);
  const categoryName = budget.category_name ?? 'this category';
  const confidence = budget.forecast_confidence ?? 'none';

  return {
    source: 'budget',
    recordKind: 'budget_row',
    recordId: `${month}:${budget.category_id}`,
    params: {
      month,
      categoryId: budget.category_id,
      actualSpent: spent,
      projectedSpend,
      available,
      expectedRecurring,
      projectedRemaining,
      confidence,
    },
    prompt: [
      `Analyze my ${categoryName} budget for ${month}.`,
      `Actual spending is ${formatMoneyValue(spent)} against ${formatMoneyValue(available)} available.`,
      `Projected spending is ${formatMoneyValue(projectedSpend)}, including ${formatMoneyValue(expectedRecurring)} expected recurring activity.`,
      `Projected remaining is ${formatMoneyValue(projectedRemaining)} with ${confidence} forecast confidence.`,
      'Explain whether I am likely to stay under budget, what is driving the projection, and what I should review next.',
    ].join(' '),
  };
}

export function buildTransactionAdvisorPrompt(transaction: Transaction): AdvisorRoutePrompt {
  const merchantName = transaction.merchant_name ?? transaction.original_name;
  const categoryName = transaction.category_name ?? 'uncategorized';
  const accountName = transaction.account_name ?? 'unknown account';
  const institutionName = transaction.institution_name ?? 'unknown institution';
  const notes = transaction.notes?.trim() || null;

  return {
    source: 'transaction',
    recordKind: 'transaction',
    recordId: transaction.id,
    params: {
      transactionId: transaction.id,
      accountId: transaction.account_id,
      date: transaction.date,
      amount: transaction.amount,
      merchantName,
      categoryName,
      accountName,
      institutionName,
      pending: transaction.pending,
      sourceType: transaction.source_type,
      duplicateStatus: transaction.duplicate_status,
      transferStatus: transaction.transfer_status,
      reviewStatus: transaction.review_status,
      notes,
    },
    prompt: [
      `Analyze this ${merchantName} transaction from ${transaction.date}.`,
      `It posted to ${accountName} at ${institutionName} for ${formatMoneyValue(transaction.amount)}.`,
      `It is categorized as ${categoryName}, with ${transaction.pending ? 'pending' : 'posted'} status, ${transaction.transfer_status} transfer status, and ${transaction.duplicate_status} duplicate status.`,
      notes ? `The note says: ${notes}.` : 'There is no note on the transaction.',
      'Explain whether the category, transfer handling, duplicate state, or review state needs attention.',
    ].join(' '),
  };
}

export function buildAccountAdvisorPrompt(account: Account): AdvisorRoutePrompt {
  const availableBalance = account.available_balance ?? null;
  const creditLimit = account.credit_limit ?? null;
  const visibleState = account.is_hidden ? 'hidden' : 'visible';
  const balanceRole = account.is_liability ? 'liability' : 'asset';

  return {
    source: 'account',
    recordKind: 'account_balance',
    recordId: account.id,
    params: {
      accountId: account.id,
      accountName: account.account_name,
      institutionName: account.institution_name,
      type: account.type,
      subtype: account.subtype ?? null,
      connectionType: account.connection_type,
      currentBalance: account.current_balance,
      availableBalance,
      creditLimit,
      currency: account.currency,
      isLiability: account.is_liability,
      isHidden: account.is_hidden,
      updatedAt: account.updated_at,
    },
    prompt: [
      `Analyze my ${account.account_name} account at ${account.institution_name}.`,
      `It is a ${visibleState} ${account.type} ${balanceRole} connected by ${account.connection_type}.`,
      `The current balance is ${formatCurrencyValue(account.current_balance, account.currency)}.`,
      availableBalance != null ? `The available balance is ${formatCurrencyValue(availableBalance, account.currency)}.` : 'There is no available balance reported.',
      creditLimit != null ? `The credit limit is ${formatCurrencyValue(creditLimit, account.currency)}.` : 'There is no credit limit reported.',
      `The account was last updated at ${account.updated_at}.`,
      'Explain what this balance means for cash flow, debt, net worth, and any sync or data-quality concerns I should review.',
    ].join(' '),
  };
}

export function buildHoldingAdvisorPrompt(
  holding: Holding,
  account: Account | null = null
): AdvisorRoutePrompt {
  const securityName = holding.security_name ?? holding.ticker ?? 'this holding';
  const accountName = account?.account_name ?? 'unknown account';
  const institutionName = account?.institution_name ?? 'unknown institution';
  const unrealizedGain = holding.cost_basis != null ? holding.institution_value - holding.cost_basis : null;
  const returnPct = unrealizedGain != null && holding.cost_basis != null && holding.cost_basis > 0
    ? (unrealizedGain / holding.cost_basis) * 100
    : null;

  return {
    source: 'investment',
    recordKind: 'holding',
    recordId: holding.id,
    params: {
      holdingId: holding.id,
      accountId: holding.account_id,
      accountName,
      institutionName,
      ticker: holding.ticker ?? null,
      securityName,
      securityType: holding.security_type ?? null,
      quantity: holding.quantity,
      price: holding.institution_price,
      value: holding.institution_value,
      costBasis: holding.cost_basis ?? null,
      unrealizedGain,
      returnPct,
    },
    prompt: [
      `Analyze my ${securityName} holding${holding.ticker ? ` (${holding.ticker})` : ''}.`,
      `It is held in ${accountName} at ${institutionName}.`,
      `Quantity is ${holding.quantity.toFixed(4)}, current price is ${formatMoneyValue(holding.institution_price)}, and market value is ${formatMoneyValue(holding.institution_value)}.`,
      holding.cost_basis != null
        ? `Cost basis is ${formatMoneyValue(holding.cost_basis)}, unrealized gain or loss is ${formatMoneyValue(unrealizedGain ?? 0)}, and return is ${returnPct == null ? 'not available' : `${returnPct.toFixed(1)}%`}.`
        : 'Cost basis is missing, so unrealized return quality is limited.',
      'Explain concentration, cost basis quality, return quality, and what I should review before making decisions about this position.',
    ].join(' '),
  };
}
