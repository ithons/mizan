import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  AdvisorCitation,
  AdvisorDraftAction,
  AdvisorDraftActionKind,
  AdvisorDraftChange,
  AdvisorDraftPayload,
  AdvisorEffort,
  SyncEvent,
} from '../../../shared/types';
import { AUTONOMOUS_DRAFT_KINDS, confirmAdvisorDraft, isAutonomousDraftKind } from './advisorDrafts';
import { JOB_MODELS, type AiJobName } from './advisorSettings';
import { DraftRefusedError } from './aiWriteGuards';
import { hasAnthropicCredentials } from './anthropicClient';

/**
 * What the model does, when, with which model, and under which invariants, as DATA.
 *
 * Before this there was one hardcoded function fired by a setTimeout after every sync. Its model
 * lived in one table, the draft kinds it was allowed to emit lived in a prompt sentence, and the
 * rule that a wrong kind must not be written lived in whether the reader noticed. A job now
 * declares all of it, and the two declarations that matter are ENFORCED here rather than
 * documented: `writes` (a kind outside it never reaches a write path, whatever the model returned)
 * and `invariants` (evaluated against the rows the pass actually produced, after it produced them).
 *
 * `model` and `effort` are not restated here. They are read from JOB_MODELS, so the per-job model
 * assignment stays one table and a retiering cannot leave two lists disagreeing.
 */

/** How a pass gets started. There is no clock trigger; see aiScheduler.ts for why. */
export type AiJobTrigger = 'after_sync' | 'on_demand';

/**
 * Where the job is invoked from.
 *
 * 'scheduler' means it runs through `runAiJob`, so its `writes` and `invariants` are enforced and
 * every pass leaves an `ai_runs` row. 'callsite' means it is invoked directly by a route and gets
 * neither. A 'callsite' job must therefore declare `writes: []`; a job that writes drafts and does
 * not go through the framework has declarations nothing checks, which is the failure this file
 * exists to remove. `tests/aiJobs.test.ts` asserts that rule rather than trusting this comment.
 */
export type AiJobExecution = 'scheduler' | 'callsite';

/** The digest section a pass's output belongs under. */
export type AiDigestSection = 'review' | 'categorization';

export type AiJobInvariant = 'autonomy_boundary' | 'human_categories_preserved';

/**
 * What each invariant asserts. `closeRunRow` writes this text into `ai_runs.invariant_breach`
 * alongside the finding, so the row states the rule that broke and not only the symptom; a reader
 * looking at a breach months later does not have to find this file to know what was being checked.
 */
export const AI_JOB_INVARIANTS: Readonly<Record<AiJobInvariant, string>> = {
  autonomy_boundary:
    'every action this pass applied unattended is one of AUTONOMOUS_DRAFT_KINDS',
  human_categories_preserved:
    'no category this pass wrote replaced one the owner had set by hand',
};

export interface AiJobDeclaration {
  readonly name: AiJobName;
  readonly trigger: AiJobTrigger;
  readonly model: string;
  /** Absent where the model takes no effort level, so the row states no dial it lacks. */
  readonly effort?: AdvisorEffort;
  /** The only draft kinds this job may produce. Enforced in `runAiJob`, not documented. */
  readonly writes: readonly AdvisorDraftActionKind[];
  readonly invariants: readonly AiJobInvariant[];
  readonly digestSection: AiDigestSection;
  readonly execution: AiJobExecution;
}

function declare(
  name: AiJobName,
  spec: Omit<AiJobDeclaration, 'name' | 'model' | 'effort'>
): AiJobDeclaration {
  return { name, ...JOB_MODELS[name], ...spec };
}

/**
 * Every AI job that exists. Two, because two exist.
 *
 * There is deliberately no entry for the self-audit or the monthly synthesis the plan reserves
 * Opus 5 for: neither has an implementation, and a registry entry for a job that cannot run is a
 * worse lie than an absence.
 */
