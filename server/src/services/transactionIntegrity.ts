import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DuplicateCandidateGroup,
  TransferCandidatePair,
} from '../../../shared/types';
import {
  latestRevertableRevision,
  revertRevisions,
  writeTransactionCategory,
} from './categoryWrites';

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
  category_id: string | null;
  merchant_name: string | null;
  original_name: string;
  is_transfer_category: number;
}

/**
 * STANDING AND NEW ARE DIFFERENT NUMBERS, AND ONLY ONE OF THEM IS AN EVENT.
 *
 * `groupCount`/`pairCount` are what detection currently holds: every unresolved candidate, whether
 * it was found this run or eight weeks ago. The sync panel's `detected` row was emitted from those,
 * so an unresolved candidate wrote an identical "3 transfer pair(s) need review" into `sync_changes`
 * every hour, forever, and the only way to stop it was to resolve the candidate. That is the
 * standing finding rule 3 forbids: a run in which nothing happened has to be silent.
 *
 * `newGroupCount`/`newPairCount` count only the groups and pairs this run created, so an unchanged
 * ledger reports zero and the panel says nothing. The standing figures stay on the result because
 * `sync_runs.duplicate_candidates` / `transfer_candidates` are columns about state, not about the
 * run, and the review queue reads them as such.
 *
 * NEWNESS IS DECIDED ON MEMBER IDS, NOT ON THE GROUP KEY.
 *
 * `duplicate_group_id` is `dup_${shortHash(key)}` and the key carries `date`, `amount`, `pending`,
 * the normalized merchant and the normalized `original_name`. Every one of those is a field
 * `upsertSimplefinTransaction` overwrites from the provider, so keying newness off the group id
 * reported a fresh finding for a candidate the owner had already seen every time the provider
 * amended a member. Measured on a `migratedTestDb()` fixture holding one pending duplicate pair:
 * a second run over the unchanged ledger returned newGroupCount 0, `UPDATE transactions SET
 * pending = 0` returned newGroupCount 1 with the id moving dup_bac414ef9eaf8e48 ->
 * dup_9f6f1c4f3f63f44a, and renaming the merchant returned newGroupCount 1 again. The same fixture
 * was silent on none of it. It also missed the opposite case: a third identical row joining an
 * established group left the key untouched, so `newGroupCount` stayed 0 and nothing was reported
 * for a transaction the owner had never been shown.
 *
 * So a run reports what it newly FLAGGED. `newTransactionCount` is the number of rows this run put
 * into `duplicate_status = 'candidate'` that were not already there, and `newGroupCount` is the
 * number of emitted groups holding at least one of them. An amendment that leaves the member set
 * alone is silent whatever it does to the key, and a new copy joining an old group is reported once.
 *
 * The bound, stated rather than implied: a candidate that stops being one and later becomes one
 * again is reported again. A pair posting one leg at a time does exactly that, because the
 * intermediate state has the two rows disagreeing on `pending` and holds no group at all. Both legs
 * posting in one sync, which is the shape a provider batch has, is silent.
 */
export interface DuplicateDetectionResult {
  groupCount: number;
  transactionCount: number;
  /** Groups holding at least one transaction this run newly flagged. */
  newGroupCount: number;
  /** Transactions this run flagged as candidates that were not candidates before it. */
  newTransactionCount: number;
}

export interface TransferDetectionResult {
  pairCount: number;
  transactionCount: number;
  /** Pairs that did not exist before this run. */
  newPairCount: number;
}

