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
  retireMerchantRule,
  suggestMerchantRules,
  unretireMerchantRule,
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
  checkRuleIsRetirableByAi,
  partitionByAuthorship,
} from './aiWriteGuards';
import { recordBudgetRolloverLedger } from './budgetProjection';
import {
  revertRevisions,
  revertableRevisionsForAction,
  writeTransactionCategory,
} from './categoryWrites';
import {
  recordDraftDismissalFeedback,
  recordUndoFeedback,
  type DraftDismissalFeedback,
} from './aiFeedback';
import { refreshTransactionIntegrity } from './transactionIntegrity';
import { upsertRecurringAdjustment } from './recurringAdjustments';
import { setManualCostBasis, setSecurityMetadata } from './investmentMetadata';
import { toCents, toDollars, toDollarsOrNull } from './money';
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
 * `isDraftStillActionable` deliberately does not ask it. Filtering the queue with a guard removes
 * the suggestion with no reason shown and no way to see it, while a refusal at confirm time is a
 * 409 whose sentence the owner reads, leaving the draft explainable and dismissable instead of
 * silently absent. That was the right split when these guards still refused healthy proposals in
 * bulk (the 'UBER *EATS' -> food delivery case, since fixed by narrowing
 * `checkRuleDoesNotContradictOwnerRule` to the rows a rule would actually claim), and it stays the
 * right split now that they refuse fewer: a guard the queue applies silently cannot be argued with.
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
  //
  // `ruleSource` is not optional here even though nothing is written yet: this runs before the
  // upsert, so `countMerchantRuleImpact` has no stored row to read the author off and would rank
  // the proposal as the owner's. Every owner rule outranks every AI rule, so counting it as the
  // owner's counts rows this write can never take, and `checkBlastRadius` puts that number in
  // front of the owner as "would relabel N transactions".
  const impact = payload.apply_existing
    ? countMerchantRuleImpact(db, payload.pattern, payload.category_id, {
        overwrite: true,
        ruleSource: 'ai',
      })
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

/**
 * Retire one AI-authored rule that currently files nothing.
 *
 * Both bounds are in `checkRuleIsRetirableByAi` and both refuse rather than narrow: this never
 * quietly retires "the closest thing" to what was asked for. `changed: 1` counts the rule, not
 * transactions, and that is not the same as `wroteNothing`: the rule row and its revision row are
 * real writes with a real undo, on a rule whose transaction radius is provably zero.
 */
function confirmRetireMerchantRule(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'retire_merchant_rule' }>,
  actionId: string
): DraftApplyResult {
  assertGuardPassed(checkRuleIsRetirableByAi(db, payload.rule_id));

  const retired = retireMerchantRule(db, payload.rule_id, {
    source: 'ai',
    actionId,
    now: new Date().toISOString(),
  });
  // The guard read the same row in the same transaction, so this cannot be false. Thrown rather
  // than reported as `changed: 0`, which would record an action whose Undo reverts nothing.
  if (!retired) {
    throw new DraftRefusedError('rule_not_found', `no live merchant rule carries the id "${payload.rule_id}".`);
  }

  return { changed: 1, result: { rule_id: payload.rule_id, retired: true } };
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

    // The second writer of budgets.amount, and it has to record what it just set for the same
    // reason the route does. Left to the next hourly sync, a month that turns over inside that
    // window freezes at the pre-change amount with no surface anywhere to correct it.
    recordBudgetRolloverLedger(db, { budgetId: existing.id });

    return { changed: result.changes, result: { budget_id: existing.id } };
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, payload.category_id, amountCents, payload.period, payload.rollover ? 1 : 0, now, now);

  recordBudgetRolloverLedger(db, { budgetId: id });

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

