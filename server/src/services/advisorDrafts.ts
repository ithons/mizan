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
  applyMerchantRuleToMatchingTransactions,
  countMerchantRuleImpact,
  suggestMerchantRules,
  upsertMerchantRule,
} from './rules';
import type { GuardRejectionReason, GuardResult } from './aiWriteGuards';
import {
  DraftRefusedError,
  assertGuardPassed,
  checkBlastRadius,
  checkPatternLength,
  checkRuleAgreesWithHistory,
  checkRuleDoesNotContradictOwnerRule,
  partitionByAuthorship,
} from './aiWriteGuards';
import { revertAction, writeTransactionCategory } from './categoryWrites';
import { refreshTransactionIntegrity } from './transactionIntegrity';
import { upsertRecurringAdjustment } from './recurringAdjustments';
import { setManualCostBasis, setSecurityMetadata } from './investmentMetadata';
import { toCents, toCentsOrNull, toDollars, toDollarsOrNull } from './money';
import { AdvisorDraftPayloadSchema } from '../../../shared/schemas';
import { safeJsonParse } from './jsonSafe';

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
  category_is_income: number;
  average_amount: number;
  frequency: string;
  next_expected: string;
  is_confirmed: number;
  transaction_count: number;
}

interface BudgetGroupRow {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
}

interface HoldingDraftRow {
  id: string;
  security_id: string;
  ticker: string | null;
  security_name: string | null;
  institution_value: number;
  provider_cost_basis: number | null;
  manual_cost_basis: number | null;
  effective_cost_basis: number | null;
  sector: string | null;
}

/**
 * Draft kinds the AI applies on its own, with no confirmation step.
 *
 * The boundary is drawn by DOMAIN, not by the model's confidence in itself. Categorization and
 * merchant rules are observations about data that already exists: the model is reading a
 * merchant name and saying what it is, and a wrong answer is visible on the row and reversible
 * by action id. Everything else changes a target the owner set (a budget, a goal, a cost basis,
 * whether a recurring charge is real), where the model has no way to know the intent behind the
 * number and being wrong is not obviously visible.
 *
 * This replaces a self-reported `confidence >= 0.9` gate. That number was written by the model,
 * about the model, in the same JSON blob as the change it was proposing, which makes it a
 * boundary the model asserts rather than one the owner set.
 */
export const AUTONOMOUS_DRAFT_KINDS: ReadonlySet<string> = new Set([
  'categorize_transaction',
  'create_merchant_rule',
]);

export function isAutonomousDraftKind(kind: string): boolean {
  return AUTONOMOUS_DRAFT_KINDS.has(kind);
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

function dateMentions(question: string): string[] {
  return Array.from(question.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)).map((match) => match[0]);
}

function quotedName(question: string): string | null {
  const match = question.match(/["']([^"']{1,80})["']/);
  return match?.[1].trim() || null;
}

function afterKeywordName(question: string, keyword: string): string | null {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = question.match(new RegExp(`\\b${escaped}\\b\\s+(?:called|named|to|as)?\\s*([a-zA-Z0-9 &/._-]{2,80})`, 'i'));
  return match?.[1].trim().replace(/[.?!]+$/, '') || null;
}

function categories(db: Database.Database): CategoryRow[] {
  return db.prepare(`
    SELECT id, name, parent_id
    FROM categories
    ORDER BY length(name) DESC
  `).all() as CategoryRow[];
}

function assertCategory(db: Database.Database, categoryId: string): CategoryRow {
  const row = db.prepare('SELECT id, name, parent_id FROM categories WHERE id = ?').get(categoryId) as
    | CategoryRow
    | undefined;
  if (!row) throw new Error('Category not found');
  return row;
}

function budgetGroups(db: Database.Database): BudgetGroupRow[] {
  return db.prepare(`
    SELECT id, name, color, sort_order
    FROM budget_groups
    ORDER BY length(name) DESC
  `).all() as BudgetGroupRow[];
}

function findBudgetGroupMention(db: Database.Database, question: string): BudgetGroupRow | null {
  const text = normalize(question);
  return budgetGroups(db).find((group) => text.includes(normalize(group.name))) ?? null;
}

function nextBudgetGroupSort(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM budget_groups').get() as
    | { next_sort: number }
    | undefined;
  return row?.next_sort ?? 0;
}

function holdingRows(db: Database.Database): HoldingDraftRow[] {
  // A stored basis of 0 is unreported (migration 043), so it must surface as NULL here too, or a
  // draft's citation reads "Effective $0.00" for a position whose basis nobody actually knows.
  return db.prepare(`
    SELECT
      h.id,
      h.security_id,
      h.institution_value,
      CASE WHEN h.cost_basis > 0 THEN h.cost_basis END AS provider_cost_basis,
      h.manual_cost_basis,
      COALESCE(h.manual_cost_basis, CASE WHEN h.cost_basis > 0 THEN h.cost_basis END) AS effective_cost_basis,
      s.ticker,
      s.name AS security_name,
      s.sector
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    ORDER BY h.institution_value DESC
  `).all() as HoldingDraftRow[];
}

function holdingName(holding: HoldingDraftRow): string {
  return holding.ticker ?? holding.security_name ?? holding.id;
}

