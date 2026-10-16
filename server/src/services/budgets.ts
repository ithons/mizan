import type Database from 'better-sqlite3';

export function deleteBudget(db: Database.Database, id: string): { ok: boolean } {
  return { ok: db.prepare('DELETE FROM budgets WHERE id = ?').run(id).changes > 0 };
}

export function budgetIdForCategory(db: Database.Database, categoryId: string): string | null {
  const row = db.prepare("SELECT id FROM budgets WHERE category_id = ? AND period = 'monthly'").get(categoryId) as { id: string } | undefined;
  return row?.id ?? null;
}
