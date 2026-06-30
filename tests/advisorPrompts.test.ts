import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccountAdvisorPrompt,
  buildBudgetAdvisorPrompt,
  buildTransactionAdvisorPrompt,
} from '../client/src/lib/advisorPrompts';
import type { Account, Budget, Transaction } from '../shared/types';

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