function findHoldingMention(db: Database.Database, question: string): HoldingDraftRow | null {
  const text = normalize(question);
  const holdings = holdingRows(db);
  return holdings.find((holding) => {
    const ticker = holding.ticker ? normalize(holding.ticker) : '';
    const name = holding.security_name ? normalize(holding.security_name) : '';
    return Boolean((ticker && text.includes(ticker)) || (name && text.includes(name)));
  }) ?? (holdings.length === 1 ? holdings[0] : null);
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
      -- Matches transactionReview.ts getCounts(); see the note there on why 'open' is wrong.
      AND review_status <> 'dismissed'
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
        amount: toDollars(transaction.amount),
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

  // existing.amount is integer cents; `before` is display-only (changes + citation), so
  // dollarize it here. The payload keeps `amount` in dollars and is converted at the write.
  const before = existing?.amount != null ? toDollars(existing.amount) : null;
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
      { field: 'target amount', before: toDollars(goal.target_amount), after: amount },
    ],
    citations: [
      citation({
        id: `goal:${goal.id}`,
        kind: 'goal',
        label: goal.name,
        detail: `Current target $${toDollars(goal.target_amount).toFixed(2)}`,
        route: '/goals',
        record_id: goal.id,
        amount: toDollars(goal.target_amount),
      }),
    ],
  });
}

function recurringCandidates(db: Database.Database): RecurringRow[] {
  return db.prepare(`
    SELECT
      rp.id,
      rp.merchant_name,
      rp.category_id,
      COALESCE(c.is_income, 0) AS category_is_income,
      rp.average_amount,
      rp.frequency,
      rp.next_expected,
      rp.is_confirmed,
      rp.transaction_count
    FROM recurring_patterns rp
    LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.is_active = 1
      AND rp.is_confirmed = 0
      AND rp.transaction_count >= 3
    ORDER BY rp.transaction_count DESC, rp.next_expected ASC
    LIMIT 10
  `).all() as RecurringRow[];
}

function activeRecurringPatterns(db: Database.Database): RecurringRow[] {
  return db.prepare(`
    SELECT
      rp.id,
      rp.merchant_name,
      rp.category_id,
      COALESCE(c.is_income, 0) AS category_is_income,
      rp.average_amount,
      rp.frequency,
      rp.next_expected,
      rp.is_confirmed,
      rp.transaction_count
    FROM recurring_patterns rp
    LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.is_active = 1
    ORDER BY rp.next_expected ASC
    LIMIT 25
  `).all() as RecurringRow[];
}

function findRecurringMention(db: Database.Database, question: string): RecurringRow | null {
  const text = normalize(question);
  const rows = activeRecurringPatterns(db);
  return rows.find((row) => text.includes(normalize(row.merchant_name))) ?? (rows.length === 1 ? rows[0] : null);
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
        amount: toDollars(recurring.average_amount),
        date: recurring.next_expected,
      }),
    ],
  });
}

function draftCreateBudgetGroup(question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!/\b(create|add|new)\b/.test(text) || !text.includes('budget group')) return null;

  const name = quotedName(question)
    ?? afterKeywordName(question, 'called')
    ?? afterKeywordName(question, 'named')
    ?? afterKeywordName(question, 'group');
  const cleanName = name?.replace(/\bbudget group\b/i, '').trim();
  if (!cleanName || cleanName.length < 2) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'create_budget_group',
    name: cleanName,
    color: null,
  };

  return draft({
    kind: 'create_budget_group',
    label: `Create ${cleanName} group`,
    summary: `Create a personal budget rollup group named ${cleanName}. Category budgets remain the source of truth.`,
    route: '/budget',
    payload,
    changes: [
      { field: 'budget group', before: null, after: cleanName },
    ],
    citations: [
      citation({
        id: 'budget-groups:new',
        kind: 'budget',
        label: 'Budget groups',
        detail: 'New group draft',
        route: '/budget',
      }),
    ],
  });
}

function draftRenameBudgetGroup(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!text.includes('rename') || !text.includes('group')) return null;

  const group = findBudgetGroupMention(db, question);
  const nextName = afterKeywordName(question, 'to') ?? quotedName(question);
  if (!group || !nextName || normalize(nextName) === normalize(group.name)) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'rename_budget_group',
    group_id: group.id,
    name: nextName,
  };

  return draft({
    kind: 'rename_budget_group',
    label: `Rename ${group.name}`,
    summary: `Rename the ${group.name} budget group to ${nextName}.`,
    route: '/budget',
    payload,
    changes: [
      { field: 'name', before: group.name, after: nextName },
    ],
    citations: [
      citation({
        id: `budget-group:${group.id}`,
        kind: 'budget',
        label: group.name,
        detail: 'Budget group',
        route: '/budget',
        record_id: group.id,
      }),
    ],
  });
}

function draftAssignCategoryToBudgetGroup(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!/\b(assign|add|move|group)\b/.test(text) || !text.includes('group')) return null;

  const category = findCategoryMention(db, question);
  const group = findBudgetGroupMention(db, question);
  if (!category || !group) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'assign_category_to_budget_group',
    group_id: group.id,
    category_id: category.id,
  };

  return draft({
    kind: 'assign_category_to_budget_group',
    label: `Add ${category.name} to ${group.name}`,
    summary: `Assign ${category.name} to the ${group.name} budget group. It will be removed from any other group first.`,
    route: '/budget',
    payload,
    changes: [
      { field: 'category group', before: null, after: group.name },
    ],
    citations: [
      citation({
        id: `budget-group:${group.id}:${category.id}`,
        kind: 'budget',
        label: group.name,
        detail: `Assign ${category.name}`,
        route: '/budget',
        record_id: group.id,
      }),
    ],
  });
}

