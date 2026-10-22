import type Database from 'better-sqlite3';
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';
import type { AdvisorDraftPayload } from '../../../shared/types';
import { PAYROLL_WORDS, payerKey } from './recurring';
import { LIQUID_TYPES } from './safeToSpend';
import { excludedFromTotalsSql } from './transactionFilters';
import { toCents, toDollars } from './money';

export const LUMP_MIN_CENTS = 100_000;
export const LUMP_MIN_OCCURRENCES = 3;
const BAND_STEP_RATIO = 1.4;
const MIN_SPREAD_DAYS = 7;
export const DEPOSIT_KEY = 'deposit';

const ymd = (date: Date) => format(date, 'yyyy-MM-dd');

export interface LumpInflow {
  id: string;
  date: string;
  amount: number;
  merchant_name: string | null;
  key: string;
}

export interface LumpCandidate {
  label: string;
  merchant_key: string;
  amount_low_cents: number;
  amount_high_cents: number;
  window_start: string;
  window_end: string;
  last_occurrence: string;
  median_gap_days: number;
  spread_days: number;
  occurrences: Array<{ id: string; date: string; amount: number }>;
}

const DEPOSIT_WORDS = [
  /\b(?:mobile|remote|online|atm|counter|teller|branch|banking center)\b.*\bdeposit\b/,
  /\bcounter credit\b/,
  /\bcheck\b.*\bdeposit\b|\bdeposit\b.*\bcheck\b/,
];
const ACH_TAIL = /\s(?:(?:PPD|CCD|WEB|TEL|ARC)\s+)?(?:=\s*)?(?:INDN|ID)\s*:.*$/i;

/** Anonymous deposits share one key: the descriptor names the channel, not the payer. */
export function lumpKey(merchantName: string | null, originalName: string | null): string {
  const texts = [merchantName, originalName].filter((text): text is string => Boolean(text)).map((text) => text.toLowerCase());
  if (texts.some((text) => DEPOSIT_WORDS.some((pattern) => pattern.test(text)))) return DEPOSIT_KEY;
  const fromOriginal = originalName ? payerKey(originalName.replace(ACH_TAIL, '').replace(/\bDES:/gi, ' ')) : '';
  return fromOriginal || payerKey(merchantName ?? '');
}

