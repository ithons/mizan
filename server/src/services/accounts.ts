import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { toCents } from './money';

// Money columns (current_balance/available_balance/credit_limit) are integer cents
// here; callers dollarize at the response boundary. native_balance (crypto quantity)
// is not money. These functions own the SQL; the route owns HTTP + snapshot orchestration.

type AccountRow = Record<string, unknown> & {
  is_manual: number;
  is_hidden: number;
  is_liability: number;
};

// The list endpoint coerces the SQLite integer booleans to real booleans (so the client
// doesn't render a literal "0"); the single-account responses deliberately return the raw
// row, matching long-standing behavior. Don't unify the two without checking the client.
export function listAccounts(db: Database.Database): Record<string, unknown>[] {
  return (db.prepare(`
    SELECT a.*
    FROM accounts a
    ORDER BY a.sort_order ASC, a.created_at ASC
  `).all() as AccountRow[]).map((a) => ({
    ...a,
    is_manual: Boolean(a.is_manual),
    is_hidden: Boolean(a.is_hidden),
    is_liability: Boolean(a.is_liability),
  }));
}

export interface CreateManualAccountInput {
  account_name: string;
  type: string;
  institution_name?: string;
  current_balance: number; // dollars
  currency: string;
  is_liability?: boolean;
  color?: string;
}

export function createManualAccount(db: Database.Database, input: CreateManualAccountInput): Record<string, unknown> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Auto-derive liability from type if not explicitly provided.
  const isLiability = input.is_liability ?? (input.type === 'credit');

  const maxOrder = db.prepare('SELECT MAX(sort_order) as max_order FROM accounts').get() as {
    max_order: number | null;
  };
  const sortOrder = (maxOrder.max_order ?? -1) + 1;

  db.prepare(`
    INSERT INTO accounts
      (id, connection_type, institution_name, account_name, type,
       current_balance, currency, is_manual, is_hidden, is_liability,
       color, sort_order, created_at, updated_at)
    VALUES (?, 'manual', ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)
  `).run(
    id,
    // institution_name is NOT NULL DEFAULT '' but named explicitly in the INSERT, so an
    // omitted value would bind `undefined` and throw. Fall back to '' at the bind site.
    input.institution_name ?? '',
    input.account_name,
    input.type,
    toCents(input.current_balance),
    input.currency,
    isLiability ? 1 : 0,
    input.color || null,
    sortOrder,
    now,
    now
  );

  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown>;
}

export interface UpdateAccountInput {
  account_name?: string;
  institution_name?: string | null;
  type?: string;
  currency?: string;
  is_liability?: boolean;
  color?: string | null;
  is_hidden?: boolean;
  sort_order?: number;
  current_balance?: number; // dollars
}

export type UpdateAccountResult =
  | { ok: true; row: Record<string, unknown>; balanceChanged: boolean }
  | { ok: false; reason: 'not_found' | 'manual_only' };

export function updateAccount(db: Database.Database, id: string, input: UpdateAccountInput): UpdateAccountResult {
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | (Record<string, unknown> & { is_manual: number })
    | undefined;
  if (!existing) {
    return { ok: false, reason: 'not_found' };
  }

  // institution_name/currency are provider-sourced and only editable on manual accounts.
  // type/is_liability are editable on any account — a synced account's type is only ever a
  // sync-time guess (see accountClassification.ts), and correcting it is the intended
  // escape hatch for a misclassified account.
  const manualOnlyFields = [input.institution_name, input.currency];
  if (!existing.is_manual && manualOnlyFields.some((field) => field !== undefined)) {
    return { ok: false, reason: 'manual_only' };
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.account_name !== undefined) {
    updates.push('account_name = ?');
    values.push(input.account_name);
    // Mark the name user-owned so SimpleFIN sync stops overwriting it (mirrors type_source).
    updates.push('name_source = ?');
    values.push('manual');
  }
  if (input.institution_name !== undefined) {
    updates.push('institution_name = ?');
    values.push(input.institution_name);
  }
  if (input.type !== undefined) {
    updates.push('type = ?');
    values.push(input.type);
    updates.push('type_source = ?');
    values.push('manual');
  }
  if (input.currency !== undefined) {
    updates.push('currency = ?');
    values.push(input.currency);
  }
  if (input.is_liability !== undefined) {
    updates.push('is_liability = ?');
    values.push(input.is_liability ? 1 : 0);
  } else if (input.type !== undefined) {
    updates.push('is_liability = ?');
    values.push(input.type === 'credit' ? 1 : 0);
  }
  if (input.color !== undefined) {
    updates.push('color = ?');
    values.push(input.color);
  }
  if (input.is_hidden !== undefined) {
    updates.push('is_hidden = ?');
    values.push(input.is_hidden ? 1 : 0);
  }
  if (input.sort_order !== undefined) {
    updates.push('sort_order = ?');
    values.push(input.sort_order);
  }
  if (input.current_balance !== undefined) {
    updates.push('current_balance = ?');
    values.push(toCents(input.current_balance));
  }

  if (updates.length === 0) {
    return { ok: true, row: existing, balanceChanged: false };
  }

  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown>;
  return { ok: true, row, balanceChanged: input.current_balance !== undefined };
}

export type MergeAccountsResult =
  | { ok: true }
  | { ok: false; reason: 'same_account' | 'not_found' };

export function mergeAccounts(
  db: Database.Database,
  targetAccountId: string,
  sourceAccountId: string
): MergeAccountsResult {
  if (targetAccountId === sourceAccountId) {
    return { ok: false, reason: 'same_account' };
  }

  const target = db.prepare('SELECT * FROM accounts WHERE id = ?').get(targetAccountId) as any;
  const source = db.prepare('SELECT * FROM accounts WHERE id = ?').get(sourceAccountId) as any;

  if (!target || !source) {
    return { ok: false, reason: 'not_found' };
  }

  const now = new Date().toISOString();

  db.transaction(() => {
    // Move provider IDs from source to target.
    const providerFields: string[] = [];
    const providerValues: any[] = [];

    if (source.simplefin_account_id) {
      providerFields.push('simplefin_account_id = ?');
      providerValues.push(source.simplefin_account_id);
    }

    // Update target account connection info to match source.
    db.prepare(`
      UPDATE accounts
      SET connection_type = ?,
          connection_id = ?,
          ${providerFields.length > 0 ? providerFields.join(', ') + ',' : ''}
          current_balance = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      source.connection_type,
      source.connection_id,
      ...providerValues,
      source.current_balance,
      now,
      targetAccountId
    );

    // Reassign all transactions.
    db.prepare(`
      UPDATE transactions
      SET account_id = ?, updated_at = ?
      WHERE account_id = ?
    `).run(targetAccountId, now, sourceAccountId);

    // Reassign holdings and investment transactions.
    db.prepare(`
      UPDATE holdings
      SET account_id = ?, updated_at = ?
      WHERE account_id = ?
    `).run(targetAccountId, now, sourceAccountId);

    // Remove the source account.
    db.prepare('DELETE FROM accounts WHERE id = ?').run(sourceAccountId);
  })();

  return { ok: true };
}

export type DeleteAccountResult = { ok: true } | { ok: false; reason: 'not_found' };

export function deleteAccount(db: Database.Database, id: string): DeleteAccountResult {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | { is_manual: number }
    | undefined;

  if (!account) {
    return { ok: false, reason: 'not_found' };
  }

  if (account.is_manual) {
    // Clean up associated transactions before deleting the account.
    db.prepare('DELETE FROM transactions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  } else {
    db.prepare('UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      id
    );
  }

  return { ok: true };
}