function draftRecurringAdjustment(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!/\b(skip|snooze|adjust)\b/.test(text) || !/\b(recurring|bill|subscription|occurrence)\b/.test(text)) {
    return null;
  }

  const recurring = findRecurringMention(db, question);
  if (!recurring) return null;

  const dates = dateMentions(question);
  const action = text.includes('skip') ? 'skip' : text.includes('snooze') ? 'snooze' : 'adjust';
  const originalDate = action === 'snooze' && dates.length === 1
    ? recurring.next_expected
    : dates[0] ?? recurring.next_expected;
  const amount = moneyAmount(question);
  const adjustedAmount = action === 'adjust' && amount != null
    ? recurring.category_is_income ? amount : -amount
    : null;
  const adjustedDate = action === 'snooze' ? dates[1] ?? dates[0] ?? null : null;
  if (action === 'snooze' && !adjustedDate) return null;
  if (action === 'adjust' && adjustedAmount == null) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'create_recurring_adjustment',
    recurring_id: recurring.id,
    original_date: originalDate,
    action,
    adjusted_date: adjustedDate,
    adjusted_amount: adjustedAmount,
    note: 'Created from Advisor draft',
  };
  const after = action === 'skip'
    ? 'skipped'
    : action === 'snooze'
      ? adjustedDate
      : adjustedAmount;

  return draft({
    kind: 'create_recurring_adjustment',
    label: `${action === 'adjust' ? 'Adjust' : action === 'snooze' ? 'Snooze' : 'Skip'} ${recurring.merchant_name}`,
    summary: `Create a one-time ${action} adjustment for ${recurring.merchant_name} on ${originalDate}.`,
    route: '/bills',
    payload,
    changes: [
      { field: 'occurrence', before: originalDate, after },
    ],
    citations: [
      citation({
        id: `recurring:${recurring.id}:${originalDate}`,
        kind: 'recurring',
        label: recurring.merchant_name,
        detail: `${recurring.frequency}, next expected ${recurring.next_expected}`,
        route: '/bills',
        record_id: recurring.id,
        amount: toDollars(recurring.average_amount),
        date: originalDate,
      }),
    ],
  });
}

function draftManualCostBasis(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!text.includes('cost basis')) return null;

  const holding = findHoldingMention(db, question);
  if (!holding) return null;

  const shouldClear = /\b(clear|remove|reset)\b/.test(text);
  const amount = shouldClear ? null : moneyAmount(question);
  if (!shouldClear && amount == null) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'set_manual_cost_basis',
    holding_id: holding.id,
    manual_cost_basis: amount,
    note: amount == null ? null : 'Set from Advisor draft',
  };

  return draft({
    kind: 'set_manual_cost_basis',
    label: `${amount == null ? 'Clear' : 'Set'} ${holdingName(holding)} cost basis`,
    summary: amount == null
      ? `Clear the manual cost basis override for ${holdingName(holding)}.`
      : `Set ${holdingName(holding)} manual cost basis to $${amount.toFixed(2)} while preserving provider basis.`,
    route: '/investments',
    payload,
    changes: [
      { field: 'manual cost basis', before: toDollarsOrNull(holding.manual_cost_basis), after: amount },
    ],
    citations: [
      citation({
        id: `holding:${holding.id}:cost-basis`,
        kind: 'investment',
        label: holdingName(holding),
        detail: holding.effective_cost_basis == null ? 'Missing effective cost basis' : `Effective $${toDollars(holding.effective_cost_basis).toFixed(2)}`,
        route: '/investments',
        record_id: holding.id,
        amount: toDollars(holding.institution_value),
      }),
    ],
  });
}