export const AI_JOBS: Readonly<Record<AiJobName, AiJobDeclaration>> = {
  background_review: declare('background_review', {
    trigger: 'after_sync',
    // Mirrors the 'Allowed kind values' the worker's prompt publishes, which is generated from
    // this list. A kind here that the prompt omits is a kind the model never emits; a kind in the
    // prompt that is missing here is refused after the call, which wastes the call.
    writes: [
      'categorize_transaction',
      'create_merchant_rule',
      'create_recurring_adjustment',
      'update_budget',
      'update_goal_target',
      'create_budget_group',
    ],
    invariants: ['autonomy_boundary', 'human_categories_preserved'],
    digestSection: 'review',
    execution: 'scheduler',
  }),

  // Advisory only: it answers POST /api/ai/suggest-categories with suggestions the owner applies
  // from the worklist, and writes nothing itself. Declared here because its model assignment and
  // its empty write set are facts about the model's behaviour that belong in one place, and
  // recorded as 'callsite' because its invocation is outside this framework: it leaves no ai_runs
  // row today. Routing it through `runAiJob` means giving the route a job context, which is a
  // change to routes/ai.ts and aiCategorySuggest.ts.
  bulk_categorization: declare('bulk_categorization', {
    trigger: 'on_demand',
    writes: [],
    invariants: [],
    digestSection: 'categorization',
    execution: 'callsite',
  }),
};

// ─── What a job hands back ───────────────────────────────────────────────────

export interface AiJobUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

export interface AiJobProposal {
  kind: AdvisorDraftActionKind;
  label: string;
  summary: string;
  route: string;
  payload: AdvisorDraftPayload;
  changes: AdvisorDraftChange[];
  citations: AdvisorCitation[];
}

/**
 * A pass's outcome before anything is written.
 *
 * 'nothing_to_do' is the ordinary quiet case: the job looked, found nothing worth a model call,
 * and made none. It is not a failure and never reads as one.
 */
export type AiJobCollectResult =
  | { status: 'nothing_to_do'; detail: string }
  | {
      status: 'collected';
      proposals: AiJobProposal[];
      /** Replies the job's own output contract rejected. Counted, never applied. */
      malformed: number;
      usage: AiJobUsage | null;
    };

export interface AiJobRunContext {
  db: Database.Database;
  /** ISO timestamp the pass started, so everything a pass writes carries one clock. */
  startedAt: string;
  /**
   * This pass's own `ai_runs` row, already inserted and still 'running'.
   *
   * A collector that measures a delta against the last pass has to exclude this row, or it
   * measures against itself and every delta comes back empty.
   */
  runId: string;
}

export type AiJobCollect = (ctx: AiJobRunContext) => Promise<AiJobCollectResult>;

export interface AiJobRunOptions {
  db: Database.Database;
  trigger: AiJobTrigger;
  syncRunId?: string | null;
  /** Where a client-visible event goes. Omitted in tests that assert on silence. */
  emit?: (event: SyncEvent) => void;
  now?: () => Date;
}

export type AiJobSkipReason = 'no_credentials' | 'already_running' | 'nothing_to_do';

export interface AiJobCounts {
  proposed: number;
  applied: number;
  queued: number;
  refused_by_guards: number;
  refused_out_of_scope: number;
  malformed: number;
}

export type AiJobOutcome =
  | { status: 'skipped'; reason: AiJobSkipReason; detail?: string; runId: string | null }
  | ({ status: 'completed'; runId: string; breaches: AiJobInvariantBreach[] } & AiJobCounts)
  | { status: 'failed'; runId: string; message: string };

// ─── Invariants ──────────────────────────────────────────────────────────────

export interface AppliedAction {
  id: string;
  kind: string;
  source: string;
}

export interface AiJobInvariantBreach {
  invariant: AiJobInvariant;
  detail: string;
}

/**
 * Judge a pass by the rows it produced.
 *
 * Attribution is by action id, never by timestamp or by a before/after diff of the whole ledger.
 * An owner editing a budget in another tab while a pass runs would move any global total, and a
 * check that fired on that would be a detector firing on an ordinary healthy event.
 */
