import type Database from 'better-sqlite3';
import { merchantMatchesRulePattern } from './rules';

/**
 * Policy for autonomous (model-authored) writes.
 *
 * The autonomy boundary is by domain, not confidence: a write is autonomous when it is an
 * observation about data that already exists, has an exact mechanical inverse, has a bounded and
 * enumerable blast radius, and does not overwrite a number the owner set. Domain membership is
 * decided by `AUTONOMOUS_DRAFT_KINDS`. This module enforces the other three properties, in code
 * rather than in a prompt, because a bound the model is merely asked to respect is not a bound.
 *
 * These guards apply to the AI path only. A human writing a three-character rule for REI is making
 * a judgement about their own ledger; the model doing it unattended is installing a fuzzy matcher
 * across four years of history that nobody reviewed.
 */

/**
 * Rule matching is substring plus 0.86 fuzzy similarity over every transaction, so a short pattern
 * has an unbounded and unpredictable reach. Five characters is where "SBUX" stops being a
 * coin-flip. Existing shorter rules are untouched; this gates creation on the AI path.
 */
export const AI_MIN_PATTERN_LENGTH = 5;

/**
 * A single autonomous action may relabel at most this many rows. Past it, the action is refused and
 * queued as a draft instead: at that size the owner should see the blast radius before it lands,
 * and no legitimate merchant rule in a personal ledger sweeps more.
 */
export const AI_MAX_ROWS_PER_ACTION = 200;

/**
 * A proposed rule must not contradict the evidence already in the ledger. If 30 of 32 Spotify rows
 * are Streaming and the model proposes Subscriptions, that is the model changing its mind rather
 * than observing something, and changing your mind about settled data is not an autonomous act.
 */
export const AI_RULE_AGREEMENT_THRESHOLD = 0.6;

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: GuardRejectionReason; detail: string };

export type GuardRejectionReason =
  | 'pattern_too_short'
  | 'blast_radius_exceeded'
  | 'contradicts_history'
  | 'rule_exists_with_different_category';

const ok: GuardResult = { ok: true };

function reject(reason: GuardRejectionReason, detail: string): GuardResult {
  return { ok: false, reason, detail };
}

export function checkPatternLength(pattern: string): GuardResult {
  const trimmed = pattern.trim();
  if (trimmed.length >= AI_MIN_PATTERN_LENGTH) return ok;
  return reject(
    'pattern_too_short',
    `"${trimmed}" is ${trimmed.length} characters; an autonomous rule needs at least ${AI_MIN_PATTERN_LENGTH}.`
  );
}

export function checkBlastRadius(rowCount: number): GuardResult {
  if (rowCount <= AI_MAX_ROWS_PER_ACTION) return ok;
  return reject(
    'blast_radius_exceeded',
    `would relabel ${rowCount} transactions; the autonomous limit is ${AI_MAX_ROWS_PER_ACTION}.`
  );
}

export interface MerchantHistory {
  /** Category the majority of already-categorized matching rows sit in. */
  majorityCategoryId: string | null;
  majorityCount: number;
  categorizedTotal: number;
}

/**
 * What the ledger already says about a merchant pattern. Matches with the same substring-plus-fuzzy
 * rule the application itself uses, so the evidence considered here is exactly the set the rule
 * would sweep.
 */
export function merchantHistoryForPattern(
  db: Database.Database,
  pattern: string
): MerchantHistory {
  const rows = db.prepare(`
    SELECT merchant_name, original_name, category_id
    FROM transactions
    WHERE category_id IS NOT NULL
  `).all() as Array<{ merchant_name: string | null; original_name: string; category_id: string }>;

  const counts = new Map<string, number>();
  let categorizedTotal = 0;
  for (const row of rows) {
    if (!merchantMatchesRulePattern(row.merchant_name || row.original_name, pattern)) continue;
    categorizedTotal += 1;
    counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1);
  }

  let majorityCategoryId: string | null = null;
  let majorityCount = 0;
  for (const [categoryId, count] of counts) {
    if (count > majorityCount) {
      majorityCategoryId = categoryId;
      majorityCount = count;
    }
  }

  return { majorityCategoryId, majorityCount, categorizedTotal };
}

export function checkRuleAgreesWithHistory(
  db: Database.Database,
  pattern: string,
  categoryId: string
): GuardResult {
  const history = merchantHistoryForPattern(db, pattern);
  // No settled evidence yet: nothing to contradict, so the rule is an observation about new data.
  if (history.categorizedTotal === 0 || history.majorityCategoryId === null) return ok;
  if (history.majorityCategoryId === categoryId) return ok;

  const share = history.majorityCount / history.categorizedTotal;
  if (share < AI_RULE_AGREEMENT_THRESHOLD) return ok; // genuinely mixed; no settled answer to contradict

  return reject(
    'contradicts_history',
    `${history.majorityCount} of ${history.categorizedTotal} categorized "${pattern}" transactions are already in a different category.`
  );
}

export interface AuthorshipPartition {
  /** Ids the AI may write. */
  writable: string[];
  /** Ids the owner categorized by hand, which the AI must never overwrite. */
  humanAuthored: string[];
  /** Ids that do not exist. */
  missing: string[];
}

/**
 * Split transaction ids by who last decided their category.
 *
 * Two markers, because they were introduced years apart and neither is reliable alone:
 * `manually_categorized` (migration 026) can be cleared wholesale by a bulk re-categorization pass,
 * and `category_source` (migration 041) only exists for rows written since. Honour both, so a
 * hand-made choice survives even when one marker has been wiped.
 */
export function partitionByAuthorship(
  db: Database.Database,
  transactionIds: readonly string[]
): AuthorshipPartition {
  const partition: AuthorshipPartition = { writable: [], humanAuthored: [], missing: [] };
  if (transactionIds.length === 0) return partition;

  const lookup = db.prepare(
    'SELECT id, manually_categorized, category_source FROM transactions WHERE id = ?'
  );

  for (const id of transactionIds) {
    const row = lookup.get(id) as
      | { id: string; manually_categorized: number; category_source: string | null }
      | undefined;
    if (!row) {
      partition.missing.push(id);
    } else if (row.manually_categorized === 1 || row.category_source === 'human') {
      partition.humanAuthored.push(id);
    } else {
      partition.writable.push(id);
    }
  }

  return partition;
}