function draftSectorMetadata(db: Database.Database, question: string): AdvisorDraftAction | null {
  const text = normalize(question);
  if (!text.includes('sector')) return null;

  const holding = findHoldingMention(db, question);
  if (!holding) return null;

  const shouldClear = /\b(clear|remove|reset)\b/.test(text);
  const rawSector = shouldClear ? null : afterKeywordName(question, 'to') ?? quotedName(question);
  const sector = rawSector?.replace(/\bsector\b/i, '').trim() || null;
  if (!shouldClear && !sector) return null;

  const payload: AdvisorDraftPayload = {
    kind: 'set_sector_metadata',
    security_id: holding.security_id,
    sector,
    sector_source: sector ? 'manual' : null,
  };

  return draft({
    kind: 'set_sector_metadata',
    label: `${sector ? 'Set' : 'Clear'} ${holdingName(holding)} sector`,
    summary: sector
      ? `Set ${holdingName(holding)} sector metadata to ${sector}.`
      : `Clear sector metadata for ${holdingName(holding)}.`,
    route: '/investments',
    payload,
    changes: [
      { field: 'sector', before: holding.sector, after: sector },
    ],
    citations: [
      citation({
        id: `security:${holding.security_id}:sector`,
        kind: 'investment',
        label: holdingName(holding),
        detail: holding.sector ?? 'Sector not available',
        route: '/investments',
        record_id: holding.security_id,
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
    draftCreateBudgetGroup(question),
    draftRenameBudgetGroup(db, question),
    draftAssignCategoryToBudgetGroup(db, question),
    draftRecurringAdjustment(db, question),
    draftManualCostBasis(db, question),
    draftSectorMetadata(db, question),
    text.includes('rule') || text.includes('review') ? draftFromRuleSuggestion(db) : null,
  ].filter((item): item is AdvisorDraftAction => Boolean(item));

  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, 4);
}

/**
 * Every reason a `create_merchant_rule` confirm would refuse, decided without writing anything.
 *
 * Five guards, in code rather than in the prompt, because a bound the model is merely asked to
 * respect is not a bound. See aiWriteGuards.ts for why each exists.
 *
 * The single definition of "would this write be refused", and it belongs to the WRITE path only.
 * `isDraftStillActionable` deliberately does not ask it: these guards have false positives, and
 * filtering the queue with them removes a healthy suggestion with no reason shown and no way to see
 * it. `checkRuleDoesNotContradictOwnerRule` refuses 'UBER *EATS' -> food delivery, which 113 of the
 * owner's settled rows agree with, because `merchantMatchesRulePattern` sweeps the bare merchant
 * name "Uber" into both that pattern and the owner's own 'UBER   *TRIP HELP.UBER.COM, CA' rule. A
 * refusal at confirm time is a 409 whose text the owner reads, so the draft is explainable and
 * dismissable instead of silently absent.
 */
function checkMerchantRuleWritable(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'create_merchant_rule' }>
): GuardResult {
  const length = checkPatternLength(payload.pattern);
  if (!length.ok) return length;

  // Ahead of the history check, which only sees settled transactions and so cannot see an owner
  // rule for a merchant that has none yet.
  const ownerRule = checkRuleDoesNotContradictOwnerRule(db, payload.pattern, payload.category_id);
  if (!ownerRule.ok) return ownerRule;

  const history = checkRuleAgreesWithHistory(db, payload.pattern, payload.category_id);
  if (!history.ok) return history;

  // Rows swept in by the rule carry the action's id, so undoing the action reverts the whole
  // blast radius and not just the one transaction that motivated it. `onlyUncategorized: false`
  // is deliberate: with a fully-categorized ledger the old uncategorized-only sweep touched zero
  // rows, yet still reported changed=1 and wrote an advisor_actions row with an Undo button that
  // could only ever 409. An action either has a real blast radius and a real undo, or it is not
  // an action. `skipManual` keeps hand-made choices out of that radius.
  const impact = payload.apply_existing
    ? countMerchantRuleImpact(db, payload.pattern, payload.category_id, { overwrite: true })
    : 0;
  const blastRadius = checkBlastRadius(impact);
  if (!blastRadius.ok) return blastRadius;

  // What `upsertMerchantRule` refuses at write time: an AI write defaults to
  // allowRecategorize: false, so a live rule for this pattern pointing elsewhere never resolves
  // itself. Checked here too, or the draft is immortal for that reason instead of the others.
  const existing = db.prepare(
    'SELECT category_id FROM merchant_rules WHERE lower(pattern) = lower(?) AND retired_at IS NULL LIMIT 1'
  ).get(payload.pattern.trim()) as { category_id: string } | undefined;
  if (existing && existing.category_id !== payload.category_id) {
    return {
      ok: false,
      reason: 'rule_exists_with_different_category',
      detail: `a rule for "${payload.pattern}" already points at ${existing.category_id}.`,
    };
  }

  return { ok: true };
}

/**
 * What one draft handler did, as the audit trail needs to read it.
 *
 * `wroteNothing` is set only by a handler that can prove it touched nothing, and is never inferred
 * from `changed === 0`: `changed` counts what the owner would recognize as changed, and a handler
 * can genuinely write (a rule pattern rewrite, and the revision row recording it) while relabelling
 * no transactions at all.
 */
interface DraftApplyResult {
  changed: number;
  result: unknown;
  wroteNothing?: boolean;
}

function confirmMerchantRule(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'create_merchant_rule' }>,
  actionId: string
): DraftApplyResult {
  assertCategory(db, payload.category_id);
  const now = new Date().toISOString();

  // A refusal throws, so this function returns only when the write was allowed.
  assertGuardPassed(checkMerchantRuleWritable(db, payload));

  // Read before the upsert. Its 'unchanged' status covers two different worlds: a rule already
  // identical to the proposal (nothing is written) and a rule whose stored pattern gets rewritten
  // to the proposed casing (a rule row and a revision row are written). The status alone cannot
  // tell them apart, and only the first is a no-op.
  const storedPattern = (db.prepare(
    'SELECT pattern FROM merchant_rules WHERE lower(pattern) = lower(?) AND retired_at IS NULL LIMIT 1'
  ).get(payload.pattern.trim()) as { pattern: string } | undefined)?.pattern;

  const upsert = upsertMerchantRule(db, payload.pattern, payload.category_id, now, {
    source: 'ai',
    actionId,
    // allowRecategorize defaults to false for 'ai': see UpsertMerchantRuleOptions.
  });

  // The guard above already refuses this, reading the same table. Kept because the alternative to
  // throwing here is a `changed: 0` that gets recorded as an action with nothing behind it: the
  // write's own answer stays authoritative even if the pre-check ever stops agreeing with it.
  if (upsert.status === 'conflict') {
    throw new DraftRefusedError(
      'rule_exists_with_different_category',
      `a rule for "${payload.pattern}" already points at ${upsert.fromCategoryId}.`
    );
  }

  const applied = payload.apply_existing
    ? applyMerchantRuleToMatchingTransactions(db, payload.pattern, payload.category_id, now, {
        overwrite: true,
        provenance: { source: 'ai', actionId },
      }).updated
    : 0;

  // The worker re-proposes a rule the ledger already has on every pass. That upsert relabels
  // nothing and rewrites nothing, so it is not an action: see the audit-trail write in
  // confirmAdvisorDraft.
  const wroteNothing =
    upsert.status === 'unchanged' && storedPattern === payload.pattern.trim() && applied === 0;

  return {
    changed: applied + (upsert.status === 'created' ? 1 : 0),
    result: { rule_id: upsert.ruleId, applied, status: upsert.status },
    wroteNothing,
  };
}

function confirmCategorizeTransaction(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'categorize_transaction' }>,
  actionId: string
): {
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

  // A hand-made choice is never overwritten by the model. `applyMerchantRulesToExistingTransactions`
  // has always had a skipManual guard; this path had none, and the chat tool accepts up to 200
  // arbitrary transaction ids, so it was the one way an autonomous write could land on top of one
  // of the owner's own decisions. A batch of 200 still does not fail because one row in it was
  // yours: every caller applies one draft at a time and records the refusal against that draft.
  const authorship = partitionByAuthorship(db, [payload.transaction_id]);
  if (authorship.humanAuthored.length > 0) {
    throw new DraftRefusedError(
      'human_authored',
      'you categorized this transaction by hand, so the advisor left it alone.'
    );
  }

  const now = new Date().toISOString();
  const changed = writeTransactionCategory(
    db,
    {
      transactionId: payload.transaction_id,
      categoryId: payload.category_id,
      source: 'ai',
      actionId,
      reviewStatus: 'reviewed',
    },
    now
  );

  // Deliberately does NOT mint a merchant rule. It used to, on every categorization, built from
  // `merchant_name || original_name` (raw bank description text on SimpleFIN rows) and then
  // matched fuzzily across the ledger. That was survivable when categorization needed a human
  // click; now that it runs unattended, every AI decision would silently install a standing
  // fuzzy rule nobody asked for. A rule is created when a draft asks for one
  // (create_merchant_rule), or when the user categorizes by hand and teaches the app directly.
  refreshTransactionIntegrity(db);

  return {
    changed,
    result: { transaction_id: payload.transaction_id, category_id: category.id },
  };
}

