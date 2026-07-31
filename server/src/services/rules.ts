import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { compareTwoStrings } from 'string-similarity';
import type {
  MerchantRuleSuggestion,
  MerchantRuleSuggestionPreview,
} from '../../../shared/types';
import { guessCategoryFromText } from './textCategorization';
import { getPreference, setPreference } from './preferences';
import { writeTransactionCategories, type CategoryWrite } from './categoryWrites';

export interface RuleApplicationResult {
  updated: number;
}

/**
 * What set a transaction's category, recorded on the row (migration 041).
 *
 * 'human'     the user chose it, by hand or in a bulk selection
 * 'rule'      a merchant rule matched
 * 'heuristic' the local text classifier guessed it
 * 'ai'        a model-authored draft, carrying the advisor_actions id that applied it
 *
 * The audit trail in Settings answers "what has the AI done". This answers the question the
 * user actually asks while looking at a number: "why is THIS row in THIS category", and it is
 * what makes an AI action reversible.
 */
export type CategorySource = 'human' | 'rule' | 'heuristic' | 'ai';

export interface CategoryProvenance {
  source: CategorySource;
  /** advisor_actions.id, set only for source 'ai'. */
  actionId?: string | null;
}

// Skipped rule suggestions, stored as normalized merchant keys. Kept in app_preferences rather
// than a dedicated table: it's a small, purely-advisory list with no relational needs.
export const DISMISSED_RULE_SUGGESTIONS_KEY = 'dismissed_rule_suggestions';

// Writing a category_id that no longer exists raises "FOREIGN KEY constraint failed", which
// aborts the whole auto-categorization sync stage: a single stale mapping takes down the entire
// pass (observed once in a real sync). Callers resolve the valid ids once and skip unknown ones.
function knownCategoryIds(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT id FROM categories').all() as Array<{ id: string }>).map((row) => row.id)
  );
}

