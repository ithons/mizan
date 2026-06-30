import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type {
  AdvisorCitation,
  AdvisorConfirmResponse,
  AdvisorDraftAction,
  AdvisorDraftPayload,
} from '../../../shared/types';
import {
  applyMerchantRulesToExistingTransactions,
  suggestMerchantRules,
  upsertMerchantRule,
} from './rules';
import { refreshTransactionIntegrity } from './transactionIntegrity';

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
}

interface TransactionRow {
  id: string;
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  category_id: string | null;
}

interface BudgetRow {
  id: string;
  category_id: string;
  amount: number;
  period: string;
  rollover: number;
  category_name: string;
}

interface GoalRow {
  id: string;
  name: string;
  target_amount: number;
}

interface RecurringRow {
  id: string;
  merchant_name: string;
  category_id: string | null;
  average_amount: number;
  frequency: string;
  next_expected: string;
  is_confirmed: number;
  transaction_count: number;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function draftId(payload: AdvisorDraftPayload): string {
  return `draft_${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 14)}`;
}

function citation(params: AdvisorCitation): AdvisorCitation {
  return params;
}

function moneyAmount(question: string): number | null {
  const match = question.match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!match) return null;

  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function categories(db: Database.Database): CategoryRow[] {
  return db.prepare(`
    SELECT id, name, parent_id
    FROM categories
    ORDER BY length(name) DESC
  `).all() as CategoryRow[];
}

function categoryName(db: Database.Database, categoryId: string): string {
  const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(categoryId) as
    | { name: string }
    | undefined;
  return row?.name ?? categoryId;
}

function assertCategory(db: Database.Database, categoryId: string): CategoryRow {
  const row = db.prepare('SELECT id, name, parent_id FROM categories WHERE id = ?').get(categoryId) as
    | CategoryRow
    | undefined;
  if (!row) throw new Error('Category not found');
  return row;
}

function findCategoryMention(db: Database.Database, question: string): CategoryRow | null {
  const text = normalize(question);
  return categories(db).find((category) => text.includes(normalize(category.name))) ?? null;
}

function draft(params: Omit<AdvisorDraftAction, 'id' | 'confirmation_required'>): AdvisorDraftAction {
  return {
    ...params,
    id: draftId(params.payload),
    confirmation_required: true,
  };
}

function draftFromRuleSuggestion(db: Database.Database): AdvisorDraftAction | null {
  const suggestion = suggestMerchantRules(db)[0];
  if (!suggestion) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'create_merchant_rule',
    pattern: suggestion.pattern,
    category_id: suggestion.category_id,
    apply_existing: true,
  };

  return draft({
    kind: 'create_merchant_rule',
    label: `Create rule for ${suggestion.pattern}`,
    summary: `Future ${suggestion.pattern} transactions will use ${suggestion.category_name}. Existing uncategorized matches will be updated.`,
    route: '/review?queue=rule_suggestions',
    payload,
    changes: [
      { field: 'rule', before: null, after: suggestion.pattern },
      { field: 'category', before: null, after: suggestion.category_name },
      { field: 'apply existing', before: null, after: true },
    ],
    citations: [
      citation({
        id: `review:rule:${suggestion.pattern}`,
        kind: 'review',
        label: suggestion.pattern,
        detail: `${suggestion.uncategorized_count} uncategorized matches`,
        route: '/review?queue=rule_suggestions',
        record_id: suggestion.category_id,
      }),
    ],
  });
}

function uncategorizedTransactions(db: Database.Database): TransactionRow[] {
  return db.prepare(`
    SELECT id, date, amount, merchant_name, original_name, category_id
    FROM transactions
    WHERE pending = 0
      AND category_id IS NULL
      AND review_status = 'open'
    ORDER BY date DESC, created_at DESC
    LIMIT 20
  `).all() as TransactionRow[];
}

function findTransactionMention(db: Database.Database, question: string): TransactionRow | null {
  const text = normalize(question);
  const rows = uncategorizedTransactions(db);

  return rows.find((row) => {
    const merchant = normalize(row.merchant_name || row.original_name);
    if (!merchant) return false;
    if (text.includes(merchant)) return true;
    return merchant.split(' ').some((token) => token.length >= 3 && text.includes(token));
  }) ?? (/\bcategorize\b/.test(text) ? rows[0] ?? null : null);
}