export function evaluateAiJobInvariants(
  db: Database.Database,
  actions: AppliedAction[],
  declared: readonly AiJobInvariant[]
): AiJobInvariantBreach[] {
  const breaches: AiJobInvariantBreach[] = [];

  if (declared.includes('autonomy_boundary')) {
    const widened = actions.filter(
      (action) => action.source === 'worker_auto' && !AUTONOMOUS_DRAFT_KINDS.has(action.kind)
    );
    if (widened.length > 0) {
      const kinds = [...new Set(widened.map((a) => a.kind))].join(', ');
      breaches.push({
        invariant: 'autonomy_boundary',
        detail: `applied ${widened.length} action(s) unattended outside the owner's carve-out: ${kinds}`,
      });
    }
  }

  if (declared.includes('human_categories_preserved') && actions.length > 0) {
    const placeholders = actions.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transaction_category_revisions
         WHERE from_source = 'human' AND action_id IN (${placeholders})`
      )
      .get(...actions.map((a) => a.id)) as { n: number };
    if (row.n > 0) {
      breaches.push({
        invariant: 'human_categories_preserved',
        detail: `${row.n} row(s) had a category the owner set by hand replaced`,
      });
    }
  }

  return breaches;
}

// ─── The run row ─────────────────────────────────────────────────────────────

function startRunRow(
  db: Database.Database,
  job: AiJobDeclaration,
  options: AiJobRunOptions,
  startedAt: string
): string {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO ai_runs (
       id, job, trigger_source, sync_run_id, model, effort, digest_section,
       status, started_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(
    id,
    job.name,
    options.trigger,
    options.syncRunId ?? null,
    job.model,
    job.effort ?? null,
    job.digestSection,
    startedAt,
    startedAt
  );
  return id;
}

interface RunRowClose {
  status: 'completed' | 'failed' | 'skipped';
  skippedReason?: AiJobSkipReason;
  counts?: AiJobCounts;
  usage?: AiJobUsage | null;
  breaches?: AiJobInvariantBreach[];
  errorMessage?: string;
}

function closeRunRow(
  db: Database.Database,
  runId: string,
  completedAt: string,
  close: RunRowClose
): void {
  const counts = close.counts;
  const usage = close.usage ?? null;
  const breach = close.breaches?.length
    ? close.breaches
        .map((b) => `${b.invariant} (${AI_JOB_INVARIANTS[b.invariant]}): ${b.detail}`)
        .join('; ')
    : null;

  db.prepare(
    `UPDATE ai_runs SET
       status = ?, skipped_reason = ?, completed_at = ?,
       proposed = ?, applied = ?, queued = ?,
       refused_by_guards = ?, refused_out_of_scope = ?, malformed = ?,
       input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
       invariant_breach = ?, error_message = ?
     WHERE id = ?`
  ).run(
    close.status,
    close.skippedReason ?? null,
    completedAt,
    counts?.proposed ?? 0,
    counts?.applied ?? 0,
    counts?.queued ?? 0,
    counts?.refused_by_guards ?? 0,
    counts?.refused_out_of_scope ?? 0,
    counts?.malformed ?? 0,
    usage?.input_tokens ?? null,
    usage?.output_tokens ?? null,
    usage?.cache_read_tokens ?? null,
    usage?.cache_write_tokens ?? null,
    breach,
    close.errorMessage ?? null,
    runId
  );
}

// ─── Draft persistence, shared by every draft-producing job ──────────────────

/**
 * Stable identity for the entity a draft acts on. Two drafts with the same key are two suggestions
 * about the same thing, so a fresh pass supersedes the old one; a draft whose key the fresh pass
 * does not regenerate is left in place (still pending the owner's review) rather than blanket
 * deleted.
 */
export function draftTargetKey(payload: AdvisorDraftPayload): string {
  switch (payload.kind) {
    case 'create_merchant_rule': return `create_merchant_rule:${payload.pattern}`;
    case 'categorize_transaction': return `categorize_transaction:${payload.transaction_id}`;
    case 'update_budget': return `update_budget:${payload.category_id}`;
    case 'update_goal_target': return `update_goal_target:${payload.goal_id}`;
    case 'confirm_recurring': return `confirm_recurring:${payload.recurring_id}`;
    case 'create_budget_group': return `create_budget_group:${payload.name}`;
    case 'rename_budget_group': return `rename_budget_group:${payload.group_id}`;
    case 'assign_category_to_budget_group':
      return `assign_category_to_budget_group:${payload.group_id}:${payload.category_id}`;
    case 'create_recurring_adjustment':
      return `create_recurring_adjustment:${payload.recurring_id}:${payload.original_date}`;
    case 'set_manual_cost_basis': return `set_manual_cost_basis:${payload.holding_id}`;
    case 'set_sector_metadata': return `set_sector_metadata:${payload.security_id}`;
    default: return (payload as { kind: string }).kind;
  }
}

function supersedeRegeneratedDrafts(db: Database.Database, freshKeys: Set<string>): void {
  const openRows = db
    .prepare(`SELECT id, payload FROM advisor_drafts WHERE status = 'open'`)
    .all() as Array<{ id: string; payload: string }>;
  const deleteDraft = db.prepare(`DELETE FROM advisor_drafts WHERE id = ?`);
  for (const row of openRows) {
    try {
      const payload = JSON.parse(row.payload) as AdvisorDraftPayload;
      if (freshKeys.has(draftTargetKey(payload))) deleteDraft.run(row.id);
    } catch {
      // Leave rows with unparseable payloads untouched.
    }
  }
}

interface PersistResult {
  applied: number;
  queued: number;
  refusedByGuards: number;
}

function persistProposals(
  db: Database.Database,
  job: AiJobDeclaration,
  proposals: AiJobProposal[],
  now: string
): PersistResult {
  const insertDraft = db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let applied = 0;
  let queued = 0;
  let refusedByGuards = 0;

  db.transaction(() => {
    supersedeRegeneratedDrafts(db, new Set(proposals.map((p) => draftTargetKey(p.payload))));

    for (const proposal of proposals) {
      const id = uuidv4();
      let status: 'open' | 'confirmed' = 'open';

      // The carve-out is by DOMAIN and it is not `writes`. A job may be allowed to propose
      // update_budget and still never apply one unattended: `writes` says what it may put in front
      // of the owner, AUTONOMOUS_DRAFT_KINDS says what may land without the owner.
      if (isAutonomousDraftKind(proposal.kind)) {
        const action: AdvisorDraftAction = {
          id,
          kind: proposal.kind,
          label: proposal.label,
          summary: proposal.summary,
          route: proposal.route,
          payload: proposal.payload,
          changes: proposal.changes,
          citations: proposal.citations,
          confirmation_required: true,
        };
        try {
          confirmAdvisorDraft(db, action, true, 'worker_auto');
          status = 'confirmed';
          applied++;
        } catch (err) {
          if (err instanceof DraftRefusedError) {
            // Policy, not failure: the guards read the owner's own rules and history and said no.
            // The draft stays open and the review queue still offers it, deliberately. The guards
            // have measured false positives, so hiding a suggestion because they would refuse it
            // buries a legitimate proposal with no reason and no way to see it.
            refusedByGuards++;
            console.log(`[ai:${job.name}] Guards refused draft ${id} (${err.reason}): ${err.detail}`);
          } else {
            console.error(`[ai:${job.name}] Auto-apply failed for draft ${id}, leaving it for review:`, err);
          }
        }
      }

      if (status === 'open') queued++;

      insertDraft.run(
        id,
        proposal.kind,
        proposal.label,
        proposal.summary,
        proposal.route,
        JSON.stringify(proposal.payload),
        JSON.stringify(proposal.changes),
        JSON.stringify(proposal.citations),
        status,
        now,
        now
      );
    }
  })();

  return { applied, queued, refusedByGuards };
}

// ─── The framework ───────────────────────────────────────────────────────────

/** Jobs already in flight. A pass awaits a slow model call; two must not overlap and double-apply. */
const running = new Set<AiJobName>();

function maxActionRowid(db: Database.Database): number {
  const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS max FROM advisor_actions`).get() as { max: number };
  return row.max;
}

