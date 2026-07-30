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
// aborts the whole auto-categorization sync stage — a single stale mapping taking down the entire
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
  pattern: string;
  category_id: string;
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

export function merchantMatchesRulePattern(merchantName: string, pattern: string): boolean {
  const merchant = normalizeMerchantMatchValue(merchantName);
  const rule = normalizeMerchantMatchValue(pattern);
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

export function applyMerchantRulesToExistingTransactions(
  db: Database.Database,
  options: { onlyUncategorized?: boolean; skipManual?: boolean; provenance?: CategoryProvenance } = {}
): RuleApplicationResult {
  const onlyUncategorized = options.onlyUncategorized ?? true;
  const rules = db.prepare(
    'SELECT pattern, category_id FROM merchant_rules WHERE retired_at IS NULL ORDER BY created_at DESC'
  ).all() as MerchantRule[];

  if (rules.length === 0) return { updated: 0 };

  const clauses: string[] = [];
  if (onlyUncategorized) clauses.push('category_id IS NULL');
  // Two markers for the same thing, because they were introduced years apart and neither is
  // reliable alone. manually_categorized (026) is the older flag and a bulk re-categorization
  // pass can clear it wholesale (it currently reads 0 on every row here, though 92 were set
  // earlier). category_source (041) records provenance per write. Honor both, so a hand-made
  // choice survives a full re-check even if one marker has been wiped.
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
 * How many rows a rule would actually relabel, computed with the same matcher and the same
 * exclusions as the apply path. Exists so the blast-radius guard can run BEFORE the write rather
 * than reporting the damage afterwards.
 */
export function countMerchantRuleImpact(
  db: Database.Database,
  pattern: string,
  categoryId: string,
  options: { overwrite?: boolean } = {}
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

  let count = 0;
  for (const transaction of transactions) {
    if (!merchantMatchesRulePattern(transactionMerchantName(transaction), normalizedPattern)) continue;
    if (transaction.category_id === categoryId) continue;
    count += 1;
  }
  return count;
}

export function applyMerchantRuleToMatchingTransactions(
  db: Database.Database,
  pattern: string,
  categoryId: string,
  now = new Date().toISOString(),
  options: { overwrite?: boolean; provenance?: CategoryProvenance } = {}
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

  const provenance = options.provenance ?? { source: 'rule' as const };
  const writes: CategoryWrite[] = [];
  for (const transaction of transactions) {
    if (!merchantMatchesRulePattern(transactionMerchantName(transaction), normalizedPattern)) continue;
    if (transaction.category_id === categoryId) continue; // already correct
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
