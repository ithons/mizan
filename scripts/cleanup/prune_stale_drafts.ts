// Advisor drafts store a payload snapshot taken when the draft was created. Migration 031 folded
// and deleted several categories (cat_income_xferin, cat_travel_vacation, cat_income_dividends),
// so older payloads can reference a category id that no longer exists. Applying such a draft would
// raise "FOREIGN KEY constraint failed".
//
// Already-resolved drafts (confirmed/dismissed) are historical records and are left alone; any
// OPEN draft pointing at a missing category is unapplicable and is dismissed so it can't be
// auto-applied or offered to the user. Idempotent.
import { getDb, closeDb } from '../../server/src/db/index';

const db = getDb();

const known = new Set(
  (db.prepare('SELECT id FROM categories').all() as Array<{ id: string }>).map((r) => r.id)
);

const drafts = db.prepare('SELECT id, kind, status, payload FROM advisor_drafts').all() as Array<{
  id: string; kind: string; status: string; payload: string;
}>;

let openStale = 0;
let resolvedStale = 0;

for (const draft of drafts) {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(draft.payload) as Record<string, unknown>;
  } catch {
    console.warn(`[drafts] unparseable payload on ${draft.id} (${draft.status})`);
    continue;
  }
  const categoryId = (payload.category_id ?? payload.categoryId) as string | undefined;
  if (!categoryId || known.has(categoryId)) continue;

  if (draft.status === 'open') {
    db.prepare("UPDATE advisor_drafts SET status = 'dismissed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), draft.id);
    openStale++;
    console.log(`[drafts] dismissed open draft ${draft.id} (${draft.kind}) -> missing '${categoryId}'`);
  } else {
    resolvedStale++;
  }
}

console.log(`[drafts] ${drafts.length} total · dismissed ${openStale} unapplicable open draft(s) · left ${resolvedStale} historical record(s) untouched`);
closeDb();
