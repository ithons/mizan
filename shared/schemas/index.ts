import { z } from 'zod';

export const CreateManualAccountSchema = z.object({
  account_name: z.string().min(1),
  type: z.enum(['checking', 'savings', 'credit', 'brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet', 'cash', 'other', 'closed']),
  institution_name: z.string().optional().default(''),
  current_balance: z.number().default(0),
  currency: z.string().default('USD'),
  is_liability: z.boolean().optional(),
  color: z.string().optional(),
});

/** A real calendar day in YYYY-MM-DD, so 2026-13-45 is refused rather than stored. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Not a calendar date');

export const UpdateAccountSchema = z.object({
  account_name: z.string().min(1).optional(),
  institution_name: z.string().nullable().optional(),
  type: z.enum(['checking', 'savings', 'credit', 'brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet', 'cash', 'other', 'closed']).optional(),
  currency: z.string().min(1).optional(),
  is_liability: z.boolean().optional(),
  color: z.string().nullable().optional(),
  is_hidden: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  current_balance: z.number().optional(),
  /** A card's last statement, in dollars owed. null clears it. */
  statement_balance: z.number().nonnegative().nullable().optional(),
  statement_due_date: calendarDate.nullable().optional(),
  balance_only: z.boolean().optional(),
  credit_limit: z.number().positive().nullable().optional(),
});

export const CreateManualTransactionSchema = z.object({
  account_id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number(),
  merchant_name: z.string().optional(),
  original_name: z.string().min(1),
  category_id: z.string().optional(),
  notes: z.string().optional(),
});

export const UpdateTransactionSchema = z.object({
  category_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount: z.number().optional(),
  merchant_name: z.string().nullable().optional(),
});

export const BulkCategorySchema = z.object({
  ids: z.array(z.string()).min(1),
  categoryId: z.string().min(1),
});

/** null: the owner says this credit reverses no purchase. */
export const RefundLinkSchema = z.object({
  purchase_id: z.string().min(1).nullable(),
});

export const TransactionReviewStatusSchema = z.object({
  status: z.enum(['open', 'reviewed', 'dismissed']),
});

export const CreateCategorySchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  is_income: z.boolean().default(false),
  is_investment: z.boolean().default(false),
  sort_order: z.number().int().default(0),
});

export const UpdateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
});

export const MergeAccountSchema = z.object({
  targetAccountId: z.string().min(1),
  sourceAccountId: z.string().min(1),
});
export const MergeCategorySchema = z.object({
  targetId: z.string().min(1),
});

export const UpsertBudgetSchema = z.object({
  amount: z.number().positive(),
  period: z.literal('monthly').default('monthly'),
  rollover: z.boolean().default(false),
});

export const UpdateRecurringSchema = z.object({
  category_id: z.string().nullable().optional(),
});

export const CreateRecurringSchema = z.object({
  merchant_name: z.string().min(1),
  frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual']),
  average_amount: z.number().positive(),
  next_expected: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category_id: z.string().nullable().optional(),
});

export const UpsertRecurringAdjustmentSchema = z.object({
  original_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.enum(['skip', 'snooze', 'adjust']),
  adjusted_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  adjusted_amount: z.number().nullable().optional(),
  note: z.string().max(240).nullable().optional(),
});

export const CreateGoalSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['savings', 'debt']),
  target_amount: z.number().positive(),
  current_amount: z.number().nonnegative().default(0),
  starting_amount: z.number().nonnegative().nullable().optional(),
  account_id: z.string().nullable().optional(),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  color: z.string().nullable().optional(),
});

export const UpdateGoalSchema = CreateGoalSchema.partial().extend({
  is_archived: z.boolean().optional(),
});

export const CreateMerchantRuleSchema = z.object({
  pattern: z.string().min(1),
  category_id: z.string().min(1),
  apply_existing: z.boolean().default(true),
  // When true, re-label ALL past transactions matching this rule (except ones categorized
  // by hand), not just uncategorized ones.
  apply_existing_overwrite: z.boolean().default(false),
});

export const UpdateMerchantRuleSchema = z.object({
  pattern: z.string().min(1).optional(),
  category_id: z.string().min(1).optional(),
});

export const ApplyMerchantRulesSchema = z.object({
  only_uncategorized: z.boolean().default(true),
});

export const SimplefinCredentialsSchema = z.object({
  setupToken: z.string().min(1),
});
/**
 * Confirming a re-link pairing. `min(1)` is load-bearing: an empty `pairs` array would resolve the
 * proposal having adopted nothing, which is a dismissal without the stated reason a dismissal
 * requires. Confirming nothing has to go through the dismiss route and say why.
 */
