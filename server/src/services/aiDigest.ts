import type Database from 'better-sqlite3';
import { toDollars } from './money';
import { undoAdvisorAction } from './advisorDrafts';
import type {
  AiDigest,
  AiDigestAction,
  AiDigestFeedback,
  AiDigestRecordState,
  AiDigestRevertActionOutcome,
  AiDigestRevertResult,
  AiDigestRow,
  AiDigestRowStatus,
  AiDigestRule,
  AiDigestRuleRevision,
  AiDigestRevertScope,
} from '../../../shared/types';

/**
 * What the AI changed, as a diff rather than a count.
 *
 * Built from the revision logs (`transaction_category_revisions`, `merchant_rule_revisions`,
 * migration 042) and never by re-deriving what the model probably did. A digest assembled from
 * `advisor_actions.payload` would report the proposal; this reports the write, row by row, with the
 * category each row held before and the category it holds now.
 *
 * Three things it must never do, all of which this file is shaped around.
 *
 * It must not claim rows it cannot show. Migration 042 built the revision log; an action applied
 * before it may have no row-level record at all, and is reported `unrecorded` with no revert
 * control.
 *
 * It must not report an action that changed nothing AS a missing record. `create_merchant_rule` is
 * autonomous, and a rule whose pattern matches no settled transaction applies cleanly and writes
 * zero transaction rows. That action's record is complete. The two are separated by one fact the
 * code reads rather than assumes: whether the action predates the revision log
 * (`schema_migrations.applied_at` for migration 042). Nothing here claims to know why any given
 * pre-042 action has no rows, and the owner's ledger is why that restraint is written down.
 *
 * MEASURED on a read-only copy taken 2026-07-31, migrations applied through 044. The split falls
 * exactly on kind, not on time, and no query here separates the two candidate causes:
 *   kind vs revisions   SELECT a.kind, COUNT(*), SUM(r.n IS NULL) FROM advisor_actions a LEFT JOIN
 *                       (SELECT action_id, COUNT(*) n FROM transaction_category_revisions
 *                        WHERE revert_of IS NULL GROUP BY action_id) r ON r.action_id = a.id
 *                       GROUP BY a.kind
 *                       -> categorize_transaction 86 actions, 0 without rows
 *                          create_merchant_rule    54 actions, 54 without rows
 *   time                MIN/MAX created_at per kind overlap (2026-07-15T22:44:16.484Z through
 *                       2026-07-29T20:04:50.962Z), and 042 applied 2026-07-30T04:56:05.361Z, so
 *                       ALL 140 predate the log. "They predate 042" is true of both kinds equally
 *                       and therefore explains nothing about a split that falls on kind alone.
 *   backfill input      SELECT a.kind, COUNT(DISTINCT t.id) FROM transactions t
 *                       JOIN advisor_actions a ON a.id = t.category_action_id GROUP BY a.kind
 *                       -> categorize_transaction 86, create_merchant_rule 0. 042 read that column,
 *                          so there was nothing there for it to recover.
 * All 54 payloads carry apply_existing = true. Whether those rules matched no rows when applied, or
 * matched rows whose single provenance slot a later write overwrote before 042 ran, is NOT
 * established: the cause is unknown, and this file reports the shape rather than naming one.
 *
 * And it must not offer a revert that quietly does less OR more than it says.
 * `revertableRevisionsForAction` only returns revisions that are still the NEWEST for their
 * transaction, so a row a later write has displaced cannot be put back without discarding that later
 * decision. Undo is a stack: peeling the newer action off makes the older one revertable again.
 * `buildAiDigest` therefore simulates the whole peel over its own window before answering, so
 * `revertable_rows` is what the gesture will really restore and `blocked_rows` is what it will leave
 * alone, each named per row. The mirror case is why `revertAiDigestSince` takes the caller's action
 * limit instead of its own: a revert planned over a wider window than the panel displayed would put
 * back rows the panel never counted.
 */

/** Actions per digest page. A window wider than this reports `truncated` rather than trimming quietly. */
export const DEFAULT_DIGEST_ACTION_LIMIT = 200;

/** Ceiling on the action limit a revert-since pass will accept. */
export const MAX_REVERT_ACTIONS = 2000;

