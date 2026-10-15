import type Database from 'better-sqlite3';

/** A transfer whose first leg posted more than this before a snapshot had settled by then. */
export const IN_TRANSIT_LOOKBACK_DAYS = 7;

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

/**
 * Transfers caught between the two balance reads of one snapshot: one institution had moved the
 * money and the other had not. The leg that was in the balance is the one this ledger had already
 * received when the snapshot was taken, since balances and rows arrive in the same payload; the
 * posted date cannot say, because a leg is dated when it posts, not when it is reported.
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
      AND MIN(o.date, i.date) BETWEEN date(@date, '-${IN_TRANSIT_LOOKBACK_DAYS} days') AND @date
      AND (o.created_at <= @takenAt) <> (i.created_at <= @takenAt)
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