export interface TransactionIntegrityResult {
  duplicates: DuplicateDetectionResult;
  transfers: TransferDetectionResult;
}

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// Deliberately minimal, and deliberately NOT the aggressive canonicalizer in recurring.ts.
// This feeds the duplicate-detection key, so it must keep genuinely distinct charges distinct
// ("starbucks 1234" vs "starbucks 5678" stay separate). recurring.ts strips store numbers and
// suffixes on purpose: that's correct for grouping a merchant's recurring charges, but here it
// would merge separate purchases into false duplicates. The two must not be unified.
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
  // Read before the reset below wipes it. These are the rows the owner has already been shown as
  // possible duplicates; anything outside this set that comes back a candidate is what this run
  // found. See the note on DuplicateDetectionResult for why this is member ids and not the group id.
  const knownCandidateIds = new Set(
    (db.prepare(`
      SELECT id
      FROM transactions
      WHERE duplicate_status = 'candidate' AND duplicate_group_id IS NOT NULL
    `).all() as Array<{ id: string }>).map((row) => row.id)
  );

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
    -- Both resolutions are sticky: 'dismissed' (keep both) and 'confirmed' (redundant copy,
    -- excluded from reports). Re-scanning either would resurrect a decision the user already made.
    WHERE t.duplicate_status NOT IN ('dismissed', 'confirmed')
    ORDER BY t.date DESC, t.created_at DESC
  `).all() as DuplicateRow[];

  const groups = new Map<string, DuplicateRow[]>();

  // Two rows are duplicates only on an exact match of account, date, amount, pending flag,
  // normalized merchant AND normalized original name. A looser fuzzy pass used to sit
  // alongside this one and was removed; the empty scaffolding it left behind is gone too.
  //
  // original_name has to be in the key because merchant_name is the coarser field and can be
  // rewritten to something shared: migration 033 set every consolidated Coinbase row's
  // merchant to "Coinbase", which made a $25 POL buy and a $25 SOL buy on one day look
  // identical. The raw description still tells them apart.
  for (const row of rows) {
    const merchant = normalizeMerchant(row.merchant_name || row.original_name);
    if (!merchant) continue;

    const key = [
      row.account_id,
      row.date,
      row.amount, // already integer cents
      row.pending,
      merchant,
      normalizeMerchant(row.original_name),
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  let groupCount = 0;
  let transactionCount = 0;
  let newGroupCount = 0;
  let newTransactionCount = 0;

  for (const [key, group] of groups) {
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
    const freshlyFlagged = ids.filter((id) => !knownCandidateIds.has(id)).length;
    newTransactionCount += freshlyFlagged;
    if (freshlyFlagged > 0) newGroupCount++;
  }

  return { groupCount, transactionCount, newGroupCount, newTransactionCount };
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

// The two categories this detector writes, and the only ones it is allowed to take back.
const TRANSFER_LEG_CATEGORIES = new Set(['cat_xfer_in', 'cat_xfer_out']);

// Money moving between two of the owner's own accounts says so on the row. Amount symmetry on its
// own is a coincidence, and on the live ledger it is a coincidence that happens: a $100.00 charge at
// ARTS STUDIOS on 2026-02-11 matches a $100.00 Fidelity Roth IRA contribution on 2026-02-09 on every
// structural test below (opposite signs, different accounts, inside the 3-day window, exactly one
// candidate each way). Pairing those would move a real entertainment expense out of spending and
// relabel a real retirement contribution as an internal transfer.
//
// So a row whose category the machine already assigned re-enters the pool only if the row's own text
// names a transfer. That is what separates the two cases, and it is what makes the widened
// eligibility below safe: measured on the live ledger, the widening admits 22 more rows and finds
// exactly the same 3 pairs it found before.
const TRANSFER_TEXT =
  /\btransfers?\b|\bautopay\b|\bzelle\b|\bwire\b|\bcontribution\b|automatic payment|online payment|internet payment|payment thank you|credit card payment|bill pay/i;

function looksLikeTransfer(row: TransferRow): boolean {
  return TRANSFER_TEXT.test(`${row.merchant_name ?? ''} ${row.original_name}`);
}

function transferCandidateRows(db: Database.Database): TransferRow[] {
  const rows = db.prepare(`
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
      t.amount,
      t.category_id,
      t.merchant_name,
      t.original_name,
      CASE WHEN t.category_id IN (SELECT id FROM transfer_categories) THEN 1 ELSE 0 END
        AS is_transfer_category
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    -- ELIGIBILITY IS ABOUT THE ROW'S HISTORY, NOT ITS CURRENT CATEGORY.
    -- This clause used to be "category_id IS NULL OR transfer class". Categorization runs on every
    -- sync, so the first pass to assign a row any other category made that row permanently
    -- unpairable: a transfer whose two legs post on different days, with a categorization pass in
    -- between, could never be found. One chance ever instead of one chance per row.
    -- The gate is now the two things a later machine pass cannot rewrite: the owner never made this
    -- choice, and the pair was not already settled. Both resolutions stay sticky for the same reason
    -- duplicates do.
    WHERE t.pending = 0
      AND t.manually_categorized = 0
      AND COALESCE(t.category_source, '') <> 'human'
      AND COALESCE(t.transfer_status, 'none') NOT IN ('dismissed', 'confirmed')
      -- Ignore trivial amounts under 1 dollar. amount is integer cents (migrations
      -- 018/022); the old threshold of 1 silently became "1 cent" after that migration.
      AND ABS(t.amount) >= 100
    ORDER BY t.date DESC, ABS(t.amount) DESC
  `).all() as TransferRow[];

  return rows.filter(
    (row) => row.category_id === null || row.is_transfer_category === 1 || looksLikeTransfer(row)
  );
}

interface CandidateState {
  pairId: string | null;
  categoryId: string | null;
}

interface TransferLeg {
  pairId: string;
  categoryId: string;
}

function existingTransferCandidates(db: Database.Database): Map<string, CandidateState> {
  const rows = db.prepare(`
    SELECT id, transfer_pair_id, category_id
    FROM transactions
    WHERE transfer_status = 'candidate'
  `).all() as Array<{ id: string; transfer_pair_id: string | null; category_id: string | null }>;

  return new Map(rows.map((row) => [row.id, { pairId: row.transfer_pair_id, categoryId: row.category_id }]));
}

/**
 * Hand a row back the category the pairing displaced, then drop it out of the pair.
 *
 * The reset this replaces NULLed the category instead, on every sync, which was survivable only
 * because the old pool held nothing but uncategorized and transfer-class rows. With the pool widened
 * it would destroy a machine-assigned category hourly and hand the row back to the categorizer to
 * re-guess. Restoring needs the displaced value, and the only place that exists is the revision log,
 * which is why the write side goes through `categoryWrites` too.
 */
function releaseTransferLeg(db: Database.Database, transactionId: string, now: string): void {
  const revision = latestRevertableRevision(db, transactionId);
  if (revision && TRANSFER_LEG_CATEGORIES.has(revision.to_category_id ?? '')) {
    revertRevisions(db, [revision], now);
  } else {
    // Either a later pass wrote this row (its decision is newer than ours and stands), or the pair
    // predates the revision log and there is no record of what it displaced. In the second case the
    // old behaviour is the only one available, but it is now logged rather than silent.
    const current = db.prepare('SELECT category_id FROM transactions WHERE id = ?')
      .get(transactionId) as { category_id: string | null } | undefined;
    if (current && TRANSFER_LEG_CATEGORIES.has(current.category_id ?? '')) {
      writeTransactionCategory(
        db,
        { transactionId, categoryId: null, source: null, reviewStatus: 'open' },
        now
      );
    }
  }
}

function claimTransferLeg(
  db: Database.Database,
  transactionId: string,
  pairId: string,
  categoryId: string,
  now: string
): void {
  db.prepare(`
    UPDATE transactions
    SET transfer_pair_id = ?,
        transfer_status = 'candidate',
        updated_at = ?
    WHERE id = ?
  `).run(pairId, now, transactionId);

  writeTransactionCategory(db, { transactionId, categoryId, source: 'heuristic' }, now);
}

export function refreshTransferCandidates(db: Database.Database): TransferDetectionResult {
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

  const desired = new Map<string, TransferLeg>();
  for (const pair of pairs) {
    desired.set(pair.outflow.id, { pairId: pair.pairId, categoryId: 'cat_xfer_out' });
    desired.set(pair.inflow.id, { pairId: pair.pairId, categoryId: 'cat_xfer_in' });
  }

  // Apply the difference rather than tearing every candidate down and rebuilding it. Detection is
  // deterministic, so on an unchanged ledger the difference is empty and this stage writes nothing
  // at all: no revision rows, no updated_at churn, no hourly "modified" entries in the sync panel.
  // The rebuild-every-sync shape is exactly how this codebase produced ~123 phantom modified rows an
  // hour once already.
  const existing = existingTransferCandidates(db);
  const unchanged = (id: string, next: TransferLeg): boolean => {
    const current = existing.get(id);
    return current !== undefined
      && current.pairId === next.pairId
      && current.categoryId === next.categoryId;
  };

  for (const [id] of existing) {
    const next = desired.get(id);
    if (next && unchanged(id, next)) continue;
    releaseTransferLeg(db, id, now);
    db.prepare(`
      UPDATE transactions
      SET transfer_pair_id = NULL,
          transfer_status = 'none',
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  for (const [id, next] of desired) {
    if (unchanged(id, next)) continue;
    claimTransferLeg(db, id, next.pairId, next.categoryId, now);
  }

  // `existing` was read before any of the writes above, so this is the set of pairs that were
  // already standing when this run began. A pair id is a hash of its two transaction ids, so a
  // re-detected pair keeps its id and is correctly not new.
  const knownPairIds = new Set(
    [...existing.values()].map((state) => state.pairId).filter((id): id is string => id !== null)
  );

  return {
    pairCount: pairs.length,
    transactionCount: pairs.length * 2,
    newPairCount: pairs.filter((pair) => !knownPairIds.has(pair.pairId)).length,
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

export type ConfirmDuplicateResult =
  | { ok: true; excluded: number }
  | { ok: false; reason: 'group_not_found' | 'keep_not_in_group' };

/**
 * Resolves a duplicate group as a REAL duplicate: the kept row kepts counting, every other copy is
 * marked `duplicate_status = 'confirmed'`, which reporting excludes from income/expense totals.
 *
 * Marking rather than deleting is deliberate. Provider rows (SimpleFIN/Coinbase) are re-inserted by
 * the next sync (`deleteTransaction` refuses them for exactly this reason), so a delete would
 * silently come back. A flag survives re-sync and is reversible.
 */
export function confirmDuplicateGroup(
  db: Database.Database,
  groupId: string,
  keepTransactionId: string
): ConfirmDuplicateResult {
  const rows = db.prepare(
    "SELECT id FROM transactions WHERE duplicate_group_id = ? AND duplicate_status = 'candidate'"
  ).all(groupId) as Array<{ id: string }>;

  if (rows.length === 0) return { ok: false, reason: 'group_not_found' };
  if (!rows.some((r) => r.id === keepTransactionId)) return { ok: false, reason: 'keep_not_in_group' };

  const now = new Date().toISOString();
  let excluded = 0;
  const apply = db.transaction(() => {
    // The survivor: resolved, still counts.
    db.prepare(`
      UPDATE transactions
      SET duplicate_status = 'dismissed', duplicate_group_id = NULL,
          review_status = 'reviewed', updated_at = ?
      WHERE id = ?
    `).run(now, keepTransactionId);

    // The redundant copies: excluded from reports.
    excluded = db.prepare(`
      UPDATE transactions
      SET duplicate_status = 'confirmed', review_status = 'reviewed', updated_at = ?
      WHERE duplicate_group_id = ? AND duplicate_status = 'candidate' AND id <> ?
    `).run(now, groupId, keepTransactionId).changes;
  });
  apply();

  return { ok: true, excluded };
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

/**
 * "These two are not a transfer": the pair is refused for good, and each row goes back to the
 * category it had before the detector took it. Dropping to NULL instead would spend the owner's
 * correction on erasing a category that was never in question.
 */
export function dismissTransferPair(db: Database.Database, pairId: string): number {
  const now = new Date().toISOString();
  const legs = db.prepare(`
    SELECT id FROM transactions
    WHERE transfer_pair_id = ? AND transfer_status = 'candidate'
  `).all(pairId) as Array<{ id: string }>;
  if (legs.length === 0) return 0;

  const dismiss = db.transaction(() => {
    for (const leg of legs) {
      releaseTransferLeg(db, leg.id, now);
      db.prepare(`
        UPDATE transactions
        SET transfer_status = 'dismissed',
            transfer_pair_id = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, leg.id);
    }
  });
  dismiss();

  return legs.length;
}

export function refreshTransactionIntegrity(db: Database.Database): TransactionIntegrityResult {
  const refresh = db.transaction(() => {
    const duplicates = refreshDuplicateCandidates(db);
    const transfers = refreshTransferCandidates(db);
    return { duplicates, transfers };
  });

  return refresh();
}