function draftCategorizeTransaction(db: Database.Database, question: string): AdvisorDraftAction | null {
  const category = findCategoryMention(db, question);
  const transaction = category ? findTransactionMention(db, question) : null;
  if (!category || !transaction) return null;

  const merchant = transaction.merchant_name || transaction.original_name;
  const payload: AdvisorDraftPayload = {
    kind: 'categorize_transaction',
    transaction_id: transaction.id,
    category_id: category.id,
  };

  return draft({
    kind: 'categorize_transaction',
    label: `Categorize ${merchant}`,
    summary: `Set this transaction to ${category.name} and mark it reviewed.`,
    route: `/transactions?search=${encodeURIComponent(merchant)}`,
    payload,
    changes: [
      { field: 'category', before: null, after: category.name },
      { field: 'review status', before: 'open', after: 'reviewed' },
    ],
    citations: [
      citation({
        id: `transaction:${transaction.id}`,
        kind: 'transaction',
        label: merchant,
        detail: transaction.date,
        route: `/transactions?search=${encodeURIComponent(merchant)}`,
        record_id: transaction.id,
        amount: transaction.amount,
        date: transaction.date,
      }),
    ],
  });
}

function draftUpdateBudget(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!text.includes('budget')) return null;

  const category = findCategoryMention(db, question);
  const amount = moneyAmount(question);
  if (!category || amount === null) return null;

  const existing = db.prepare(`
    SELECT b.*, c.name AS category_name
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    WHERE b.category_id = ?
    LIMIT 1
  `).get(category.id) as BudgetRow | undefined;

  const before = existing?.amount ?? null;
  const payload: AdvisorDraftPayload = {
    kind: 'update_budget',
    category_id: category.id,
    amount,
    period: 'monthly',
    rollover: Boolean(existing?.rollover ?? 0),
  };

  return draft({
    kind: 'update_budget',
    label: `Set ${category.name} budget`,
    summary: `Set the monthly ${category.name} budget to $${amount.toFixed(2)}.`,
    route: '/budget',
    payload,
    changes: [
      { field: 'amount', before, after: amount },
      { field: 'period', before: existing?.period ?? null, after: 'monthly' },
    ],
    citations: [
      citation({
        id: `budget:${category.id}`,
        kind: 'budget',
        label: category.name,
        detail: before === null ? 'No existing budget' : `Current $${before.toFixed(2)}`,
        route: '/budget',
        record_id: existing?.id ?? category.id,
        amount: before,
      }),
    ],
  });
}

function activeGoals(db: Database.Database): GoalRow[] {
  return db.prepare(`
    SELECT id, name, target_amount
    FROM goals
    WHERE is_archived = 0
    ORDER BY target_date IS NULL ASC, target_date ASC, created_at ASC
  `).all() as GoalRow[];
}

function draftUpdateGoal(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!/\b(goal|target)\b/.test(text)) return null;

  const amount = moneyAmount(question);
  if (amount === null) return null;

  const goals = activeGoals(db);
  const goal = goals.find((candidate) => text.includes(normalize(candidate.name))) ?? (goals.length === 1 ? goals[0] : null);
  if (!goal) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'update_goal_target',
    goal_id: goal.id,
    target_amount: amount,
  };

  return draft({
    kind: 'update_goal_target',
    label: `Update ${goal.name} target`,
    summary: `Set the ${goal.name} target to $${amount.toFixed(2)}.`,
    route: '/goals',
    payload,
    changes: [
      { field: 'target amount', before: goal.target_amount, after: amount },
    ],
    citations: [
      citation({
        id: `goal:${goal.id}`,
        kind: 'goal',
        label: goal.name,
        detail: `Current target $${goal.target_amount.toFixed(2)}`,
        route: '/goals',
        record_id: goal.id,
        amount: goal.target_amount,
      }),
    ],
  });
}

function recurringCandidates(db: Database.Database): RecurringRow[] {
  return db.prepare(`
    SELECT id, merchant_name, category_id, average_amount, frequency, next_expected, is_confirmed, transaction_count
    FROM recurring_patterns
    WHERE is_active = 1
      AND is_confirmed = 0
      AND transaction_count >= 3
    ORDER BY transaction_count DESC, next_expected ASC
    LIMIT 10
  `).all() as RecurringRow[];
}

function draftConfirmRecurring(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!text.includes('confirm') || !/\b(recurring|bill|subscription)\b/.test(text)) return null;

  const candidates = recurringCandidates(db);
  const recurring = candidates.find((candidate) => text.includes(normalize(candidate.merchant_name))) ?? candidates[0] ?? null;
  if (!recurring) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'confirm_recurring',
    recurring_id: recurring.id,
  };

  return draft({
    kind: 'confirm_recurring',
    label: `Confirm ${recurring.merchant_name}`,
    summary: `Mark ${recurring.merchant_name} as a confirmed recurring ${recurring.frequency} pattern.`,
    route: '/bills',
    payload,
    changes: [
      { field: 'confirmed', before: false, after: true },
    ],
    citations: [
      citation({
        id: `recurring:${recurring.id}`,
        kind: 'recurring',
        label: recurring.merchant_name,
        detail: `${recurring.frequency}, ${recurring.transaction_count} transactions`,
        route: '/bills',
        record_id: recurring.id,
        amount: recurring.average_amount,
        date: recurring.next_expected,
      }),
    ],
  });
}

