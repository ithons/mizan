import type Database from 'better-sqlite3';
import {
  latestRevertableRevision,
  revertRevisions,
  writeTransactionCategory,
} from './categoryWrites';
import { excludedFromTotalsSql } from './transactionFilters';

export const REFUND_WINDOW_DAYS = 90;

interface LedgerRow {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  category_id: string | null;
  category_source: string | null;
  manually_categorized: number;
  refund_of_id: string | null;
  refund_link_source: string | null;
}

export interface RefundLinkResult {
  linked: number;
  newlyLinked: number;
}

/** The merchant a purchase and its refund share once store numbers and punctuation are gone. */
export function refundMerchantKey(row: Pick<LedgerRow, 'merchant_name' | 'original_name'>): string {
  return (row.merchant_name || row.original_name)
    .toLowerCase()
    .replace(/#\s*\w+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token && !/^\d+$/.test(token))
    .join(' ');
}

const OUT_OF_SCOPE_CTE = `
  WITH RECURSIVE out_of_scope(id) AS (
    SELECT id FROM categories WHERE id IN ('cat_xfer', 'cat_inv', 'cat_crypto')
    UNION ALL
    SELECT c.id FROM categories c JOIN out_of_scope s ON c.parent_id = s.id
  )
`;

const ROW_COLUMNS = `
  t.id, t.account_id, t.date, t.amount, t.merchant_name, t.original_name, t.category_id,
  t.category_source, t.manually_categorized, t.refund_of_id, t.refund_link_source
`;

function refundRows(db: Database.Database): LedgerRow[] {
  return db.prepare(`
    ${OUT_OF_SCOPE_CTE}
    SELECT ${ROW_COLUMNS}
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
      AND t.amount > 0
      AND ${excludedFromTotalsSql('t')}
      AND COALESCE(c.is_income, 0) = 0
      AND COALESCE(t.category_id, '') NOT IN (SELECT id FROM out_of_scope)
    ORDER BY t.date ASC, t.id ASC
  `).all() as LedgerRow[];
}

function purchaseRows(db: Database.Database): LedgerRow[] {
  return db.prepare(`
    ${OUT_OF_SCOPE_CTE}
    SELECT ${ROW_COLUMNS}
    FROM transactions t
    WHERE t.pending = 0
      AND t.amount < 0
      AND ${excludedFromTotalsSql('t')}
      AND COALESCE(t.category_id, '') NOT IN (SELECT id FROM out_of_scope)
    ORDER BY t.date DESC, t.id ASC
  `).all() as LedgerRow[];
}

function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

/**
 * The purchase a refund reverses: same merchant, at or before the refund, within the window, with
 * room left for this much money to come back. The same card before any other, the exact amount
 * before a partial, the most recent before an older one.
 */
function choosePurchase(
  refund: LedgerRow,
  purchases: LedgerRow[],
  remaining: Map<string, number>
): LedgerRow | null {
  const key = refundMerchantKey(refund);
  const eligible = purchases.filter((purchase) => {
    const gap = daysBetween(purchase.date, refund.date);
    return gap >= 0
      && gap <= REFUND_WINDOW_DAYS
      && refundMerchantKey(purchase) === key
      && (remaining.get(purchase.id) ?? 0) >= refund.amount;
  });
  const rank = (purchase: LedgerRow): number =>
    (purchase.account_id === refund.account_id ? 0 : 2) + (-purchase.amount === refund.amount ? 0 : 1);
  const best = eligible.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date))[0];
  if (!best) return null;
  // A refund on another card is only taken for the exact amount: a partial match across accounts
  // is more often a second purchase than a return.
  return best.account_id === refund.account_id || -best.amount === refund.amount ? best : null;
}

function desiredLinks(db: Database.Database): Map<string, LedgerRow> {
  const refunds = refundRows(db);
  const purchases = purchaseRows(db);
  const byId = new Map(purchases.map((purchase) => [purchase.id, purchase]));
  const remaining = new Map(purchases.map((purchase) => [purchase.id, -purchase.amount]));

  for (const refund of refunds) {
    if (refund.refund_link_source !== 'owner' || !refund.refund_of_id) continue;
    remaining.set(refund.refund_of_id, (remaining.get(refund.refund_of_id) ?? 0) - refund.amount);
  }

  const desired = new Map<string, LedgerRow>();
  for (const refund of refunds) {
    if (refund.refund_link_source === 'owner' || refund.refund_link_source === 'rejected') continue;
    const purchase = choosePurchase(refund, purchases, remaining);
    if (!purchase) continue;
    remaining.set(purchase.id, (remaining.get(purchase.id) ?? 0) - refund.amount);
    desired.set(refund.id, byId.get(purchase.id) as LedgerRow);
  }
  return desired;
}

