export interface CsvImportMapping {
  date: string;
  amount: string;
  merchant: string;
  category: string;
  account: string;
  notes: string;
  dateFormat: string;
  amountNegate: boolean;
}

export const MIZAN_CSV_MAPPING: CsvImportMapping = {
  date: 'date',
  amount: 'amount',
  merchant: 'merchant_name',
  category: 'category_name',
  account: 'account_name',
  notes: 'notes',
  dateFormat: 'yyyy-MM-dd',
  amountNegate: false,
};

export const MONARCH_CSV_MAPPING: CsvImportMapping = {
  date: 'Date',
  amount: 'Amount',
  merchant: 'Merchant',
  category: 'Category',
  account: 'Account',
  notes: 'Notes',
  dateFormat: 'yyyy-MM-dd',
  amountNegate: false,
};

function findHeader(headers: string[], candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    const exact = headers.find((header) => header === candidate);
    if (exact) return exact;
  }

  const normalized = new Map(headers.map((header) => [header.trim().toLowerCase(), header]));
  for (const candidate of candidates) {
    const match = normalized.get(candidate.toLowerCase());
    if (match) return match;
  }

  return fallback;
}

export function detectCsvImportMapping(headers: string[]): CsvImportMapping {
  return {
    date: findHeader(headers, ['date', 'Date', 'Posted Date', 'Transaction Date'], MIZAN_CSV_MAPPING.date),
    amount: findHeader(headers, ['amount', 'Amount', 'Transaction Amount'], MIZAN_CSV_MAPPING.amount),
    merchant: findHeader(headers, ['merchant_name', 'Merchant', 'merchant', 'Description', 'Name'], MIZAN_CSV_MAPPING.merchant),
    category: findHeader(headers, ['category_name', 'Category', 'category'], MIZAN_CSV_MAPPING.category),
    account: findHeader(headers, ['account_name', 'Account', 'account'], MIZAN_CSV_MAPPING.account),
    notes: findHeader(headers, ['notes', 'Notes', 'note', 'Memo'], MIZAN_CSV_MAPPING.notes),
    dateFormat: MIZAN_CSV_MAPPING.dateFormat,
    amountNegate: false,
  };
}
