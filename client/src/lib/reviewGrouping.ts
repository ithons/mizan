import type { Transaction } from '@shared/types';

export interface ReviewBatchGroup {
  key: string;
  merchant_name: string;
  account_name: string | null;
  transaction_ids: string[];
  count: number;
  total_amount: number;
  latest_date: string;
}

function merchantLabel(transaction: Transaction): string {
  return (transaction.merchant_name || transaction.original_name).trim();
}

function normalizeGroupPart(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getUncategorizedBatchGroups(transactions: Transaction[]): ReviewBatchGroup[] {
  const groups = new Map<string, ReviewBatchGroup>();

  for (const transaction of transactions) {
    const merchant = merchantLabel(transaction);
    if (!merchant) continue;

    const key = `${normalizeGroupPart(merchant)}:${normalizeGroupPart(transaction.account_id)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.transaction_ids.push(transaction.id);
      existing.count += 1;
      existing.total_amount += transaction.amount;
      existing.latest_date = transaction.date > existing.latest_date ? transaction.date : existing.latest_date;
      continue;
    }

    groups.set(key, {
      key,
      merchant_name: merchant,
      account_name: transaction.account_name ?? null,
      transaction_ids: [transaction.id],
      count: 1,
      total_amount: transaction.amount,
      latest_date: transaction.date,
    });
  }

  return [...groups.values()]
    .filter((group) => group.count > 1)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.latest_date.localeCompare(a.latest_date);
    });
}