export const SimplefinRelinkAdoptSchema = z.object({
  pairs: z
    .array(
      z.object({
        stored_account_id: z.string().min(1),
        provider_account_id: z.string().min(1),
      })
    )
    .min(1),
});

/**
 * Dismissing a re-link proposal. The reason is required rather than optional: dismissal records the
 * owner's claim that these really are new accounts, and it is the only record of why the ledger's
 * existing accounts were left to be zeroed by the next sync.
 */
export const SimplefinRelinkDismissSchema = z.object({
  reason: z.string().trim().min(1).max(240),
});

export const CoinbaseCredentialsSchema = z.object({
  keyName: z.string().regex(/^organizations\/.+\/apiKeys\/.+$/, 'Key name must match organizations/xxx/apiKeys/yyy'),
  privateKey: z.string().min(1),
});

export const UpdateHoldingCostBasisSchema = z.object({
  manual_cost_basis: z.number().nonnegative().nullable(),
  manual_cost_basis_note: z.string().max(240).nullable().optional(),
});

export const UpdateSecurityMetadataSchema = z.object({
  sector: z.string().trim().min(1).max(80).nullable().optional(),
  sector_source: z.string().trim().min(1).max(40).nullable().optional(),
  /** The instrument class. NULL means the provider did not say and the owner has not either. */
  type: z.enum(['equity', 'etf', 'mutual_fund', 'crypto', 'cash', 'other']).nullable().optional(),
});

export const ExportCsvSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  accountIds: z.array(z.string()).optional(),
  format: z.enum(['mizan', 'monarch']).optional(),
});

export const DeleteDataSchema = z.object({
  confirm: z.literal('delete'),
});

export const BackupRestorePreviewSchema = z.object({
  backup: z.unknown(),
});

export const BackupRestoreSchema = BackupRestorePreviewSchema.extend({
  confirm: z.literal('restore'),
});

export const SetPreferenceSchema = z.object({
  value: z.unknown(),
});

export const CsvImportMappingSchema = z.object({
  date: z.string(),
  amount: z.string(),
  merchant: z.string().optional(),
  account: z.string().optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
  dateFormat: z.string().optional(),
  amountNegate: z.boolean().default(false),
});

// ─── Advisor drafts (trust boundary for LLM-authored actions) ────────────────
// The background AI worker parses raw JSON straight out of the model. These
// schemas are the boundary: every draft is validated against them before it is
// stored or auto-applied, so a malformed or hallucinated payload is rejected
// rather than best-effort written to the DB. Money fields (amount/target_amount/
// manual_cost_basis) are DOLLARS here; confirm handlers convert to integer cents.
const id = z.string().min(1);
const money = z.number().finite();

export const AdvisorDraftPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_merchant_rule'), pattern: z.string().min(1), category_id: id, apply_existing: z.boolean() }),
  z.object({ kind: z.literal('retire_merchant_rule'), rule_id: id }),
  z.object({ kind: z.literal('categorize_transaction'), transaction_id: id, category_id: id }),
  z.object({ kind: z.literal('update_budget'), category_id: id, amount: money, period: z.literal('monthly'), rollover: z.boolean() }),
  z.object({ kind: z.literal('update_goal_target'), goal_id: id, target_amount: money }),
  z.object({ kind: z.literal('confirm_recurring'), recurring_id: id }),
  z.object({
    kind: z.literal('create_recurring_adjustment'),
    recurring_id: id,
    original_date: z.string().min(1),
    action: z.enum(['skip', 'snooze', 'adjust']),
    adjusted_date: z.string().nullable().optional(),
    adjusted_amount: money.nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal('set_manual_cost_basis'), holding_id: id, manual_cost_basis: money.nullable(), note: z.string().nullable().optional() }),
  z.object({ kind: z.literal('set_sector_metadata'), security_id: id, sector: z.string().nullable(), sector_source: z.string().nullable().optional() }),
  z.object({ kind: z.literal('delete_budget'), category_id: id }),
  z.object({
    kind: z.literal('create_goal'),
    name: z.string().trim().min(1).max(80),
    type: z.enum(['savings', 'debt']),
    target_amount: z.number().positive(),
    target_date: calendarDate.nullable().optional(),
    account_id: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal('dismiss_recurring'), recurring_id: id }),
  z.object({
    kind: z.literal('update_account'),
    account_id: id,
    account_name: z.string().trim().min(1).max(80).optional(),
    is_hidden: z.boolean().optional(),
    current_balance: z.number().optional(),
    statement_balance: z.number().nonnegative().nullable().optional(),
    statement_due_date: calendarDate.nullable().optional(),
    credit_limit: z.number().positive().nullable().optional(),
  }),
  z.object({
    kind: z.literal('set_notification_rule'),
    rule_id: z.string().min(1).optional(),
    rule_kind: z.string().min(1),
    params: z.record(z.unknown()),
    enabled: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('delete_notification_rule'), rule_id: id }),
]);