function confirmBudget(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'update_budget' }>): {
  changed: number;
  result: unknown;
} {
  assertCategory(db, payload.category_id);
  const now = new Date().toISOString();
  // payload.amount is dollars; budgets.amount is integer cents.
  const amountCents = toCents(payload.amount);
  const existing = db.prepare('SELECT id FROM budgets WHERE category_id = ?').get(payload.category_id) as
    | { id: string }
    | undefined;

  if (existing) {
    const result = db.prepare(`
      UPDATE budgets
      SET amount = ?, period = ?, rollover = ?, updated_at = ?
      WHERE id = ?
    `).run(amountCents, payload.period, payload.rollover ? 1 : 0, now, existing.id);

    return { changed: result.changes, result: { budget_id: existing.id } };
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, payload.category_id, amountCents, payload.period, payload.rollover ? 1 : 0, now, now);

  return { changed: 1, result: { budget_id: id } };
}

function confirmGoalTarget(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'update_goal_target' }>): {
  changed: number;
  result: unknown;
} {
  const existing = db.prepare('SELECT id FROM goals WHERE id = ?').get(payload.goal_id);
  if (!existing) throw new Error('Goal not found');

  // payload.target_amount is dollars; goals.target_amount is integer cents.
  const result = db.prepare(`
    UPDATE goals
    SET target_amount = ?,
        updated_at = ?
    WHERE id = ?
  `).run(toCents(payload.target_amount), new Date().toISOString(), payload.goal_id);

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

function confirmCreateBudgetGroup(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'create_budget_group' }>): {
  changed: number;
  result: unknown;
} {
  const name = payload.name.trim();
  if (!name) throw new Error('Budget group name is required');

  const now = new Date().toISOString();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO budget_groups (id, name, color, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, payload.color ?? null, nextBudgetGroupSort(db), now, now);

  return { changed: 1, result: { group_id: id } };
}

function confirmRenameBudgetGroup(db: Database.Database, payload: Extract<AdvisorDraftPayload, { kind: 'rename_budget_group' }>): {
  changed: number;
  result: unknown;
} {
  const name = payload.name.trim();
  if (!name) throw new Error('Budget group name is required');

  const existing = db.prepare('SELECT id FROM budget_groups WHERE id = ?').get(payload.group_id);
  if (!existing) throw new Error('Budget group not found');

  const result = db.prepare(`
    UPDATE budget_groups
    SET name = ?,
        updated_at = ?
    WHERE id = ?
  `).run(name, new Date().toISOString(), payload.group_id);

  return { changed: result.changes, result: { group_id: payload.group_id } };
}