/**
 * Run one pass of `job`, record it, and enforce what the job declared.
 *
 * The order is deliberate. Credentials are checked before any row is written, because an install
 * with no API key syncs hourly forever and a run row per hour saying "no key" is a log nobody can
 * act on and everybody stops reading. Everything after that leaves a row, including the quiet
 * outcome where the job had nothing to look at.
 *
 * Rejects rather than returning a `failed` outcome when the run row itself cannot be written: a
 * `failed` outcome names the row carrying its error message, and there is no row. The latch is
 * released either way, which is the part that matters. It used to be taken before the insert and
 * released only by the body's own `finally`, so a failed insert stranded the job's name in
 * `running` and every later trigger returned 'already_running' until the process restarted.
 */
export async function runAiJob(
  job: AiJobDeclaration,
  collect: AiJobCollect,
  options: AiJobRunOptions
): Promise<AiJobOutcome> {
  if (!hasAnthropicCredentials()) {
    console.log(`[ai:${job.name}] Skipped: no Anthropic credentials configured.`);
    return { status: 'skipped', reason: 'no_credentials', runId: null };
  }

  const db = options.db;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();

  if (running.has(job.name)) {
    // Recorded rather than dropped: a trigger skipped because the previous pass is still in flight
    // is the first thing worth seeing when the model appears to have stopped working.
    const runId = startRunRow(db, job, options, startedAt);
    closeRunRow(db, runId, clock().toISOString(), { status: 'skipped', skippedReason: 'already_running' });
    console.log(`[ai:${job.name}] Skipped: a pass is already running.`);
    return { status: 'skipped', reason: 'already_running', runId };
  }

  running.add(job.name);
  try {
    return await runOnePass(job, collect, options, startedAt, clock);
  } finally {
    running.delete(job.name);
  }
}