function ownerChoseCategory(row: { manually_categorized: number; category_source: string | null }): boolean {
  return row.manually_categorized === 1 || row.category_source === 'human';
}

function releaseRefund(db: Database.Database, refundId: string, now: string): void {
  const current = db.prepare(`
    SELECT r.category_id, p.category_id AS purchase_category_id
    FROM transactions r LEFT JOIN transactions p ON p.id = r.refund_of_id
    WHERE r.id = ?
  `).get(refundId) as { category_id: string | null; purchase_category_id: string | null };
  const revision = latestRevertableRevision(db, refundId);
  if (revision && revision.to_category_id === current.category_id
      && current.category_id === current.purchase_category_id) {
    revertRevisions(db, [revision], now);
  }
  db.prepare(`
    UPDATE transactions SET refund_of_id = NULL, refund_link_source = NULL, updated_at = ? WHERE id = ?
  `).run(now, refundId);
}

function linkRefund(db: Database.Database, refundId: string, purchase: LedgerRow, now: string): void {
  db.prepare(`
    UPDATE transactions SET refund_of_id = ?, refund_link_source = 'auto', updated_at = ? WHERE id = ?
  `).run(purchase.id, now, refundId);
  inheritCategory(db, refundId, purchase.category_id, now);
}

/** A refund files where its purchase did, unless the owner has said otherwise. */
function inheritCategory(db: Database.Database, refundId: string, categoryId: string | null, now: string): void {
  if (!categoryId) return;
  const refund = db.prepare(
    'SELECT category_id, category_source, manually_categorized FROM transactions WHERE id = ?'
  ).get(refundId) as { category_id: string | null; category_source: string | null; manually_categorized: number };
  if (ownerChoseCategory(refund) || refund.category_id === categoryId) return;
  writeTransactionCategory(db, { transactionId: refundId, categoryId, source: 'heuristic' }, now);
}

/**
 * Link each refund to the purchase it reverses. Automatic links are re-derived every run and the
 * difference applied, so an unchanged ledger writes nothing; the owner's links and refusals stand.
 */
export function refreshRefundLinks(db: Database.Database): RefundLinkResult {
  const desired = desiredLinks(db);
  const now = new Date().toISOString();
  const existing = new Map(
    (db.prepare(
      "SELECT id, refund_of_id FROM transactions WHERE refund_link_source = 'auto'"
    ).all() as Array<{ id: string; refund_of_id: string }>).map((row) => [row.id, row.refund_of_id])
  );

  for (const [refundId, purchaseId] of existing) {
    if (desired.get(refundId)?.id !== purchaseId) releaseRefund(db, refundId, now);
  }
  let newlyLinked = 0;
  for (const [refundId, purchase] of desired) {
    if (existing.get(refundId) === purchase.id) continue;
    linkRefund(db, refundId, purchase, now);
    newlyLinked++;
  }
  return { linked: desired.size, newlyLinked };
}

export type RefundLinkError = 'not_found' | 'not_a_refund' | 'not_a_purchase' | 'exceeds_purchase';

/** The owner links a refund to a purchase by hand, or (purchaseId null) says it reverses nothing. */
export function setRefundLink(
  db: Database.Database,
  refundId: string,
  purchaseId: string | null
): { ok: true } | { ok: false; reason: RefundLinkError } {
  const refund = db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(refundId) as
    | { id: string; amount: number }
    | undefined;
  if (!refund) return { ok: false, reason: 'not_found' };
  if (refund.amount <= 0) return { ok: false, reason: 'not_a_refund' };
  const now = new Date().toISOString();

  if (purchaseId === null) {
    const apply = db.transaction(() => {
      releaseRefund(db, refundId, now);
      db.prepare("UPDATE transactions SET refund_link_source = 'rejected', updated_at = ? WHERE id = ?")
        .run(now, refundId);
    });
    apply();
    return { ok: true };
  }

  const purchase = db.prepare('SELECT id, amount, category_id FROM transactions WHERE id = ?').get(purchaseId) as
    | { id: string; amount: number; category_id: string | null }
    | undefined;
  if (!purchase) return { ok: false, reason: 'not_found' };
  if (purchase.amount >= 0) return { ok: false, reason: 'not_a_purchase' };
  const alreadyBack = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE refund_of_id = ? AND id <> ?
  `).get(purchaseId, refundId) as { total: number }).total;
  if (alreadyBack + refund.amount > -purchase.amount) return { ok: false, reason: 'exceeds_purchase' };

  const apply = db.transaction(() => {
    db.prepare(`
      UPDATE transactions SET refund_of_id = ?, refund_link_source = 'owner', updated_at = ? WHERE id = ?
    `).run(purchaseId, now, refundId);
    inheritCategory(db, refundId, purchase.category_id, now);
  });
  apply();
  return { ok: true };
}