function confirmAssignCategoryToBudgetGroup(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'assign_category_to_budget_group' }>
): {
  changed: number;
  result: unknown;
} {
  assertCategory(db, payload.category_id);
  const group = db.prepare('SELECT id FROM budget_groups WHERE id = ?').get(payload.group_id);
  if (!group) throw new Error('Budget group not found');

  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT group_id
    FROM budget_group_members
    WHERE category_id = ?
  `).get(payload.category_id) as { group_id: string } | undefined;
  const sortRow = db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
    FROM budget_group_members
    WHERE group_id = ?
  `).get(payload.group_id) as { next_sort: number };

  db.prepare('DELETE FROM budget_group_members WHERE category_id = ?').run(payload.category_id);
  db.prepare(`
    INSERT INTO budget_group_members (group_id, category_id, sort_order, created_at)
    VALUES (?, ?, ?, ?)
  `).run(payload.group_id, payload.category_id, sortRow.next_sort, now);
  db.prepare('UPDATE budget_groups SET updated_at = ? WHERE id = ?').run(now, payload.group_id);

  return {
    changed: existing?.group_id === payload.group_id ? 0 : 1,
    result: { group_id: payload.group_id, category_id: payload.category_id },
  };
}

function confirmRecurringAdjustment(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'create_recurring_adjustment' }>
): {
  changed: number;
  result: unknown;
} {
  // payload.adjusted_amount is dollars. recurring_occurrence_adjustments.adjusted_amount
  // substitutes for recurring_patterns.average_amount (integer cents) in the forecast, so it
  // must be stored in cents to stay consistent with that arithmetic.
  const adjustment = upsertRecurringAdjustment(db, payload.recurring_id, {
    original_date: payload.original_date,
    action: payload.action,
    adjusted_date: payload.adjusted_date ?? null,
    adjusted_amount: toCentsOrNull(payload.adjusted_amount),
    note: payload.note ?? null,
  });

  return { changed: 1, result: { adjustment_id: adjustment.id } };
}

function confirmManualCostBasis(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'set_manual_cost_basis' }>
): {
  changed: number;
  result: unknown;
} {
  const holding = setManualCostBasis(db, payload.holding_id, {
    manual_cost_basis: payload.manual_cost_basis,
    manual_cost_basis_note: payload.note ?? null,
  });

  return { changed: 1, result: { holding_id: holding.id, cost_basis_quality: holding.cost_basis_quality } };
}

function confirmSectorMetadata(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'set_sector_metadata' }>
): {
  changed: number;
  result: unknown;
} {
  const security = setSecurityMetadata(db, payload.security_id, {
    sector: payload.sector,
    sector_source: payload.sector_source ?? null,
  });

  return { changed: 1, result: { security_id: security.id, sector: security.sector } };
}

/**
 * Whether an open draft's premise is still true.
 *
 * Drafts are generated from a snapshot of the ledger and then persisted, but nothing ever
 * re-examined them: `aiWorker` only deletes drafts a fresh pass regenerates, and it only drafts for
 * rows where `category_id IS NULL`, so a draft whose transaction has since been categorized can
 * never be superseded and never expires. On the live database that left 14 `categorize_transaction`
 * drafts pointing at transactions that already have a category (four of them proposing the category
 * the row is already in, three pointing at a category migration 036 deleted), pinning the review
 * count and the data-quality penalty at their caps forever with no work behind them. Worse,
 * confirming one silently re-categorized a settled transaction.
 *
 * Checked on read rather than fixed by a one-off cleanup, because a cleanup would decay the same
 * way: this is the invariant, not a repair.
 */
export function isDraftStillActionable(
  db: Database.Database,
  payload: AdvisorDraftPayload
): boolean {
  const categoryExists = (id: string): boolean =>
    db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id) !== undefined;

  switch (payload.kind) {
    case 'categorize_transaction': {
      if (!categoryExists(payload.category_id)) return false;
      const txn = db.prepare(
        'SELECT category_id, manually_categorized, category_source FROM transactions WHERE id = ?'
      ).get(payload.transaction_id) as
        | { category_id: string | null; manually_categorized: number; category_source: string | null }
        | undefined;
      if (!txn) return false;
      // The draft's premise is "this row is uncategorized". Once it isn't, the draft is a
      // proposal to overwrite a decision nobody asked it to revisit.
      if (txn.category_id !== null) return false;
      if (txn.manually_categorized === 1 || txn.category_source === 'human') return false;
      return true;
    }
    case 'create_merchant_rule':
      // Only the category, deliberately. Asking `checkMerchantRuleWritable` here as well hid every
      // draft the guards would refuse, and the guards refuse healthy proposals (see the note on
      // that function). A suggestion the owner cannot see is worse than one that refuses when
      // clicked: the refusal is a 409 carrying its own reason, which is readable and dismissable.
      return categoryExists(payload.category_id);
    case 'update_budget':
      return categoryExists(payload.category_id);
    case 'update_goal_target':
      return (
        db.prepare('SELECT 1 FROM goals WHERE id = ? AND is_archived = 0').get(payload.goal_id) !== undefined
      );
    case 'confirm_recurring':
      return (
        db.prepare('SELECT 1 FROM recurring_patterns WHERE id = ?').get(payload.recurring_id) !== undefined
      );
    default:
      // Kinds without a cheap liveness check stay visible; a draft that cannot be validated is
      // better shown than silently swallowed.
      return true;
  }
}

