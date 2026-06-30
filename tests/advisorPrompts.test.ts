import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccountAdvisorPrompt,
  buildBudgetAdvisorPrompt,
  buildDashboardCardAdvisorPrompt,
  buildGoalAdvisorPrompt,
  buildHoldingAdvisorPrompt,
  buildNetWorthEvidenceAdvisorPrompt,
  buildRecurringForecastAdvisorPrompt,
  buildRecurringOccurrenceAdvisorPrompt,
  buildReportAdvisorPrompt,
  buildReportDrilldownAdvisorPrompt,
  buildReportEvidenceAdvisorPrompt,
  buildSyncRunAdvisorPrompt,
  buildTransactionAdvisorPrompt,
} from '../client/src/lib/advisorPrompts';
import type {
  Account,
  Budget,
  Goal,
  Holding,
  NetWorthSnapshot,
  RecurringForecast,
  ReportDrilldown,
  ReportEvidenceDrilldown,
  ReportNetWorthEvidence,
  ReportSummary,
  SyncRun,
  SyncRunDetail,
  Transaction,
} from '../shared/types';

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: overrides.id ?? 'budget_food',
    category_id: overrides.category_id ?? 'cat_food',
    category_name: overrides.category_name ?? 'Food',
    amount: overrides.amount ?? 500,
    period: overrides.period ?? 'monthly',
    rollover: overrides.rollover ?? true,
    rollover_balance: overrides.rollover_balance ?? 50,
    created_at: overrides.created_at ?? '2026-06-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-01T00:00:00.000Z',
    spent: overrides.spent ?? 240,
    expected_recurring: overrides.expected_recurring ?? 90,
    projected_spend: overrides.projected_spend ?? 330,
    projected_remaining: overrides.projected_remaining ?? 220,
    forecast_confidence: overrides.forecast_confidence ?? 'likely',
  };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: overrides.id ?? 'tx_1',
    plaid_transaction_id: overrides.plaid_transaction_id ?? 'plaid_tx_1',
    coinbase_transaction_id: overrides.coinbase_transaction_id ?? null,
    account_id: overrides.account_id ?? 'acct_checking',
    date: overrides.date ?? '2026-06-28',
    amount: overrides.amount ?? -46.72,
    merchant_name: overrides.merchant_name ?? 'City Market',
    original_name: overrides.original_name ?? 'CITY MARKET #22',
    category_id: overrides.category_id ?? 'cat_groceries',
    pending: overrides.pending ?? false,
    notes: overrides.notes ?? 'Dinner supplies',
    is_manual: overrides.is_manual ?? false,
    recurring_id: overrides.recurring_id ?? null,
    source_type: overrides.source_type ?? 'plaid',
    source_detail: overrides.source_detail ?? null,
    duplicate_group_id: overrides.duplicate_group_id ?? null,
    duplicate_status: overrides.duplicate_status ?? 'none',
    transfer_pair_id: overrides.transfer_pair_id ?? null,
    transfer_status: overrides.transfer_status ?? 'none',
    review_status: overrides.review_status ?? 'open',
    created_at: overrides.created_at ?? '2026-06-28T12:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-28T12:00:00.000Z',
    category_name: overrides.category_name ?? 'Groceries',
    category_color: overrides.category_color ?? '#32bfa3',
    category_icon: overrides.category_icon ?? 'shopping-cart',
    account_name: overrides.account_name ?? 'Rewards Checking',
    institution_name: overrides.institution_name ?? 'Test Bank',
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.id ?? 'acct_checking',
    plaid_account_id: overrides.plaid_account_id ?? 'plaid_acct_1',
    coinbase_account_id: overrides.coinbase_account_id ?? null,
    connection_id: overrides.connection_id ?? 'item_1',
    connection_type: overrides.connection_type ?? 'plaid',
    institution_name: overrides.institution_name ?? 'Test Bank',
    account_name: overrides.account_name ?? 'Rewards Checking',
    type: overrides.type ?? 'checking',
    subtype: overrides.subtype ?? 'checking',
    mask: overrides.mask ?? '4242',
    current_balance: overrides.current_balance ?? 1240.25,
    available_balance: overrides.available_balance ?? 1180.25,
    credit_limit: overrides.credit_limit ?? null,
    currency: overrides.currency ?? 'USD',
    native_currency: overrides.native_currency ?? null,
    native_balance: overrides.native_balance ?? null,
    is_manual: overrides.is_manual ?? false,
    is_hidden: overrides.is_hidden ?? false,
    is_liability: overrides.is_liability ?? false,
    color: overrides.color ?? '#32bfa3',
    sort_order: overrides.sort_order ?? 0,
    created_at: overrides.created_at ?? '2026-06-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-30T12:00:00.000Z',
  };
}

