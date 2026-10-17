import type Database from 'better-sqlite3';

/** Whether anything has paid the card after `since`: a paired transfer in, or a row filed as a transfer. */
export function cardPaidSince(db: Database.Database, cardId: string, since: string): boolean {
  return db.prepare(`
    SELECT 1 FROM transactions WHERE account_id = ? AND amount > 0 AND date > ?
      AND (transfer_pair_id IS NOT NULL OR category_id IN (SELECT id FROM categories WHERE id = 'cat_xfer' OR parent_id = 'cat_xfer'))
    LIMIT 1
  `).get(cardId, since) !== undefined;
}

/** A scheduled card payment whose card still owes and that nothing has paid since the last one, or null. */
export function unpaidCardPayment(db: Database.Database, recurringId: string): { card: string; owed: number; lastSeen: string } | null {
  const row = db.prepare(`
    SELECT card.id, card.account_name, card.current_balance, rp.last_seen
    FROM recurring_patterns rp JOIN accounts card ON card.id = rp.counterparty_account_id AND card.is_liability = 1
    WHERE rp.id = ? AND rp.kind = 'transfer' AND card.current_balance > 0
  `).get(recurringId) as { id: string; account_name: string; current_balance: number; last_seen: string } | undefined;
  if (!row || cardPaidSince(db, row.id, row.last_seen)) return null;
  return { card: row.account_name, owed: row.current_balance, lastSeen: row.last_seen };
}
