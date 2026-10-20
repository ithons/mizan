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

export type UpdateGoalInput = Partial<CreateGoalInput> & { is_archived?: boolean };

export type UpdateGoalResult =
  | { ok: true }
  | { ok: false; reason: 'goal_not_found' | 'account_not_found' | 'saved_amount_on_linked_goal' };

/**
 * Amounts are dollars. A linked goal's saved amount is its account's balance, so `current_amount`
 * is refused while the goal stays linked: the edit form used to send back the resolved balance,
 * which snapshotted that day's balance into a column that becomes the saved figure on unlinking.
 */
export function updateGoal(db: Database.Database, id: string, input: UpdateGoalInput): UpdateGoalResult {
  const existing = db.prepare('SELECT account_id FROM goals WHERE id = ?').get(id) as { account_id: string | null } | undefined;
  if (!existing) return { ok: false, reason: 'goal_not_found' };
  const accountId = input.account_id === undefined ? existing.account_id : input.account_id?.trim() || null;
  if (input.account_id !== undefined && accountId && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
    return { ok: false, reason: 'account_not_found' };
  }
  if (input.current_amount !== undefined && accountId !== null) return { ok: false, reason: 'saved_amount_on_linked_goal' };

  const columns: Array<[string, unknown]> = [];
  if (input.name !== undefined) columns.push(['name', input.name]);
  if (input.type !== undefined) columns.push(['type', input.type]);
  if (input.target_amount !== undefined) columns.push(['target_amount', toCents(input.target_amount)]);
  if (input.current_amount !== undefined) columns.push(['current_amount', toCents(input.current_amount)]);
  if (input.starting_amount !== undefined) columns.push(['starting_amount', toCentsOrNull(input.starting_amount)]);
  if (input.account_id !== undefined) columns.push(['account_id', accountId]);
  if (input.target_date !== undefined) columns.push(['target_date', input.target_date]);
  if (input.color !== undefined) columns.push(['color', input.color]);
  if (input.is_archived !== undefined) columns.push(['is_archived', input.is_archived ? 1 : 0]);
  if (columns.length === 0) return { ok: true };

  columns.push(['updated_at', new Date().toISOString()]);
  db.prepare(`UPDATE goals SET ${columns.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`)
    .run(...columns.map(([, value]) => value), id);
  return { ok: true };
}