// Top-level draft object as emitted by the worker LLM. label/summary/route/changes/
// citations are display-only, so they're validated loosely; the payload carries
// everything that mutates the DB, so it's validated strictly. The refinement rejects
// any draft whose top-level kind disagrees with its payload kind (confirmAdvisorDraft
// also enforces this, but rejecting here keeps a mismatched draft out of the DB).
export const AiWorkerDraftSchema = z
  .object({
    kind: z.string().min(1),
    label: z.string().min(1),
    summary: z.string().min(1),
    route: z.string().optional(),
    // `confidence` was a self-reported 0-1 score that gated auto-apply. It is gone: what applies
    // unattended is now decided by draft KIND (DRAFT_KIND_AUTONOMY), a boundary the owner
    // sets. Still accepted-and-ignored so a model that volunteers one is not rejected wholesale.
    confidence: z.number().optional(),
    payload: AdvisorDraftPayloadSchema,
    changes: z.array(z.object({
      field: z.string(),
      before: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      after: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })).optional().default([]),
    citations: z.array(z.unknown()).optional().default([]),
  })
  .refine((d) => d.kind === d.payload.kind, { message: 'draft.kind must match payload.kind' });

// Unit-agnostic: the route takes dollars and converts after parsing, the service takes cents.
const nullableId = z.string().min(1).nullable().default(null);

export const NotificationRuleParamsSchemas = {
  budget_threshold: z.object({ category_id: nullableId, percent: z.number().gt(0).max(1000) }),
  large_transaction: z.object({
    min_amount: z.number().positive(),
    account_id: nullableId,
    lookback_days: z.number().int().min(1).max(90).default(7),
  }),
  bill_due: z.object({ days_ahead: z.number().int().min(0).max(60) }),
  low_balance: z.object({ account_id: nullableId, threshold: z.number().finite() }),
  safe_to_spend_negative: z.object({}),
  sync_failed: z.object({ include_partial: z.boolean().default(true) }),
  goal_milestone: z.object({
    goal_id: nullableId,
    milestones: z.array(z.number().int().min(1).max(100)).min(1).max(10)
      .refine((values) => new Set(values).size === values.length, 'Milestones must be distinct'),
  }),
  unusual_spending: z.object({
    category_id: nullableId,
    ratio: z.number().gt(1).max(20),
    min_amount: z.number().nonnegative().default(0),
  }),
  recurring_amount_changed: z.object({}),
  income_late: z.object({ min_days_late: z.number().int().min(0).max(30).default(2) }),
  account_shortfall: z.object({ days_ahead: z.number().int().min(1).max(60).default(14) }),
  card_payment_missing: z.object({ min_days_late: z.number().int().min(0).max(30).default(3) }),
} as const;

const notificationRuleVariant = <K extends keyof typeof NotificationRuleParamsSchemas>(kind: K) =>
  z.object({ kind: z.literal(kind), params: NotificationRuleParamsSchemas[kind] });

export const NotificationRuleSpecSchema = z.discriminatedUnion('kind', [
  notificationRuleVariant('budget_threshold'),
  notificationRuleVariant('large_transaction'),
  notificationRuleVariant('bill_due'),
  notificationRuleVariant('low_balance'),
  notificationRuleVariant('safe_to_spend_negative'),
  notificationRuleVariant('sync_failed'),
  notificationRuleVariant('goal_milestone'),
  notificationRuleVariant('unusual_spending'),
  notificationRuleVariant('recurring_amount_changed'),
  notificationRuleVariant('income_late'),
  notificationRuleVariant('account_shortfall'),
  notificationRuleVariant('card_payment_missing'),
]);

export const CreateNotificationRuleSchema = z.object({
  kind: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  enabled: z.boolean().optional(),
});

export const UpdateNotificationRuleSchema = z.object({
  enabled: z.boolean().optional(),
  params: z.record(z.unknown()).optional(),
}).refine((body) => body.enabled !== undefined || body.params !== undefined, 'Nothing to update');

export const MarkNotificationsReadSchema = z.object({
  ids: z.union([z.literal('all'), z.array(z.string().min(1)).min(1).max(500)]),
});

export const ListNotificationsQuerySchema = z.object({
  unread_only: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
