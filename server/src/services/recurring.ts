import { v4 as uuidv4 } from 'uuid';
import {
  differenceInDays,
  addDays,
  format,
  parseISO,
  subMonths,
} from 'date-fns';
import { getDb } from '../db/index';

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

const STRIP_SUFFIXES = /\b(llc|inc|corp|co|ltd)\b/gi;
const STRIP_TRAILING_DIGITS = /\s+\d+$/;
const STRIP_HASH_DIGITS = /\s*#\d+/g;
const STRIP_PUNCTUATION = /[^\w\s]/g;

function normalizeMerchant(name: string): string {
  let n = name.toLowerCase().trim();
  n = n.replace(STRIP_PUNCTUATION, ' ');
  n = n.replace(STRIP_HASH_DIGITS, '');
  n = n.replace(STRIP_SUFFIXES, '');
  n = n.replace(STRIP_TRAILING_DIGITS, '');

  // Strip trailing US state abbreviations
  const words = n.trim().split(/\s+/);
  while (words.length > 0 && US_STATES.has(words[words.length - 1].toUpperCase())) {
    words.pop();
  }
  n = words.join(' ').trim();

  // Collapse multiple spaces
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function classifyFrequency(
  medianGap: number
): 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | null {
  if (medianGap >= 5 && medianGap <= 9) return 'weekly';
  if (medianGap >= 12 && medianGap <= 16) return 'biweekly';
  if (medianGap >= 27 && medianGap <= 33) return 'monthly';
  if (medianGap >= 85 && medianGap <= 95) return 'quarterly';
  if (medianGap >= 355 && medianGap <= 375) return 'annual';
  return null;
}

function variance(values: number[], med: number): number {
  if (values.length === 0 || med === 0) return 0;
  // Coefficient of variation: std_dev / mean, using median as center
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return stdDev / Math.abs(mean);
}

export function detectRecurring(): void {
  const db = getDb();
  const cutoff = format(subMonths(new Date(), 13), 'yyyy-MM-dd');
  const today = format(new Date(), 'yyyy-MM-dd');

  interface TxnRow {
    id: string;
    date: string;
    amount: number;
    merchant_name: string | null;
    original_name: string;
  }

  // 1. Load all non-pending transactions from last 13 months
  const transactions = db.prepare(`
    SELECT id, date, amount, merchant_name, original_name
    FROM transactions
    WHERE pending = 0 AND date >= ?
    ORDER BY date ASC
  `).all(cutoff) as TxnRow[];

  // 2. Group by normalized merchant name
  const groups = new Map<string, Array<{ id: string; date: string; amount: number }>>();

  for (const txn of transactions) {
    const raw = txn.merchant_name || txn.original_name;
    if (!raw) continue;
    const normalized = normalizeMerchant(raw);
    if (!normalized) continue;

    if (!groups.has(normalized)) {
      groups.set(normalized, []);
    }
    groups.get(normalized)!.push({ id: txn.id, date: txn.date, amount: txn.amount });
  }

  // 3. For each group with >= 3 transactions
  for (const [normalizedName, txns] of groups) {
    if (txns.length < 3) continue;

    // Sort by date ascending
    txns.sort((a, b) => a.date.localeCompare(b.date));

    // Compute day-gaps between consecutive dates
    const gaps: number[] = [];
    for (let i = 1; i < txns.length; i++) {
      const gap = differenceInDays(parseISO(txns[i].date), parseISO(txns[i - 1].date));
      gaps.push(gap);
    }

    const medianGap = median(gaps);
    const frequency = classifyFrequency(medianGap);
    if (!frequency) continue;

    const amounts = txns.map(t => Math.abs(t.amount));
    const medianAmount = median(amounts);

    const gapVariance = variance(gaps, medianGap);
    const amountVariance = variance(amounts, medianAmount);

    if (gapVariance >= 0.2 || amountVariance >= 0.25) continue;

    const lastTxn = txns[txns.length - 1];
    const nextExpected = format(
      addDays(parseISO(lastTxn.date), Math.round(medianGap)),
      'yyyy-MM-dd'
    );
    const now = new Date().toISOString();

    // Upsert recurring_pattern matching on merchant_name
    const existing = db.prepare(
      'SELECT id, is_confirmed FROM recurring_patterns WHERE merchant_name = ?'
    ).get(normalizedName) as { id: string; is_confirmed: number } | undefined;

    let patternId: string;

    if (existing) {
      patternId = existing.id;
      db.prepare(`
        UPDATE recurring_patterns
        SET frequency = ?, average_amount = ?, last_seen = ?, next_expected = ?,
            transaction_count = ?, is_active = 1, updated_at = ?
        WHERE id = ?
      `).run(
        frequency,
        medianAmount,
        lastTxn.date,
        nextExpected,
        txns.length,
        now,
        patternId
      );
    } else {
      patternId = uuidv4();
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, merchant_name, frequency, average_amount, last_seen, next_expected,
           is_active, is_confirmed, transaction_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
      `).run(
        patternId,
        normalizedName,
        frequency,
        medianAmount,
        lastTxn.date,
        nextExpected,
        txns.length,
        now,
        now
      );
    }

    // 5. Link matched transactions
    const ids = txns.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE transactions SET recurring_id = ? WHERE id IN (${placeholders})`
    ).run(patternId, ...ids);
  }

  // 6. Deactivate stale patterns
  const allPatterns = db.prepare(`
    SELECT id, last_seen, frequency, average_amount
    FROM recurring_patterns
    WHERE is_active = 1
  `).all() as Array<{
    id: string;
    last_seen: string;
    frequency: string;
    average_amount: number;
  }>;

  // Map frequency to approximate days for stale check
  const freqDays: Record<string, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
    quarterly: 91,
    annual: 365,
  };

  for (const pattern of allPatterns) {
    const approxGap = freqDays[pattern.frequency] || 30;
    const staleThreshold = format(
      addDays(parseISO(pattern.last_seen), 2 * approxGap),
      'yyyy-MM-dd'
    );
    if (staleThreshold < today) {
      db.prepare(
        'UPDATE recurring_patterns SET is_active = 0, updated_at = ? WHERE id = ?'
      ).run(new Date().toISOString(), pattern.id);
    }
  }
}
