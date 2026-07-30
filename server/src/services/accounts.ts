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

// Per-account balance history lives in balanceHistory.ts. It used to live here, reading the
// per-account breakdown out of net_worth_snapshots, which meant an account's chart described when
// the app was running rather than when its money moved.

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
    // Release the source's provider ids BEFORE claiming them on the target.
    //
    // `simplefin_account_id` and `coinbase_account_id` are both UNIQUE, and SQLite has no deferred
    // unique constraints, so writing the source's id onto the target while the source row still held
    // it threw on the spot. Merging any provider-linked account simply failed, and the failure was
    // a raw constraint error rather than anything the UI could explain.
    db.prepare(`
      UPDATE accounts
      SET simplefin_account_id = NULL, coinbase_account_id = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, sourceAccountId);

    db.prepare(`
      UPDATE accounts
      SET connection_type = ?,
          connection_id = ?,
          simplefin_account_id = ?,
          coinbase_account_id = ?,
          current_balance = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      source.connection_type,
      source.connection_id,
      source.simplefin_account_id ?? null,
      source.coinbase_account_id ?? null,
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

    db.prepare(`
      UPDATE holdings
      SET account_id = ?, updated_at = ?
      WHERE account_id = ?
    `).run(targetAccountId, now, sourceAccountId);

    // holdings_history is the lesson migration 033 had to learn by hand.
    //
    // It carries `ON DELETE CASCADE` on account_id, so deleting the source below destroys every
    // historical position it held. Migration 033 consolidated eight per-coin Coinbase accounts into
    // one and had to rebuild exactly these rows afterwards; that repair went into the migration and
    // never into this function, so the next merge would have destroyed them again.
    //
    // The composite key is (account_id, security_id, date), so a date where BOTH accounts held the
    // same security would collide. Sum those rather than letting one silently win: two rows for the
    // same security on the same day are two parts of one position once the accounts are one account.
    db.prepare(`
      UPDATE OR REPLACE holdings_history
      SET account_id = ?
      WHERE account_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM holdings_history existing
          WHERE existing.account_id = ?
            AND existing.security_id = holdings_history.security_id
            AND existing.date = holdings_history.date
        )
    `).run(targetAccountId, sourceAccountId, targetAccountId);

    db.prepare(`
      UPDATE holdings_history AS target
      SET quantity = quantity + COALESCE((
            SELECT s.quantity FROM holdings_history s
            WHERE s.account_id = ? AND s.security_id = target.security_id AND s.date = target.date
          ), 0),
          institution_value = institution_value + COALESCE((
            SELECT s.institution_value FROM holdings_history s
            WHERE s.account_id = ? AND s.security_id = target.security_id AND s.date = target.date
          ), 0)
      WHERE target.account_id = ?
    `).run(sourceAccountId, sourceAccountId, targetAccountId);

    db.prepare('DELETE FROM holdings_history WHERE account_id = ?').run(sourceAccountId);

    // A goal linked to the source would be silently unlinked by ON DELETE SET NULL, quietly
    // detaching the goal from the money backing it.
    db.prepare('UPDATE goals SET account_id = ? WHERE account_id = ?').run(targetAccountId, sourceAccountId);

    // The lesson migration 039 had to learn by hand: the source id stays inside every historical
    // net_worth_snapshots.breakdown, where it becomes an id pointing at nothing. Migration 039
    // remapped exactly these orphans after 033 deleted eight accounts, and that repair also never
    // made it into this function.
    remapAccountIdInSnapshots(db, sourceAccountId, targetAccountId);

    db.prepare('DELETE FROM accounts WHERE id = ?').run(sourceAccountId);
  })();

  return { ok: true };
}

/**
 * Rewrite every historical breakdown so `fromAccountId`'s balance is attributed to `toAccountId`.
 *
 * Values are summed where both ids appear on the same date: after a merge they are two parts of one
 * account, so the month's net worth must not change. That is the property migration 039 was
 * restoring, and it is the property this keeps.
 */
export function remapAccountIdInSnapshots(
  db: Database.Database,
  fromAccountId: string,
  toAccountId: string
): number {
  const rows = db.prepare('SELECT id, breakdown FROM net_worth_snapshots').all() as Array<{
    id: string;
    breakdown: string;
  }>;
  const update = db.prepare('UPDATE net_worth_snapshots SET breakdown = ? WHERE id = ?');
  let changed = 0;

  for (const row of rows) {
    let breakdown: Record<string, unknown>;
    try {
      breakdown = JSON.parse(row.breakdown) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!(fromAccountId in breakdown)) continue;

    const moved = breakdown[fromAccountId];
    delete breakdown[fromAccountId];
    if (typeof moved === 'number' && Number.isFinite(moved)) {
      const existing = breakdown[toAccountId];
      breakdown[toAccountId] =
        typeof existing === 'number' && Number.isFinite(existing) ? existing + moved : moved;
    }
    update.run(JSON.stringify(breakdown), row.id);
    changed += 1;
  }

  return changed;
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
    // Historical breakdowns are deliberately left intact.
    //
    // The account's past balances DID happen, so rewriting them would silently change what net
    // worth was in every earlier month. What the app must not do is guess about an id it can no
    // longer resolve: `deriveAssetBuckets` therefore counts an unresolvable account under `other`
    // rather than assuming it was a non-liability asset, which is what made a removed credit card
    // read as money the owner had.
    //
    // holdings and holdings_history cascade away with the account. That is correct HERE and wrong in
    // mergeAccounts, where the positions survive under the target: see the note there.
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
