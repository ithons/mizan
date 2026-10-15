import type Database from 'better-sqlite3';

/** A leg a live sync took in arrives within days of its posted date; a backfill arrives months later. */
export const PROMPT_INGEST_DAYS = 7;
/** How late a slow institution can show its side of a transfer and still be the same transfer. */
export const SLOW_LEG_DAYS = 45;

export interface SnapshotMoment {
  date: string;
  /** When the balances were read. Rows written before migration 070 fall back to created_at. */
  taken_at: string | null;
  created_at: string;
  breakdown: Record<string, number>;
}

export interface InTransit {
  /** Added to the recorded net worth to give the settled one, in cents. */
  total: number;
  /** Added to each account's recorded balance, in the breakdown's own terms (owed, for a card). */
  byAccount: Map<string, number>;
}

interface PairRow {
  out_account: string;
  in_account: string;
  amount: number;
  out_landed: number;
  out_liability: number;
  in_liability: number;
}

function ingestLag(alias: string): string {
  return `(julianday(${alias}.created_at) - julianday(${alias}.date))`;
}

/**
 * Transfers caught between the two balance reads of one snapshot: one institution had moved the
 * money and the other had not. The leg that was in the balance is the one this ledger had already
 * received when the snapshot was taken, since balances and rows arrive in the same payload; the
 * posted date cannot say, because a leg is dated when it posts, not when it is reported. That
 * reasoning only holds for rows a live sync took in, so a leg imported from a file, or received
 * long after its own date, says nothing about what a past balance held.
 */
export function transfersInTransit(db: Database.Database, snapshot: SnapshotMoment): InTransit {
  const takenAt = snapshot.taken_at ?? snapshot.created_at;
  const rows = db.prepare(`
    SELECT o.account_id AS out_account, i.account_id AS in_account, -o.amount AS amount,
           CASE WHEN o.created_at <= @takenAt THEN 1 ELSE 0 END AS out_landed,
           oa.is_liability AS out_liability, ia.is_liability AS in_liability
    FROM transactions o
    JOIN transactions i ON i.transfer_pair_id = o.transfer_pair_id AND i.id <> o.id
    JOIN accounts oa ON oa.id = o.account_id
    JOIN accounts ia ON ia.id = i.account_id
    WHERE o.amount < 0
      AND i.amount > 0
      AND o.transfer_status IN ('candidate', 'confirmed')
      AND o.source_type IN ('simplefin', 'coinbase')
      AND i.source_type IN ('simplefin', 'coinbase')
      AND (o.created_at <= @takenAt) <> (i.created_at <= @takenAt)
      AND CASE WHEN o.created_at <= @takenAt
        THEN o.date <= @date AND ${ingestLag('o')} <= ${PROMPT_INGEST_DAYS} AND ${ingestLag('i')} <= ${SLOW_LEG_DAYS}
        ELSE i.date <= @date AND ${ingestLag('i')} <= ${PROMPT_INGEST_DAYS} AND ${ingestLag('o')} <= ${SLOW_LEG_DAYS}
      END
  `).all({ takenAt, date: snapshot.date }) as PairRow[];

  const byAccount = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    if (!(row.out_account in snapshot.breakdown) || !(row.in_account in snapshot.breakdown)) continue;
    const [account, liability, sign] = row.out_landed
      ? [row.in_account, row.in_liability, 1]
      : [row.out_account, row.out_liability, -1];
    byAccount.set(account, (byAccount.get(account) ?? 0) + (liability ? -sign : sign) * row.amount);
    total += sign * row.amount;
  }
  return { total, byAccount };
}

export function parseBreakdown(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    );
  } catch {
    return {};
  }
}
