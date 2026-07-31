import type Database from 'better-sqlite3';
import { merchantMatchesRulePattern, merchantNamesClaimedByRule } from './rules';

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
  | 'contradicts_owner_rule'
  | 'rule_exists_with_different_category'
  | 'human_authored';

const ok: GuardResult = { ok: true };

function reject(reason: GuardRejectionReason, detail: string): GuardResult {
  return { ok: false, reason, detail };
}

/**
 * A guard refused the write, so nothing happened and nothing may be recorded as having happened.
 *
 * Thrown rather than returned. A refusal used to travel back inside an opaque `result` blob that no
 * caller read, while the draft was still marked confirmed and an `advisor_actions` row was written
 * anyway: the owner saw an applied action whose Undo reverted nothing. Every caller of
 * `confirmAdvisorDraft` already treats a throw as "this draft did not apply" (the batch reports it
 * per draft, the worker leaves the row open for review), so throwing is what makes the code agree
 * with the rule it already states: an action either has a real blast radius and a real undo, or it
 * is not an action.
 *
 * `status` is read by the error middleware. A refusal is a 409 and not a 500: it is the owner's own
 * data saying no, not a fault, and the message is written to be shown as-is.
 */
export class DraftRefusedError extends Error {
  readonly status = 409;

  constructor(readonly reason: GuardRejectionReason, readonly detail: string) {
    super(`Refused: ${detail}`);
    this.name = 'DraftRefusedError';
  }
}

/** Let a passing guard through; turn a refusal into the one failure shape callers handle. */
export function assertGuardPassed(result: GuardResult): void {
  if (!result.ok) throw new DraftRefusedError(result.reason, result.detail);
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
 * What the ledger already says about a merchant pattern, over every row the pattern matches.
 *
 * Deliberately wider than the rows the rule would actually claim. The question here is what the
 * owner's ledger says about the merchant, not what this particular rule would win: a row another
 * rule holds is still evidence about the merchant, and narrowing to the claimed set would let a
 * proposal contradict settled history simply because some other rule was standing in front of it.
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

/**
 * Whether two patterns can ever fight over the same row: either the two patterns match each other,
 * or some transaction the proposed rule would actually CLAIM is one the owner's rule also matches.
 *
 * The second arm used to ask a wider question, "does any transaction match both patterns", and it
 * was the wrong question by exactly the amount that matters. A rule does not get every row its
 * pattern touches; it gets the rows no higher-precedence rule already holds, and every rule the
 * owner wrote outranks every rule the model writes. So a row the owner's rule matches was never
 * the model's to take, and reading it as a fight reports a fight that cannot happen.
 *
 * Measured over the owner's ledger, across every distinct merchant name proposed against the
 * category holding the plurality of its own already-categorized rows: 1,297 proposals, one per name
 * from `SELECT DISTINCT COALESCE(NULLIF(merchant_name, ''), original_name) FROM transactions`,
 * evaluated against the 224 live rules with `source <> 'ai'`, no other guard applied and nothing
 * excluded. The wide question refuses 20 of them, 2 through the first arm and 18 through this arm
 * alone. Asking what the rule would CLAIM refuses 2, both through the first arm, so those 18 go
 * from refused to allowed. Each of the 18 files a specific merchant descriptor under the category
 * its own rows already sit in, and not one can take the row it was blocked through, because the
 * owner's rule outranks it there. 15 were blocked through a bare short name the matcher attaches to
 * two unrelated patterns (nine `UBER *EATS ...`/`UBER *LIME ...` spellings through `Uber`, two
 * `GRUBHUB*CHIPOTLE ...` through `Chipotle`, `APPLE STORE #R149 BOSTON MA` through `Apple`), and 3
 * through a descriptor naming both parties (`Claude.ai Subscription` reaching the owner's
 * `Anthropic` rule through `CLAUDE.AI SUBSCRIPTION ANTHROPIC.COMCA`). The 2 that stay refused are
 * the first arm's: a transfer line against the owner's `Online payment from CHK 8618`, and a
 * proposal spelled identically to an owner rule pointing somewhere else.
 *
 * The first arm stays wide on purpose, because it is about rows that do not exist yet. An AI rule
 * that contradicts an owner rule is dormant while the owner's rule stands, and would activate
 * silently if the owner ever retired theirs.
 *
 * One match call per arm, not one per direction: `merchantMatchesRulePattern` is symmetric by
 * construction. Its substring clause already tests containment both ways, and equality and the
 * bigram similarity are symmetric relations, so swapping the arguments cannot change the answer.
 * `tests/aiWriteGuards.test.ts` pins the symmetry, since it is the matcher's property that makes
 * one call enough.
 */
function rulesContend(
  pattern: string,
  ownerPattern: string,
  claimedNames: () => string[]
): boolean {
  if (merchantMatchesRulePattern(pattern, ownerPattern)) return true;
  return claimedNames().some((name) => merchantMatchesRulePattern(name, ownerPattern));
}

/**
 * A model-authored rule may not contend with a rule the owner wrote.
 *
 * `checkRuleAgreesWithHistory` is not enough on its own: it reads only `transactions`, so an owner
 * rule for a merchant with no settled history is invisible to it, and it waves that case through.
 * The owner's rule is itself a statement of intent about rows that do not exist yet. `source` is
 * anything but 'ai' here, so a 'suggestion' rule counts as the owner's: it is written only when the
 * owner approves it.
 */
export function checkRuleDoesNotContradictOwnerRule(
  db: Database.Database,
  pattern: string,
  categoryId: string
): GuardResult {
  const proposed = pattern.trim();
  if (!proposed) return ok;

  const ownerRules = db.prepare(
    "SELECT pattern, category_id FROM merchant_rules WHERE retired_at IS NULL AND source <> 'ai'"
  ).all() as Array<{ pattern: string; category_id: string }>;

  // Scanned once and reused across every owner rule. Matching each owner pattern against the whole
  // ledger instead is ~1.2M fuzzy comparisons on the owner's data, seconds inside a write path.
  // 'ai' is not a guess: this guard runs on the model's path only, which is what `source <> 'ai'`
  // above already assumes.
  let claimed: string[] | null = null;
  const claimedNames = (): string[] =>
    (claimed ??= merchantNamesClaimedByRule(db, proposed, categoryId, 'ai'));

  for (const owner of ownerRules) {
    if (owner.category_id === categoryId) continue;
    if (!rulesContend(proposed, owner.pattern, claimedNames)) continue;
    return reject(
      'contradicts_owner_rule',
      `"${proposed}" contends with your own rule "${owner.pattern}", which points at ${owner.category_id}.`
    );
  }

  return ok;
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