function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: overrides.id ?? 'holding_1',
    account_id: overrides.account_id ?? 'acct_checking',
    security_id: overrides.security_id ?? 'sec_1',
    quantity: overrides.quantity ?? 10,
    institution_value: overrides.institution_value ?? 1250,
    institution_price: overrides.institution_price ?? 125,
    cost_basis: overrides.cost_basis ?? 1000,
    currency: overrides.currency ?? 'USD',
    updated_at: overrides.updated_at ?? '2026-06-30T12:00:00.000Z',
    ticker: overrides.ticker ?? 'VTI',
    security_name: overrides.security_name ?? 'Vanguard Total Stock Market ETF',
    security_type: overrides.security_type ?? 'etf',
  };
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: overrides.id ?? 'goal_emergency',
    name: overrides.name ?? 'Emergency Fund',
    type: overrides.type ?? 'savings',
    target_amount: overrides.target_amount ?? 10000,
    current_amount: overrides.current_amount ?? 2500,
    starting_amount: overrides.starting_amount ?? null,
    account_id: overrides.account_id ?? 'acct_savings',
    target_date: overrides.target_date ?? '2026-12-31',
    color: overrides.color ?? '#32bfa3',
    is_archived: overrides.is_archived ?? false,
    created_at: overrides.created_at ?? '2026-06-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-30T12:00:00.000Z',
    progress_amount: overrides.progress_amount ?? 4000,
    remaining_amount: overrides.remaining_amount ?? 6000,
    progress_percent: overrides.progress_percent ?? 40,
    account_name: overrides.account_name ?? 'High Yield Savings',
    institution_name: overrides.institution_name ?? 'Test Bank',
    account_balance: overrides.account_balance ?? 4000,
    account_is_liability: overrides.account_is_liability ?? false,
  };
}

function reportSummary(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    start_date: overrides.start_date ?? '2026-06-01',
    end_date: overrides.end_date ?? '2026-06-30',
    comparison: overrides.comparison ?? 'prior_month',
    comparison_label: overrides.comparison_label ?? 'Prior month',
    comparison_start_date: overrides.comparison_start_date ?? '2026-05-01',
    comparison_end_date: overrides.comparison_end_date ?? '2026-05-31',
    income: overrides.income ?? { current: 5000, previous: 4800, delta: 200, delta_percent: 4.17 },
    expenses: overrides.expenses ?? { current: 3200, previous: 3000, delta: 200, delta_percent: 6.67 },
    net: overrides.net ?? { current: 1800, previous: 1800, delta: 0, delta_percent: 0 },
    savings_rate: overrides.savings_rate ?? { current: 36, previous: 37.5, delta: -1.5, delta_percent: null },
    top_spending: overrides.top_spending ?? [{
      category_id: 'cat_food',
      category_name: 'Food',
      current: 820,
      previous: 700,
      delta: 120,
      delta_percent: 17.14,
    }],
    top_income: overrides.top_income ?? [{
      category_id: 'cat_payroll',
      category_name: 'Payroll',
      current: 5000,
      previous: 4800,
      delta: 200,
      delta_percent: 4.17,
    }],
    spending_movers: overrides.spending_movers ?? [{
      category_id: 'cat_travel',
      category_name: 'Travel',
      current: 450,
      previous: 50,
      delta: 400,
      delta_percent: 800,
    }],
    excluded_flows: overrides.excluded_flows ?? [{
      flow_type: 'transfers',
      count: 6,
      inflows: 1200,
      outflows: -1200,
      net: 0,
    }],
  };
}

