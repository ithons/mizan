import type { AdvisorRoutePrompt } from './advisorRouteState';
import type { Account, Budget, Holding, Transaction } from '@shared/types';
import { availableBudgetAmount, budgetProjectedRemaining, budgetProjectedSpend } from './budgetMath';

function formatMoneyValue(value: number): string {
  const amount = Math.abs(value).toFixed(2);
  return value < 0 ? `-$${amount}` : `$${amount}`;
}

function formatCurrencyValue(value: number, currency: string): string {
  return currency === 'USD' ? formatMoneyValue(value) : `${value.toFixed(2)} ${currency}`;
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