/** The migration that created `transaction_category_revisions`. Its apply time is the log's start. */
const REVISION_LOG_MIGRATION = '042_ai_write_provenance.sql';

interface ActionRow {
  id: string;
  kind: string;
  label: string;
  summary: string;
  source: 'worker_auto' | 'user_confirm';
  created_at: string;
}

interface RevisionRow {
  id: string;
  action_id: string;
  transaction_id: string;
  from_category_id: string | null;
  to_category_id: string | null;
  reverted_at: string | null;
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  account_name: string | null;
  before_category_name: string | null;
  after_category_name: string | null;
}

/** One entry of a transaction's live revision stack, newest first. */
interface StackEntry {
  id: string;
  transaction_id: string;
  action_id: string | null;
  to_source: string | null;
}

interface RuleRow {
  id: string;
  action_id: string;
  pattern: string;
  category_id: string | null;
  category_name: string | null;
  source: string;
  retired_at: string | null;
}

interface RuleRevisionRow {
  action_id: string;
  rule_id: string;
  pattern: string;
  operation: 'create' | 'recategorize' | 'rename' | 'retire';
  from_category_id: string | null;
  to_category_id: string | null;
  from_category_name: string | null;
  to_category_name: string | null;
  created_at: string;
}

interface FeedbackRow {
  action_id: string;
  signal: string;
  owner_choice: string;
  affected_transactions: number;
  created_at: string;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function loadActions(db: Database.Database, since: string | null, limit: number): ActionRow[] {
  return db.prepare(`
    SELECT id, kind, label, summary, source, created_at
    FROM advisor_actions
    WHERE ? IS NULL OR created_at >= ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(since, since, limit) as ActionRow[];
}

function loadRevisions(db: Database.Database, actionIds: readonly string[]): RevisionRow[] {
  if (actionIds.length === 0) return [];
  return db.prepare(`
    SELECT r.id, r.action_id, r.transaction_id, r.from_category_id, r.to_category_id, r.reverted_at,
           t.date, t.amount, t.merchant_name, t.original_name,
           a.account_name,
           cb.name AS before_category_name,
           ca.name AS after_category_name
    FROM transaction_category_revisions r
    JOIN transactions t ON t.id = r.transaction_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories cb ON cb.id = r.from_category_id
    LEFT JOIN categories ca ON ca.id = r.to_category_id
    WHERE r.action_id IN (${placeholders(actionIds.length)})
      AND r.revert_of IS NULL
    ORDER BY r.created_at, r.rowid
  `).all(...actionIds) as RevisionRow[];
}

/**
 * Every live revision for the transactions in the window, newest first.
 *
 * Ordered exactly as `revertableRevisionsForAction` orders its subselect, because the simulation is
 * only worth anything if it walks the same stack undo will walk.
 */
function loadStacks(db: Database.Database, transactionIds: readonly string[]): Map<string, StackEntry[]> {
  if (transactionIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT id, transaction_id, action_id, to_source
    FROM transaction_category_revisions
    WHERE transaction_id IN (${placeholders(transactionIds.length)})
      AND revert_of IS NULL
      AND reverted_at IS NULL
    ORDER BY transaction_id, created_at DESC, rowid DESC
  `).all(...transactionIds) as StackEntry[];
  return groupBy(rows, (r) => r.transaction_id);
}

function loadRules(db: Database.Database, actionIds: readonly string[]): Map<string, RuleRow> {
  if (actionIds.length === 0) return new Map();
  // Two ways an action names a rule, and only the first used to be read. `merchant_rules.action_id`
  // records the action that CREATED or recategorized the rule; a retirement never touches that
  // column, so a `retire_merchant_rule` action showed no rule at all and the digest reported it as
  // an action about nothing. The revision log is the other way in, and it is the one that carries
  // the retirement.
  const rows = db.prepare(`
    SELECT v.action_id, m.id, m.pattern, m.category_id, m.source, m.retired_at, c.name AS category_name
    FROM merchant_rules m
    LEFT JOIN categories c ON c.id = m.category_id
    JOIN (
      SELECT id AS rule_id, action_id FROM merchant_rules WHERE action_id IS NOT NULL
      UNION
      SELECT rule_id, action_id FROM merchant_rule_revisions WHERE action_id IS NOT NULL
    ) v ON v.rule_id = m.id
    WHERE v.action_id IN (${placeholders(actionIds.length)})
  `).all(...actionIds) as RuleRow[];
  return new Map(rows.map((r) => [r.action_id, r]));
}

/**
 * Rule revisions are joined on `action_id`, so a revision with no AI action behind it is invisible
 * to this digest however many exist. That is not a count claim: the digest groups by action, and a
 * revision `merchant_rules.action_id` never pointed at has no action to group under. Migration 045's
 * retirements are the live example, both written with `action_id` NULL because a migration retired
 * them, not the model. They belong on a rule's own history rather than in "what the AI changed".
 */
function loadRuleRevisions(db: Database.Database, actionIds: readonly string[]): Map<string, RuleRevisionRow[]> {
  if (actionIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT v.action_id, v.rule_id, v.pattern, v.operation, v.from_category_id, v.to_category_id,
           v.created_at,
           cf.name AS from_category_name,
           ct.name AS to_category_name
    FROM merchant_rule_revisions v
    LEFT JOIN categories cf ON cf.id = v.from_category_id
    LEFT JOIN categories ct ON ct.id = v.to_category_id
    WHERE v.action_id IN (${placeholders(actionIds.length)})
    ORDER BY v.created_at, v.rowid
  `).all(...actionIds) as RuleRevisionRow[];
  return groupBy(rows, (r) => r.action_id);
}

function loadFeedback(db: Database.Database, actionIds: readonly string[]): Map<string, FeedbackRow[]> {
  if (actionIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT action_id, signal, owner_choice, affected_transactions, created_at
    FROM ai_feedback
    WHERE action_id IN (${placeholders(actionIds.length)})
    ORDER BY created_at DESC, rowid DESC
  `).all(...actionIds) as FeedbackRow[];
  return groupBy(rows, (r) => r.action_id);
}

/**
 * When the row-level revision log began, as an ISO timestamp, or null if that cannot be read.
 *
 * Read from `schema_migrations`, not hardcoded: on a fresh install migration 042 applies at install
 * time and every action is after it, while on this owner's database it applied on 2026-07-30 and
 * every action already on record is before it. Null (no migrations table, or the row absent) means
 * the boundary is unknown, and an action with no rows is then reported `unrecorded` rather than
 * credited with having changed nothing.
 */
function revisionLogStart(db: Database.Database): string | null {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get();
  if (!table) return null;
  const row = db.prepare('SELECT applied_at FROM schema_migrations WHERE name = ?')
    .get(REVISION_LOG_MIGRATION) as { applied_at: string } | undefined;
  return row?.applied_at ?? null;
}

function recordState(
  rowCount: number,
  actionCreatedAt: string,
  logStart: string | null
): AiDigestRecordState {
  if (rowCount > 0) return 'rows';
  if (logStart !== null && actionCreatedAt >= logStart) return 'no_rows_changed';
  return 'unrecorded';
}

/**
 * What one gesture would put back.
 *
 * Rules count on BOTH sides, which is the whole reason this is not a count of rows.
 * `retire_merchant_rule` earns autonomy BECAUSE it changes no transaction, so an action with zero
 * rows and one restorable retirement is fully revertable, not `nothing_to_revert`. The same argument
 * says a restorable retirement alongside a fully revertable row set leaves nothing behind and is
 * still `full`; this read `revertable === rows.length && revertableRules === 0`, which inverted its
 * own reasoning and reported the MORE revertable action as `partial`.
 *
 * `strandedRules` is the other half, and without it `full` would be a claim the code did not check:
 * a retirement a later revision buried, or whose pattern a replacement rule now holds, stays retired
 * after the gesture. The decision is therefore over what comes back and what is left, never over
 * rows alone.
 */
function revertScope(
  rows: readonly AiDigestRow[],
  state: AiDigestRecordState,
  revertableRules: number,
  strandedRules: number
): AiDigestRevertScope {
  const revertableRows = rows.filter((r) => r.revertable).length;
  const restorable = revertableRows + revertableRules;
  const left = rows.length - revertableRows + strandedRules;

  if (restorable === 0) {
    if (left > 0) return 'none';
    return state === 'unrecorded' ? 'unrecorded' : 'nothing_to_revert';
  }
  return left === 0 ? 'full' : 'partial';
}

/** Retirements an action made that are still standing, split by whether undo can put them back. */
interface RuleRetirementPlan {
  restorable: number;
  stranded: number;
}

/**
 * Retirements an action made whose rule is still retired, and which of them undo would restore.
 *
 * Both conditions are the ones `unretireMerchantRule` itself applies, so the plan and the gesture
 * cannot disagree. A retirement is restorable while it is the NEWEST revision for its rule, which
 * is the stack rule categories follow, AND while no live rule holds its pattern: the partial unique
 * index `idx_merchant_rules_pattern_live` allows one live rule per pattern, so a replacement written
 * after the retirement blocks the restore and reviving the old rule would be a second, unasked
 * change to whichever rule the owner has now.
 *
 * The stranded half exists because `revert_scope` has to be able to say `full` truthfully. Counting
 * only what comes back would let an action with one unrestorable retirement report that one gesture
 * puts everything back.
 */
function loadRuleRetirementPlans(
  db: Database.Database,
  actionIds: readonly string[]
): Map<string, RuleRetirementPlan> {
  if (actionIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT v.action_id, COUNT(*) AS standing,
           SUM(
             CASE
               WHEN v.id = (
                      SELECT v2.id FROM merchant_rule_revisions v2
                      WHERE v2.rule_id = v.rule_id
                      ORDER BY v2.created_at DESC, v2.rowid DESC
                      LIMIT 1
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM merchant_rules live
                      WHERE live.retired_at IS NULL AND lower(live.pattern) = lower(m.pattern)
                    )
               THEN 1 ELSE 0
             END
           ) AS restorable
    FROM merchant_rule_revisions v
    JOIN merchant_rules m ON m.id = v.rule_id
    WHERE v.action_id IN (${placeholders(actionIds.length)})
      AND v.operation = 'retire'
      AND m.retired_at IS NOT NULL
    GROUP BY v.action_id
  `).all(...actionIds) as Array<{ action_id: string; standing: number; restorable: number }>;
  return new Map(
    rows.map((r) => [r.action_id, { restorable: r.restorable, stranded: r.standing - r.restorable }])
  );
}

function toFeedback(rows: readonly FeedbackRow[]): AiDigestFeedback[] {
  return rows.map((r) => ({
    signal: r.signal,
    owner_choice: r.owner_choice,
    affected_transactions: r.affected_transactions,
    created_at: r.created_at,
  }));
}

function toRule(row: RuleRow | undefined): AiDigestRule | null {
  if (!row) return null;
  return {
    rule_id: row.id,
    pattern: row.pattern,
    category_id: row.category_id,
    category_name: row.category_name,
    source: row.source,
    retired_at: row.retired_at,
  };
}

function toRuleRevisions(rows: readonly RuleRevisionRow[] | undefined): AiDigestRuleRevision[] {
  return (rows ?? []).map((r) => ({
    rule_id: r.rule_id,
    pattern: r.pattern,
    operation: r.operation,
    from_category_id: r.from_category_id,
    from_category_name: r.from_category_name,
    to_category_id: r.to_category_id,
    to_category_name: r.to_category_name,
    created_at: r.created_at,
  }));
}

export interface AiDigestOptions {
  /** ISO timestamp lower bound on `advisor_actions.created_at`. Null means every action on record. */
  since?: string | null;
  limit?: number;
}

export function buildAiDigest(db: Database.Database, options: AiDigestOptions = {}): AiDigest {
  const since = options.since ?? null;
  const limit = options.limit ?? DEFAULT_DIGEST_ACTION_LIMIT;

  // One over the limit, so truncation is observed rather than assumed.
  const fetched = loadActions(db, since, limit + 1);
  const truncated = fetched.length > limit;
  const actionRows = truncated ? fetched.slice(0, limit) : fetched;

  const actionIds = actionRows.map((a) => a.id);
  const revisions = loadRevisions(db, actionIds);
  const revisionsByAction = groupBy(revisions, (r) => r.action_id);
  const stacks = loadStacks(db, [...new Set(revisions.map((r) => r.transaction_id))]);
  const rules = loadRules(db, actionIds);
  const ruleRevisions = loadRuleRevisions(db, actionIds);
  const feedback = loadFeedback(db, actionIds);
  const retirementPlans = loadRuleRetirementPlans(db, actionIds);
  const logStart = revisionLogStart(db);

  // What the ledger holds right now, read before the simulation consumes anything.
  const standingNow = new Map<string, string>();
  for (const [transactionId, stack] of stacks) {
    if (stack.length > 0) standingNow.set(transactionId, stack[0].id);
  }

  // The peel. Actions are already newest-first, which is the order undo has to run in: reverting a
  // newer action is what makes the one beneath it revertable again.
  const pending = new Map<string, StackEntry[]>();
  for (const [transactionId, stack] of stacks) pending.set(transactionId, [...stack]);

  const actions: AiDigestAction[] = [];
  for (const action of actionRows) {
    const rows: AiDigestRow[] = [];

    for (const rev of revisionsByAction.get(action.id) ?? []) {
      const base = {
        revision_id: rev.id,
        transaction_id: rev.transaction_id,
        date: rev.date,
        merchant: rev.merchant_name ?? rev.original_name,
        account_name: rev.account_name,
        amount: toDollars(rev.amount),
        before_category_id: rev.from_category_id,
        before_category_name: rev.before_category_name,
        after_category_id: rev.to_category_id,
        after_category_name: rev.after_category_name,
      };

      if (rev.reverted_at !== null) {
        rows.push({
          ...base,
          status: 'reverted' satisfies AiDigestRowStatus,
          revertable: false,
          blocked_reason: 'already_reverted',
          changed_since_by_source: null,
          changed_since_by_action_id: null,
        });
        continue;
      }

      const stack = pending.get(rev.transaction_id) ?? [];
      const top = stack[0];
      const isStanding = standingNow.get(rev.transaction_id) === rev.id;

      if (top && top.id === rev.id) {
        stack.shift();
        rows.push({
          ...base,
          status: isStanding ? 'standing' : 'superseded',
          revertable: true,
          blocked_reason: null,
          changed_since_by_source: null,
          changed_since_by_action_id: null,
        });
        continue;
      }

      // The write on top may be this action's OWN later write to the same transaction. That is not
      // "somebody changed it since", and saying so named the action as its own intruder.
      const selfReplaced = top?.action_id === action.id;
      rows.push({
        ...base,
        status: 'superseded',
        revertable: false,
        blocked_reason: selfReplaced ? 'replaced_by_same_action' : 'changed_since',
        // Recorded, not inferred: the source and action stamped on the write that now stands here.
        changed_since_by_source: top?.to_source ?? null,
        changed_since_by_action_id: top?.action_id ?? null,
      });
    }

    const revertableRows = rows.filter((r) => r.revertable).length;
    const retirements = retirementPlans.get(action.id) ?? { restorable: 0, stranded: 0 };
    const state = recordState(rows.length, action.created_at, logStart);
    actions.push({
      action_id: action.id,
      kind: action.kind,
      label: action.label,
      summary: action.summary,
      source: action.source,
      created_at: action.created_at,
      rows,
      rule: toRule(rules.get(action.id)),
      rule_revisions: toRuleRevisions(ruleRevisions.get(action.id)),
      owner_feedback: toFeedback(feedback.get(action.id) ?? []),
      record_state: state,
      standing_rows: rows.filter((r) => r.status === 'standing').length,
      revertable_rows: revertableRows,
      blocked_rows: rows.length - revertableRows,
      revertable_rules: retirements.restorable,
      revert_scope: revertScope(rows, state, retirements.restorable, retirements.stranded),
    });
  }

  const allRows = actions.flatMap((a) => a.rows);
  return {
    since,
    generated_at: new Date().toISOString(),
    action_limit: limit,
    truncated,
    action_count: actions.length,
    actions_that_changed_no_rows: actions.filter((a) => a.record_state === 'no_rows_changed').length,
    actions_unrecorded: actions.filter((a) => a.record_state === 'unrecorded').length,
    row_count: allRows.length,
    standing_rows: allRows.filter((r) => r.status === 'standing').length,
    revertable_rows: allRows.filter((r) => r.revertable).length,
    revertable_rules: actions.reduce((sum, a) => sum + a.revertable_rules, 0),
    already_reverted_rows: allRows.filter((r) => r.blocked_reason === 'already_reverted').length,
    changed_since_rows: allRows.filter((r) => r.blocked_reason === 'changed_since').length,
    replaced_within_action_rows: allRows.filter((r) => r.blocked_reason === 'replaced_by_same_action').length,
    actions,
  };
}

export type AiDigestRevertOutcome =
  | { ok: true; result: AiDigestRevertResult }
  | { ok: false; error: string };

/**
 * Put back everything the AI changed since a timestamp, in one gesture.
 *
 * Runs the actions newest-first for the same reason the plan simulates them that way, and inside a
 * single transaction so a failure part-way leaves the ledger where it started rather than half
 * reverted.
 *
 * `limit` is the caller's, not this function's, and defaults to the digest's own page size. The
 * panel that offers this gesture describes a digest built with some limit; planning here against a
 * wider one would revert rows the owner was never shown a count for. A window that overflows the
 * limit refuses, in both directions: covering part of a window without saying so is what this
 * control exists to avoid.
 *
 * The response restates the plan next to the result. The rows it never claimed are carried through
 * even though nothing was attempted for them, because a revert that reports only what it managed
 * reads as a complete one; and any action whose real revert count differs from the planned one is
 * named in `discrepancies` rather than absorbed into the total.
 */
export function revertAiDigestSince(
  db: Database.Database,
  since: string,
  limit: number = DEFAULT_DIGEST_ACTION_LIMIT
): AiDigestRevertOutcome {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVERT_ACTIONS) {
    return { ok: false, error: `limit must be an integer between 1 and ${MAX_REVERT_ACTIONS}` };
  }

  const digest = buildAiDigest(db, { since, limit });
  if (digest.truncated) {
    return {
      ok: false,
      error: `More than ${limit} AI actions fall in this window, which is more than this view counted. Pick a later starting point: reverting more than was described is exactly what this control is meant to avoid.`,
    };
  }

  const run = db.transaction((): AiDigestRevertResult => {
    const outcomes: AiDigestRevertActionOutcome[] = [];
    const discrepancies: string[] = [];
    let revertedRows = 0;
    let revertedRules = 0;

    for (const action of digest.actions) {
      // A rule retirement changes no transaction, so an action with zero revertable rows can still
      // have something to put back. Skipping on rows alone left every autonomous retirement in the
      // window standing while the result reported a complete revert.
      if (action.revertable_rows === 0 && action.revertable_rules === 0) continue;
      const undone = undoAdvisorAction(db, action.action_id);
      const undoneRules = undone.reverted_rules ?? 0;
      outcomes.push({
        action_id: action.action_id,
        label: action.label,
        planned_rows: action.revertable_rows,
        reverted_rows: undone.reverted,
        planned_rules: action.revertable_rules,
        reverted_rules: undoneRules,
      });
      revertedRows += undone.reverted;
      revertedRules += undoneRules;
      if (undone.reverted !== action.revertable_rows) {
        discrepancies.push(
          `"${action.label}" was expected to restore ${action.revertable_rows} row(s) and restored ${undone.reverted}.`
        );
      }
      if (undoneRules !== action.revertable_rules) {
        discrepancies.push(
          `"${action.label}" was expected to restore ${action.revertable_rules} rule(s) and restored ${undoneRules}.`
        );
      }
      for (const failure of undone.rule_failures ?? []) discrepancies.push(failure);
    }

    return {
      since,
      action_limit: limit,
      planned_rows: digest.revertable_rows,
      reverted_rows: revertedRows,
      planned_rules: digest.revertable_rules,
      reverted_rules: revertedRules,
      already_reverted_rows: digest.already_reverted_rows,
      changed_since_rows: digest.changed_since_rows,
      replaced_within_action_rows: digest.replaced_within_action_rows,
      actions: outcomes,
      discrepancies,
    };
  });

  return { ok: true, result: run() };
}
