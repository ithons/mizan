import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type {
  RecurringAdjustmentAction,
  RecurringOccurrenceAdjustment,
} from '../../../shared/types';

export interface UpsertRecurringAdjustmentInput {
  original_date: string;
  action: RecurringAdjustmentAction;
  adjusted_date?: string | null;
  adjusted_amount?: number | null;
  note?: string | null;
}

interface AdjustmentRow {
  id: string;
  recurring_id: string;
  original_date: string;
  action: RecurringAdjustmentAction;
  adjusted_date: string | null;
  adjusted_amount: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function assertDate(value: string, label: string): void {
  if (!DATE_RE.test(value)) {
    throw httpError(`${label} must be YYYY-MM-DD`, 400);
  }
}

function adjustmentFromRow(row: AdjustmentRow): RecurringOccurrenceAdjustment {
  return {
    id: row.id,
    recurring_id: row.recurring_id,
    original_date: row.original_date,
    action: row.action,
    adjusted_date: row.adjusted_date,
    adjusted_amount: row.adjusted_amount,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function assertRecurringPattern(db: Database.Database, recurringId: string): void {
  const pattern = db.prepare('SELECT id FROM recurring_patterns WHERE id = ? AND is_active = 1').get(recurringId);
  if (!pattern) throw httpError('Recurring pattern not found', 404);
}

function normalizeAdjustmentInput(input: UpsertRecurringAdjustmentInput): Required<Pick<
  UpsertRecurringAdjustmentInput,
  'original_date' | 'action'
>> & {
  adjusted_date: string | null;
  adjusted_amount: number | null;
  note: string | null;
} {
  assertDate(input.original_date, 'original_date');

  const note = input.note?.trim() || null;
  if (input.action === 'skip') {
    return {
      original_date: input.original_date,
      action: 'skip',
      adjusted_date: null,
      adjusted_amount: null,
      note,
    };
  }

  if (input.action === 'snooze') {
    if (!input.adjusted_date) throw httpError('adjusted_date is required for snooze adjustments', 400);
    assertDate(input.adjusted_date, 'adjusted_date');
    return {
      original_date: input.original_date,
      action: 'snooze',
      adjusted_date: input.adjusted_date,
      adjusted_amount: null,
      note,
    };
  }

  if (input.adjusted_amount == null || !Number.isFinite(input.adjusted_amount)) {
    throw httpError('adjusted_amount is required for amount adjustments', 400);
  }

  return {
    original_date: input.original_date,
    action: 'adjust',
    adjusted_date: null,
    adjusted_amount: input.adjusted_amount,
    note,
  };
}

export function listRecurringAdjustments(
  db: Database.Database,
  recurringId: string
): RecurringOccurrenceAdjustment[] {
  assertRecurringPattern(db, recurringId);
  return (db.prepare(`
    SELECT *
    FROM recurring_occurrence_adjustments
    WHERE recurring_id = ?
    ORDER BY original_date ASC
  `).all(recurringId) as AdjustmentRow[]).map(adjustmentFromRow);
}

export function getRecurringAdjustmentMap(
  db: Database.Database,
  recurringIds: string[]
): Map<string, RecurringOccurrenceAdjustment> {
  if (recurringIds.length === 0) return new Map();
  const placeholders = recurringIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT *
    FROM recurring_occurrence_adjustments
    WHERE recurring_id IN (${placeholders})
  `).all(...recurringIds) as AdjustmentRow[];

  return new Map(rows.map((row) => [
    `${row.recurring_id}:${row.original_date}`,
    adjustmentFromRow(row),
  ]));
}

export function upsertRecurringAdjustment(
  db: Database.Database,
  recurringId: string,
  input: UpsertRecurringAdjustmentInput
): RecurringOccurrenceAdjustment {
  assertRecurringPattern(db, recurringId);
  const normalized = normalizeAdjustmentInput(input);
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT id
    FROM recurring_occurrence_adjustments
    WHERE recurring_id = ? AND original_date = ?
  `).get(recurringId, normalized.original_date) as { id: string } | undefined;

  const id = existing?.id ?? uuidv4();
  if (existing) {
    db.prepare(`
      UPDATE recurring_occurrence_adjustments
      SET action = ?,
          adjusted_date = ?,
          adjusted_amount = ?,
          note = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      normalized.action,
      normalized.adjusted_date,
      normalized.adjusted_amount,
      normalized.note,
      now,
      id
    );
  } else {
    db.prepare(`
      INSERT INTO recurring_occurrence_adjustments (
        id, recurring_id, original_date, action, adjusted_date, adjusted_amount, note, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      recurringId,
      normalized.original_date,
      normalized.action,
      normalized.adjusted_date,
      normalized.adjusted_amount,
      normalized.note,
      now,
      now
    );
  }

  const row = db.prepare('SELECT * FROM recurring_occurrence_adjustments WHERE id = ?').get(id) as AdjustmentRow;
  return adjustmentFromRow(row);
}

export function deleteRecurringAdjustment(
  db: Database.Database,
  recurringId: string,
  adjustmentId: string
): boolean {
  assertRecurringPattern(db, recurringId);
  const result = db.prepare(`
    DELETE FROM recurring_occurrence_adjustments
    WHERE id = ? AND recurring_id = ?
  `).run(adjustmentId, recurringId);
  return result.changes > 0;
}
