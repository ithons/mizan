import { z } from 'zod';

export const CreateManualAccountSchema = z.object({
  account_name: z.string().min(1),
  type: z.enum(['checking', 'savings', 'credit', 'brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet', 'cash', 'other']),
  institution_name: z.string().optional(),
  current_balance: z.number().default(0),
  currency: z.string().default('USD'),
  is_liability: z.boolean().optional(),
  color: z.string().optional(),
});

export const UpdateAccountSchema = z.object({
  account_name: z.string().min(1).optional(),
  institution_name: z.string().nullable().optional(),
  type: z.enum(['checking', 'savings', 'credit', 'brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet', 'cash', 'other']).optional(),
  currency: z.string().min(1).optional(),
  is_liability: z.boolean().optional(),
  color: z.string().nullable().optional(),
  is_hidden: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  current_balance: z.number().optional(),
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

export const MergeCategorySchema = z.object({
  targetId: z.string().min(1),
});

export const UpsertBudgetSchema = z.object({
  amount: z.number().positive(),
  period: z.literal('monthly').default('monthly'),
  rollover: z.boolean().default(false),
});

export const CreateBudgetGroupSchema = z.object({
  name: z.string().min(1),
  color: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
});

export const UpdateBudgetGroupSchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
});

export const BudgetGroupMembersSchema = z.object({
  category_ids: z.array(z.string().min(1)),
});

export const UpdateRecurringSchema = z.object({
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
});

export const UpdateMerchantRuleSchema = z.object({
  pattern: z.string().min(1).optional(),
  category_id: z.string().min(1).optional(),
});

export const ApplyMerchantRulesSchema = z.object({
  only_uncategorized: z.boolean().default(true),
});

export const PlaidCredentialsSchema = z.object({
  clientId: z.string().min(1),
  secret: z.string().min(1),
  environment: z.enum(['sandbox', 'production']),
});

export const PlaidExchangeTokenSchema = z.object({
  publicToken: z.string().min(1),
  metadata: z.record(z.unknown()),
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
  sector: z.string().trim().min(1).max(80).nullable(),
  sector_source: z.string().trim().min(1).max(40).nullable().optional(),
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
