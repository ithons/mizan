import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DuplicateCandidateGroup,
  TransferCandidatePair,
} from '../../../shared/types';

interface DuplicateRow {
  id: string;
  account_id: string;
  account_name: string;
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  pending: number;
  source_type: string;
}

interface TransferRow {
  id: string;
  account_id: string;
  account_name: string;
  date: string;
  amount: number;
}

export interface DuplicateDetectionResult {
  groupCount: number;
  transactionCount: number;
}

export interface TransferDetectionResult {
  pairCount: number;
  transactionCount: number;
}

export interface TransactionIntegrityResult {
  duplicates: DuplicateDetectionResult;
  transfers: TransferDetectionResult;
}

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function normalizeMerchant(merchant: string): string {
  return merchant.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function dateToDay(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 86_400_000);
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(',');
}

export function refreshDuplicateCandidates(db: Database.Database): DuplicateDetectionResult {
  db.prepare(`
    UPDATE transactions
    SET duplicate_group_id = NULL,
        duplicate_status = 'none'
    WHERE duplicate_status = 'candidate'
  `).run();

  const rows = db.prepare(`
    SELECT
      t.id,
      t.account_id,
      a.account_name,
      t.date,
      t.amount,
      t.merchant_name,
      t.original_name,
      t.pending,
      t.source_type
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.duplicate_status != 'dismissed'
    ORDER BY t.date DESC, t.created_at DESC
  `).all() as DuplicateRow[];

  const groups = new Map<string, DuplicateRow[]>();

  for (const row of rows) {
    const merchant = normalizeMerchant(row.merchant_name || row.original_name);
    if (!merchant) continue;

    const cents = row.amount; // already integer cents

    // Exact strict match key (original logic)
    const key = [
      row.account_id,
      row.date,
      cents,
      row.pending,
      merchant,
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);


  }

  let groupCount = 0;
  let transactionCount = 0;


  // Process strict groups
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    
    if (group.length < 2) continue;

    const ids = group.map((row) => row.id);
    const groupId = `dup_${shortHash(key)}`;
    db.prepare(`
      UPDATE transactions
      SET duplicate_group_id = ?,
          duplicate_status = 'candidate'
      WHERE id IN (${placeholders(ids)})
    `).run(groupId, ...ids);

    groupCount++;
    transactionCount += ids.length;
  }
  


  return { groupCount, transactionCount };
}

export function getDuplicateCandidateGroups(
  db: Database.Database,
  limit = 20
): DuplicateCandidateGroup[] {
  const rows = db.prepare(`
    SELECT
      t.duplicate_group_id AS group_id,
      COUNT(*) AS count,
      MAX(t.date) AS date,
      MAX(t.amount) AS amount,
      COALESCE(MAX(t.merchant_name), MAX(t.original_name), 'Unknown') AS merchant_name,
      MAX(a.account_name) AS account_name,
      GROUP_CONCAT(t.id) AS transaction_ids
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.duplicate_status = 'candidate'
      AND t.duplicate_group_id IS NOT NULL
    GROUP BY t.duplicate_group_id
    ORDER BY date DESC
    LIMIT ?
  `).all(limit) as Array<Omit<DuplicateCandidateGroup, 'transaction_ids'> & {
    transaction_ids: string;
  }>;

  return rows.map((row) => ({
    ...row,
    transaction_ids: row.transaction_ids.split(',').filter(Boolean),
  }));
}

function transferCandidateRows(db: Database.Database): TransferRow[] {
  return db.prepare(`
    WITH RECURSIVE transfer_categories(id) AS (
      SELECT id FROM categories WHERE id = 'cat_xfer'
      UNION ALL
      SELECT c.id
      FROM categories c
      JOIN transfer_categories parent ON parent.id = c.parent_id
    )
    SELECT
      t.id,
      t.account_id,
      a.account_name,
      t.date,
      t.amount
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.pending = 0
      AND t.transfer_status NOT IN ('dismissed', 'confirmed')
      AND ABS(t.amount) >= 1
      AND (
        t.category_id IS NULL
        OR t.category_id IN (SELECT id FROM transfer_categories)
      )
    ORDER BY t.date DESC, ABS(t.amount) DESC
  `).all() as TransferRow[];
}