export function buildAdvisorDrafts(
  db: Database.Database,
  question: string
): AdvisorDraftAction[] {
  const text = normalize(question);
  const candidates = [
    draftCategorizeTransaction(db, question),
    draftUpdateBudget(db, question),
    draftUpdateGoal(db, question),
    draftConfirmRecurring(db, question),
    text.includes('rule') || text.includes('review') ? draftFromRuleSuggestion(db) : null,
  ].filter((item): item is AdvisorDraftAction => Boolean(item));

  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, 4);
}

function confirmMerchantRule(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'create_merchant_rule' }>): {
  changed: number;
  result: unknown;
} {
  assertCategory(db, payload.category_id);
  const now = new Date().toISOString();
  const ruleId = upsertMerchantRule(db, payload.pattern, payload.category_id, now);
  const applied = payload.apply_existing
    ? applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true }).updated
    : 0;

  return {
    changed: applied + (ruleId ? 1 : 0),
    result: { rule_id: ruleId, applied },
  };
}

function confirmCategorizeTransaction(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'categorize_transaction' }>): {
  changed: number;
  result: unknown;
} {
  const category = assertCategory(db, payload.category_id);
  const transaction = db.prepare(`
    SELECT id, merchant_name, original_name
    FROM transactions
    WHERE id = ?
  `).get(payload.transaction_id) as { id: string; merchant_name: string | null; original_name: string } | undefined;
  if (!transaction) throw new Error('Transaction not found');

  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE transactions
    SET category_id = ?,
        review_status = 'reviewed',
        updated_at = ?
    WHERE id = ?
  `).run(payload.category_id, now, payload.transaction_id);

  upsertMerchantRule(db, transaction.merchant_name || transaction.original_name, category.id, now);
  refreshTransactionIntegrity(db);

  return {
    changed: result.changes,
    result: { transaction_id: payload.transaction_id, category_id: category.id },
  };
}

function confirmBudget(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'update_budget' }>): {
  changed: number;
  result: unknown;
} {
  assertCategory(db, payload.category_id);
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM budgets WHERE category_id = ?').get(payload.category_id) as
    | { id: string }
    | undefined;

  if (existing) {
    const result = db.prepare(`
      UPDATE budgets
      SET amount = ?, period = ?, rollover = ?, updated_at = ?
      WHERE id = ?
    `).run(payload.amount, payload.period, payload.rollover ? 1 : 0, now, existing.id);

    return { changed: result.changes, result: { budget_id: existing.id } };
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, payload.category_id, payload.amount, payload.period, payload.rollover ? 1 : 0, now, now);

  return { changed: 1, result: { budget_id: id } };
}

function confirmGoalTarget(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'update_goal_target' }>): {
  changed: number;
  result: unknown;
} {
  const existing = db.prepare('SELECT id FROM goals WHERE id = ?').get(payload.goal_id);
  if (!existing) throw new Error('Goal not found');

  const result = db.prepare(`
    UPDATE goals
    SET target_amount = ?,
        updated_at = ?
    WHERE id = ?
  `).run(payload.target_amount, new Date().toISOString(), payload.goal_id);

  return { changed: result.changes, result: { goal_id: payload.goal_id } };
}

function confirmRecurring(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'confirm_recurring' }>): {
  changed: number;
  result: unknown;
} {
  const existing = db.prepare('SELECT id FROM recurring_patterns WHERE id = ?').get(payload.recurring_id);
  if (!existing) throw new Error('Recurring pattern not found');

  const result = db.prepare(`
    UPDATE recurring_patterns
    SET is_confirmed = 1,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), payload.recurring_id);

  return { changed: result.changes, result: { recurring_id: payload.recurring_id } };
}

export function confirmAdvisorDraft(
  db: Database.Database,
  draftAction: AdvisorDraftAction,
  confirm: boolean
): AdvisorConfirmResponse {
  if (!confirm) throw new Error('Explicit confirmation is required');
  if (draftAction.confirmation_required !== true) throw new Error('Invalid draft action');
  if (draftAction.kind !== draftAction.payload.kind) throw new Error('Draft kind does not match payload');

  const apply = db.transaction(() => {
    switch (draftAction.payload.kind) {
      case 'create_merchant_rule':
        return confirmMerchantRule(db, draftAction.payload);
      case 'categorize_transaction':
        return confirmCategorizeTransaction(db, draftAction.payload);
      case 'update_budget':
        return confirmBudget(db, draftAction.payload);
      case 'update_goal_target':
        return confirmGoalTarget(db, draftAction.payload);
      case 'confirm_recurring':
        return confirmRecurring(db, draftAction.payload);
    }
  });
  const result = apply();

  return {
    success: true,
    message: 'Draft action applied.',
    changed: result.changed,
    draft: draftAction,
    result: result.result,
  };
}