export function dismissAdvisorDraft(db: Database.Database, id: string): { changed: number } {
  const result = db.prepare(`
    UPDATE advisor_drafts
    SET status = 'dismissed',
        updated_at = ?
    WHERE id = ? AND status = 'open'
  `).run(new Date().toISOString(), id);

  return { changed: result.changes };
}

export interface AdvisorActionLog {
  id: string;
  kind: string;
  label: string;
  summary: string;
  source: 'worker_auto' | 'user_confirm';
  created_at: string;
}

export interface UndoAdvisorActionResult {
  ok: boolean;
  reason?: 'not_found' | 'nothing_to_undo';
  reverted: number;
}

/**
 * Reverse every categorization an AI action made.
 *
 * Reads `transaction_category_revisions` (migration 042), so each row is restored to the exact
 * category AND the exact source it had before this action, rather than blanket-clearing to
 * uncategorized (which would throw away a correction the AI made to a wrongly-categorized row).
 *
 * Restoring the source matters as much as the category: the previous implementation wrote
 * `category_source = 'rule'` for every row it touched, so undoing an action that had displaced a
 * hand-made choice handed that choice back relabelled as machine-authored, and the next
 * `skipManual` pass was then free to overwrite it.
 *
 * Undo behaves like a stack. Only revisions that are still the newest for their transaction can be
 * reverted; if a later action or a hand edit has written the row since, this action's revision is
 * buried and reverting it would silently discard the newer decision. Undo the later action first
 * and this one becomes revertable again. Under the old single-slot scheme the later write simply
 * destroyed the earlier action's record and there was no way back at all.
 *
 * A merchant rule the action created is left in place. Deleting it would be a second, unasked
 * change, and the rule is visible and removable in Settings; undo here means "put the ledger
 * back", not "erase that this happened". The action stays in the audit trail for the same
 * reason.
 */
export function undoAdvisorAction(db: Database.Database, actionId: string): UndoAdvisorActionResult {
  const action = db.prepare('SELECT id FROM advisor_actions WHERE id = ?').get(actionId);
  if (!action) return { ok: false, reason: 'not_found', reverted: 0 };

  const reverted = revertAction(db, actionId);
  if (reverted === 0) return { ok: false, reason: 'nothing_to_undo', reverted: 0 };
  return { ok: true, reverted };
}