/** The body of a pass, with the re-entrancy latch already held by `runAiJob`. */
async function runOnePass(
  job: AiJobDeclaration,
  collect: AiJobCollect,
  options: AiJobRunOptions,
  startedAt: string,
  clock: () => Date
): Promise<AiJobOutcome> {
  const db = options.db;
  const runId = startRunRow(db, job, options, startedAt);

  try {
    const collected = await collect({ db, startedAt, runId });

    if (collected.status === 'nothing_to_do') {
      closeRunRow(db, runId, clock().toISOString(), {
        status: 'skipped',
        skippedReason: 'nothing_to_do',
        errorMessage: undefined,
      });
      console.log(`[ai:${job.name}] Nothing to review: ${collected.detail}`);
      return { status: 'skipped', reason: 'nothing_to_do', detail: collected.detail, runId };
    }

    let malformed = collected.malformed;
    let refusedOutOfScope = 0;
    const allowed: AiJobProposal[] = [];
    for (const proposal of collected.proposals) {
      if (proposal.kind !== proposal.payload.kind) {
        malformed++;
        console.warn(`[ai:${job.name}] Dropped a proposal whose payload kind is ${proposal.payload.kind}, not ${proposal.kind}.`);
        continue;
      }
      if (!job.writes.includes(proposal.kind)) {
        refusedOutOfScope++;
        console.warn(`[ai:${job.name}] Refused a '${proposal.kind}' proposal: this job declares writes of ${job.writes.join(', ') || '(none)'}.`);
        continue;
      }
      allowed.push(proposal);
    }

    // Nothing else can write between these two reads: better-sqlite3 is synchronous and
    // persistProposals awaits nothing, so `rowid >` attributes exactly this pass's actions.
    const rowidBefore = maxActionRowid(db);
    const persisted = persistProposals(db, job, allowed, startedAt);
    const actions = db
      .prepare(`SELECT id, kind, source FROM advisor_actions WHERE rowid > ?`)
      .all(rowidBefore) as AppliedAction[];

    const breaches = evaluateAiJobInvariants(db, actions, job.invariants);
    for (const breach of breaches) {
      console.error(`[ai:${job.name}] Invariant ${breach.invariant} broke: ${breach.detail}`);
    }

    const counts: AiJobCounts = {
      proposed: allowed.length,
      applied: persisted.applied,
      queued: persisted.queued,
      refused_by_guards: persisted.refusedByGuards,
      refused_out_of_scope: refusedOutOfScope,
      malformed,
    };

    closeRunRow(db, runId, clock().toISOString(), {
      status: 'completed',
      counts,
      usage: collected.usage,
      breaches,
    });

    if (counts.applied > 0) {
      // The client already dropped its caches on sync_complete, which this pass runs after. Without
      // this it renders pre-AI category totals until something else invalidates them.
      options.emit?.({
        type: 'ai_pass_applied',
        message: `AI review applied ${counts.applied} change${counts.applied === 1 ? '' : 's'}`,
        job: job.name,
        applied: counts.applied,
      });
    }

    console.log(
      `[ai:${job.name}] ${counts.proposed} proposed, ${counts.applied} applied, ${counts.queued} queued` +
      `${counts.refused_by_guards ? `, ${counts.refused_by_guards} refused by guards` : ''}` +
      `${counts.refused_out_of_scope ? `, ${counts.refused_out_of_scope} outside this job's writes` : ''}` +
      `${counts.malformed ? `, ${counts.malformed} malformed` : ''}.`
    );

    return { status: 'completed', runId, breaches, ...counts };
  } catch (err) {
    const message = (err as Error).message || 'AI job failed';
    console.error(`[ai:${job.name}] Pass failed:`, err);
    try {
      closeRunRow(db, runId, clock().toISOString(), { status: 'failed', errorMessage: message });
    } catch (closeErr) {
      // The pass failed and so did recording it. Say both; a swallowed close leaves a row stuck
      // at 'running' with no explanation anywhere.
      console.error(`[ai:${job.name}] Could not record the failed pass:`, closeErr);
    }
    return { status: 'failed', runId, message };
  }
}