function reportDrilldown(overrides: Partial<ReportDrilldown> = {}): ReportDrilldown {
  return {
    kind: overrides.kind ?? 'spending',
    category_id: overrides.category_id ?? 'cat_food',
    category_name: overrides.category_name ?? 'Food',
    start_date: overrides.start_date ?? '2026-06-01',
    end_date: overrides.end_date ?? '2026-06-30',
    total: overrides.total ?? 146.72,
    count: overrides.count ?? 2,
    transactions: overrides.transactions ?? [
      transaction({ id: 'tx_food_1', amount: -46.72, merchant_name: 'City Market' }),
      transaction({ id: 'tx_food_2', amount: -100, merchant_name: 'Dinner House', category_name: 'Dining' }),
    ],
  };
}

function reportEvidence(overrides: Partial<ReportEvidenceDrilldown> = {}): ReportEvidenceDrilldown {
  return {
    kind: overrides.kind ?? 'cashflow_month',
    label: overrides.label ?? 'Cash flow for June 2026',
    start_date: overrides.start_date ?? '2026-06-01',
    end_date: overrides.end_date ?? '2026-06-30',
    month: overrides.month ?? '2026-06',
    flow_type: overrides.flow_type ?? undefined,
    income: overrides.income ?? 5000,
    expenses: overrides.expenses ?? 3200,
    net: overrides.net ?? 1800,
    total: overrides.total ?? 8200,
    count: overrides.count ?? 2,
    transactions: overrides.transactions ?? [
      transaction({ id: 'tx_paycheck', amount: 5000, merchant_name: 'Payroll', category_name: 'Paycheck' }),
      transaction({ id: 'tx_rent', amount: -1800, merchant_name: 'Rent', category_name: 'Rent' }),
    ],
  };
}

function netWorthSnapshot(overrides: Partial<NetWorthSnapshot> = {}): NetWorthSnapshot {
  return {
    id: overrides.id ?? 'snap_2026_06_30',
    date: overrides.date ?? '2026-06-30',
    total_assets: overrides.total_assets ?? 82000,
    total_liabilities: overrides.total_liabilities ?? 12000,
    net_worth: overrides.net_worth ?? 70000,
    breakdown: overrides.breakdown ?? '{}',
    is_estimated: overrides.is_estimated ?? false,
    created_at: overrides.created_at ?? '2026-06-30T12:00:00.000Z',
    liquid_assets: overrides.liquid_assets ?? 20000,
    investment_assets: overrides.investment_assets ?? 62000,
    crypto_assets: overrides.crypto_assets ?? 0,
  };
}

function netWorthEvidence(overrides: Partial<ReportNetWorthEvidence> = {}): ReportNetWorthEvidence {
  return {
    kind: 'networth_snapshot',
    label: overrides.label ?? 'Net worth on 2026-06-30',
    snapshot: overrides.snapshot ?? netWorthSnapshot(),
    previous_snapshot: overrides.previous_snapshot ?? netWorthSnapshot({
      id: 'snap_2026_05_31',
      date: '2026-05-31',
      total_assets: 79000,
      total_liabilities: 12500,
      net_worth: 66500,
    }),
    delta: overrides.delta ?? 3500,
    asset_delta: overrides.asset_delta ?? 3000,
    liability_delta: overrides.liability_delta ?? -500,
    accounts: overrides.accounts ?? [{
      account_id: 'acct_brokerage',
      account_name: 'Brokerage',
      institution_name: 'Test Bank',
      type: 'investment',
      is_liability: false,
      balance: 62000,
    }],
  };
}

function syncRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: overrides.id ?? 'sync_run_1',
    scope: overrides.scope ?? 'plaid_all',
    status: overrides.status ?? 'partial',
    started_at: overrides.started_at ?? '2026-06-30T12:00:00.000Z',
    completed_at: overrides.completed_at ?? '2026-06-30T12:00:10.000Z',
    message: overrides.message ?? 'Completed with provider attention',
    error_code: overrides.error_code ?? null,
    error_message: overrides.error_message ?? null,
    recovery_action: overrides.recovery_action ?? null,
    accounts_seen: overrides.accounts_seen ?? 4,
    transactions_added: overrides.transactions_added ?? 12,
    transactions_modified: overrides.transactions_modified ?? 3,
    transactions_removed: overrides.transactions_removed ?? 1,
    transactions_skipped: overrides.transactions_skipped ?? 2,
    duplicate_candidates: overrides.duplicate_candidates ?? 1,
    transfer_candidates: overrides.transfer_candidates ?? 2,
  };
}

function syncRunDetail(overrides: Partial<SyncRunDetail> = {}): SyncRunDetail {
  const base = syncRun(overrides);
  return {
    ...base,
    items: overrides.items ?? [{
      id: 'sync_item_1',
      run_id: base.id,
      provider: 'plaid',
      connection_id: 'item_1',
      institution_name: 'Test Bank',
      status: 'reauth_required',
      started_at: base.started_at,
      completed_at: base.completed_at,
      accounts_seen: 2,
      transactions_added: 8,
      transactions_modified: 1,
      transactions_removed: 0,
      transactions_skipped: 2,
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'Bank login required',
      recovery_action: 'Reconnect Test Bank',
    }],
    changes: overrides.changes ?? [{
      id: 'sync_change_1',
      run_item_id: 'sync_item_1',
      entity_type: 'transaction',
      entity_id: 'tx_1',
      change_type: 'inserted',
      description: 'Imported City Market transaction',
      created_at: '2026-06-30T12:00:11.000Z',
    }],
  };
}

function recurringForecast(overrides: Partial<RecurringForecast> = {}): RecurringForecast {
  return {
    days: overrides.days ?? 60,
    income: overrides.income ?? 5000,
    bills: overrides.bills ?? 2800,
    net: overrides.net ?? 2200,
    confirmed_income: overrides.confirmed_income ?? 4000,
    confirmed_bills: overrides.confirmed_bills ?? 1800,
    likely_income: overrides.likely_income ?? 1000,
    likely_bills: overrides.likely_bills ?? 800,
    uncertain_income: overrides.uncertain_income ?? 0,
    uncertain_bills: overrides.uncertain_bills ?? 200,
    overdue_count: overrides.overdue_count ?? 1,
    review_count: overrides.review_count ?? 2,
    occurrences: overrides.occurrences ?? [{
      id: 'occ_rent_2026_07_01',
      pattern_id: 'rec_rent',
      merchant_name: 'Rent',
      frequency: 'monthly',
      expected_date: '2026-07-01',
      amount: -1800,
      is_income: false,
      is_confirmed: true,
      confidence: 1,
      confidence_label: 'confirmed',
      status: 'upcoming',
      days_until: 1,
      needs_review: false,
    }],
  };
}