function confirmRecurringAdjustment(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'create_recurring_adjustment' }>
): {
  changed: number;
  result: unknown;
} {
  // `payload.adjusted_amount` is dollars, and it is passed on in dollars, because
  // `upsertRecurringAdjustment` is the thing that converts. That is the unit contract its other
  // caller, `routes/recurring.ts`, already holds: it hands `req.body` straight through.
  //
  // This used to call `toCentsOrNull` here as well, under a comment that stated the requirement
  // ("must be stored in cents") correctly and then met it twice. An owner-confirmed "reprice the
  // Comcast bill to $180" was stored as -1,800,000 cents, so the forecast reported an $18,000
  // bill and that carried into `forecast.net`, the ledger spine, the next-bill reading, and
  // `monthlyRecurringSurplus`, which sets every goal's projected completion date.
  //
  // The sibling handlers are the reason this one stood out and the reason the fix is to remove
  // the conversion rather than to change the service: `confirmBudget` and `confirmGoalTarget`
  // convert once and then write SQL themselves, and `confirmManualCostBasis` passes dollars to
  // `setManualCostBasis`, which converts. This was the only handler that both converted AND
  // called a converting service.
  const adjustment = upsertRecurringAdjustment(db, payload.recurring_id, {
    original_date: payload.original_date,
    action: payload.action,
    adjusted_date: payload.adjusted_date ?? null,
    adjusted_amount: payload.adjusted_amount ?? null,
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
 * What a liveness check concluded about an open draft.
 *
 * Three states, not two, because "we looked and the premise holds" and "we never looked" are
 * different facts and only one of them is a claim. Five kinds have a cheap premise to check; the
 * other six have none, and calling those live would assert a check that did not run. The queue
 * treats both the same on purpose (see `isDraftStillActionable`); anything that RECORDS the
 * conclusion must not.
 */
export type DraftLiveness = 'live' | 'lapsed' | 'not_judged';

/** A dismissal on record that is about the same proposal as the payload in hand. */
export interface DeclinedProposal {
  /** `advisor_drafts.id` of the draft the owner dismissed. */
  draftId: string | null;
  declinedAt: string;
}

/**
 * The identity of a proposal, as `ai_feedback` records it: kind plus the thing it is about.
 *
 * Null for the kinds a dismissal cannot be matched on. `ai_feedback` keeps the transaction, the
 * proposed category and the proposed pattern, which covers every kind that applies unattended, and
 * nothing more is invented here so a match is always something the row actually says.
 *
 * `retire_merchant_rule` is NOT here, because none of those three columns identifies a rule. See
 * `declinedRetirement`.
 */
interface ProposalIdentity {
  transactionId: string | null;
  categoryId: string | null;
  pattern: string | null;
}

function proposalIdentity(payload: AdvisorDraftPayload): ProposalIdentity | null {
  switch (payload.kind) {
    case 'categorize_transaction':
      return { transactionId: payload.transaction_id, categoryId: payload.category_id, pattern: null };
    case 'create_merchant_rule':
      // The pattern AND the category, because a rule is both. Declining "file Spotify under
      // Entertainment" is not declining "file Spotify under Subscriptions", and matching on the
      // pattern alone would silence the second proposal on the strength of a no to the first.
      return { transactionId: null, categoryId: payload.category_id, pattern: payload.pattern.trim() };
    default:
      return null;
  }
}

/**
 * A dismissal on record about the retirement of THIS rule, matched on the rule's id.
 *
 * IT USED TO MATCH ON THE PATTERN, which does not identify a rule. `idx_merchant_rules_pattern_live`
 * is partial (`WHERE retired_at IS NULL`), so any number of retired rules and one live rule may
 * carry the same pattern, and "the pattern is what the rule is" was a claim the schema contradicts.
 * A dismissal about a rule the owner has since retired therefore suppressed the retirement of a
 * DIFFERENT, later rule with the same text, permanently and invisibly.
 *
 * `ai_feedback` has no rule column, so the rule id is read back out of the payload of the draft the
 * dismissal names. That row survives: `supersedeRegeneratedDrafts` (aiJobs.ts) deletes only
 * `status = 'open'` drafts, and nothing else in the server deletes from `advisor_drafts`. When it is
 * gone anyway, this returns null and the proposal is merely re-offered, which is the safe direction
 * to fail in: the owner sees a suggestion again rather than never seeing one they never refused.
 */
function declinedRetirement(db: Database.Database, ruleId: string): DeclinedProposal | null {
  const row = db.prepare(`
    SELECT f.draft_id, f.created_at
    FROM ai_feedback f
    JOIN advisor_drafts d ON d.id = f.draft_id
    WHERE f.signal = 'draft_dismissed'
      AND f.proposal_kind = 'retire_merchant_rule'
      AND COALESCE(f.stale, 0) <> 1
      -- CASE, not a bare json_extract: a payload that is not JSON makes json_extract RAISE, and one
      -- unreadable draft row would take this guard and the worker's rule list down with it. The
      -- rest of this file treats an unparseable payload as a row nothing can be concluded from
      -- (see dismissedDraftEvidence and safeJsonParse), and so does this. CASE cannot be reordered
      -- around the validity test the way an AND term can.
      AND (CASE WHEN json_valid(d.payload) THEN json_extract(d.payload, '$.rule_id') END) = ?
    ORDER BY f.created_at DESC, f.rowid DESC
    LIMIT 1
  `).get(ruleId) as { draft_id: string | null; created_at: string } | undefined;

  if (!row) return null;
  return { draftId: row.draft_id, declinedAt: row.created_at };
}

/**
 * Whether the owner has already declined this exact proposal (migration 047).
 *
 * `ai_feedback` was built as the record of the owner disagreeing with the model, and for as long as
 * nothing read it the record was write-only: dismissing a draft flipped a status, wrote a row, and
 * taught nothing. The worker re-proposed the same suggestion on the next pass and, for an autonomous
 * kind, applied it unattended. Declining is now a fact the write paths read.
 *
 * WHAT COUNTS AS THE SAME PROPOSAL is the kind plus the thing it is about, never the draft id: a
 * fresh pass mints a new uuid for a draft it re-proposes, so matching by id would match nothing.
 * "The thing it is about" is spelled out per kind rather than left to a reader's guess, because
 * three of the four columns available are wider than the proposal they stand in for:
 *   categorize_transaction  the row AND the proposed category. Declining one category for a row is
 *     not declining the row, and the model may propose a different one.
 *   create_merchant_rule    the pattern AND the category, case- and whitespace-insensitive.
 *   retire_merchant_rule    the rule id, out of the dismissed draft's own payload. See
 *     `declinedRetirement`; the pattern is not the rule.
 * Every other kind matches nothing and is never blocked here.
 *
 * THE OWNER CAN TAKE IT BACK. A decline is durable, not permanent: `listDeclinedProposals` puts
 * every one of these rows on a screen and `restoreDeclinedProposal` removes one. Without that this
 * function would be a silent, unappealable veto, which is the standing-finding-you-cannot-act-on
 * failure with the sign flipped.
 *
 * WHY `stale = 1` IS EXCLUDED. A dismissal of a draft whose premise had already lapsed says the
 * model was late, not that it was wrong about the merchant, which is the distinction `stale` was
 * added to keep (see `recordDraftDismissalFeedback`). Reading it as a refusal would let one stale
 * suggestion silence a later correct one. NULL is included: the question was not answerable, but the
 * owner still declined, and their decision is not a claim this code has to verify.
 */
export function ownerDeclinedProposal(
  db: Database.Database,
  payload: AdvisorDraftPayload
): DeclinedProposal | null {
  if (payload.kind === 'retire_merchant_rule') return declinedRetirement(db, payload.rule_id);

  const identity = proposalIdentity(payload);
  if (identity === null) return null;

  const row = db.prepare(`
    SELECT draft_id, created_at
    FROM ai_feedback
    WHERE signal = 'draft_dismissed'
      AND proposal_kind = ?
      AND COALESCE(stale, 0) <> 1
      AND transaction_id IS ?
      AND proposed_category_id IS ?
      AND lower(trim(COALESCE(proposed_pattern, ''))) = lower(trim(?))
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(
    payload.kind,
    identity.transactionId,
    identity.categoryId,
    identity.pattern ?? ''
  ) as { draft_id: string | null; created_at: string } | undefined;

  if (!row) return null;
  return { draftId: row.draft_id, declinedAt: row.created_at };
}

/** One recorded decline, as the owner needs to read it back. */
export interface DeclinedProposalRecord {
  /** `ai_feedback.id`, which is what `restoreDeclinedProposal` takes. */
  id: string;
  kind: string;
  summary: string | null;
  merchant_name: string | null;
  pattern: string | null;
  /**
   * The category the model proposed and its name. The name is null when the category no longer
   * exists, which is a different fact from "this proposal named no category" and is why both are
   * carried: a screen that showed only the name could not tell them apart.
   */
  category_id: string | null;
  category_name: string | null;
  declined_at: string;
  /**
   * Whether the write paths still read this row as a refusal. `stale = 1` rows do not suppress
   * anything (see `ownerDeclinedProposal`) and are still listed, because they are still something
   * the owner did and a list that hid them would be a second invisible filter.
   */
  suppressing: boolean;
}

/**
 * Every proposal the owner has declined, newest first.
 *
 * WHY THIS EXISTS. `ownerDeclinedProposal` turned a dismissal into a standing block on a write
 * path, and for a while nothing anywhere showed one: the draft stopped being drawn, `total_open`
 * went down by one, and no field on any response named the reason. `listAiFeedback` had no
 * production caller, `aiDigest` joins `ai_feedback` on `action_id` and a dismissal has none, and no
 * client code referenced the table at all. A suggestion that silently stops appearing forever, with
 * nothing to look at and nothing to undo, is worse than the nag the block was added to end.
 *
 * Unbounded by default for the same reason `listAdvisorActions` is: the panel decides how many rows
 * to draw and says so, and a cap chosen here would be one nothing surfaces.
 */
export function listDeclinedProposals(
  db: Database.Database,
  limit: number | null = null
): DeclinedProposalRecord[] {
  const rows = db.prepare(`
    SELECT f.id,
           f.proposal_kind AS kind,
           f.proposal_summary AS summary,
           f.merchant_name,
           f.proposed_pattern AS pattern,
           f.proposed_category_id AS category_id,
           c.name AS category_name,
           f.created_at AS declined_at,
           COALESCE(f.stale, 0) AS stale
    FROM ai_feedback f
    LEFT JOIN categories c ON c.id = f.proposed_category_id
    WHERE f.signal = 'draft_dismissed'
    ORDER BY f.created_at DESC, f.rowid DESC
    LIMIT ?
  `).all(limit ?? -1) as Array<Omit<DeclinedProposalRecord, 'suppressing'> & { stale: number }>;

  return rows.map(({ stale, ...row }) => ({ ...row, suppressing: stale !== 1 }));
}

/** What taking a decline back actually managed, each part checked rather than assumed. */
export interface RestoreDeclinedProposalResult {
  ok: boolean;
  reason?: 'not_found';
  /** The dismissed draft row was put back to 'open'. False when the worker's row is long gone. */
  draft_reopened: boolean;
  /** The reopened draft passes `isDraftStillActionable`, so the review queue will draw it. */
  queued: boolean;
}

/**
 * Take back one decline.
 *
 * The `ai_feedback` row is deleted rather than flagged: it is the record of a refusal, and a
 * refusal the owner has withdrawn is not one. Nothing else joins to it (the digest reads
 * `action_id`, which a dismissal never carries), so there is no orphan to leave behind.
 *
 * The draft the dismissal named is put back to 'open' when it still exists, so the suggestion
 * returns now rather than whenever the next pass happens to regenerate it. Whether the queue will
 * actually draw it is then asked, not assumed: the premise may have lapsed for some other reason
 * while the decline stood, and reporting `queued: true` on a draft `isDraftStillActionable` refuses
 * would be exactly the kind of unchecked claim this file keeps being burned by.
 */
export function restoreDeclinedProposal(
  db: Database.Database,
  feedbackId: string
): RestoreDeclinedProposalResult {
  const restore = db.transaction((): RestoreDeclinedProposalResult => {
    const row = db.prepare(`
      SELECT id, draft_id FROM ai_feedback WHERE id = ? AND signal = 'draft_dismissed'
    `).get(feedbackId) as { id: string; draft_id: string | null } | undefined;

    if (!row) return { ok: false, reason: 'not_found', draft_reopened: false, queued: false };

    db.prepare('DELETE FROM ai_feedback WHERE id = ?').run(row.id);

    if (row.draft_id === null) return { ok: true, draft_reopened: false, queued: false };

    const reopened = db.prepare(`
      UPDATE advisor_drafts SET status = 'open', updated_at = ?
      WHERE id = ? AND status = 'dismissed'
    `).run(new Date().toISOString(), row.draft_id);

    if (reopened.changes === 0) return { ok: true, draft_reopened: false, queued: false };

    const draft = db.prepare('SELECT payload FROM advisor_drafts WHERE id = ?')
      .get(row.draft_id) as { payload: string } | undefined;
    const parsed = AdvisorDraftPayloadSchema.safeParse(
      safeJsonParse<unknown>(draft?.payload ?? 'null', null, `advisor_drafts.payload for ${row.draft_id}`)
    );

    return {
      ok: true,
      draft_reopened: true,
      queued: parsed.success && isDraftStillActionable(db, parsed.data),
    };
  });

  return restore();
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
 *
 * A PROPOSAL THE OWNER HAS ALREADY DECLINED HAS NO PREMISE LEFT, whatever else is still true of the
 * ledger, so that is asked first and for every kind. This is the one filter in the queue that is the
 * OWNER'S decision rather than a guard's opinion, which is why it hides the draft where
 * `checkMerchantRuleWritable` deliberately does not: re-offering a suggestion someone already said
 * no to every hour is the nag `ai_feedback` exists to end, and the same answer refused at confirm
 * time would just be the nag with an extra click.
 *
 * HIDDEN IS NOT VANISHED. A draft removed for that reason is removed by a decision the owner made,
 * and the decision itself is on a screen: `listDeclinedProposals` is what Settings draws and
 * `restoreDeclinedProposal` is the way back. A suppression with no surface and no undo would be
 * worse than the nag, not better.
 */
export function draftLiveness(
  db: Database.Database,
  payload: AdvisorDraftPayload
): DraftLiveness {
  if (ownerDeclinedProposal(db, payload) !== null) return 'lapsed';
  return premiseLiveness(db, payload);
}

/**
 * Whether the LEDGER still supports this proposal, ignoring what the owner has said about it.
 *
 * Split out from `draftLiveness` because `stale` on an `ai_feedback` row means one specific thing
 * (migration 047: "the premise had already lapsed before the owner acted"), and folding the owner's
 * own earlier decline into the same verdict made the code assert that from its own suppression: a
 * second, genuine refusal of a still-live suggestion was recorded as `stale = 1`, i.e. as the model
 * merely being late. Any reader filtering `stale = 1` as "late" would discount a repeated no.
 */
function premiseLiveness(
  db: Database.Database,
  payload: AdvisorDraftPayload
): DraftLiveness {
  const categoryExists = (id: string): boolean =>
    db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id) !== undefined;
  const verdict = (live: boolean): DraftLiveness => (live ? 'live' : 'lapsed');

  switch (payload.kind) {
    case 'categorize_transaction': {
      if (!categoryExists(payload.category_id)) return 'lapsed';
      const txn = db.prepare(
        'SELECT category_id, manually_categorized, category_source FROM transactions WHERE id = ?'
      ).get(payload.transaction_id) as
        | { category_id: string | null; manually_categorized: number; category_source: string | null }
        | undefined;
      if (!txn) return 'lapsed';
      // The premise used to be "this row is uncategorized", which made every recategorization
      // lapsed on sight. It is now the narrower thing that was always the actual point: nobody has
      // made a decision here the model is not allowed to revisit. Two decisions count.
      //
      // A HAND EDIT. The owner's, and never the model's to reopen. Same pair of markers
      // `partitionByAuthorship` reads, because neither is reliable alone.
      if (txn.manually_categorized === 1 || txn.category_source === 'human') return 'lapsed';
      // THE MODEL'S OWN ANSWER. Re-proposing a row the model already filed is changing its mind
      // about its own settled write, which is what `allowRecategorize: false` refuses on the rule
      // path after that path moved the Spotify rule twice in two hours. Nothing here should
      // oscillate hourly either.
      if (txn.category_source === 'ai') return 'lapsed';
      // Already where the draft wants it. Applying would write nothing and record an action whose
      // Undo reverts nothing.
      if (txn.category_id === payload.category_id) return 'lapsed';
      return 'live';
    }
    case 'retire_merchant_rule':
      // Only that a live rule still carries the id. Whether it is the model's own and whether it
      // holds rows are the write guards' questions, and asking them here would hide the draft
      // instead of refusing it with its reason, which is the split `create_merchant_rule` below
      // already documents.
      return verdict(
        db.prepare('SELECT 1 FROM merchant_rules WHERE id = ? AND retired_at IS NULL')
          .get(payload.rule_id) !== undefined
      );
    case 'create_merchant_rule':
      // Only the category, deliberately. Asking `checkMerchantRuleWritable` here as well hid every
      // draft the guards would refuse, and the guards refuse healthy proposals (see the note on
      // that function). A suggestion the owner cannot see is worse than one that refuses when
      // clicked: the refusal is a 409 carrying its own reason, which is readable and dismissable.
      return verdict(categoryExists(payload.category_id));
    case 'update_budget':
      return verdict(categoryExists(payload.category_id));
    case 'update_goal_target':
      return verdict(
        db.prepare('SELECT 1 FROM goals WHERE id = ? AND is_archived = 0').get(payload.goal_id) !== undefined
      );
    case 'confirm_recurring':
      return verdict(
        db.prepare('SELECT 1 FROM recurring_patterns WHERE id = ?').get(payload.recurring_id) !== undefined
      );
    default:
      // No cheap premise to check for the budget-group, recurring-adjustment and investment-metadata
      // kinds. Reported as unjudged rather than live, so a reader can tell the difference.
      return 'not_judged';
  }
}

/**
 * Whether the queue should still offer this draft.
 *
 * Unjudged counts as showable: a draft that cannot be validated is better shown than silently
 * swallowed. That is a decision about what to display, and it is deliberately NOT the same as
 * concluding the premise holds, which is why callers that store a conclusion use `draftLiveness`.
 */
export function isDraftStillActionable(
  db: Database.Database,
  payload: AdvisorDraftPayload
): boolean {
  return draftLiveness(db, payload) !== 'lapsed';
}

interface OpenDraftRow {
  id: string;
  kind: string;
  summary: string;
  payload: string;
}

/**
 * The category the model is proposing FOR SOMETHING, or null when the payload names no such thing.
 *
 * One other kind carries a `category_id` that is the subject of the change rather than a proposal
 * about it: `update_budget` names the category whose budget is being changed. Filing it into
 * `ai_feedback.proposed_category_id` would record the model as having proposed a categorization it
 * never proposed.
 */
function proposedCategoryOf(payload: AdvisorDraftPayload): string | null {
  switch (payload.kind) {
    case 'categorize_transaction':
    case 'create_merchant_rule':
      return payload.category_id;
    default:
      return null;
  }
}

/**
 * The merchant pattern the proposal is about, which is not always one the payload carries.
 *
 * `create_merchant_rule` states its own, and there it is half of the proposal's identity.
 * `retire_merchant_rule` names a rule id, and `ai_feedback` has no rule column, so the rule's
 * pattern is read out of `merchant_rules` and recorded here as the readable description of what was
 * declined: it is what the declined-proposals panel prints. It is NOT the identity, because a
 * pattern does not identify a rule (`declinedRetirement` says why); the id is taken from the
 * dismissed draft's own payload instead. Null when the rule row is already gone, because inventing
 * a pattern for it would be a claim about a rule nobody can look at.
 */
function proposedPatternOf(db: Database.Database, payload: AdvisorDraftPayload): string | null {
  switch (payload.kind) {
    case 'create_merchant_rule':
      return payload.pattern;
    case 'retire_merchant_rule': {
      const rule = db.prepare('SELECT pattern FROM merchant_rules WHERE id = ?')
        .get(payload.rule_id) as { pattern: string } | undefined;
      return rule?.pattern ?? null;
    }
    default:
      return null;
  }
}

/** 1 lapsed, 0 live, null when nothing judged it. Never defaults an unasked question to 0. */
function staleFlag(liveness: DraftLiveness | null): number | null {
  if (liveness === null || liveness === 'not_judged') return null;
  return liveness === 'lapsed' ? 1 : 0;
}

/**
 * The evidence a dismissed draft rested on, as `ai_feedback` needs to read it.
 *
 * `stale` is NULL for both a payload that no longer parses and a kind no liveness check covers. The
 * draft was still declined and that fact is worth keeping, but "its premise was still live" is a
 * claim nothing checked in either case, and writing 0 would assert it (migration 047's own header).
 */
function dismissedDraftEvidence(db: Database.Database, draft: OpenDraftRow): DraftDismissalFeedback {
  const parsed = AdvisorDraftPayloadSchema.safeParse(
    safeJsonParse<unknown>(draft.payload, null, `advisor_drafts.payload for ${draft.id}`)
  );
  const payload: AdvisorDraftPayload | null = parsed.success ? parsed.data : null;

  return {
    draftId: draft.id,
    kind: draft.kind,
    summary: draft.summary,
    proposedCategoryId: payload === null ? null : proposedCategoryOf(payload),
    proposedPattern: payload === null ? null : proposedPatternOf(db, payload),
    transactionId: payload?.kind === 'categorize_transaction' ? payload.transaction_id : null,
    // `premiseLiveness`, not `draftLiveness`: see its header. A dismissal recorded while an earlier
    // dismissal of the same proposal is on file is still a refusal of a live suggestion.
    stale: staleFlag(payload === null ? null : premiseLiveness(db, payload)),
  };
}

/**
 * Decline a proposal, and record that it was declined (migration 047).
 *
 * The status flip alone kept no trace: `aiWorker` deletes drafts on its next pass, so the payload
 * the owner rejected disappears with the row and the model is never shown that it happened.
 */
export function dismissAdvisorDraft(db: Database.Database, id: string): { changed: number } {
  const now = new Date().toISOString();

  const dismiss = db.transaction(() => {
    const draft = db.prepare(`
      SELECT id, kind, summary, payload FROM advisor_drafts WHERE id = ? AND status = 'open'
    `).get(id) as OpenDraftRow | undefined;

    const result = db.prepare(`
      UPDATE advisor_drafts
      SET status = 'dismissed',
          updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(now, id);

    if (result.changes > 0 && draft) {
      recordDraftDismissalFeedback(db, dismissedDraftEvidence(db, draft), now);
    }

    return { changed: result.changes };
  });

  return dismiss();
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
  /** Transaction categories put back. */
  reverted: number;
  /** Merchant rules un-retired. Counted separately: it is not a row of the owner's ledger. */
  reverted_rules?: number;
  /**
   * Merchant rules this action CREATED that the undo retired, so auto-categorization on the next
   * sync cannot re-file the rows the undo just restored. Counted separately from `reverted_rules`
   * because the two are opposite operations and collapsing them would hide which one happened.
   */
  retired_rules?: number;
  /**
   * Rules this action retired that could not be restored, with the reason. Reported rather than
   * absorbed: a revert that says only what it managed reads as a complete one.
   */
  rule_failures?: string[];
}

interface RuleUndoOutcome {
  restored: number;
  failures: string[];
}

/**
 * Put back every rule this action retired.
 *
 * The stack rule is the same one categories follow: a retirement is restorable only while it is the
 * NEWEST revision for its rule. If something wrote that rule afterwards, restoring would discard
 * the newer decision, so it is left alone and named. The one failure the owner can actually act on
 * is `pattern_taken`, where a replacement rule now holds the pattern; reviving the old one would be
 * a second, unasked change to whichever rule they have now.
 */
/**
 * Retire the rules an action created, so the undo actually holds.
 *
 * The docstring below used to argue that a created rule is left in place because deleting it
 * "would be a second, unasked change". Deleting it would be. Leaving it is not neutral either:
 * `revertRevisions` restores each row's prior category, which for a previously-uncategorized row
 * is NULL, and `autoCategorizeTransactions` runs on every sync
 * (`syncManager.ts`) calling `applyMerchantRulesToExistingTransactions(db, { onlyUncategorized:
 * true })`. The surviving rule matched those rows again within the hour. The owner's strongest
 * signal, reversing an applied answer wholesale, lasted until the next sync.
 *
 * Retiring is the reversible middle the app already has. `retire_merchant_rule` is an autonomous
 * kind, retirement writes a `merchant_rule_revisions` row, and `undoRuleRetirements` above puts one
 * back. So undoing a creation and undoing a retirement are now inverses of each other, both
 * recorded, both reversible from Settings.
 *
 * The action stays in the audit trail either way: undo means "put the ledger back", not "erase
 * that this happened".
 */
function undoRuleCreations(db: Database.Database, actionId: string, now: string): number {
  const created = db.prepare(`
    SELECT v.rule_id
    FROM merchant_rule_revisions v
    WHERE v.action_id = ?
      AND v.operation = 'create'
      AND v.id = (
        SELECT v2.id FROM merchant_rule_revisions v2
        WHERE v2.rule_id = v.rule_id
        ORDER BY v2.created_at DESC, v2.rowid DESC
        LIMIT 1
      )
    ORDER BY v.rowid
  `).all(actionId) as Array<{ rule_id: string }>;

  let retired = 0;
  for (const row of created) {
    // `retireMerchantRule` returns false when the rule is already retired or gone, which is the
    // outcome asked for either way.
    if (retireMerchantRule(db, row.rule_id, { source: 'ai', actionId: null, now })) retired += 1;
  }
  return retired;
}

function undoRuleRetirements(db: Database.Database, actionId: string, now: string): RuleUndoOutcome {
  const retirements = db.prepare(`
    SELECT v.rule_id, v.pattern
    FROM merchant_rule_revisions v
    WHERE v.action_id = ?
      AND v.operation = 'retire'
      AND v.id = (
        SELECT v2.id FROM merchant_rule_revisions v2
        WHERE v2.rule_id = v.rule_id
        ORDER BY v2.created_at DESC, v2.rowid DESC
        LIMIT 1
      )
    ORDER BY v.rowid
  `).all(actionId) as Array<{ rule_id: string; pattern: string }>;

  const outcome: RuleUndoOutcome = { restored: 0, failures: [] };
  for (const retirement of retirements) {
    const result = unretireMerchantRule(db, retirement.rule_id, { source: 'ai', actionId: null, now });
    if (result.ok) {
      outcome.restored += 1;
    } else if (result.reason === 'pattern_taken') {
      outcome.failures.push(
        `"${retirement.pattern}" was not restored: another live rule now holds that pattern.`
      );
    } else if (result.reason === 'not_found') {
      outcome.failures.push(`"${retirement.pattern}" was not restored: the rule row is gone.`);
    }
    // 'not_retired' means something already restored it, which is the outcome asked for.
  }
  return outcome;
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
 * A merchant rule the action created is RETIRED, not deleted and not left live. See
 * `undoRuleCreations`: leaving it live meant the next sync's auto-categorization re-filed every
 * row the undo had just restored to uncategorized, so the undo lasted about an hour. Retiring is
 * reversible, is recorded in `merchant_rule_revisions`, and is exactly the inverse of the creation
 * being undone. The action stays in the audit trail: undo means "put the ledger back", not "erase
 * that this happened".
 *
 * A successful undo also writes an `ai_feedback` row (migration 047). Until then the strongest
 * signal the owner can give -- reversing an applied answer wholesale -- left no record anywhere,
 * so the model's own history showed 140 applied actions and not one outcome.
 */
export function undoAdvisorAction(db: Database.Database, actionId: string): UndoAdvisorActionResult {
  const action = db.prepare('SELECT id FROM advisor_actions WHERE id = ?').get(actionId);
  if (!action) return { ok: false, reason: 'not_found', reverted: 0 };

  const undo = db.transaction((): UndoAdvisorActionResult => {
    const now = new Date().toISOString();
    // The revisions are read before they are consumed, because they carry what the model chose and
    // what it displaced. `revertRevisions` only returns a count.
    const revisions = revertableRevisionsForAction(db, actionId);
    const reverted = revertRevisions(db, revisions, now);
    // A retirement is the one autonomous write that changes no transaction row, so "nothing to
    // undo" has to be judged on both halves or `retire_merchant_rule` would be permanently
    // un-undoable while reporting itself as having nothing to undo.
    const rules = undoRuleRetirements(db, actionId, now);
    // Ordered after the revisions on purpose: retiring first would leave a window in which the
    // rows are reverted and the rule is gone, and both happen inside one transaction anyway.
    const retiredCreations = undoRuleCreations(db, actionId, now);

    if (reverted === 0 && rules.restored === 0 && retiredCreations === 0) {
      return {
        ok: false,
        reason: 'nothing_to_undo',
        reverted: 0,
        reverted_rules: 0,
        rule_failures: rules.failures,
      };
    }

    if (reverted > 0) recordUndoFeedback(db, { actionId, revisions, reverted });
    return {
      ok: true,
      reverted,
      reverted_rules: rules.restored,
      retired_rules: retiredCreations,
      rule_failures: rules.failures,
    };
  });

  return undo();
}

/**
 * The audit trail, newest first. `limit` null means every action on record, which is the default.
 *
 * IT USED TO DEFAULT TO 50, and `GET /api/ai/actions` took no limit, so the panel titled "Every
 * action the AI applied to your data, and the ones you can put back" showed the newest 50 and
 * nothing said the rest existed. Measured against a copy of .mizan/mizan.db at migration 054 on
 * 2026-07-31: `SELECT COUNT(*) FROM advisor_actions` is 142, so 92 of them (65%) were past the cap.
 * Undo is per action and reachable only from that list, so an action past it was an action the owner
 * could not put back at all.
 *
 * Unbounded here rather than paged over the wire because the boundary this list has to respect is
 * the owner's, not the transport's, and the transport is not under strain. Measured 2026-07-31
 * against the running dev server, which is the figure that matters because it is what crosses the
 * wire:
 *   curl -s -o /tmp/actions.json -w "http=%{http_code} bytes=%{size_download}" \
 *     http://127.0.0.1:3001/api/ai/actions            -> http=200 bytes=38554, 142 rows, 142 ids
 * The six columns themselves are 28,320 bytes of that; the rest is JSON framing, so quoting the
 * column figure as the payload understates it by 27 percent. On a copy of .mizan/mizan.db at
 * migration 054:
 *   SELECT SUM(LENGTH(id)+LENGTH(kind)+LENGTH(label)+LENGTH(COALESCE(summary,''))
 *              +LENGTH(source)+LENGTH(created_at)) FROM advisor_actions;   -> 28320
 * A page size chosen here would be another cap nothing surfaces. The panel decides how many to draw
 * at once and says how many there are, which is a statement about a screen and not about the record.
 *
 * `advisorChatTools` passes its own limit and is unaffected: a model reading the trail is answering
 * a question about recent activity, not offering an undo control for each row.
 */
export function listAdvisorActions(
  db: Database.Database,
  limit: number | null = null
): AdvisorActionLog[] {
  return db.prepare(`
    SELECT id, kind, label, summary, source, created_at
    FROM advisor_actions
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(limit ?? -1) as AdvisorActionLog[];
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

  // THE OWNER'S OWN NO IS A BOUND ON THE UNATTENDED PATH, and only on it. A pass that re-proposes
  // something the owner has already dismissed does not get to apply it while they are not looking.
  // The refusal is a `DraftRefusedError`, so `persistProposals` counts it as refused and still
  // writes the draft row: what the model suggested stays on record even though `draftLiveness`
  // keeps it out of the queue. The owner confirming the same thing by hand is them changing their
  // mind, which is theirs to do, so 'user_confirm' never reaches this. Without it, `ai_feedback`
  // recorded every dismissal and no write path read one: the next pass proposed it again, and for
  // an autonomous kind applied it.
  //
  // THOSE ROWS DO NOT PILE UP, and the thing stopping them is not here. `supersedeRegeneratedDrafts`
  // runs at the top of `persistProposals` and deletes every `status = 'open'` draft whose
  // `draftTargetKey` the fresh pass regenerates, and a refused draft is left open, so the next pass
  // re-proposing the same target replaces it rather than stacking beside it. The target key for a
  // categorization is the ROW, so a model working through candidate categories for one transaction
  // is bounded too. Measured on a `.backup` copy of `.mizan/mizan.db` taken 2026-08-01:
  // `SELECT COALESCE(SUM(refused_by_guards),0), COUNT(*) FROM ai_runs` returns 0 over 12 runs, and
  // `SELECT json_extract(payload,'$.transaction_id'), COUNT(*) FROM advisor_drafts
  //  WHERE kind='categorize_transaction' GROUP BY 1 HAVING COUNT(*)>1` returns exactly one target,
  // at 2 rows sharing one `created_at`, out of 278 drafts: one pass proposing a row twice, not two
  // passes stacking. tests/refusedDraftBound.test.ts holds the bound and, just as importantly,
  // holds that supersession leaves an unrelated open draft and an applied one alone.
  if (source === 'worker_auto') {
    const declined = ownerDeclinedProposal(db, parsedPayload.data);
    if (declined !== null) {
      throw new DraftRefusedError(
        'owner_declined',
        `you dismissed this same proposal on ${declined.declinedAt.slice(0, 10)}, so it was not applied again on its own.`
      );
    }
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
      case 'retire_merchant_rule':
        result = confirmRetireMerchantRule(db, draftAction.payload, actionId); break;
      case 'categorize_transaction':
        result = confirmCategorizeTransaction(db, draftAction.payload, actionId); break;
      case 'update_budget':
        result = confirmBudget(db, draftAction.payload); break;
      case 'update_goal_target':
        result = confirmGoalTarget(db, draftAction.payload); break;
      case 'confirm_recurring':
        result = confirmRecurring(db, draftAction.payload); break;
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
 * chat draft never touches the database, but that makes the payload a trust boundary, and handing
 * a bulk endpoint N arbitrary payloads multiplies the blast radius. Here every payload is read back
 * from `advisor_drafts`, so a batch can only ever apply work the worker actually proposed.
 *
 * Each draft is applied in its own transaction (inside `confirmAdvisorDraft`). One bad draft is
 * reported and stepped over rather than rolling back the drafts that already succeeded: a partial
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
