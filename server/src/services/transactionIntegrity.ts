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
import { refreshRefundLinks, type RefundLinkResult } from './refundLinks';

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
  account_type: string;
  is_liability: number;
  date: string;
  amount: number;
  category_id: string | null;
  category_source: string | null;
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
  /** Pairs waiting on the owner. */
  pairCount: number;
  transactionCount: number;
  /** Pairs waiting on the owner that did not exist before this run. */
  newPairCount: number;
  /**
   * Pairs settled without review: card payments, pairs whose legs both name a transfer, and pairs
   * with one named leg between two accounts the owner has confirmed a transfer between before.
   */
  autoPairCount: number;
  newAutoPairCount: number;
}

export interface TransactionIntegrityResult {
  duplicates: DuplicateDetectionResult;
  transfers: TransferDetectionResult;
  refunds: RefundLinkResult;
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

// The categories this detector writes, and the only ones it is allowed to take back.
const TRANSFER_LEG_CATEGORIES = new Set(['cat_xfer_in', 'cat_xfer_out', 'cat_xfer_cc']);

// Amount symmetry alone is a coincidence that happens on this ledger (a $100.00 ARTS STUDIOS charge
// against a $100.00 Roth contribution two days apart), so a machine-categorized row joins the pool
// only when its own text names a transfer.
const TRANSFER_TEXT =
  /\btransfers?\b|\bautopay\b|\bzelle\b|\bwire\b|\bcontribution\b|automatic payment|online payment|internet payment|payment thank you|credit card payment|bill pay|crcardpmt|\be-?payment\b|directpay|moneyline|online\/mobile recurring|\baccount \*+\d{3,4}\b/i;

export const PAIR_WINDOW_BUSINESS_DAYS = 5;

const FUNDING_TYPES = new Set(['checking', 'savings', 'cash']);

function looksLikeTransfer(row: TransferRow): boolean {
  return TRANSFER_TEXT.test(`${row.merchant_name ?? ''} ${row.original_name}`);
}

// Evidence the detector did not write itself: its own text, or a transfer category someone or
// something other than this detector chose.
function hasIndependentEvidence(row: TransferRow): boolean {
  if (looksLikeTransfer(row)) return true;
  return row.is_transfer_category === 1 && row.category_source !== 'heuristic';
}

// The shape alone would also take a card refund that posts the same hour as an equal checking debit,
// before categorization has seen the refund. Every real payment leg names itself.
function isCardPayment(outflow: TransferRow, inflow: TransferRow): boolean {
  return inflow.is_liability === 1
    && outflow.is_liability === 0
    && FUNDING_TYPES.has(outflow.account_type)
    && (looksLikeTransfer(outflow) || looksLikeTransfer(inflow));
}

/** Weekdays after the earlier date, up to and including the later one. */
export function businessDaysBetween(a: string, b: string): number {
  const [from, to] = a <= b ? [dateToDay(a), dateToDay(b)] : [dateToDay(b), dateToDay(a)];
  let count = 0;
  for (let day = from + 1; day <= to; day++) {
    const weekday = (day + 4) % 7;
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

function transferCandidateRows(db: Database.Database): TransferRow[] {
  const rows = db.prepare(`
    WITH RECURSIVE transfer_categories(id) AS (
      SELECT id FROM categories WHERE id IN ('cat_xfer', 'cat_inv_transfer')
      UNION ALL
      SELECT c.id
      FROM categories c
      JOIN transfer_categories parent ON parent.id = c.parent_id
    )
    SELECT
      t.id,
      t.account_id,
      a.account_name,
      a.type AS account_type,
      a.is_liability,
      t.date,
      t.amount,
      t.category_id,
      t.category_source,
      t.merchant_name,
      t.original_name,
      CASE WHEN t.category_id IN (SELECT id FROM transfer_categories) THEN 1 ELSE 0 END
        AS is_transfer_category
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    -- Eligibility is about the row's history, not its current category: a categorization pass
    -- between two legs posting must not make the second one unpairable. Owner decisions are sticky;
    -- the detector's own auto-confirmations are re-derived every run.
    WHERE t.pending = 0
      AND t.is_internal_trade = 0
      AND t.manually_categorized = 0
      AND COALESCE(t.category_source, '') <> 'human'
      AND (
        COALESCE(t.transfer_status, 'none') IN ('none', 'candidate')
        OR (t.transfer_status = 'confirmed' AND t.transfer_source = 'auto')
      )
      AND ABS(t.amount) >= 100
    ORDER BY t.date DESC, ABS(t.amount) DESC
  `).all() as TransferRow[];

  return rows.filter(
    (row) => row.category_id === null || row.is_transfer_category === 1 || looksLikeTransfer(row)
  );
}

interface PairEdge {
  outflow: TransferRow;
  inflow: TransferRow;
  businessGap: number;
  calendarGap: number;
}

function edgeOrder(a: PairEdge, b: PairEdge): number {
  return a.businessGap - b.businessGap
    || a.calendarGap - b.calendarGap
    || a.outflow.id.localeCompare(b.outflow.id)
    || a.inflow.id.localeCompare(b.inflow.id);
}

function candidateEdges(rows: TransferRow[]): PairEdge[] {
  const byAbsAmount = new Map<number, { inflows: TransferRow[]; outflows: TransferRow[] }>();
  for (const row of rows) {
    const bucket = byAbsAmount.get(Math.abs(row.amount)) ?? { inflows: [], outflows: [] };
    (row.amount > 0 ? bucket.inflows : bucket.outflows).push(row);
    byAbsAmount.set(Math.abs(row.amount), bucket);
  }

  const edges: PairEdge[] = [];
  for (const { inflows, outflows } of byAbsAmount.values()) {
    for (const outflow of outflows) {
      for (const inflow of inflows) {
        if (outflow.account_id === inflow.account_id) continue;
        const businessGap = businessDaysBetween(outflow.date, inflow.date);
        if (businessGap > PAIR_WINDOW_BUSINESS_DAYS) continue;
        edges.push({
          outflow,
          inflow,
          businessGap,
          calendarGap: Math.abs(dateToDay(outflow.date) - dateToDay(inflow.date)),
        });
      }
    }
  }
  return edges.sort(edgeOrder);
}

/** Above this many candidate edges a group is assigned greedily rather than searched. */
const EXACT_GROUP_EDGES = 14;

function edgeGap(edge: PairEdge): number {
  return edge.businessGap * 100 + edge.calendarGap;
}

/** Nearer pairs first; when the nearest agree, the matching that pairs more legs. */
function compareMatchings(a: PairEdge[], b: PairEdge[]): number {
  const gapsA = a.map(edgeGap).sort((x, y) => x - y);
  const gapsB = b.map(edgeGap).sort((x, y) => x - y);
  for (let i = 0; i < Math.min(gapsA.length, gapsB.length); i++) {
    if (gapsA[i] !== gapsB[i]) return gapsA[i] - gapsB[i];
  }
  return gapsB.length - gapsA.length;
}

function moveSignature(matching: PairEdge[]): string {
  return matching
    .map(({ outflow, inflow }) =>
      [outflow.account_id, outflow.date, outflow.original_name, inflow.account_id, inflow.date, inflow.original_name].join('|'))
    .sort()
    .join('\n');
}

function groupsOf(edges: PairEdge[]): PairEdge[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  for (const edge of edges) parent.set(find(edge.outflow.id), find(edge.inflow.id));
  const groups = new Map<string, PairEdge[]>();
  for (const edge of edges) {
    const root = find(edge.outflow.id);
    groups.set(root, [...(groups.get(root) ?? []), edge]);
  }
  return [...groups.values()];
}

function bestMatchings(edges: PairEdge[]): PairEdge[][] {
  let best: PairEdge[][] = [];
  const walk = (i: number, used: Set<string>, picked: PairEdge[]): void => {
    if (i === edges.length) {
      const order = best.length === 0 ? -1 : compareMatchings(picked, best[0]);
      if (order < 0) best = [[...picked]];
      else if (order === 0) best.push([...picked]);
      return;
    }
    const edge = edges[i];
    if (!used.has(edge.outflow.id) && !used.has(edge.inflow.id)) {
      used.add(edge.outflow.id);
      used.add(edge.inflow.id);
      walk(i + 1, used, [...picked, edge]);
      used.delete(edge.outflow.id);
      used.delete(edge.inflow.id);
    }
    walk(i + 1, used, picked);
  };
  walk(0, new Set(), []);
  return best;
}

/**
 * Every best matching in a small group is found. When they all describe the same moves, one is
 * taken; when they disagree, only the pairs every one of them makes are kept.
 */
function assignExactly(edges: PairEdge[]): PairEdge[] {
  const best = bestMatchings(edges);
  if (best.length === 0) return [];
  if (best.every((matching) => moveSignature(matching) === moveSignature(best[0]))) return best[0];
  return best[0].filter((edge) => best.every((matching) => matching.includes(edge)));
}

/** Nearest legs first, and a tie between equally near counterparts leaves every row in it alone. */
function assignGreedily(edges: PairEdge[]): PairEdge[] {
  const settled = new Set<string>();
  const chosen: PairEdge[] = [];
  for (const edge of edges) {
    if (settled.has(edge.outflow.id) || settled.has(edge.inflow.id)) continue;
    const rivals = edges.filter((other) =>
      other !== edge
      && edgeGap(other) === edgeGap(edge)
      && (other.outflow.id === edge.outflow.id || other.inflow.id === edge.inflow.id)
      && !settled.has(other.outflow.id)
      && !settled.has(other.inflow.id)
    );
    for (const tied of [edge, ...rivals]) {
      settled.add(tied.outflow.id);
      settled.add(tied.inflow.id);
    }
    if (rivals.length === 0) chosen.push(edge);
  }
  return chosen;
}

/**
 * Edges that are the strictly nearest choice for both of their legs belong to every best matching,
 * so they are fixed first and the rest is searched with them removed.
 */
function settleMutualNearest(edges: PairEdge[]): { fixed: PairEdge[]; rest: PairEdge[] } {
  const fixed: PairEdge[] = [];
  let rest = edges;
  for (;;) {
    const nearest = new Map<string, { gap: number; count: number }>();
    for (const edge of rest) {
      for (const leg of [edge.outflow.id, edge.inflow.id]) {
        const seen = nearest.get(leg);
        const gap = edgeGap(edge);
        if (!seen || gap < seen.gap) nearest.set(leg, { gap, count: 1 });
        else if (gap === seen.gap) seen.count++;
      }
    }
    const isNearest = (leg: string, gap: number) => {
      const seen = nearest.get(leg);
      return seen !== undefined && seen.gap === gap && seen.count === 1;
    };
    const round = rest.filter((edge) => isNearest(edge.outflow.id, edgeGap(edge)) && isNearest(edge.inflow.id, edgeGap(edge)));
    if (round.length === 0) return { fixed, rest };
    fixed.push(...round);
    const taken = new Set(round.flatMap((edge) => [edge.outflow.id, edge.inflow.id]));
    rest = rest.filter((edge) => !taken.has(edge.outflow.id) && !taken.has(edge.inflow.id));
  }
}

function assignPairs(edges: PairEdge[]): PairEdge[] {
  const { fixed, rest } = settleMutualNearest(edges);
  return [
    ...fixed,
    ...groupsOf(rest).flatMap((group) => (group.length <= EXACT_GROUP_EDGES ? assignExactly(group) : assignGreedily(group))),
  ].sort(edgeOrder);
}

interface TransferLeg {
  pairId: string;
  status: 'candidate' | 'confirmed';
  source: 'auto' | null;
  categoryId: string | null;
}

interface CandidateState {
  pairId: string | null;
  status: string;
  source: string | null;
  categoryId: string | null;
}

function existingTransferLegs(db: Database.Database): Map<string, CandidateState> {
  const rows = db.prepare(`
    SELECT id, transfer_pair_id, transfer_status, transfer_source, category_id
    FROM transactions
    WHERE transfer_status = 'candidate'
       OR (transfer_status = 'confirmed' AND transfer_source = 'auto')
  `).all() as Array<{
    id: string;
    transfer_pair_id: string | null;
    transfer_status: string;
    transfer_source: string | null;
    category_id: string | null;
  }>;

  return new Map(rows.map((row) => [row.id, {
    pairId: row.transfer_pair_id,
    status: row.transfer_status,
    source: row.transfer_source,
    categoryId: row.category_id,
  }]));
}

function legCategory(row: TransferRow, side: 'out' | 'in', cardPayment: boolean): string | null {
  if (row.is_transfer_category === 1) return row.category_id;
  if (cardPayment) return 'cat_xfer_cc';
  return side === 'out' ? 'cat_xfer_out' : 'cat_xfer_in';
}

function accountPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Account pairs the owner has already confirmed a transfer between.
function ownerConfirmedAccountPairs(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT o.account_id AS a, i.account_id AS b
    FROM transactions o
    JOIN transactions i ON i.transfer_pair_id = o.transfer_pair_id AND i.id <> o.id
    WHERE o.transfer_status = 'confirmed' AND o.transfer_source = 'owner'
  `).all() as Array<{ a: string; b: string }>;
  return new Set(rows.map((row) => accountPairKey(row.a, row.b)));
}

function desiredLegs(pairs: PairEdge[], confirmedBefore: Set<string>): Map<string, TransferLeg> {
  const desired = new Map<string, TransferLeg>();
  for (const { outflow, inflow } of pairs) {
    const cardPayment = isCardPayment(outflow, inflow);
    const auto = cardPayment
      || (hasIndependentEvidence(outflow) && hasIndependentEvidence(inflow))
      || ((hasIndependentEvidence(outflow) || hasIndependentEvidence(inflow))
        && confirmedBefore.has(accountPairKey(outflow.account_id, inflow.account_id)));
    const pairId = `xfer_${shortHash([outflow.id, inflow.id].sort().join('|'))}`;
    const shared = {
      pairId,
      status: auto ? 'confirmed' as const : 'candidate' as const,
      source: auto ? 'auto' as const : null,
    };
    desired.set(outflow.id, { ...shared, categoryId: legCategory(outflow, 'out', cardPayment) });
    desired.set(inflow.id, { ...shared, categoryId: legCategory(inflow, 'in', cardPayment) });
  }
  return desired;
}

/**
 * Drop a row out of its pair. The latest category write is undone only when it is a heuristic write
 * of a transfer-leg category, which is what pairing writes; an importer, rule, model or owner
 * category is left as it is.
 */
function releaseTransferLeg(db: Database.Database, transactionId: string, now: string): void {
  const revision = latestRevertableRevision(db, transactionId);
  if (revision && revision.to_source === 'heuristic' && TRANSFER_LEG_CATEGORIES.has(revision.to_category_id ?? '')) {
    revertRevisions(db, [revision], now);
  }
  db.prepare(`
    UPDATE transactions
    SET transfer_pair_id = NULL, transfer_status = 'none', transfer_source = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, transactionId);
}

function claimTransferLeg(db: Database.Database, transactionId: string, leg: TransferLeg, now: string): void {
  db.prepare(`
    UPDATE transactions
    SET transfer_pair_id = ?, transfer_status = ?, transfer_source = ?, updated_at = ?
    WHERE id = ?
  `).run(leg.pairId, leg.status, leg.source, now, transactionId);

  const current = db.prepare('SELECT category_id FROM transactions WHERE id = ?')
    .get(transactionId) as { category_id: string | null };
  if (leg.categoryId !== null && current.category_id !== leg.categoryId) {
    writeTransactionCategory(db, { transactionId, categoryId: leg.categoryId, source: 'heuristic' }, now);
  }
}

const TRANSFER_CLASS_SQL = `(
  category_id IN ('cat_xfer', 'cat_inv_transfer')
  OR category_id IN (SELECT id FROM categories WHERE parent_id = 'cat_xfer')
)`;

/**
 * The owner categorized a leg of an automatic pair by hand, which settles it: kept as a transfer
 * category, the pair becomes theirs; filed anywhere else, that leg is not a transfer.
 */
function settleTouchedAutoPairs(db: Database.Database, now: string): void {
  const touched = db.prepare(`
    SELECT DISTINCT transfer_pair_id AS pair_id,
           MIN(CASE WHEN ${TRANSFER_CLASS_SQL} THEN 1 ELSE 0 END) AS kept_as_transfer
    FROM transactions
    WHERE transfer_status = 'confirmed' AND transfer_source = 'auto'
      AND (manually_categorized = 1 OR category_source = 'human')
    GROUP BY transfer_pair_id
  `).all() as Array<{ pair_id: string; kept_as_transfer: number }>;
  for (const { pair_id: pairId, kept_as_transfer: kept } of touched) {
    if (kept) {
      db.prepare("UPDATE transactions SET transfer_source = 'owner', updated_at = ? WHERE transfer_pair_id = ?")
        .run(now, pairId);
      continue;
    }
    // The decision was about the leg the owner re-filed. Its partner goes back to the pool, where
    // it can still pair with its real counterpart.
    const legs = db.prepare(`
      SELECT id, (manually_categorized = 1 OR category_source = 'human') AS touched
      FROM transactions WHERE transfer_pair_id = ?
    `).all(pairId) as Array<{ id: string; touched: number }>;
    for (const leg of legs) {
      releaseTransferLeg(db, leg.id, now);
      if (leg.touched) {
        db.prepare("UPDATE transactions SET transfer_status = 'dismissed', updated_at = ? WHERE id = ?").run(now, leg.id);
      }
    }
  }
}

export function refreshTransferCandidates(db: Database.Database): TransferDetectionResult {
  settleTouchedAutoPairs(db, new Date().toISOString());
  const pairs = assignPairs(candidateEdges(transferCandidateRows(db)));
  const desired = desiredLegs(pairs, ownerConfirmedAccountPairs(db));
  const now = new Date().toISOString();

  // Apply the difference rather than rebuilding: on an unchanged ledger this stage writes nothing,
  // so it produces no revision rows and no phantom "modified" entries in the sync panel.
  const existing = existingTransferLegs(db);
  const unchanged = (id: string, next: TransferLeg): boolean => {
    const current = existing.get(id);
    return current !== undefined
      && current.pairId === next.pairId
      && current.status === next.status
      && current.source === next.source
      && (next.categoryId === null || current.categoryId === next.categoryId);
  };

  for (const [id] of existing) {
    const next = desired.get(id);
    if (next && unchanged(id, next)) continue;
    releaseTransferLeg(db, id, now);
  }
  for (const [id, next] of desired) {
    if (unchanged(id, next)) continue;
    claimTransferLeg(db, id, next, now);
  }

  const known = new Set(
    [...existing.values()].map((state) => `${state.pairId}|${state.status}`)
  );
  const legs = pairs.map((pair) => desired.get(pair.outflow.id) as TransferLeg);
  const candidates = legs.filter((leg) => leg.status === 'candidate');
  const automatic = legs.filter((leg) => leg.status === 'confirmed');

  return {
    pairCount: candidates.length,
    transactionCount: candidates.length * 2,
    newPairCount: candidates.filter((leg) => !known.has(`${leg.pairId}|candidate`)).length,
    autoPairCount: automatic.length,
    newAutoPairCount: automatic.filter((leg) => !known.has(`${leg.pairId}|confirmed`)).length,
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
        transfer_source = 'owner',
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
    WHERE transfer_pair_id = ?
      AND (transfer_status = 'candidate' OR (transfer_status = 'confirmed' AND transfer_source = 'auto'))
  `).all(pairId) as Array<{ id: string }>;
  if (legs.length === 0) return 0;

  const dismiss = db.transaction(() => {
    for (const leg of legs) {
      releaseTransferLeg(db, leg.id, now);
      db.prepare("UPDATE transactions SET transfer_status = 'dismissed', updated_at = ? WHERE id = ?")
        .run(now, leg.id);
    }
  });
  dismiss();

  return legs.length;
}

export function refreshTransactionIntegrity(db: Database.Database): TransactionIntegrityResult {
  const refresh = db.transaction(() => {
    const duplicates = refreshDuplicateCandidates(db);
    const transfers = refreshTransferCandidates(db);
    // After pairing, so a leg that just became a transfer is never taken for a refund.
    const refunds = refreshRefundLinks(db);
    return { duplicates, transfers, refunds };
  });

  return refresh();
}