export function listAdvisorActions(db: Database.Database, limit = 50): AdvisorActionLog[] {
  return db.prepare(`
    SELECT id, kind, label, summary, source, created_at
    FROM advisor_actions
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(limit) as AdvisorActionLog[];
}

/**
 * Apply one draft, atomically with the row that records it in the audit trail.
 *
 * A guard that refuses throws `DraftRefusedError` from inside the transaction, which rolls back and
 * propagates: the draft stays open, no `advisor_actions` row is written, and the caller is handed
 * the reason. It used to return `{ changed: 0 }` with the reason buried in an opaque `result` blob
 * while this function marked the draft confirmed and logged the action regardless, so a refusal
 * showed up in Settings as something that happened, with an Undo that reverted nothing.
 */
export function confirmAdvisorDraft(
  db: Database.Database,
  draftAction: AdvisorDraftAction,
  confirm: boolean,
  source: 'worker_auto' | 'user_confirm' = 'user_confirm'
): AdvisorConfirmResponse {
  if (!confirm) throw new Error('Explicit confirmation is required');
  if (draftAction.confirmation_required !== true) throw new Error('Invalid draft action');
  if (draftAction.kind !== draftAction.payload.kind) throw new Error('Draft kind does not match payload');

  // Trust boundary: the payload can be fully client-supplied (POST /api/ai/confirm),
  // so validate it strictly before any handler converts money to cents. Without this,
  // a string/non-finite target_amount reaches toCents() -> Math.round(NaN) -> a NaN
  // write into an integer-cents column. The background worker already validates on
  // ingestion, but this is the single boundary both paths must pass.
  const parsedPayload = AdvisorDraftPayloadSchema.safeParse(draftAction.payload);
  if (!parsedPayload.success) {
    const detail = parsedPayload.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid draft payload: ${detail}`);
  }

  // Generated before the handlers run, not after: the categorization paths stamp it onto every
  // row they touch (category_action_id), which is what makes "undo everything this action did"
  // a single query rather than a reconstruction.
  const actionId = uuidv4();

  const apply = db.transaction(() => {
    let result: DraftApplyResult;
    switch (draftAction.payload.kind) {
      case 'create_merchant_rule':
        result = confirmMerchantRule(db, draftAction.payload, actionId); break;
      case 'categorize_transaction':
        result = confirmCategorizeTransaction(db, draftAction.payload, actionId); break;
      case 'update_budget':
        result = confirmBudget(db, draftAction.payload); break;
      case 'update_goal_target':
        result = confirmGoalTarget(db, draftAction.payload); break;
      case 'confirm_recurring':
        result = confirmRecurring(db, draftAction.payload); break;
      case 'create_budget_group':
        result = confirmCreateBudgetGroup(db, draftAction.payload); break;
      case 'rename_budget_group':
        result = confirmRenameBudgetGroup(db, draftAction.payload); break;
      case 'assign_category_to_budget_group':
        result = confirmAssignCategoryToBudgetGroup(db, draftAction.payload); break;
      case 'create_recurring_adjustment':
        result = confirmRecurringAdjustment(db, draftAction.payload); break;
      case 'set_manual_cost_basis':
        result = confirmManualCostBasis(db, draftAction.payload); break;
      case 'set_sector_metadata':
        result = confirmSectorMetadata(db, draftAction.payload); break;
      default:
        throw new Error(`Unhandled draft kind: ${(draftAction.payload as { kind: string }).kind}`);
    }

    // Marks the persisted background-worker row (if this draft came from one) as confirmed,
    // so getTransactionReviewSummary() stops returning it. No-op for ephemeral chat-drafts
    // whose id isn't a real advisor_drafts row. A handler that wrote nothing still resolves its
    // draft: the state the draft proposes already holds, and leaving it open makes it immortal.
    db.prepare(`
      UPDATE advisor_drafts SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'open'
    `).run(new Date().toISOString(), draftAction.id);

    // Record the applied action in the visible audit trail, atomically with the mutation. A
    // refusal never reaches here; it threw, taking the status update above with it. A handler that
    // wrote nothing gets no action either: re-proposing a rule the ledger already has is a no-op
    // the worker performs every pass, and recording it produces exactly what the refusal path was
    // fixed to stop producing, an action with no blast radius and an Undo that reverts nothing.
    if (!result.wroteNothing) {
      db.prepare(`
        INSERT INTO advisor_actions (id, kind, label, summary, source, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        actionId,
        draftAction.kind,
        draftAction.label,
        draftAction.summary,
        source,
        JSON.stringify(draftAction.payload),
        new Date().toISOString()
      );
    }

    return result;
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

export interface BatchConfirmOutcome {
  id: string;
  status: 'applied' | 'skipped';
  /** Present on 'applied'. */
  changed?: number;
  /**
   * Present on 'skipped'. One of the tokens below when nothing was refused ('not_found_or_resolved',
   * 'unreadable_payload', 'apply_failed'), and the guard's own sentence when `refused` is set.
   * Never raw exception text: a Zod path or a SQLite constraint string is a fault for the log, not
   * something to render to the owner.
   */
  reason?: string;
  /** Set when a write guard refused, which is what tells a refusal apart from a fault. */
  refused?: GuardRejectionReason;
  label?: string;
}

export interface BatchConfirmResult {
  applied: number;
  skipped: number;
  outcomes: BatchConfirmOutcome[];
}

/**
 * Confirm several persisted background-worker drafts in one request.
 *
 * Takes draft IDS, not payloads. `confirmAdvisorDraft` accepts a client-supplied payload because a
 * chat draft never touches the database — but that makes the payload a trust boundary, and handing
 * a bulk endpoint N arbitrary payloads multiplies the blast radius. Here every payload is read back
 * from `advisor_drafts`, so a batch can only ever apply work the worker actually proposed.
 *
 * Each draft is applied in its own transaction (inside `confirmAdvisorDraft`). One bad draft is
 * reported and stepped over rather than rolling back the drafts that already succeeded — a partial
 * apply the caller can see beats an all-or-nothing failure with no explanation.
 */
export function confirmAdvisorDraftsByIds(
  db: Database.Database,
  ids: string[]
): BatchConfirmResult {
  const uniqueIds = Array.from(new Set(ids));
  const outcomes: BatchConfirmOutcome[] = [];

  for (const id of uniqueIds) {
    const row = db.prepare(
      `SELECT id, kind, label, summary, route, payload, changes, citations
       FROM advisor_drafts WHERE id = ? AND status = 'open'`
    ).get(id) as
      | {
          id: string;
          kind: string;
          label: string;
          summary: string;
          route: string | null;
          payload: string;
          changes: string | null;
          citations: string | null;
        }
      | undefined;

    if (!row) {
      outcomes.push({ id, status: 'skipped', reason: 'not_found_or_resolved' });
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      outcomes.push({ id, status: 'skipped', reason: 'unreadable_payload', label: row.label });
      continue;
    }

    const draftAction = {
      id: row.id,
      kind: row.kind,
      label: row.label,
      summary: row.summary,
      route: row.route ?? undefined,
      payload,
      changes: safeJsonParse<unknown[]>(row.changes ?? '[]', [], `advisor_draft ${row.id} changes`),
      citations: safeJsonParse<unknown[]>(row.citations ?? '[]', [], `advisor_draft ${row.id} citations`),
      confirmation_required: true,
    } as unknown as AdvisorDraftAction;

    try {
      const result = confirmAdvisorDraft(db, draftAction, true, 'user_confirm');
      outcomes.push({ id, status: 'applied', changed: result.changed, label: row.label });
    } catch (err) {
      // A refusal is a decision the guards made about this draft, not a failure of the batch: the
      // draft is still open for the owner to look at, and `detail` is a sentence written to be
      // shown. Anything else is a fault, and its message is exception text (a Zod issue path, a
      // SQLite constraint) that means nothing to the owner, so it goes to the log and the outcome
      // says only that applying failed.
      if (err instanceof DraftRefusedError) {
        outcomes.push({ id, status: 'skipped', reason: err.detail, refused: err.reason, label: row.label });
      } else {
        console.error(`[advisor] Confirming draft ${id} failed:`, err);
        outcomes.push({ id, status: 'skipped', reason: 'apply_failed', label: row.label });
      }
    }
  }

  return {
    applied: outcomes.filter((o) => o.status === 'applied').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    outcomes,
  };
}