/** Money into checking, savings or cash (or a closed account) that is not pay, not a paired transfer and not a scheduled item. */
export function lumpInflows(db: Database.Database): LumpInflow[] {
  const types = [...LIQUID_TYPES, 'closed'].map((type) => `'${type}'`).join(', ');
  const rows = db.prepare(`
    SELECT t.id, t.date, t.amount, t.merchant_name, t.original_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.amount >= ? AND t.pending = 0 AND ${excludedFromTotalsSql('t')}
      AND t.transfer_pair_id IS NULL AND t.refund_of_id IS NULL
      AND a.is_liability = 0 AND a.is_hidden = 0 AND a.type IN (${types})
      AND COALESCE(t.category_id, '') <> 'cat_income_paycheck'
      AND (t.category_id IS NULL OR c.is_income = 1 OR t.category_id = 'cat_xfer_in')
      AND NOT EXISTS (SELECT 1 FROM recurring_patterns rp WHERE rp.id = t.recurring_id AND rp.is_active = 1)
    ORDER BY t.date, t.id
  `).all(LUMP_MIN_CENTS) as Array<{ id: string; date: string; amount: number; merchant_name: string | null; original_name: string | null }>;
  return rows
    .filter((row) => !PAYROLL_WORDS.test(row.original_name ?? '') && !PAYROLL_WORDS.test(row.merchant_name ?? ''))
    .map((row) => ({ id: row.id, date: row.date, amount: row.amount, merchant_name: row.merchant_name, key: lumpKey(row.merchant_name, row.original_name) }))
    .filter((row) => row.key !== '');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Amounts chained while each is within BAND_STEP_RATIO of the one below it. */
function amountBands(rows: LumpInflow[]): LumpInflow[][] {
  const sorted = [...rows].sort((a, b) => a.amount - b.amount);
  const bands: LumpInflow[][] = [];
  for (const row of sorted) {
    const current = bands[bands.length - 1];
    if (current && row.amount <= current[current.length - 1].amount * BAND_STEP_RATIO) current.push(row);
    else bands.push([row]);
  }
  return bands;
}

function mostCommonName(rows: LumpInflow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.merchant_name) counts.set(row.merchant_name, (counts.get(row.merchant_name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'Expected deposit';
}

function candidateFor(key: string, band: LumpInflow[]): LumpCandidate {
  const byDate = [...band].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const gaps = byDate.slice(1).map((row, index) => differenceInCalendarDays(parseISO(row.date), parseISO(byDate[index].date)));
  const gap = Math.round(median(gaps));
  const spread = Math.min(Math.max(Math.round(median(gaps.map((value) => Math.abs(value - gap)))), MIN_SPREAD_DAYS), Math.max(MIN_SPREAD_DAYS, Math.floor(gap / 2)));
  const last = byDate[byDate.length - 1].date;
  const next = addDays(parseISO(last), gap);
  const amounts = band.map((row) => row.amount);
  return {
    label: key === DEPOSIT_KEY ? 'Deposits' : mostCommonName(band),
    merchant_key: key,
    amount_low_cents: Math.min(...amounts),
    amount_high_cents: Math.max(...amounts),
    window_start: ymd(addDays(next, -spread)),
    window_end: ymd(addDays(next, spread)),
    last_occurrence: last,
    median_gap_days: gap,
    spread_days: spread,
    occurrences: byDate.map((row) => ({ id: row.id, date: row.date, amount: row.amount })),
  };
}

/**
 * Large inflows that come back at irregular intervals, one group per payer key: the band with
 * the most occurrences, if it has at least three and its next window has not already passed.
 */
export function detectExpectedLumps(db: Database.Database, today = new Date()): LumpCandidate[] {
  const byKey = new Map<string, LumpInflow[]>();
  for (const row of lumpInflows(db)) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  const todayKey = ymd(today);
  const out: LumpCandidate[] = [];
  for (const [key, rows] of byKey) {
    const band = amountBands(rows).sort((a, b) => b.length - a.length)[0];
    if (!band || band.length < LUMP_MIN_OCCURRENCES) continue;
    const candidate = candidateFor(key, band);
    if (candidate.window_end >= todayKey) out.push(candidate);
  }
  return out.sort((a, b) => a.window_start.localeCompare(b.window_start) || a.merchant_key.localeCompare(b.merchant_key));
}

/**
 * The first inflow after `last_occurrence` with this key whose amount sits in the lump's band.
 *
 * Not `lumpInflows`: that is the filter for proposing a lump, and its pending and category clauses
 * would leave a deposit already in the balance unseen, so the runway would count it a second time.
 * Any category and pending rows count here; transfers, duplicates, linked refunds and internal
 * trades do not.
 */
export function lumpArrival(
  db: Database.Database,
  lump: { merchant_key: string; amount_low_cents: number; amount_high_cents: number; last_occurrence: string }
): LumpInflow | null {
  const types = [...LIQUID_TYPES, 'closed'].map((type) => `'${type}'`).join(', ');
  const rows = db.prepare(`
    SELECT t.id, t.date, t.amount, t.merchant_name, t.original_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.date > ? AND t.amount >= ? AND t.amount <= ? AND ${excludedFromTotalsSql('t')}
      AND t.transfer_pair_id IS NULL AND t.refund_of_id IS NULL
      AND a.is_liability = 0 AND a.is_hidden = 0 AND a.type IN (${types})
    ORDER BY t.date, t.id
  `).all(
    lump.last_occurrence,
    Math.ceil(lump.amount_low_cents / BAND_STEP_RATIO),
    Math.floor(lump.amount_high_cents * BAND_STEP_RATIO)
  ) as Array<{ id: string; date: string; amount: number; merchant_name: string | null; original_name: string | null }>;
  for (const row of rows) {
    const key = lumpKey(row.merchant_name, row.original_name);
    if (key === lump.merchant_key) return { id: row.id, date: row.date, amount: row.amount, merchant_name: row.merchant_name, key };
  }
  return null;
}

export type ExpectLumpPayload = Extract<AdvisorDraftPayload, { kind: 'expect_lump' }>;

export function candidatePayload(candidate: LumpCandidate): ExpectLumpPayload {
  return {
    kind: 'expect_lump',
    label: candidate.label,
    merchant_key: candidate.merchant_key,
    amount_low: toDollars(candidate.amount_low_cents),
    amount_high: toDollars(candidate.amount_high_cents),
    window_start: candidate.window_start,
    window_end: candidate.window_end,
    last_occurrence: candidate.last_occurrence,
  };
}

export interface ExpectedLumpRow {
  id: string;
  label: string;
  merchant_key: string;
  amount_low_cents: number;
  amount_high_cents: number;
  window_start: string;
  window_end: string;
  last_occurrence: string;
  status: 'open' | 'confirmed' | 'dismissed';
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export type ConfirmedLumpState = 'expected' | 'arrived' | 'passed';

export interface ConfirmedLump extends ExpectedLumpRow {
  state: ConfirmedLumpState;
  arrived_on: string | null;
}

export function listConfirmedLumps(db: Database.Database, today = new Date()): ConfirmedLump[] {
  const rows = db.prepare(`
    SELECT * FROM expected_lumps WHERE status = 'confirmed' ORDER BY window_start, id
  `).all() as ExpectedLumpRow[];
  const todayKey = ymd(today);
  return rows.map((row) => {
    const arrival = lumpArrival(db, row);
    const state: ConfirmedLumpState = arrival ? 'arrived' : row.window_end < todayKey ? 'passed' : 'expected';
    return { ...row, state, arrived_on: arrival?.date ?? null };
  });
}

/** Confirmed lumps still to come, which only an estimate may count. */
export function pendingConfirmedLumps(db: Database.Database, today = new Date()): ConfirmedLump[] {
  return listConfirmedLumps(db, today).filter((lump) => lump.state === 'expected');
}

/** Writes the owner's confirmation; a live confirmed lump with the same key is replaced in place. */
export function confirmExpectedLump(db: Database.Database, payload: ExpectLumpPayload, today = new Date()): { id: string; changed: number } {
  const low = toCents(payload.amount_low);
  const high = toCents(payload.amount_high);
  const now = new Date().toISOString();
  const live = pendingConfirmedLumps(db, today).find((lump) => lump.merchant_key === payload.merchant_key);
  if (live) {
    const same = live.label === payload.label && live.amount_low_cents === low && live.amount_high_cents === high
      && live.window_start === payload.window_start && live.window_end === payload.window_end
      && live.last_occurrence === payload.last_occurrence;
    if (same) return { id: live.id, changed: 0 };
    db.prepare(`
      UPDATE expected_lumps
      SET label = ?, amount_low_cents = ?, amount_high_cents = ?, window_start = ?, window_end = ?,
          last_occurrence = ?, updated_at = ?, confirmed_at = ?
      WHERE id = ?
    `).run(payload.label, low, high, payload.window_start, payload.window_end, payload.last_occurrence, now, now, live.id);
    return { id: live.id, changed: 1 };
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO expected_lumps (id, label, merchant_key, amount_low_cents, amount_high_cents, window_start,
                                window_end, last_occurrence, status, created_at, updated_at, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
  `).run(id, payload.label, payload.merchant_key, low, high, payload.window_start, payload.window_end, payload.last_occurrence, now, now, now);
  return { id, changed: 1 };
}

export function dismissConfirmedLump(db: Database.Database, id: string): boolean {
  return db.prepare(`
    UPDATE expected_lumps SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'confirmed'
  `).run(new Date().toISOString(), id).changes === 1;
}

/** Why an expect_lump payload cannot become a card, or null. */
export function expectLumpProblem(payload: ExpectLumpPayload, today = new Date()): string | null {
  if (payload.amount_low > payload.amount_high) return 'amount_low must not exceed amount_high';
  if (payload.window_start > payload.window_end) return 'window_start must not be after window_end';
  if (payload.window_end < ymd(today)) return 'that window has already passed';
  if (payload.last_occurrence > ymd(today)) return 'last_occurrence cannot be in the future';
  return null;
}

/** Lapsed when its window passed, the lump already arrived, or the owner already confirmed this exact one. */
export function expectLumpLapsed(db: Database.Database, payload: ExpectLumpPayload, today = new Date()): boolean {
  if (payload.window_end < ymd(today)) return true;
  const low = toCents(payload.amount_low);
  const high = toCents(payload.amount_high);
  if (lumpArrival(db, { merchant_key: payload.merchant_key, amount_low_cents: low, amount_high_cents: high, last_occurrence: payload.last_occurrence })) return true;
  return pendingConfirmedLumps(db, today).some((lump) =>
    lump.merchant_key === payload.merchant_key && lump.amount_low_cents === low && lump.amount_high_cents === high
    && lump.window_start === payload.window_start && lump.window_end === payload.window_end
  );
}