export function refreshTransferCandidates(db: Database.Database): TransferDetectionResult {
  db.prepare(`
    UPDATE transactions
    SET transfer_pair_id = NULL,
        transfer_status = 'none',
        category_id = CASE
          WHEN category_id IN ('cat_xfer_in', 'cat_xfer_out') THEN NULL
          ELSE category_id
        END
    WHERE transfer_status = 'candidate'
  `).run();

  const rows = transferCandidateRows(db);
  const byAbsAmount = new Map<number, { inflows: TransferRow[]; outflows: TransferRow[] }>();

  for (const row of rows) {
    const cents = Math.abs(row.amount); // already integer cents
    const bucket = byAbsAmount.get(cents) ?? { inflows: [], outflows: [] };
    if (row.amount > 0) {
      bucket.inflows.push(row);
    } else if (row.amount < 0) {
      bucket.outflows.push(row);
    }
    byAbsAmount.set(cents, bucket);
  }

  const outflowCandidates = new Map<string, TransferRow[]>();
  const inflowCandidates = new Map<string, TransferRow[]>();

  for (const bucket of byAbsAmount.values()) {
    for (const outflow of bucket.outflows) {
      for (const inflow of bucket.inflows) {
        if (outflow.account_id === inflow.account_id) continue;
        if (Math.abs(dateToDay(outflow.date) - dateToDay(inflow.date)) > 3) continue;

        outflowCandidates.set(outflow.id, [
          ...(outflowCandidates.get(outflow.id) ?? []),
          inflow,
        ]);
        inflowCandidates.set(inflow.id, [
          ...(inflowCandidates.get(inflow.id) ?? []),
          outflow,
        ]);
      }
    }
  }

  const now = new Date().toISOString();
  const used = new Set<string>();
  const pairs: Array<{ outflow: TransferRow; inflow: TransferRow; pairId: string }> = [];

  for (const bucket of byAbsAmount.values()) {
    for (const outflow of bucket.outflows) {
      if (used.has(outflow.id)) continue;

      const candidates = outflowCandidates.get(outflow.id) ?? [];
      if (candidates.length !== 1) continue;

      const inflow = candidates[0];
      if (used.has(inflow.id)) continue;
      if ((inflowCandidates.get(inflow.id) ?? []).length !== 1) continue;

      const orderedIds = [outflow.id, inflow.id].sort();
      const pairId = `xfer_${shortHash(orderedIds.join('|'))}`;
      pairs.push({ outflow, inflow, pairId });
      used.add(outflow.id);
      used.add(inflow.id);
    }
  }

  for (const pair of pairs) {
    db.prepare(`
      UPDATE transactions
      SET transfer_pair_id = ?,
          transfer_status = 'candidate',
          category_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(pair.pairId, 'cat_xfer_out', now, pair.outflow.id);

    db.prepare(`
      UPDATE transactions
      SET transfer_pair_id = ?,
          transfer_status = 'candidate',
          category_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(pair.pairId, 'cat_xfer_in', now, pair.inflow.id);
  }

  return {
    pairCount: pairs.length,
    transactionCount: pairs.length * 2,
  };
}

export function getTransferCandidatePairs(
  db: Database.Database,
  limit = 20
): TransferCandidatePair[] {
  const rows = db.prepare(`
    SELECT
      outflow.transfer_pair_id AS pair_id,
      ABS(outflow.amount) AS amount,
      outflow.date AS date,
      from_account.account_name AS from_account_name,
      to_account.account_name AS to_account_name,
      outflow.id AS outflow_transaction_id,
      inflow.id AS inflow_transaction_id
    FROM transactions outflow
    JOIN transactions inflow
      ON inflow.transfer_pair_id = outflow.transfer_pair_id
      AND inflow.amount > 0
    JOIN accounts from_account ON from_account.id = outflow.account_id
    JOIN accounts to_account ON to_account.id = inflow.account_id
    WHERE outflow.transfer_status = 'candidate'
      AND outflow.amount < 0
      AND outflow.transfer_pair_id IS NOT NULL
    ORDER BY outflow.date DESC
    LIMIT ?
  `).all(limit) as TransferCandidatePair[];

  return rows;
}

export function dismissDuplicateGroup(db: Database.Database, groupId: string): number {
  const result = db.prepare(`
    UPDATE transactions
    SET duplicate_status = 'dismissed',
        duplicate_group_id = NULL
    WHERE duplicate_group_id = ?
      AND duplicate_status = 'candidate'
  `).run(groupId);

  return result.changes;
}

export function confirmTransferPair(db: Database.Database, pairId: string): number {
  const result = db.prepare(`
    UPDATE transactions
    SET transfer_status = 'confirmed',
        review_status = 'reviewed',
        updated_at = ?
    WHERE transfer_pair_id = ?
      AND transfer_status = 'candidate'
  `).run(new Date().toISOString(), pairId);

  return result.changes;
}

export function dismissTransferPair(db: Database.Database, pairId: string): number {
  const result = db.prepare(`
    UPDATE transactions
    SET transfer_status = 'dismissed',
        transfer_pair_id = NULL,
        category_id = CASE
          WHEN category_id IN ('cat_xfer_in', 'cat_xfer_out') THEN NULL
          ELSE category_id
        END,
        updated_at = ?
    WHERE transfer_pair_id = ?
      AND transfer_status = 'candidate'
  `).run(new Date().toISOString(), pairId);

  return result.changes;
}

export function refreshTransactionIntegrity(db: Database.Database): TransactionIntegrityResult {
  const refresh = db.transaction(() => {
    const duplicates = refreshDuplicateCandidates(db);
    const transfers = refreshTransferCandidates(db);
    return { duplicates, transfers };
  });

  return refresh();
}
