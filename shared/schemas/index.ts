import { z } from 'zod';

export const CreateManualAccountSchema = z.object({
  account_name: z.string().min(1),
  type: z.enum(['checking', 'savings', 'credit', 'brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet', 'cash', 'other']),
  institution_name: z.string().optional(),
  current_balance: z.number().default(0),
  currency: z.string().default('USD'),
  is_liability: z.boolean().default(false),
  color: z.string().optional(),
});

export const UpdateAccountSchema = z.object({
  account_name: z.string().min(1).optional(),
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
  period: z.string().default('monthly'),
  rollover: z.boolean().default(false),
});

export const UpdateRecurringSchema = z.object({
  category_id: z.string().nullable().optional(),
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

export const ExportCsvSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  accountIds: z.array(z.string()).optional(),
});

export const DeleteDataSchema = z.object({
  confirm: z.literal('delete'),
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
