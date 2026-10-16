import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { GoalType } from '../../../shared/types';
import { toCents, toCentsOrNull } from './money';

export interface CreateGoalInput {
  name: string;
  type: GoalType;
  target_amount: number;
  current_amount?: number;
  starting_amount?: number | null;
  account_id?: string | null;
  target_date?: string | null;
  color?: string | null;
}

export type CreateGoalResult = { ok: true; id: string } | { ok: false; reason: 'account_not_found' };

/** Amounts are dollars; a debt goal linked to an account starts from what that account owes. */
export function createGoal(db: Database.Database, input: CreateGoalInput): CreateGoalResult {
  const accountId = input.account_id?.trim() || null;
  if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
    return { ok: false, reason: 'account_not_found' };
  }
  const now = new Date().toISOString();
  const id = uuidv4();
  let startingAmount = toCentsOrNull(input.starting_amount ?? null);
  if (input.type === 'debt' && accountId && startingAmount === null) {
    const account = db.prepare('SELECT current_balance FROM accounts WHERE id = ?').get(accountId) as { current_balance: number };
    startingAmount = Math.max(account.current_balance, 0);
  }
  db.prepare(`
    INSERT INTO goals
      (id, name, type, target_amount, current_amount, starting_amount,
       account_id, target_date, color, is_archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    input.name,
    input.type,
    toCents(input.target_amount),
    toCents(input.current_amount ?? 0),
    startingAmount,
    accountId,
    input.target_date ?? null,
    input.color ?? null,
    now,
    now
  );
  return { ok: true, id };
}
