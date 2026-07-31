import type { AdvisorRoutePrompt } from './advisorRouteState';
import type {
  Account,
  Budget,
  BudgetRolloverLedgerEntry,
  DataImportRun,
  Goal,
  Holding,
  RecurringForecast,
  RecurringForecastOccurrence,
  ReportDrilldown,
  ReportEvidenceDrilldown,
  ReportCategoryChange,
  ReportExcludedFlowSummary,
  ReportMetricSummary,
  ReportNetWorthEvidence,
  ReportSummary,
  SyncRun,
  SyncRunDetail,
  Transaction,
} from '@shared/types';
import { creditBalancePhrase, readOwedTotal } from './accountBalance';
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

export interface RecurringForecastAdvisorPromptContext {
  startingBalance?: number | null;
  endingBalance?: number | null;
  lowestBalance?: number | null;
  lowestDate?: string | null;
  liquidAccountCount?: number | null;
}

export interface InvestmentAllocationAdvisorPromptContext {
  lens: string;
  quality: string;
  holdingCount: number;
  totalValue: number;
  missingSectorCount?: number | null;
  slices: Array<{
    key: string;
    label: string;
    value: number;
    pct: number;
    count: number;
  }>;
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

function reportMetricLine(
  label: string,
  // Nullable: a savings rate is undefined for a window with no income, and a prompt that states it
  // as 0% is asking the model to reason about a number nobody measured.
  metric: { current: number | null; delta: number | null },
  isRate = false
): string {
  if (metric.current === null) {
    return `${label} is not defined for this period.`;
  }
  const current = isRate ? `${metric.current.toFixed(1)}%` : formatMoneyValue(metric.current);
  const delta = metric.delta === null
    ? 'no comparison available'
    : isRate
      ? formatSignedPercentPoints(metric.delta)
      : formatSignedMoneyValue(metric.delta);
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

function summarizeForecastOccurrences(forecast: RecurringForecast): string {
  if (forecast.occurrences.length === 0) return 'none';
  return forecast.occurrences
    .slice(0, 5)
    .map((occurrence) => {
      const adjustment = occurrence.adjustment_action
        ? `, ${occurrence.adjustment_action} adjustment${occurrence.original_expected_date ? ` from ${occurrence.original_expected_date}` : ''}`
        : '';
      return `${occurrence.expected_date} ${occurrence.merchant_name} ${formatSignedMoneyValue(occurrence.amount)} (${occurrence.confidence_label}${adjustment})`;
    })
    .join('; ');
}

function summarizeTransactions(transactions: Transaction[]): string {
  if (transactions.length === 0) return 'none';
  return transactions
    .slice(0, 5)
    .map((transaction) => {
      const merchantName = transaction.merchant_name ?? transaction.original_name;
      const accountName = transaction.account_name ?? 'unknown account';
      const categoryName = transaction.category_name ?? 'uncategorized';
      return `${transaction.date} ${merchantName} ${formatSignedMoneyValue(transaction.amount)} from ${accountName} in ${categoryName}`;
    })
    .join('; ');
}

function summarizeNetWorthAccounts(evidence: ReportNetWorthEvidence): string {
  if (evidence.accounts.length === 0) return 'none';
  return evidence.accounts
    .slice(0, 5)
    .map((account) => {
      const accountName = account.account_name ?? account.account_id;
      const institutionName = account.institution_name ?? 'missing institution';
      const accountType = account.type ?? 'unknown type';
      // A liability stores the amount OWED, so a negative one is a credit. "-$563.26 liability"
      // leaves the direction to be inferred from a sign the model may not weigh at all.
      const reading = account.is_liability && account.balance < 0
        ? creditBalancePhrase(formatMoneyValue(-account.balance))
        : `${formatMoneyValue(account.balance)} ${account.is_liability ? 'liability' : 'asset'}`;
      return `${accountName} at ${institutionName} ${reading} (${accountType})`;
    })
    .join('; ');
}

function summarizeSyncItems(detail?: SyncRunDetail): string {
  if (!detail || detail.items.length === 0) return 'detail not loaded';
  return detail.items
    .slice(0, 5)
    .map((item) => {
      const issue = item.error_message ? `, issue ${item.error_message}` : '';
      const recovery = item.recovery_action ? `, recovery ${item.recovery_action}` : '';
      return `${item.institution_name} ${item.provider} ${item.status}: ${item.accounts_seen} accounts, ${item.transactions_added} added, ${item.transactions_modified} updated, ${item.transactions_removed} removed, ${item.transactions_skipped} skipped${issue}${recovery}`;
    })
    .join('; ');
}

function summarizeSyncChanges(detail?: SyncRunDetail): string {
  if (!detail || detail.changes.length === 0) return detail ? 'none' : 'detail not loaded';
  return detail.changes
    .slice(0, 5)
    .map((change) => `${change.entity_type} ${change.change_type}: ${change.description}`)
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

export function buildSyncRunAdvisorPrompt(
  run: SyncRun,
  detail?: SyncRunDetail
): AdvisorRoutePrompt {
  const providerSummary = summarizeSyncItems(detail);
  const changeSummary = summarizeSyncChanges(detail);
  const changedTransactions = run.transactions_added + run.transactions_modified + run.transactions_removed;

  return {
    source: 'sync',
    recordKind: 'sync_run',
    recordId: run.id,
    params: {
      runId: run.id,
      scope: run.scope,
      status: run.status,
      startedAt: run.started_at,
      completedAt: run.completed_at ?? null,
      accountsSeen: run.accounts_seen,
      transactionsAdded: run.transactions_added,
      transactionsModified: run.transactions_modified,
      transactionsRemoved: run.transactions_removed,
      transactionsSkipped: run.transactions_skipped,
      changedTransactions,
      duplicateCandidates: run.duplicate_candidates,
      transferCandidates: run.transfer_candidates,
      errorCode: run.error_code ?? null,
      errorMessage: run.error_message ?? null,
      recoveryAction: run.recovery_action ?? null,
      providerCount: detail?.items.length ?? null,
      changeCount: detail?.changes.length ?? null,
      providerSummary,
      changeSummary,
    },
    prompt: [
      `Explain this ${run.scope} sync run from ${run.started_at}.`,
      `Status is ${run.status}${run.completed_at ? `, completed at ${run.completed_at}` : ''}.`,
      `It saw ${run.accounts_seen} account${run.accounts_seen === 1 ? '' : 's'} and changed ${changedTransactions} transaction${changedTransactions === 1 ? '' : 's'}: ${run.transactions_added} added, ${run.transactions_modified} updated, ${run.transactions_removed} removed, ${run.transactions_skipped} skipped.`,
      `${run.duplicate_candidates} duplicate candidate group${run.duplicate_candidates === 1 ? '' : 's'} and ${run.transfer_candidates} transfer candidate pair${run.transfer_candidates === 1 ? '' : 's'} were detected.`,
      run.error_message ? `Run issue: ${run.error_message}.` : 'No run-level issue is recorded.',
      run.recovery_action ? `Suggested recovery: ${run.recovery_action}.` : 'No run-level recovery action is recorded.',
      `Provider detail: ${providerSummary}.`,
      `Detected changes: ${changeSummary}.`,
      'Explain what changed, whether this sync result should affect account balances or reports, and what I should do next if anything needs recovery or review.',
    ].join(' '),
  };
}

export function buildReportDrilldownAdvisorPrompt(
  drilldown: ReportDrilldown
): AdvisorRoutePrompt {
  const startDate = drilldown.start_date ?? 'unknown start';
  const endDate = drilldown.end_date ?? 'unknown end';
  const transactionSummary = summarizeTransactions(drilldown.transactions);

  return {
    source: 'reports',
    recordKind: 'report_drilldown',
    recordId: `${drilldown.kind}:${drilldown.category_id}:${startDate}:${endDate}`,
    params: {
      kind: drilldown.kind,
      categoryId: drilldown.category_id,
      categoryName: drilldown.category_name,
      startDate,
      endDate,
      total: drilldown.total,
      count: drilldown.count,
      transactionSummary,
    },
    prompt: [
      `Explain the ${drilldown.category_name} ${drilldown.kind} report drill-through from ${startDate} to ${endDate}.`,
      `The total is ${formatMoneyValue(drilldown.total)} across ${drilldown.count} transaction${drilldown.count === 1 ? '' : 's'}.`,
      `Backing transactions: ${transactionSummary}.`,
      'Explain why this report number changed, whether any transactions look miscategorized or excluded incorrectly, and what I should inspect next.',
    ].join(' '),
  };
}

export function buildReportEvidenceAdvisorPrompt(
  evidence: ReportEvidenceDrilldown
): AdvisorRoutePrompt {
  const startDate = evidence.start_date ?? 'unknown start';
  const endDate = evidence.end_date ?? 'unknown end';
  const transactionSummary = summarizeTransactions(evidence.transactions);
  const evidenceScope = evidence.kind === 'cashflow_month'
    ? `cash-flow month ${evidence.month ?? evidence.label}`
    : `excluded ${evidence.flow_type ?? evidence.label} flow`;

  return {
    source: 'reports',
    recordKind: 'report_evidence',
    recordId: `${evidence.kind}:${evidence.month ?? evidence.flow_type ?? evidence.label}:${startDate}:${endDate}`,
    params: {
      kind: evidence.kind,
      label: evidence.label,
      startDate,
      endDate,
      month: evidence.month ?? null,
      flowType: evidence.flow_type ?? null,
      income: evidence.income,
      expenses: evidence.expenses,
      net: evidence.net,
      total: evidence.total,
      count: evidence.count,
      transactionSummary,
    },
    prompt: [
      `Explain this ${evidenceScope} evidence from ${startDate} to ${endDate}.`,
      `Income is ${formatMoneyValue(evidence.income)}, spending is ${formatMoneyValue(evidence.expenses)}, net is ${formatSignedMoneyValue(evidence.net)}, and total is ${formatMoneyValue(evidence.total)}.`,
      `It is backed by ${evidence.count} transaction${evidence.count === 1 ? '' : 's'}: ${transactionSummary}.`,
      'Explain how these transactions affect the report, whether exclusions or transfers are being handled correctly, and what should be reviewed.',
    ].join(' '),
  };
}

export function buildNetWorthEvidenceAdvisorPrompt(
  evidence: ReportNetWorthEvidence
): AdvisorRoutePrompt {
  const snapshot = evidence.snapshot;
  const previousDate = evidence.previous_snapshot?.date ?? null;
  const accountSummary = summarizeNetWorthAccounts(evidence);
  // A snapshot total arrives already summed and signed, so a net credit reaches here as a negative
  // amount owed. "liabilities are -$852.89" states the opposite of what happened, and the
  // per-account line below already reads the same position correctly.
  const owed = readOwedTotal(snapshot.total_liabilities);
  const liabilityReading = owed.inCredit
    ? `${formatMoneyValue(owed.amount)} in credit (the cards owe you)`
    : formatMoneyValue(owed.amount);

  return {
    source: 'reports',
    recordKind: 'networth_evidence',
    recordId: snapshot.id,
    params: {
      snapshotId: snapshot.id,
      date: snapshot.date,
      previousSnapshotDate: previousDate,
      totalAssets: snapshot.total_assets,
      // Stored sign preserved; the reading travels beside it rather than replacing it, matching
      // how a single account in credit is handed over (buildAccountAdvisorPrompt).
      totalLiabilities: snapshot.total_liabilities,
      liabilitiesInCredit: owed.inCredit,
      netWorth: snapshot.net_worth,
      delta: evidence.delta ?? null,
      assetDelta: evidence.asset_delta ?? null,
      liabilityDelta: evidence.liability_delta ?? null,
      accountCount: evidence.accounts.length,
      accountSummary,
    },
    prompt: [
      `Explain the net-worth evidence for ${snapshot.date}.`,
      `Assets are ${formatMoneyValue(snapshot.total_assets)}, liabilities are ${liabilityReading}, and net worth is ${formatMoneyValue(snapshot.net_worth)}.`,
      previousDate ? `Compared with ${previousDate}, net worth changed by ${formatSignedMoneyValue(evidence.delta ?? 0)}.` : 'There is no prior snapshot comparison.',
      `Asset change is ${evidence.asset_delta != null ? formatSignedMoneyValue(evidence.asset_delta) : 'unknown'} and liability change is ${evidence.liability_delta != null ? formatSignedMoneyValue(evidence.liability_delta) : 'unknown'}.`,
      `Account evidence: ${accountSummary}.`,
      'Explain why net worth changed, which accounts drove it, and whether stale sync or missing account records could affect trust.',
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
      'Explain why this number changed, whether it needs review, and which accounts, transactions, reports, sync runs, or budget rows I should inspect.',
    ].join(' '),
  };
}

export function buildRecurringForecastAdvisorPrompt(
  forecast: RecurringForecast,
  context: RecurringForecastAdvisorPromptContext = {}
): AdvisorRoutePrompt {
  const confirmedNet = forecast.confirmed_income - forecast.confirmed_bills;
  const likelyNet = forecast.likely_income - forecast.likely_bills;
  const uncertainNet = forecast.uncertain_income - forecast.uncertain_bills;
  const nextOccurrences = summarizeForecastOccurrences(forecast);
  const projectionContext = [
    context.liquidAccountCount != null ? `${context.liquidAccountCount} liquid account${context.liquidAccountCount === 1 ? '' : 's'}` : null,
    context.startingBalance != null ? `starting cash ${formatMoneyValue(context.startingBalance)}` : null,
    context.lowestBalance != null ? `lowest projected cash ${formatMoneyValue(context.lowestBalance)}${context.lowestDate ? ` on ${context.lowestDate}` : ''}` : null,
    context.endingBalance != null ? `ending cash ${formatMoneyValue(context.endingBalance)}` : null,
  ].filter(Boolean).join(', ') || 'no local cash projection context';

  return {
    source: 'recurring',
    recordKind: 'recurring_forecast',
    recordId: `${forecast.days}d`,
    params: {
      days: forecast.days,
      income: forecast.income,
      bills: forecast.bills,
      net: forecast.net,
      confirmedNet,
      likelyNet,
      uncertainNet,
      overdueCount: forecast.overdue_count,
      reviewCount: forecast.review_count,
      occurrenceCount: forecast.occurrences.length,
      startingBalance: context.startingBalance ?? null,
      endingBalance: context.endingBalance ?? null,
      lowestBalance: context.lowestBalance ?? null,
      lowestDate: context.lowestDate ?? null,
      liquidAccountCount: context.liquidAccountCount ?? null,
      nextOccurrences,
    },
    prompt: [
      `Analyze my recurring bills and income forecast for the next ${forecast.days} days.`,
      `Projected income is ${formatMoneyValue(forecast.income)}, bills are ${formatMoneyValue(forecast.bills)}, and net impact is ${formatSignedMoneyValue(forecast.net)}.`,
      `Confirmed net is ${formatSignedMoneyValue(confirmedNet)}, likely net is ${formatSignedMoneyValue(likelyNet)}, and uncertain net is ${formatSignedMoneyValue(uncertainNet)}.`,
      `${forecast.review_count} recurring item${forecast.review_count === 1 ? '' : 's'} need review and ${forecast.overdue_count} are overdue.`,
      `Cash projection context: ${projectionContext}.`,
      `Next occurrences: ${nextOccurrences}.`,
      'Explain the cash-flow risk, which patterns need review, and what evidence I should inspect before changing bills or budgets.',
    ].join(' '),
  };
}

export function buildRecurringOccurrenceAdvisorPrompt(
  occurrence: RecurringForecastOccurrence
): AdvisorRoutePrompt {
  const categoryName = occurrence.category_name ?? 'uncategorized';
  const reviewState = occurrence.needs_review ? 'needs review' : 'does not need review';
  const adjustmentContext = occurrence.adjustment_action
    ? `This occurrence has a ${occurrence.adjustment_action} one-time adjustment from ${occurrence.original_expected_date ?? occurrence.expected_date}${occurrence.adjusted_amount != null ? ` to ${formatSignedMoneyValue(occurrence.adjusted_amount)}` : ''}${occurrence.adjusted_date ? ` on ${occurrence.adjusted_date}` : ''}.`
    : 'This occurrence has no one-time adjustment.';

  return {
    source: 'recurring',
    recordKind: 'recurring_occurrence',
    recordId: occurrence.id,
    params: {
      occurrenceId: occurrence.id,
      patternId: occurrence.pattern_id,
      merchantName: occurrence.merchant_name,
      categoryId: occurrence.category_id ?? null,
      categoryName,
      frequency: occurrence.frequency,
      expectedDate: occurrence.expected_date,
      amount: occurrence.amount,
      isIncome: occurrence.is_income,
      isConfirmed: occurrence.is_confirmed,
      confidence: occurrence.confidence,
      confidenceLabel: occurrence.confidence_label,
      status: occurrence.status,
      daysUntil: occurrence.days_until,
      needsReview: occurrence.needs_review,
      adjustmentId: occurrence.adjustment_id ?? null,
      adjustmentAction: occurrence.adjustment_action ?? null,
      originalExpectedDate: occurrence.original_expected_date ?? null,
      adjustedDate: occurrence.adjusted_date ?? null,
      adjustedAmount: occurrence.adjusted_amount ?? null,
    },
    prompt: [
      `Analyze this recurring ${occurrence.is_income ? 'income' : 'bill'} item from ${occurrence.merchant_name}.`,
      `It is expected on ${occurrence.expected_date} for ${formatSignedMoneyValue(occurrence.amount)} and repeats ${occurrence.frequency}.`,
      `It is categorized as ${categoryName}, has ${occurrence.confidence_label} confidence (${Math.round(occurrence.confidence * 100)}%), and ${reviewState}.`,
      `The pattern is ${occurrence.is_confirmed ? 'confirmed' : 'unconfirmed'} and the occurrence is ${occurrence.status}.`,
      adjustmentContext,
      'Explain whether this recurring item should be trusted in my cash-flow forecast, what evidence supports it, and whether I should confirm, dismiss, recategorize, or inspect matching transactions.',
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

export function buildRolloverLedgerAdvisorPrompt(row: BudgetRolloverLedgerEntry): AdvisorRoutePrompt {
  return {
    source: 'budget',
    recordKind: 'rollover_ledger_row',
    recordId: row.id,
    params: {
      ledgerId: row.id,
      budgetId: row.budget_id,
      categoryId: row.category_id,
      categoryName: row.category_name ?? null,
      month: row.month,
      startingRollover: row.starting_rollover,
      budgetAmount: row.budget_amount,
      actualSpend: row.actual_spend,
      endingRollover: row.ending_rollover,
      calculatedAt: row.calculated_at,
    },
    prompt: [
      `Explain this rollover ledger row for ${row.category_name ?? 'this budget'} in ${row.month}.`,
      `Starting rollover was ${formatMoneyValue(row.starting_rollover)}, budget amount was ${formatMoneyValue(row.budget_amount)}, actual spend was ${formatMoneyValue(row.actual_spend)}, and ending rollover was ${formatMoneyValue(row.ending_rollover)}.`,
      `The row was calculated at ${row.calculated_at}.`,
      'Explain the rollover math, whether it looks consistent, and what transactions or budget settings I should inspect if the ending balance is surprising.',
    ].join(' '),
  };
}

export function buildGoalAdvisorPrompt(goal: Goal): AdvisorRoutePrompt {
  const accountName = goal.account_name ?? null;
  const institutionName = goal.institution_name ?? null;
  const linkedAccount = accountName
    ? `${institutionName ? `${institutionName} ` : ''}${accountName}`
    : null;
  const targetDate = goal.target_date ?? null;
  const accountBalance = goal.account_balance ?? null;

  return {
    source: 'goal',
    recordKind: 'goal',
    recordId: goal.id,
    params: {
      goalId: goal.id,
      name: goal.name,
      type: goal.type,
      targetAmount: goal.target_amount,
      currentAmount: goal.current_amount,
      progressAmount: goal.progress_amount,
      remainingAmount: goal.remaining_amount,
      progressPercent: goal.progress_percent,
      startingAmount: goal.starting_amount ?? null,
      accountId: goal.account_id ?? null,
      accountName,
      institutionName,
      accountBalance,
      targetDate,
    },
    prompt: [
      `Analyze my ${goal.name} ${goal.type} goal.`,
      `Target is ${formatMoneyValue(goal.target_amount)} and progress is ${formatMoneyValue(goal.progress_amount)} (${goal.progress_percent.toFixed(1)}%).`,
      `Remaining amount is ${formatMoneyValue(goal.remaining_amount)}.`,
      targetDate ? `Target date is ${targetDate}.` : 'There is no target date.',
      linkedAccount
        ? `This goal is linked to ${linkedAccount}${accountBalance != null ? ` with balance ${formatMoneyValue(accountBalance)}` : ''}.`
        : `This goal uses manual progress of ${formatMoneyValue(goal.current_amount)}.`,
      goal.type === 'debt' && goal.starting_amount != null
        ? `Starting debt balance is ${formatMoneyValue(goal.starting_amount)}.`
        : '',
      'Explain whether the goal is realistic, what could affect progress, and which budgets, bills, accounts, or cash-flow projections I should inspect.',
    ].filter(Boolean).join(' '),
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
  const inCredit = account.is_liability && account.current_balance < 0;

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
      inCredit,
      isHidden: account.is_hidden,
      updatedAt: account.updated_at,
    },
    prompt: [
      `Analyze my ${account.account_name} account at ${account.institution_name}.`,
      `It is a ${visibleState} ${account.type} ${balanceRole} connected by ${account.connection_type}.`,
      inCredit
        ? `The current balance is ${creditBalancePhrase(formatCurrencyValue(-account.current_balance, account.currency))}, stored as a negative amount owed.`
        : `The current balance is ${formatCurrencyValue(account.current_balance, account.currency)}.`,
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
  // A basis of 0 is unreported, so there is no gain to state: quoting one hands the model the
  // position's whole market value as profit and asks it to explain a return that never happened.
  const costBasis = holding.cost_basis != null && holding.cost_basis > 0 ? holding.cost_basis : null;
  const unrealizedGain = costBasis != null ? holding.institution_value - costBasis : null;
  const returnPct = unrealizedGain != null && costBasis != null
    ? (unrealizedGain / costBasis) * 100
    : null;
  const costBasisSource = holding.cost_basis_quality ?? (costBasis == null ? 'missing' : 'provider');
  const sector = holding.sector ?? 'not available';

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
      costBasis,
      providerCostBasis: holding.provider_cost_basis ?? null,
      manualCostBasis: holding.manual_cost_basis ?? null,
      costBasisSource,
      sector,
      sectorSource: holding.sector_source ?? null,
      unrealizedGain,
      returnPct,
    },
    prompt: [
      `Analyze my ${securityName} holding${holding.ticker ? ` (${holding.ticker})` : ''}.`,
      `It is held in ${accountName} at ${institutionName}.`,
      `Quantity is ${holding.quantity.toFixed(4)}, current price is ${formatMoneyValue(holding.institution_price)}, and market value is ${formatMoneyValue(holding.institution_value)}.`,
      costBasis != null
        ? `Effective cost basis is ${formatMoneyValue(costBasis)} from ${costBasisSource} data, provider basis is ${holding.provider_cost_basis == null ? 'not available' : formatMoneyValue(holding.provider_cost_basis)}, unrealized gain or loss is ${formatMoneyValue(unrealizedGain ?? 0)}, and return is ${returnPct == null ? 'not available' : `${returnPct.toFixed(1)}%`}.`
        : 'Cost basis is missing, so unrealized return quality is limited.',
      `Sector is ${sector}${holding.sector_source ? ` from ${holding.sector_source}` : ''}.`,
      'Explain concentration, cost basis quality, sector metadata quality, return quality, and what I should review before making decisions about this position.',
    ].join(' '),
  };
}

export function buildInvestmentAllocationAdvisorPrompt(
  context: InvestmentAllocationAdvisorPromptContext
): AdvisorRoutePrompt {
  const topSlices = context.slices.slice(0, 5).map((slice) =>
    `${slice.label}: ${formatMoneyValue(slice.value)} (${slice.pct.toFixed(1)}%, ${slice.count} holding${slice.count === 1 ? '' : 's'})`
  ).join('; ') || 'none';
  const missingSectorLine = context.missingSectorCount != null
    ? `${context.missingSectorCount} holding${context.missingSectorCount === 1 ? '' : 's'} ${context.missingSectorCount === 1 ? 'is' : 'are'} missing sector metadata.`
    : '';

  return {
    source: 'investment',
    recordKind: 'investment_allocation',
    recordId: context.lens,
    params: {
      lens: context.lens,
      quality: context.quality,
      holdingCount: context.holdingCount,
      totalValue: context.totalValue,
      missingSectorCount: context.missingSectorCount ?? null,
      topSlices,
    },
    prompt: [
      `Analyze my investment allocation by ${context.lens}.`,
      `The visible portfolio has ${context.holdingCount} holding${context.holdingCount === 1 ? '' : 's'} worth ${formatMoneyValue(context.totalValue)}.`,
      `Data quality for this allocation view is ${context.quality}.`,
      missingSectorLine,
      `Top allocation slices: ${topSlices}.`,
      'Explain concentration, diversification, sector metadata quality, and what metadata or holdings I should review before trusting this allocation view.',
    ].filter(Boolean).join(' '),
  };
}

export function buildImportRunAdvisorPrompt(run: DataImportRun): AdvisorRoutePrompt {
  return {
    source: 'import',
    recordKind: 'import_run',
    recordId: run.id,
    params: {
      runId: run.id,
      source: run.source,
      status: run.status,
      rowsSeen: run.rows_seen,
      rowsImported: run.rows_imported,
      rowsInvalid: run.rows_invalid,
      duplicateCandidates: run.duplicate_candidates,
      transferCandidates: run.transfer_candidates,
      warnings: run.warnings_count,
      errors: run.errors_count,
      createdAt: run.created_at,
    },
    prompt: [
      `Explain this ${run.source === 'csv' ? 'CSV import' : 'backup restore'} audit run from ${run.created_at}.`,
      `Status is ${run.status}. It imported ${run.rows_imported}/${run.rows_seen} rows, with ${run.rows_invalid} invalid rows.`,
      `It found ${run.duplicate_candidates} duplicate candidate${run.duplicate_candidates === 1 ? '' : 's'}, ${run.transfer_candidates} transfer candidate${run.transfer_candidates === 1 ? '' : 's'}, ${run.warnings_count} warning${run.warnings_count === 1 ? '' : 's'}, and ${run.errors_count} error${run.errors_count === 1 ? '' : 's'}.`,
      `Summary: ${run.summary}.`,
      'Explain whether this import changed trustworthy financial data, what review queues I should inspect, and whether duplicates or transfers need cleanup.',
    ].join(' '),
  };
}