test('report advisor prompt captures summary metrics and exclusions', () => {
  const prompt = buildReportAdvisorPrompt(reportSummary(), {
    tab: 'cashflow',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

  assert.equal(prompt.source, 'reports');
  assert.equal(prompt.recordKind, 'report_summary');
  assert.equal(prompt.recordId, 'cashflow:2026-06-01:2026-06-30');
  assert.equal(prompt.params?.tab, 'cashflow');
  assert.equal(prompt.params?.incomeCurrent, 5000);
  assert.equal(prompt.params?.spendingDelta, 200);
  assert.equal(prompt.params?.excludedFlowCount, 6);
  assert.match(prompt.prompt, /cashflow report from 2026-06-01 to 2026-06-30/);
  assert.match(prompt.prompt, /Compared with Prior month/);
  assert.match(prompt.prompt, /Food \$820\.00 \(\+\$120\.00\)/);
  assert.match(prompt.prompt, /transfers: 6 transactions/);
});

test('report drilldown advisor prompt captures backing transactions', () => {
  const prompt = buildReportDrilldownAdvisorPrompt(reportDrilldown());

  assert.equal(prompt.source, 'reports');
  assert.equal(prompt.recordKind, 'report_drilldown');
  assert.equal(prompt.recordId, 'spending:cat_food:2026-06-01:2026-06-30');
  assert.equal(prompt.params?.categoryName, 'Food');
  assert.equal(prompt.params?.count, 2);
  assert.match(prompt.prompt, /Food spending report drill-through/);
  assert.match(prompt.prompt, /total is \$146\.72 across 2 transactions/);
  assert.match(prompt.prompt, /City Market -\$46\.72 from Rewards Checking in Groceries/);
});

test('report evidence advisor prompt captures cash-flow evidence', () => {
  const prompt = buildReportEvidenceAdvisorPrompt(reportEvidence());

  assert.equal(prompt.source, 'reports');
  assert.equal(prompt.recordKind, 'report_evidence');
  assert.equal(prompt.recordId, 'cashflow_month:2026-06:2026-06-01:2026-06-30');
  assert.equal(prompt.params?.net, 1800);
  assert.equal(prompt.params?.count, 2);
  assert.match(prompt.prompt, /cash-flow month 2026-06 evidence/);
  assert.match(prompt.prompt, /Income is \$5000\.00, spending is \$3200\.00, net is \+\$1800\.00/);
  assert.match(prompt.prompt, /Payroll \+\$5000\.00 from Rewards Checking in Paycheck/);
});

test('net worth evidence advisor prompt captures account attribution', () => {
  const prompt = buildNetWorthEvidenceAdvisorPrompt(netWorthEvidence());

  assert.equal(prompt.source, 'reports');
  assert.equal(prompt.recordKind, 'networth_evidence');
  assert.equal(prompt.recordId, 'snap_2026_06_30');
  assert.equal(prompt.params?.accountCount, 1);
  assert.equal(prompt.params?.assetDelta, 3000);
  assert.match(prompt.prompt, /net-worth evidence for 2026-06-30/);
  assert.match(prompt.prompt, /net worth is \$70000\.00/);
  assert.match(prompt.prompt, /Brokerage at Test Bank \$62000\.00 asset/);
});

test('sync run advisor prompt captures provider status and detected changes', () => {
  const detail = syncRunDetail();
  const prompt = buildSyncRunAdvisorPrompt(detail, detail);

  assert.equal(prompt.source, 'sync');
  assert.equal(prompt.recordKind, 'sync_run');
  assert.equal(prompt.recordId, 'sync_run_1');
  assert.equal(prompt.params?.status, 'partial');
  assert.equal(prompt.params?.changedTransactions, 16);
  assert.equal(prompt.params?.providerCount, 1);
  assert.equal(prompt.params?.changeCount, 1);
  assert.match(prompt.prompt, /plaid_all sync run/);
  assert.match(prompt.prompt, /12 added, 3 updated, 1 removed, 2 skipped/);
  assert.match(prompt.prompt, /Test Bank plaid reauth_required/);
  assert.match(prompt.prompt, /Imported City Market transaction/);
});

test('dashboard card advisor prompt captures the selected metric context', () => {
  const prompt = buildDashboardCardAdvisorPrompt({
    card: 'monthly_spend',
    title: 'Monthly Spend',
    period: '2026-06',
    value: 3200,
    delta: 200,
    deltaLabel: 'vs last month',
    extraContext: 'Transfers are excluded from this number.',
  });

  assert.equal(prompt.source, 'dashboard');
  assert.equal(prompt.recordKind, 'dashboard_card');
  assert.equal(prompt.recordId, 'monthly_spend:2026-06');
  assert.equal(prompt.params?.currentValue, 3200);
  assert.equal(prompt.params?.delta, 200);
  assert.match(prompt.prompt, /dashboard Monthly Spend card for 2026-06/);
  assert.match(prompt.prompt, /displayed value is \$3200\.00/);
  assert.match(prompt.prompt, /displayed change is \+\$200\.00 vs last month/);
  assert.match(prompt.prompt, /Transfers are excluded/);
  assert.match(prompt.prompt, /Explain why this number changed/);
});

test('recurring forecast advisor prompt captures cash projection context', () => {
  const prompt = buildRecurringForecastAdvisorPrompt(recurringForecast(), {
    startingBalance: 3000,
    endingBalance: 5200,
    lowestBalance: 1200,
    lowestDate: '2026-07-01',
    liquidAccountCount: 2,
  });

  assert.equal(prompt.source, 'recurring');
  assert.equal(prompt.recordKind, 'recurring_forecast');
  assert.equal(prompt.recordId, '60d');
  assert.equal(prompt.params?.reviewCount, 2);
  assert.equal(prompt.params?.lowestBalance, 1200);
  assert.match(prompt.prompt, /recurring bills and income forecast for the next 60 days/);
  assert.match(prompt.prompt, /Projected income is \$5000\.00, bills are \$2800\.00/);
  assert.match(prompt.prompt, /lowest projected cash \$1200\.00 on 2026-07-01/);
  assert.match(prompt.prompt, /2026-07-01 Rent -\$1800\.00/);
});

test('recurring occurrence advisor prompt captures row context', () => {
  const [occurrence] = recurringForecast({
    occurrences: [{
      id: 'occ_payroll_2026_07_03',
      pattern_id: 'rec_payroll',
      merchant_name: 'Payroll',
      category_id: 'cat_income',
      category_name: 'Paycheck',
      frequency: 'biweekly',
      expected_date: '2026-07-03',
      amount: 2500,
      is_income: true,
      is_confirmed: false,
      confidence: 0.82,
      confidence_label: 'likely',
      status: 'upcoming',
      days_until: 3,
      needs_review: true,
    }],
  }).occurrences;

  const prompt = buildRecurringOccurrenceAdvisorPrompt(occurrence);

  assert.equal(prompt.source, 'recurring');
  assert.equal(prompt.recordKind, 'recurring_occurrence');
  assert.equal(prompt.recordId, 'occ_payroll_2026_07_03');
  assert.equal(prompt.params?.patternId, 'rec_payroll');
  assert.equal(prompt.params?.confidenceLabel, 'likely');
  assert.equal(prompt.params?.needsReview, true);
  assert.match(prompt.prompt, /recurring income item from Payroll/);
  assert.match(prompt.prompt, /expected on 2026-07-03 for \+\$2500\.00/);
  assert.match(prompt.prompt, /Paycheck, has likely confidence \(82%\)/);
});

test('goal advisor prompt captures progress and linked account context', () => {
  const prompt = buildGoalAdvisorPrompt(goal());

  assert.equal(prompt.source, 'goal');
  assert.equal(prompt.recordKind, 'goal');
  assert.equal(prompt.recordId, 'goal_emergency');
  assert.equal(prompt.params?.progressAmount, 4000);
  assert.equal(prompt.params?.remainingAmount, 6000);
  assert.equal(prompt.params?.accountBalance, 4000);
  assert.match(prompt.prompt, /Emergency Fund savings goal/);
  assert.match(prompt.prompt, /progress is \$4000\.00 \(40\.0%\)/);
  assert.match(prompt.prompt, /linked to Test Bank High Yield Savings/);
});

test('budget advisor prompt captures row context and projection math', () => {
  const prompt = buildBudgetAdvisorPrompt(budget(), '2026-06');

  assert.equal(prompt.source, 'budget');
  assert.equal(prompt.recordKind, 'budget_row');
  assert.equal(prompt.recordId, '2026-06:cat_food');
  assert.equal(prompt.params?.month, '2026-06');
  assert.equal(prompt.params?.actualSpent, 240);
  assert.equal(prompt.params?.available, 550);
  assert.equal(prompt.params?.projectedRemaining, 220);
  assert.match(prompt.prompt, /Food budget for 2026-06/);
  assert.match(prompt.prompt, /Actual spending is \$240\.00 against \$550\.00 available/);
  assert.match(prompt.prompt, /likely forecast confidence/);
});

test('budget advisor prompt falls back to actual spending without projections', () => {
  const fallbackBudget = budget({
    rollover: false,
    rollover_balance: 50,
    spent: 120,
  });
  fallbackBudget.category_name = null;
  delete fallbackBudget.expected_recurring;
  delete fallbackBudget.projected_spend;
  delete fallbackBudget.projected_remaining;
  delete fallbackBudget.forecast_confidence;

  const prompt = buildBudgetAdvisorPrompt(fallbackBudget, '2026-07');

  assert.equal(prompt.params?.available, 500);
  assert.equal(prompt.params?.projectedSpend, 120);
  assert.equal(prompt.params?.projectedRemaining, 380);
  assert.match(prompt.prompt, /this category budget for 2026-07/);
  assert.match(prompt.prompt, /none forecast confidence/);
});

test('transaction advisor prompt captures row evidence and review state', () => {
  const prompt = buildTransactionAdvisorPrompt(transaction());

  assert.equal(prompt.source, 'transaction');
  assert.equal(prompt.recordKind, 'transaction');
  assert.equal(prompt.recordId, 'tx_1');
  assert.equal(prompt.params?.amount, -46.72);
  assert.equal(prompt.params?.categoryName, 'Groceries');
  assert.equal(prompt.params?.reviewStatus, 'open');
  assert.match(prompt.prompt, /City Market transaction from 2026-06-28/);
  assert.match(prompt.prompt, /Rewards Checking at Test Bank for -\$46\.72/);
  assert.match(prompt.prompt, /Dinner supplies/);
});

test('account advisor prompt captures balance context and data freshness', () => {
  const creditAccount = account({
    type: 'credit',
    current_balance: 420.5,
    credit_limit: 5000,
    is_liability: true,
    is_hidden: true,
  });
  creditAccount.available_balance = null;
  const prompt = buildAccountAdvisorPrompt(creditAccount);

  assert.equal(prompt.source, 'account');
  assert.equal(prompt.recordKind, 'account_balance');
  assert.equal(prompt.recordId, 'acct_checking');
  assert.equal(prompt.params?.currentBalance, 420.5);
  assert.equal(prompt.params?.availableBalance, null);
  assert.equal(prompt.params?.creditLimit, 5000);
  assert.equal(prompt.params?.isLiability, true);
  assert.match(prompt.prompt, /hidden credit liability connected by plaid/);
  assert.match(prompt.prompt, /current balance is \$420\.50/);
  assert.match(prompt.prompt, /last updated at 2026-06-30T12:00:00.000Z/);
});

test('holding advisor prompt captures account context and return quality', () => {
  const prompt = buildHoldingAdvisorPrompt(holding(), account({
    account_name: 'Brokerage',
    institution_name: 'InvestCo',
  }));

  assert.equal(prompt.source, 'investment');
  assert.equal(prompt.recordKind, 'holding');
  assert.equal(prompt.recordId, 'holding_1');
  assert.equal(prompt.params?.ticker, 'VTI');
  assert.equal(prompt.params?.value, 1250);
  assert.equal(prompt.params?.costBasis, 1000);
  assert.equal(prompt.params?.unrealizedGain, 250);
  assert.equal(prompt.params?.returnPct, 25);
  assert.match(prompt.prompt, /Vanguard Total Stock Market ETF holding \(VTI\)/);
  assert.match(prompt.prompt, /held in Brokerage at InvestCo/);
  assert.match(prompt.prompt, /unrealized gain or loss is \$250\.00/);
  assert.match(prompt.prompt, /return is 25\.0%/);
});
