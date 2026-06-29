import type Database from 'better-sqlite3';

export function adjustManualAccountBalance(
  db: Database.Database,
  accountId: string,
  delta: number,
  updatedAt: string
): boolean {
  if (delta === 0) return false;

  const result = db.prepare(`
    UPDATE accounts
    SET current_balance = current_balance + ?, updated_at = ?
    WHERE id = ? AND is_manual = 1
  `).run(delta, updatedAt, accountId);

  return result.changes > 0;
}