export function getDismissedRuleSuggestions(db: Database.Database): Set<string> {
  const value = getPreference(db, DISMISSED_RULE_SUGGESTIONS_KEY)?.value;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

export function dismissRuleSuggestion(db: Database.Database, pattern: string): void {
  const merchantKey = pattern.trim().toLowerCase();
  if (!merchantKey) return;
  const dismissed = getDismissedRuleSuggestions(db);
  if (dismissed.has(merchantKey)) return;
  dismissed.add(merchantKey);
  setPreference(db, DISMISSED_RULE_SUGGESTIONS_KEY, [...dismissed]);
}

interface MerchantRule {
  id: string;
  pattern: string;
  category_id: string;
  source: MerchantRuleSource;
  created_at: string;
}

interface TransactionRuleCandidate {
  id: string;
  merchant_name: string | null;
  original_name: string;
  category_id: string | null;
}

interface RawMerchantRuleSuggestion {
  merchant_key: string;
  pattern: string;
  category_id: string;
  category_name: string;
  category_color?: string | null;
  category_icon?: string | null;
  categorized_count: number;
  uncategorized_count: number;
  categorized_total: number;
  confidence: number;
}

interface RuleSuggestionPreviewRow {
  id: string;
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  account_name: string | null;
  category_id: string | null;
  category_name: string | null;
}

function transactionMerchantName(row: {
  merchant_name: string | null;
  original_name: string;
}): string {
  return row.merchant_name || row.original_name;
}

function normalizeMerchantMatchValue(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(store|pos|purchase|debit|card|online|payment)\b/g, ' ')
    .replace(/\b\d{2,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether a merchant name falls under a rule pattern: exact, containment either way once the
 * shorter side is 4 characters, or a 0.86 bigram similarity.
 *
 * The containment clause is deliberately two-directional and deliberately loose, and it is loose
 * in a way that has a known cost. Provider noise means one merchant arrives under many spellings
 * (`Spotify P3EFCD4E83 New York NY`, `SPOTIFY 877-778-1161, NY`,
 * `AMAZON.COM AMZN.COM/BILLWA6B9ALP5O0YJ`), and the owner's rules are typed as whole descriptors
 * while SimpleFIN also supplies a cleaned short name, so the reverse direction is what connects
 * `Chipotle` to `CHIPOTLE 1615 CAMBRIDGE MA`. It also connects the bare name `Uber` to any
 * `UBER *EATS` pattern.
 *
 * That looseness was measured over the whole ledger rather than argued about, on the state the
 * defect was found in (236 live rules, before migration 045 retired two of them): 236 patterns
 * against 1,297 distinct merchant names give 738 matching pairs, 113 of them reverse-containment
 * pairs the owner's own settled categories endorse. `Uber` <- `UBER *EATS` scores INSIDE that
 * endorsed distribution on every similarity measure tried, so a threshold tight enough to exclude
 * it also excludes endorsed pairs: 61/113 by character coverage, 58/113 by bigram similarity,
 * 112/113 by added-token count, 59/113 by token count, 19/113 by the shorter side's length. The
 * cheapest formulations were run end to end: dropping the reverse clause loses 51 endorsed pairs
 * and changes 22 merchants' winning rule; requiring two tokens on the shorter side loses 37 and
 * changes 13. Both cost correct matches to buy the one precision win, so neither shipped.
 *
 * What separates the pair is not string similarity, it is precedence: the owner's four
 * `UBER *TRIP ...` rules hold every row named `Uber`, so an eats rule can never take one. That
 * lives in `rulesOutranking`, and it is why this function stayed as it is.
 */
export function merchantMatchesRulePattern(merchantName: string, pattern: string): boolean {
  return normalizedMatch(
    normalizeMerchantMatchValue(merchantName),
    normalizeMerchantMatchValue(pattern)
  );
}

/**
 * The predicate itself, over values `normalizeMerchantMatchValue` has already reduced.
 *
 * Split out so a caller comparing one name against many patterns normalizes each string once
 * instead of once per pair. There is still exactly one definition of what matching means; only the
 * normalization is hoisted. `countTransactionsHeldByRule` is why: normalizing inside the inner loop
 * was a measurable share of a call that took over a second and a half on the owner's ledger.
 */
function normalizedMatch(merchant: string, rule: string): boolean {
  if (!merchant || !rule) return false;
  if (merchant === rule) return true;
  if (rule.length >= 4 && merchant.includes(rule)) return true;
  if (merchant.length >= 4 && rule.includes(merchant)) return true;

  return compareTwoStrings(merchant, rule) >= 0.86;
}

export type MerchantRuleSource = 'human' | 'ai' | 'suggestion';

export type MerchantRuleUpsertStatus =
  /** No rule for this pattern existed; one was created. */
  | 'created'
  /** A rule existed and already pointed at this category. */
  | 'unchanged'
  /** A rule existed pointing elsewhere, and the caller was allowed to move it. */
  | 'recategorized'
  /** A rule existed pointing elsewhere, and the caller was not allowed to move it. */
  | 'conflict'
  /** The pattern was empty. */
  | 'invalid';

export interface MerchantRuleUpsertResult {
  status: MerchantRuleUpsertStatus;
  ruleId: string | null;
  /** The category the rule pointed at before, on 'recategorized' and 'conflict'. */
  fromCategoryId?: string | null;
}

export interface UpsertMerchantRuleOptions {
  source?: MerchantRuleSource;
  actionId?: string | null;
  /**
   * Whether an existing rule may be moved to a different category. Defaults to true for owner-
   * driven writes and FALSE for `source: 'ai'`.
   *
   * That default is the fix for a real incident. The background worker proposes rules without
   * being shown the rules that already exist, so it re-proposed the same merchants every sync and
   * this function silently UPDATEd `category_id` in place. On 2026-07-29 the Spotify rule moved to
   * Streaming at 18:04 and to Subscriptions at 20:04, relabelling every matching row twice in two
   * hours with nothing in the UI reporting a change. A model changing its mind about settled data
   * is not an observation, so it no longer happens unattended: the caller gets 'conflict' back and
   * decides what to surface.
   */
  allowRecategorize?: boolean;
}

/**
 * Create or update a merchant rule, recording every change in `merchant_rule_revisions`.
 *
 * Case-insensitive matching on the pattern is now also a partial unique index (migration 042), so
 * the dedup rule is enforced by the engine rather than only by this function.
 */
export function upsertMerchantRule(
  db: Database.Database,
  pattern: string | null | undefined,
  categoryId: string,
  createdAt: string,
  options: UpsertMerchantRuleOptions = {}
): MerchantRuleUpsertResult {
  const normalizedPattern = pattern?.trim();
  if (!normalizedPattern) return { status: 'invalid', ruleId: null };

  const source = options.source ?? 'human';
  const allowRecategorize = options.allowRecategorize ?? source !== 'ai';
  const actionId = options.actionId ?? null;

  const recordRevision = (
    ruleId: string,
    fromCategoryId: string | null,
    toCategoryId: string | null,
    operation: 'create' | 'recategorize' | 'rename' | 'retire'
  ): void => {
    db.prepare(`
      INSERT INTO merchant_rule_revisions
        (id, rule_id, pattern, from_category_id, to_category_id, source, action_id, operation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), ruleId, normalizedPattern, fromCategoryId, toCategoryId, source, actionId, operation, createdAt);
  };

  const existingRule = db.prepare(
    'SELECT id, pattern, category_id FROM merchant_rules WHERE lower(pattern) = lower(?) AND retired_at IS NULL LIMIT 1'
  ).get(normalizedPattern) as { id: string; pattern: string; category_id: string } | undefined;

  if (existingRule) {
    if (existingRule.category_id === categoryId) {
      // Still record a rename, so "Spotify" replacing "spotify" is visible in the history.
      if (existingRule.pattern !== normalizedPattern) {
        db.prepare('UPDATE merchant_rules SET pattern = ?, updated_at = ? WHERE id = ?')
          .run(normalizedPattern, createdAt, existingRule.id);
        recordRevision(existingRule.id, categoryId, categoryId, 'rename');
      }
      return { status: 'unchanged', ruleId: existingRule.id };
    }

    if (!allowRecategorize) {
      return {
        status: 'conflict',
        ruleId: existingRule.id,
        fromCategoryId: existingRule.category_id,
      };
    }

    db.prepare(
      'UPDATE merchant_rules SET pattern = ?, category_id = ?, source = ?, action_id = ?, updated_at = ? WHERE id = ?'
    ).run(normalizedPattern, categoryId, source, actionId, createdAt, existingRule.id);
    recordRevision(existingRule.id, existingRule.category_id, categoryId, 'recategorize');
    return {
      status: 'recategorized',
      ruleId: existingRule.id,
      fromCategoryId: existingRule.category_id,
    };
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO merchant_rules (id, pattern, category_id, created_at, source, action_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, normalizedPattern, categoryId, createdAt, source, actionId, createdAt);
  recordRevision(id, null, categoryId, 'create');
  return { status: 'created', ruleId: id };
}

/**
 * Retire a rule without deleting it, so its revision history keeps meaning something and the
 * partial unique index frees the pattern for a replacement.
 */
export function retireMerchantRule(
  db: Database.Database,
  ruleId: string,
  options: { source?: MerchantRuleSource; actionId?: string | null; now?: string } = {}
): boolean {
  const now = options.now ?? new Date().toISOString();
  const rule = db.prepare(
    'SELECT id, pattern, category_id FROM merchant_rules WHERE id = ? AND retired_at IS NULL'
  ).get(ruleId) as { id: string; pattern: string; category_id: string } | undefined;
  if (!rule) return false;

  db.prepare('UPDATE merchant_rules SET retired_at = ?, updated_at = ? WHERE id = ?').run(now, now, ruleId);
  db.prepare(`
    INSERT INTO merchant_rule_revisions
      (id, rule_id, pattern, from_category_id, to_category_id, source, action_id, operation, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, 'retire', ?)
  `).run(uuidv4(), ruleId, rule.pattern, rule.category_id, options.source ?? 'human', options.actionId ?? null, now);
  return true;
}

/**
 * Un-retire a rule, and record that too.
 *
 * Returns why it could not, rather than a bare false, because both failures mean different things
 * to a caller putting an action back. `pattern_taken` is the real one: the partial unique index
 * `idx_merchant_rules_pattern_live` allows one live rule per pattern, so a replacement written
 * after the retirement blocks the restore. Reviving it would be a second, unasked change to
 * whichever rule the owner has now.
 */
export type UnretireMerchantRuleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_retired' | 'pattern_taken' };

export function unretireMerchantRule(
  db: Database.Database,
  ruleId: string,
  options: { source?: MerchantRuleSource; actionId?: string | null; now?: string } = {}
): UnretireMerchantRuleResult {
  const now = options.now ?? new Date().toISOString();
  const rule = db.prepare(
    'SELECT id, pattern, category_id, retired_at FROM merchant_rules WHERE id = ?'
  ).get(ruleId) as { id: string; pattern: string; category_id: string; retired_at: string | null } | undefined;
  if (!rule) return { ok: false, reason: 'not_found' };
  if (rule.retired_at === null) return { ok: false, reason: 'not_retired' };

  const live = db.prepare(
    'SELECT id FROM merchant_rules WHERE lower(pattern) = lower(?) AND retired_at IS NULL LIMIT 1'
  ).get(rule.pattern) as { id: string } | undefined;
  if (live) return { ok: false, reason: 'pattern_taken' };

  db.prepare('UPDATE merchant_rules SET retired_at = NULL, updated_at = ? WHERE id = ?').run(now, ruleId);
  db.prepare(`
    INSERT INTO merchant_rule_revisions
      (id, rule_id, pattern, from_category_id, to_category_id, source, action_id, operation, created_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, 'unretire', ?)
  `).run(uuidv4(), ruleId, rule.pattern, rule.category_id, options.source ?? 'human', options.actionId ?? null, now);
  return { ok: true };
}

/**
 * How many transactions this rule currently WINS, under the same resolution order the apply path
 * uses.
 *
 * Not "how many rows its pattern matches". A rule holds the rows no higher-precedence rule already
 * matched, and every rule the owner wrote outranks every rule the model wrote, so an AI rule's
 * pattern can touch dozens of rows while the rule itself holds none.
 *
 * WHAT A ZERO HERE DOES AND DOES NOT ESTABLISH. It is what `retire_merchant_rule` rests on, and it
 * carries exactly one claim: no row in the ledger resolves to this rule today, so retiring it
 * changes no category now. It says nothing about later, and the sentence here used to. A
 * transaction that arrives afterwards spelled so that ONLY the retired rule would have matched it
 * was never claimed by anything else, so it lands uncategorized or on the text heuristic instead.
 * `DRAFT_KIND_AUTONOMY` says the same and bounds that reach the way `create_merchant_rule`'s reach
 * into rows that do not exist yet is bounded: the rule stays visible and restorable in Settings, and
 * every change to it is a revision row.
 *
 * Returns null when no live rule carries the id, so a caller can tell "holds nothing" apart from
 * "there is nothing there".
 *
 * COST, and why the shape is what it is. This runs inside the write transaction of the single
 * process that also serves the UI, once per retirement a pass applies, so a slow answer blocks the
 * event loop. Asking each transaction which rule wins it was O(transactions x rules) with a fuzzy
 * comparison per pair: measured 2026-07-31 over a copy of .mizan/mizan.db with the pending
 * migrations applied through 052 (2,579 transactions, 234 live rules), one call cost 1630.2 /
 * 1675.3 / 1656.3 ms, so a pass proposing three retirements held the loop for about five seconds.
 *
 * Two facts make the SAME answer cheap, and neither of them approximates it. A name the target's
 * own pattern does not match cannot be won by the target, so one match call per DISTINCT name
 * settles all but a handful of them (1,297 distinct names against 2,579 rows); and the rules that
 * can beat the target are exactly the ones ahead of it in the resolved order, so each survivor is
 * checked against that prefix and nothing else. The same call now costs 7.7 / 8.1 / 7.8 ms, and
 * putting all ten of the ledger's live AI rules through `checkRuleIsRetirableByAi` costs 75.3 /
 * 70.1 / 71.3 ms. The slowest single live rule is the owner's `Amazon` at 138.9 ms, which no
 * retirement guard reaches: a short pattern matches many names, and each survivor pays for the
 * prefix. `tests/aiWriteGuards.test.ts` pins the count against the definition this replaces, on a
 * ledger built so the two could disagree.
 */
export function countTransactionsHeldByRule(db: Database.Database, ruleId: string): number | null {
  const ordered = loadOrderedMerchantRules(db);
  const rank = ordered.findIndex((rule) => rule.id === ruleId);
  if (rank === -1) return null;

  const target = normalizeMerchantMatchValue(ordered[rank].pattern);
  const outranking = ordered.slice(0, rank).map((rule) => normalizeMerchantMatchValue(rule.pattern));

  // Grouped rather than row by row: matching depends only on the normalized name, so two rows
  // spelled the same always resolve to the same rule and their counts can be added.
  const names = db.prepare(`
    SELECT COALESCE(NULLIF(merchant_name, ''), original_name) AS name, COUNT(*) AS rows_named
    FROM transactions
    GROUP BY name
  `).all() as Array<{ name: string | null; rows_named: number }>;

  let held = 0;
  for (const row of names) {
    const merchant = normalizeMerchantMatchValue(row.name);
    if (!normalizedMatch(merchant, target)) continue;
    if (outranking.some((pattern) => normalizedMatch(merchant, pattern))) continue;
    held += row.rows_named;
  }
  return held;
}

/** Where a rule sorts against another one. `id` is null for a pattern with no live rule yet. */
interface RulePrecedence {
  source: MerchantRuleSource;
  patternLength: number;
  createdAt: string;
  id: string | null;
}

function precedenceOf(rule: MerchantRule): RulePrecedence {
  return {
    source: rule.source,
    patternLength: rule.pattern.length,
    createdAt: rule.created_at,
    id: rule.id,
  };
}

/**
 * The resolution order, and the only place it is written down. Negative when `a` resolves first.
 *
 * It used to be `created_at DESC` alone, which decided nothing: 236 live rules share 41 distinct
 * timestamps, so ties fell to SQLite's sorter. That is how an AI rule for "Spotify" ->
 * Subscriptions came to outrank the owner's "SPOTIFY 877-778-1161, NY" -> Streaming on all 32
 * matching rows. Owner intent outranks a model's, the more specific pattern outranks the vaguer
 * one, and the id makes the order total so the sorter never decides. 'suggestion' ranks with
 * 'human': it is written only by approveMerchantRuleSuggestions, which is the owner accepting the
 * suggestion.
 *
 * Pattern length re-ranks the owner's rules against EACH OTHER too, not only against the model's,
 * and that is the intended policy rather than a side effect of aiming at the AI case: an overlap
 * between two owner rules used to go to whichever was written last and now goes to whichever says
 * more about the row. "SPOTIFY 877-778-1161, NY" is a claim about one merchant at one number;
 * "Spotify" is a claim about anything spelled like Spotify, and the narrower claim should win no
 * matter which was typed first. Pinned by tests/aiWriteGuards.test.ts.
 */
function compareRulePrecedence(a: RulePrecedence, b: RulePrecedence): number {
  const authorRank = (rule: RulePrecedence): number => (rule.source === 'ai' ? 1 : 0);
  if (authorRank(a) !== authorRank(b)) return authorRank(a) - authorRank(b);
  if (a.patternLength !== b.patternLength) return b.patternLength - a.patternLength;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  // A proposal with no stored row has no id to sort on, so it loses the tie. Withholding a row it
  // might have won only under-reports; taking one it loses is the write the next whole-ledger pass
  // silently reverts.
  if (a.id === null) return 1;
  if (b.id === null) return -1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Every live rule in the order the application resolves them: the first match wins.
 *
 * Sorted in this process rather than by an ORDER BY, so the whole-ledger pass and the single-rule
 * paths read the order out of `compareRulePrecedence` instead of each restating it. They did not,
 * and the two disagreed about what the same rule does: see `rulesOutranking`.
 */
function loadOrderedMerchantRules(db: Database.Database): MerchantRule[] {
  const rules = db.prepare(`
    SELECT id, pattern, category_id, source, created_at
    FROM merchant_rules
    WHERE retired_at IS NULL
  `).all() as MerchantRule[];
  return rules.sort((a, b) => compareRulePrecedence(precedenceOf(a), precedenceOf(b)));
}

/**
 * The rules that beat one pattern under the resolution order above.
 *
 * A rule never applies alone. `applyMerchantRulesToExistingTransactions` walks the ordered list
 * and takes the first match, so a row already spoken for by a higher-precedence rule is not this
 * rule's to relabel. The single-rule paths ignored that and asked only "does the pattern match",
 * which made them disagree with the whole-ledger path about the same rule on the same data.
 *
 * Measured on the owner's ledger: with `UBER *EATS` -> food delivery installed,
 * `applyMerchantRulesToExistingTransactions` leaves the 13 rows named "Uber" in
 * cat_transport_ride, because four owner rules for `UBER *TRIP ...` outrank it. The single-rule
 * path relabelled all 13 as food delivery, and `countMerchantRuleImpact` reported 13 as the blast
 * radius the owner would be shown. The matcher's reverse-containment clause is what sweeps the
 * bare name "Uber" into an eats pattern, and no threshold on it separates that pair from the
 * correct ones (see the note on `merchantMatchesRulePattern`); precedence separates them without
 * touching the matcher at all.
 *
 * A stored rule for the same pattern IS this rule, mid-upsert, so it never outranks itself.
 * Everything else is one `compareRulePrecedence` call, over the rank `resolveProposalPrecedence`
 * gives the proposal. This used to stop after the first two keys and read an equal-length rule as
 * beaten, on the reasoning that a rule being written now is the newest one there is.
 * `upsertMerchantRule` never bumps `created_at`, so a re-applied rule is not the newest, and two
 * owner rules of equal pattern length resolved differently depending on which path asked: the
 * whole-ledger pass took the newer one, the single-rule apply took whichever it was handed, and
 * the next re-check reverted the difference. `merchant_rules` is dense in exactly those ties (236
 * live rules over 41 distinct timestamps, 173 of them sharing one: `SELECT created_at, COUNT(*)
 * FROM merchant_rules WHERE retired_at IS NULL GROUP BY created_at ORDER BY 2 DESC`).
 */
function rulesOutranking(
  ordered: MerchantRule[],
  pattern: string,
  proposal: RulePrecedence
): MerchantRule[] {
  const key = pattern.trim().toLowerCase();
  return ordered.filter((rule) => {
    if (rule.pattern.trim().toLowerCase() === key) return false;
    return compareRulePrecedence(precedenceOf(rule), proposal) < 0;
  });
}

/** The rule that already holds this transaction, if one outranks the pattern being applied. */
function higherPrecedenceHolder(
  outranking: MerchantRule[],
  merchantName: string
): MerchantRule | undefined {
  return outranking.find((rule) => merchantMatchesRulePattern(merchantName, rule.pattern));
}

/**
 * Where a pattern sorts, for the single-rule paths: the rank the rule will hold once written.
 *
 * The timestamp and the id come from the stored row and are not the caller's to supply.
 * `upsertMerchantRule` rewrites neither on an existing rule (it touches `updated_at` only), so a
 * rule being re-applied keeps the instant and the id it was created with. Only a pattern with
 * nothing stored yet (the blast-radius pre-check, which runs before any write) is ranked as new.
 *
 * `source` is the caller's, because it names the write path rather than the row: it decides which
 * side of the human/ai split the write lands on, and the AI path has to be judged as the model
 * whether or not the owner happens to hold the same pattern. It falls back to the stored row, then
 * to `upsertMerchantRule`'s own default.
 */
function resolveProposalPrecedence(
  db: Database.Database,
  pattern: string,
  declared: MerchantRuleSource | undefined
): RulePrecedence {
  const trimmed = pattern.trim();
  const stored = db.prepare(
    'SELECT id, source, created_at FROM merchant_rules WHERE lower(pattern) = lower(?) AND retired_at IS NULL LIMIT 1'
  ).get(trimmed) as { id: string; source: MerchantRuleSource; created_at: string } | undefined;

  return {
    source: declared ?? stored?.source ?? 'human',
    patternLength: trimmed.length,
    createdAt: stored?.created_at ?? new Date().toISOString(),
    id: stored?.id ?? null,
  };
}

/**
 * The distinct merchant names a rule would actually claim: the ones it matches and that no
 * higher-precedence rule has already filed somewhere else.
 *
 * This is a rule's real reach, and it is narrower than the set its pattern matches.
 */
export function merchantNamesClaimedByRule(
  db: Database.Database,
  pattern: string,
  categoryId: string,
  source?: MerchantRuleSource
): string[] {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return [];

  const outranking = rulesOutranking(
    loadOrderedMerchantRules(db),
    normalizedPattern,
    resolveProposalPrecedence(db, normalizedPattern, source)
  );
  const names = db.prepare(
    "SELECT DISTINCT COALESCE(NULLIF(merchant_name, ''), original_name) AS name FROM transactions"
  ).all() as Array<{ name: string }>;

  return names
    .map((row) => row.name)
    .filter((name) => merchantMatchesRulePattern(name, normalizedPattern))
    .filter((name) => {
      const holder = higherPrecedenceHolder(outranking, name);
      return holder === undefined || holder.category_id === categoryId;
    });
}

export function applyMerchantRulesToExistingTransactions(
  db: Database.Database,
  options: { onlyUncategorized?: boolean; skipManual?: boolean; provenance?: CategoryProvenance } = {}
): RuleApplicationResult {
  const onlyUncategorized = options.onlyUncategorized ?? true;
  const rules = loadOrderedMerchantRules(db);

  if (rules.length === 0) return { updated: 0 };

  const clauses: string[] = [];
  if (onlyUncategorized) clauses.push('category_id IS NULL');
  // Two markers for the same thing, because they were introduced years apart and neither is
  // reliable alone. manually_categorized (026) is the older flag and a bulk re-categorization
  // pass can clear it wholesale; category_source (041) records provenance per write. On the
  // owner's ledger 62 rows carry both. Honor both, so a hand-made choice survives a full re-check
  // even if one marker has been wiped.
  if (options.skipManual) clauses.push("manually_categorized = 0 AND COALESCE(category_source, '') <> 'human'");
  const conditions = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const transactions = db.prepare(`
    SELECT id, merchant_name, original_name, category_id
    FROM transactions
    ${conditions}
  `).all() as Array<{
    id: string;
    merchant_name: string | null;
    original_name: string;
    category_id: string | null;
  }>;

  const now = new Date().toISOString();
  // A rule application driven by an AI draft inherits that draft's provenance, so undoing the
  // action reverts the rows the rule swept in as well as the one it was proposed for.
  const provenance = options.provenance ?? { source: 'rule' as const };

  // A rule can outlive its category (categories have been folded/renamed by migrations), and
  // writing a dangling id fails the FK and aborts the whole stage. Skip those rules instead.
  const known = knownCategoryIds(db);
  const staleRulePatterns = new Set<string>();
  const writes: CategoryWrite[] = [];

  for (const transaction of transactions) {
    const merchantName = transactionMerchantName(transaction);
    const rule = rules.find((candidate) =>
      merchantMatchesRulePattern(merchantName, candidate.pattern)
    );

    if (!rule || rule.category_id === transaction.category_id) continue;
    if (!known.has(rule.category_id)) {
      staleRulePatterns.add(rule.pattern);
      continue;
    }
    writes.push({
      transactionId: transaction.id,
      categoryId: rule.category_id,
      source: provenance.source,
      actionId: provenance.actionId ?? null,
      reviewStatus: 'reviewed',
    });
  }

  if (staleRulePatterns.size > 0) {
    console.warn(
      `[rules] Skipped rule(s) pointing at a deleted category: ${[...staleRulePatterns].join(', ')}`
    );
  }

  return { updated: writeTransactionCategories(db, writes, now) };
}

// Runs after every sync (and once as a startup backlog pass) so providers that don't supply
// their own category (SimpleFIN, Coinbase) don't leave transactions permanently uncategorized.
// User merchant rules take precedence; the text heuristic is only a fallback for whatever
// rules don't cover. Only ever touches category_id IS NULL rows, so manual categorizations
// (and prior rule/heuristic hits) are never overwritten.
export function autoCategorizeTransactions(db: Database.Database): RuleApplicationResult {
  const ruleResult = applyMerchantRulesToExistingTransactions(db, { onlyUncategorized: true });

  const remaining = db.prepare(`
    SELECT id, merchant_name, original_name
    FROM transactions
    WHERE category_id IS NULL
  `).all() as Array<{ id: string; merchant_name: string | null; original_name: string }>;

  const now = new Date().toISOString();
  const known = knownCategoryIds(db);
  const writes: CategoryWrite[] = [];
  for (const transaction of remaining) {
    const categoryId = guessCategoryFromText(transaction.merchant_name, transaction.original_name);
    if (!categoryId) continue;
    if (!known.has(categoryId)) continue;
    writes.push({ transactionId: transaction.id, categoryId, source: 'heuristic' });
  }

  return { updated: ruleResult.updated + writeTransactionCategories(db, writes, now) };
}

// Full "re-check all transactions" pass: re-applies every merchant rule and then the
// text heuristic across the whole ledger, but never touches rows the user categorized by
// hand (manually_categorized = 1). Rule/heuristic categorizations can change; deliberate
// manual choices are preserved.
export function recategorizeAll(db: Database.Database): RuleApplicationResult {
  const ruleResult = applyMerchantRulesToExistingTransactions(db, {
    onlyUncategorized: false,
    skipManual: true,
  });

  const remaining = db.prepare(`
    SELECT id, merchant_name, original_name
    FROM transactions
    WHERE category_id IS NULL AND manually_categorized = 0
      AND COALESCE(category_source, '') <> 'human'
  `).all() as Array<{ id: string; merchant_name: string | null; original_name: string }>;

  const now = new Date().toISOString();
  const known = knownCategoryIds(db);
  const writes: CategoryWrite[] = [];
  for (const transaction of remaining) {
    const categoryId = guessCategoryFromText(transaction.merchant_name, transaction.original_name);
    if (!categoryId) continue;
    if (!known.has(categoryId)) continue;
    writes.push({ transactionId: transaction.id, categoryId, source: 'heuristic' });
  }

  return { updated: ruleResult.updated + writeTransactionCategories(db, writes, now) };
}

/**
 * How many rows a rule would actually relabel, computed with the same matcher, the same
 * exclusions and the same precedence as the apply path. Exists so the blast-radius guard can run
 * BEFORE the write rather than reporting the damage afterwards.
 *
 * "Actually" is load-bearing and used not to be. This counted every row the pattern matched, so
 * for `UBER *EATS` -> food delivery it reported 13 rows the rule could never take, all of them
 * ride charges held by the owner's own `UBER *TRIP ...` rules. The number a guard refuses on, and
 * the number the owner is shown, has to be the number of rows that would change.
 *
 * Running before the write is also what makes `ruleSource` the caller's job: with no rule stored
 * for the pattern yet there is nothing to read the author off, and a proposal counted as the
 * owner's is counted against a shorter outranking set than the one the AI write then resolves
 * against. That gap put a number in front of the owner that the write disagreed with, in the one
 * place the owner reads it: `checkBlastRadius` refuses with "would relabel N transactions".
 */
export function countMerchantRuleImpact(
  db: Database.Database,
  pattern: string,
  categoryId: string,
  options: { overwrite?: boolean; ruleSource?: MerchantRuleSource } = {}
): number {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return 0;

  const scanWhere = options.overwrite
    ? "WHERE manually_categorized = 0 AND COALESCE(category_source, '') <> 'human'"
    : 'WHERE category_id IS NULL';

  const transactions = db.prepare(`
    SELECT id, merchant_name, original_name, category_id
    FROM transactions
    ${scanWhere}
  `).all() as TransactionRuleCandidate[];

  const outranking = rulesOutranking(
    loadOrderedMerchantRules(db),
    normalizedPattern,
    resolveProposalPrecedence(db, normalizedPattern, options.ruleSource)
  );

  let count = 0;
  for (const transaction of transactions) {
    const merchantName = transactionMerchantName(transaction);
    if (!merchantMatchesRulePattern(merchantName, normalizedPattern)) continue;
    if (transaction.category_id === categoryId) continue;
    const holder = higherPrecedenceHolder(outranking, merchantName);
    if (holder && holder.category_id !== categoryId) continue;
    count += 1;
  }
  return count;
}

export function applyMerchantRuleToMatchingTransactions(
  db: Database.Database,
  pattern: string,
  categoryId: string,
  now = new Date().toISOString(),
  options: { overwrite?: boolean; provenance?: CategoryProvenance; ruleSource?: MerchantRuleSource } = {}
): RuleApplicationResult {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return { updated: 0 };

  // Default: fill only uncategorized rows. overwrite: also re-label rows already in a
  // different category, but never ones the user categorized by hand. `category_source = 'human'`
  // is checked alongside `manually_categorized` because a bulk re-categorization pass can clear
  // the older flag wholesale, and a hand-made choice has to survive that.
  const scanWhere = options.overwrite
    ? "WHERE manually_categorized = 0 AND COALESCE(category_source, '') <> 'human'"
    : 'WHERE category_id IS NULL';

  const transactions = db.prepare(`
    SELECT id, merchant_name, original_name, category_id
    FROM transactions
    ${scanWhere}
  `).all() as TransactionRuleCandidate[];

  // Same order the whole-ledger pass resolves by, so applying one rule and re-checking every rule
  // cannot reach different answers about the same row. Writing a row a higher-precedence rule
  // holds is a write the next "Re-check all transactions" silently reverts, which is the
  // self-reverting-repair trap this codebase has been bitten by before.
  const outranking = rulesOutranking(
    loadOrderedMerchantRules(db),
    normalizedPattern,
    resolveProposalPrecedence(db, normalizedPattern, options.ruleSource)
  );

  const provenance = options.provenance ?? { source: 'rule' as const };
  const writes: CategoryWrite[] = [];
  for (const transaction of transactions) {
    const merchantName = transactionMerchantName(transaction);
    if (!merchantMatchesRulePattern(merchantName, normalizedPattern)) continue;
    if (transaction.category_id === categoryId) continue; // already correct
    const holder = higherPrecedenceHolder(outranking, merchantName);
    if (holder && holder.category_id !== categoryId) continue;
    writes.push({
      transactionId: transaction.id,
      categoryId,
      source: provenance.source,
      actionId: provenance.actionId ?? null,
      reviewStatus: 'reviewed',
    });
  }

  return { updated: writeTransactionCategories(db, writes, now) };
}

function reasonForSuggestion(row: RawMerchantRuleSuggestion): string {
  return `${row.categorized_count} of ${row.categorized_total} categorized ${row.pattern} transaction${row.categorized_total === 1 ? '' : 's'} use ${row.category_name}, so ${row.uncategorized_count} uncategorized match${row.uncategorized_count === 1 ? '' : 'es'} can be reviewed together.`;
}

function getRuleSuggestionPreview(
  db: Database.Database,
  merchantKey: string
): MerchantRuleSuggestionPreview[] {
  const rows = db.prepare(`
    SELECT
      t.id,
      t.date,
      t.amount,
      t.merchant_name,
      t.original_name,
      a.account_name,
      t.category_id,
      c.name AS category_name
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
      AND lower(trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, '')))) = ?
    ORDER BY t.category_id IS NULL DESC, t.date DESC, ABS(t.amount) DESC
    LIMIT 6
  `).all(merchantKey) as RuleSuggestionPreviewRow[];

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    amount: row.amount,
    merchant_name: transactionMerchantName(row),
    account_name: row.account_name,
    category_name: row.category_name,
    will_apply: row.category_id === null,
  }));
}

export function suggestMerchantRules(db: Database.Database): MerchantRuleSuggestion[] {
  const rows = db.prepare(`
    WITH normalized AS (
      SELECT
        lower(trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, '')))) AS merchant_key,
        trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, ''))) AS pattern,
        t.category_id
      FROM transactions t
      WHERE t.pending = 0
        AND trim(COALESCE(NULLIF(t.merchant_name, ''), NULLIF(t.original_name, ''))) != ''
    ),
    category_counts AS (
      SELECT
        merchant_key,
        MAX(pattern) AS pattern,
        category_id,
        COUNT(*) AS categorized_count
      FROM normalized
      WHERE category_id IS NOT NULL
      GROUP BY merchant_key, category_id
    ),
    merchant_totals AS (
      SELECT merchant_key, SUM(categorized_count) AS categorized_total
      FROM category_counts
      GROUP BY merchant_key
    ),
    uncategorized_counts AS (
      SELECT merchant_key, COUNT(*) AS uncategorized_count
      FROM normalized
      WHERE category_id IS NULL
      GROUP BY merchant_key
    ),
    ranked AS (
      SELECT
        cc.*,
        mt.categorized_total,
        uc.uncategorized_count,
        ROW_NUMBER() OVER (
          PARTITION BY cc.merchant_key
          ORDER BY cc.categorized_count DESC, cc.category_id ASC
        ) AS category_rank
      FROM category_counts cc
      JOIN merchant_totals mt ON mt.merchant_key = cc.merchant_key
      JOIN uncategorized_counts uc ON uc.merchant_key = cc.merchant_key
    )
    SELECT
      r.merchant_key,
      r.pattern,
      r.category_id,
      c.name AS category_name,
      c.color AS category_color,
      c.icon AS category_icon,
      r.categorized_count,
      r.uncategorized_count,
      r.categorized_total,
      (1.0 * r.categorized_count / r.categorized_total) AS confidence
    FROM ranked r
    JOIN categories c ON c.id = r.category_id
    WHERE r.category_rank = 1
      AND r.categorized_count >= 2
      AND r.uncategorized_count > 0
      AND (1.0 * r.categorized_count / r.categorized_total) >= 0.75
      AND NOT EXISTS (
        SELECT 1
        FROM merchant_rules mr
        WHERE mr.retired_at IS NULL
          AND r.merchant_key LIKE '%' || lower(mr.pattern) || '%'
      )
    ORDER BY r.uncategorized_count DESC, r.categorized_count DESC, r.pattern ASC
    LIMIT 10
  `).all() as RawMerchantRuleSuggestion[];

  // Suggestions are recomputed from scratch on every call, so a skipped one would reappear
  // forever. Skips are persisted as a list of merchant keys in app_preferences.
  const dismissed = getDismissedRuleSuggestions(db);
  const visible = rows.filter((row) => !dismissed.has(row.merchant_key));

  return visible.map((row) => {
    const preview = getRuleSuggestionPreview(db, row.merchant_key);

    return {
      pattern: row.pattern,
      category_id: row.category_id,
      category_name: row.category_name,
      category_color: row.category_color,
      category_icon: row.category_icon,
      categorized_count: row.categorized_count,
      uncategorized_count: row.uncategorized_count,
      confidence: row.confidence,
      affected_transaction_ids: preview
        .filter((transaction) => transaction.will_apply)
        .map((transaction) => transaction.id),
      preview_transactions: preview,
      reason: reasonForSuggestion(row),
    };
  });
}

export interface RuleSuggestionApproval {
  pattern: string;
  /** Optional override; defaults to the suggestion's own proposed category. */
  category_id?: string;
}

export interface ApproveRuleSuggestionsResult {
  approved: number;
  applied: number;
  /** Patterns that could not be approved, with the reason, so the UI never reports a silent no-op. */
  skipped: Array<{ pattern: string; reason: 'unknown_pattern' | 'unknown_category' }>;
}

/**
 * Approve several rule suggestions at once: upsert each merchant rule and categorize exactly the
 * transactions that suggestion said it would affect.
 *
 * The affected ids are recomputed server-side from `suggestMerchantRules` rather than taken from the
 * request. A client-supplied id list would let a stale page (or a bug) relabel arbitrary rows, and
 * "applies to N transactions" has to mean the N the server can still vouch for.
 *
 * Deliberately NOT `applyMerchantRulesToExistingTransactions`: that matches by substring and 0.86
 * fuzzy similarity, so approving a rule for "AMK BIG BEND BASIN STO" would also sweep in
 * "AMK BIG BEND BASIN STORE". Exact ids keep the blast radius equal to the preview the user saw.
 */
export function approveMerchantRuleSuggestions(
  db: Database.Database,
  approvals: RuleSuggestionApproval[]
): ApproveRuleSuggestionsResult {
  const suggestions = new Map(
    suggestMerchantRules(db).map((suggestion) => [suggestion.pattern, suggestion])
  );
  const known = knownCategoryIds(db);
  const now = new Date().toISOString();

  const result: ApproveRuleSuggestionsResult = { approved: 0, applied: 0, skipped: [] };

  const run = db.transaction(() => {
    for (const approval of approvals) {
      const suggestion = suggestions.get(approval.pattern);
      if (!suggestion) {
        result.skipped.push({ pattern: approval.pattern, reason: 'unknown_pattern' });
        continue;
      }

      const categoryId = approval.category_id ?? suggestion.category_id;
      if (!known.has(categoryId)) {
        result.skipped.push({ pattern: approval.pattern, reason: 'unknown_category' });
        continue;
      }

      // Approving a suggestion is the owner accepting it, so it may move an existing rule.
      upsertMerchantRule(db, suggestion.pattern, categoryId, now, { source: 'suggestion' });
      result.approved += 1;

      const ids = suggestion.affected_transaction_ids;
      if (ids.length === 0) continue;

      // Still-uncategorized guard: between building the suggestion and approving it the user may
      // have categorized a row by hand. Their choice wins over a bulk approval.
      const stillUncategorized = db.prepare(
        `SELECT id FROM transactions WHERE id IN (${ids.map(() => '?').join(',')}) AND category_id IS NULL`
      ).all(...ids) as Array<{ id: string }>;

      result.applied += writeTransactionCategories(
        db,
        stillUncategorized.map((row) => ({
          transactionId: row.id,
          categoryId,
          source: 'human' as const,
          actionId: null,
          markManual: true,
          reviewStatus: 'reviewed' as const,
        })),
        now
      );
    }
  });

  run();
  return result;
}
