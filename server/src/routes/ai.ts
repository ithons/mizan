import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { providerForModel, providerStatuses } from '../services/aiProviders';
import { resolveCredential } from '../services/aiProviders/credentials';
import { clearProviderKey, setProviderKey } from '../services/aiProviders/credentials';
import { AI_PROVIDER_IDS, type AiProviderId, type ChatStreamEvent } from '../services/aiProviders/types';
import { buildAdvisorContextSnapshot, ADVISOR_SYSTEM_PROMPT, ADVISOR_PROFILE_PREFERENCE_KEY } from '../services/aiContext';
import { getPreference, setPreference } from '../services/preferences';
import {
  buildChatTurns,
  createConversation,
  listConversations,
  getConversation,
  appendMessages,
  deleteConversation,
  type ConversationMessage,
} from '../services/conversations';
import {
  buildAiDigest,
  DEFAULT_DIGEST_ACTION_LIMIT,
  MAX_REVERT_ACTIONS,
  revertAiDigestSince,
} from '../services/aiDigest';
import {
  confirmAdvisorDraft,
  confirmAdvisorDraftsByIds,
  dismissAdvisorDraft,
  listAdvisorActions,
  listDeclinedProposals,
  restoreDeclinedProposal,
  undoAdvisorAction,
} from '../services/advisorDrafts';
import { DRAFT_KIND_AUTONOMY } from '../services/draftAutonomy';
import { analyzeAdvisorQuestion } from '../services/advisorTools';
import { createMemory, deleteMemory, listMemories, supersedeMemory } from '../services/aiMemory';
import { ADVISOR_TOOLS, ADVISOR_TOOL_SPECS, runAdvisorTool } from '../services/advisorChatTools';
import {
  MODEL_CAPABILITIES,
  getAdvisorModel,
  getAdvisorSettings,
  getJobModel,
  updateAdvisorSettings,
} from '../services/advisorSettings';
import { suggestCategoriesForMerchants } from '../services/aiCategorySuggest';
import type {
  AdvisorAutonomyEntry,
  AdvisorConfirmRequest,
  AdvisorDraftActionKind,
  ChatMessage,
} from '../../../shared/types';

const router = Router();

/**
 * Agentic-loop bound for POST /chat: stream a turn; if the model asks for a (read-only) tool,
 * run it, feed the result back, and stream again. Bounded so a misbehaving model can't loop
 * forever. Exported so a test asserts against the same bound the loop uses.
 */
export const MAX_TOOL_ROUNDS = 8;

/**
 * Output ceiling for one chat turn.
 *
 * Not a measured figure: no token count was ever taken for a turn here. It is a deliberately
 * generous bound set so that truncation cannot be the failure mode, capped at whatever the
 * chosen model actually accepts so a request can never ask a model for more than it allows.
 */
const CHAT_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Longer than any SDK default: the owner is watching this one, it streams, and a turn at the
 * top effort level with tool rounds can legitimately run for minutes.
 */
const CHAT_TIMEOUT_MS = 600_000;

// GET /api/ai/context - return the financial context snapshot (for the UI preview panel)
router.get('/context', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const snapshot = buildAdvisorContextSnapshot();
    // Reported for the provider the ADVISOR would actually call, not for Anthropic. Gating
    // this on one provider while the owner has pointed the advisor at another is how a
    // working configuration reads as "not set up".
    const advisor = providerForModel(getAdvisorModel(getDb()));
    res.json({
      data: {
        ...snapshot,
        configured: advisor.isConfigured(),
        credential_source: resolveCredential(advisor.id).source,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- Persistent chat conversations ---

// GET /api/ai/conversations - list saved conversations, newest first
router.get('/conversations', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: listConversations(getDb()) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/conversations - start a new (empty) conversation
router.post('/conversations', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    res.json({ data: createConversation(getDb(), title) });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/conversations/:id - full message history for one conversation
router.get('/conversations/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const conversation = getConversation(getDb(), id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ data: conversation });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/conversations/:id/messages - append a settled exchange
router.post('/conversations/:id/messages', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!raw) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }
    const msgs: ConversationMessage[] = [];
    for (const m of raw) {
      if ((m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string') {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    const result = appendMessages(getDb(), id, msgs);
    if (!result.ok) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ai/conversations/:id
router.delete('/conversations/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = deleteConversation(getDb(), id);
    if (result.changed === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/actions - audit trail of AI actions that mutated the database
router.get('/actions', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: listAdvisorActions(getDb()) });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/declined - every proposal the owner dismissed, and which ones still suppress.
//
// Dismissing a draft is not just a status flip: `ownerDeclinedProposal` reads the record back and
// refuses the same proposal on the unattended path forever. That is a standing decision, so it needs
// a surface, and this is it. Unlimited for the same reason /actions is.
router.get('/declined', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: listDeclinedProposals(getDb()) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/declined/:id/restore - take one decline back.
//
// State-changing, so it is a POST and the origin check applies (middleware/localGuard.ts).
router.post('/declined/:id/restore', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = restoreDeclinedProposal(getDb(), id);
    if (!result.ok) {
      res.status(404).json({ error: 'No declined suggestion with that id' });
      return;
    }
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/autonomy - which draft kinds apply unattended, straight off DRAFT_KIND_AUTONOMY.
//
// Exposed because three owner-facing surfaces need the boundary and the client cannot import a
// service that opens a database. Only the decision crosses the wire; the argument behind each one
// stays on the server, and the wording the owner reads is the client's.
router.get('/autonomy', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const kinds: AdvisorAutonomyEntry[] = (
      Object.keys(DRAFT_KIND_AUTONOMY) as AdvisorDraftActionKind[]
    ).map((kind) => ({ kind, autonomy: DRAFT_KIND_AUTONOMY[kind].autonomy }));
    res.json({ data: { kinds } });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/actions/:id/undo - reverse every categorization an AI action made.
// Each affected row carries the action id and the category it displaced, so this restores the
// exact prior state. Rows the user has edited by hand since are skipped (a manual edit clears
// category_action_id), and any merchant rule the action created is left alone.
router.post('/actions/:id/undo', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = undoAdvisorAction(getDb(), id);
    if (!result.ok) {
      // Do not assert a cause the server did not verify. `nothing_to_undo` means no revision from
      // this action is still the newest for its transaction: a later action may have written the
      // same rows, the rows may have been hand-edited, or the action may never have changed a row
      // at all. Blaming a hand edit specifically was a guess, and usually the wrong one.
      res.status(result.reason === 'not_found' ? 404 : 409).json({
        error: result.reason === 'not_found'
          ? 'Action not found'
          : 'Nothing left to undo for this action: its changes have since been superseded.',
      });
      return;
    }
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// --- What the AI changed ---

/**
 * ISO-8601 date, or date and time, with an optional zone. `Date.parse` alone is not this check:
 * it accepts 'Jan 1 2020', and `since` is compared LEXICOGRAPHICALLY against ISO `created_at`
 * strings, where that form sorts above every real timestamp and silently selects nothing. A revert
 * then returns ok having planned and reverted zero rows, which reads as success.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * An ISO timestamp normalized to UTC, or null for "everything on record".
 *
 * Normalized rather than passed through, for the same lexicographic reason: '2026-07-01T00:00+02:00'
 * parses fine and then compares wrongly against `created_at` values stored as `toISOString()` UTC.
 */
function parseSince(raw: unknown): { ok: true; since: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, since: null };
  if (typeof raw !== 'string' || !ISO_TIMESTAMP.test(raw) || Number.isNaN(Date.parse(raw))) {
    return { ok: false, error: 'since must be an ISO-8601 timestamp, e.g. 2026-07-01T00:00:00.000Z' };
  }
  return { ok: true, since: new Date(raw).toISOString() };
}

/** Optional positive-integer query/body field, bounded. Absent means "use the default". */
function parseLimit(
  raw: unknown,
  max: number
): { ok: true; limit: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, limit: null };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return { ok: false, error: `limit must be an integer between 1 and ${max}` };
  }
  return { ok: true, limit: parsed };
}

// GET /api/ai/digest?since=<iso>&limit=<n> - every row the AI touched, grouped by the action that
// caused it, with what each row was and what it is now.
router.get('/digest', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const since = parseSince(req.query.since);
    if (!since.ok) {
      res.status(400).json({ error: since.error });
      return;
    }

    const limit = parseLimit(req.query.limit, MAX_REVERT_ACTIONS);
    if (!limit.ok) {
      res.status(400).json({ error: limit.error });
      return;
    }

    res.json({
      data: buildAiDigest(getDb(), {
        since: since.since,
        limit: limit.limit ?? DEFAULT_DIGEST_ACTION_LIMIT,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/digest/revert - put back every row the AI changed since a timestamp, in one gesture.
// Rows a later write has displaced are reported rather than reverted: the result carries the plan
// beside the outcome so it cannot read as more complete than it was.
//
// `limit` is the caller's own digest page size, so the revert plans over exactly the actions the
// caller was shown. Omitted, it falls back to the same default GET /digest uses, which is what the
// client gets when it asks for a digest without a limit.
router.post('/digest/revert', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const parsed = parseSince(req.body?.since);
    if (!parsed.ok || parsed.since === null) {
      res.status(400).json({ error: 'since (ISO-8601 timestamp) is required' });
      return;
    }

    const limit = parseLimit(req.body?.limit, MAX_REVERT_ACTIONS);
    if (!limit.ok) {
      res.status(400).json({ error: limit.error });
      return;
    }

    const outcome = revertAiDigestSince(
      getDb(),
      parsed.since,
      limit.limit ?? DEFAULT_DIGEST_ACTION_LIMIT
    );
    if (!outcome.ok) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    res.json({ data: outcome.result });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/profile - the user's editable personal context injected into every AI prompt
router.get('/profile', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const pref = getPreference(getDb(), ADVISOR_PROFILE_PREFERENCE_KEY);
    const profile = typeof pref?.value === 'string' ? pref.value : '';
    res.json({ data: { profile } });
  } catch (err) {
    next(err);
  }
});

// PUT /api/ai/profile - replace the user's personal context (empty string clears it)
router.put('/profile', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
    if (profile === null) {
      res.status(400).json({ error: 'profile (string) is required' });
      return;
    }
    if (profile.length > 4000) {
      res.status(400).json({ error: 'profile must be 4000 characters or fewer' });
      return;
    }
    setPreference(getDb(), ADVISOR_PROFILE_PREFERENCE_KEY, profile.trim());
    res.json({ data: { profile: profile.trim() } });
  } catch (err) {
    next(err);
  }
});

// --- Standing statements the advisor reasons from (ai_memory) ---
//
// Every write goes through services/aiMemory.ts, which checks the SHAPE of the row and nothing
// about the sentence: no statement is refused for carrying a figure, because no pattern separates a
// disposition from a measurement. Whatever is refused, the reason is returned verbatim so the owner
// is told what was wrong rather than that "something failed". Nothing here writes source = 'ai':
// the model has no route into this store in this build.

// GET /api/ai/memory - live statements, each with the ones it replaced
router.get('/memory', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: listMemories(getDb()) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/memory - record a statement
router.post('/memory', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const result = createMemory(getDb(), req.body, 'owner');
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ data: result.memory });
  } catch (err) {
    next(err);
  }
});

// PUT /api/ai/memory/:id - replace a statement, keeping what it used to say.
// Not an edit in place: a belief that changed has a history, for the same reason merchant rules
// and transaction categories keep revision tables.
router.put('/memory/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = supersedeMemory(getDb(), id, req.body, 'owner');
    if (!result.ok) {
      res.status(result.not_found ? 404 : 400).json({ error: result.error });
      return;
    }
    res.json({ data: result.memory });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ai/memory/:id - strike a statement and the chain behind it
router.delete('/memory/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (deleteMemory(getDb(), id).changed === 0) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/settings - advisor model/effort/context-section config + the option lists
router.get('/settings', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: getAdvisorSettings(getDb()) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/ai/settings - update any subset of the advisor config (server-validated against whitelists)
router.put('/settings', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const result = updateAdvisorSettings(getDb(), req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ data: result.settings });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/suggest-categories - advisory category proposals for uncategorized merchants.
// Read-only: nothing is written, the user applies suggestions from the review worklist.
router.post('/suggest-categories', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const raw = Array.isArray(req.body?.merchants) ? req.body.merchants : null;
    if (!raw) {
      res.status(400).json({ error: 'merchants (string array) is required' });
      return;
    }
    const merchants = raw.filter((m: unknown): m is string => typeof m === 'string');
    // Checked against the provider serving THIS job, which the owner may have retiered away
    // from the advisor's. `suggestCategoriesForMerchants` returns [] when it cannot call
    // anything, and an empty list here would read as "no merchant could be identified".
    const classifier = providerForModel(getJobModel(getDb(), 'bulk_categorization').model);
    if (!classifier.isConfigured()) {
      res.status(503).json({ error: `No ${classifier.id} credentials configured: AI suggestions are unavailable` });
      return;
    }
    res.json({ data: await suggestCategoriesForMerchants(getDb(), merchants) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/analyze - local read-tool analysis with provenance
// Note: Unlike `/chat`, this endpoint is purely a local, heuristic-based regex/DB resolver.
// It does NOT hit Anthropic or any LLM. It is designed to be sub-millisecond fast for
// real-time keystroke evaluation (e.g. in the Command Palette).
router.post('/analyze', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) {
      res.status(400).json({ error: 'question is required' });
      return;
    }

    res.json({ data: analyzeAdvisorQuestion(getDb(), question) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/confirm - apply a typed advisor draft after explicit confirmation
router.post('/confirm', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const body = req.body as Partial<AdvisorConfirmRequest>;
    if (!body.draft || body.confirm !== true) {
      res.status(400).json({ error: 'confirmed draft is required' });
      return;
    }

    res.json({ data: confirmAdvisorDraft(getDb(), body.draft, body.confirm) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/drafts/confirm - apply several persisted worker drafts at once.
// Takes ids only: payloads are read back from advisor_drafts so a batch can never apply work the
// worker did not propose. Partial success is normal and is reported per draft.
router.post('/drafts/confirm', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const raw = req.body?.ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      res.status(400).json({ error: 'ids (non-empty array) is required' });
      return;
    }

    const ids: string[] = [];
    for (const entry of raw) {
      const id = typeof entry === 'string' ? entry.trim() : '';
      if (!id) {
        res.status(400).json({ error: 'each id must be a non-empty string' });
        return;
      }
      ids.push(id);
    }

    res.json({ data: confirmAdvisorDraftsByIds(getDb(), ids) });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/drafts/:id/dismiss - dismiss a persisted background-worker draft
router.post('/drafts/:id/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = dismissAdvisorDraft(getDb(), id);
    if (result.changed === 0) {
      res.status(404).json({ error: 'Draft not found or already resolved' });
      return;
    }
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/chat - streaming chat with financial advisor.
//
// Two accepted shapes, and the first is the one the client uses. `{ conversation_id, message }`
// makes the server read the thread out of its own tables and append only the new turn, so what sits
// in front of the cached system block is something the server built. `{ messages }` is the path for
// a turn with no conversation behind it (the client creates the conversation row best-effort, and
// chat has to survive that write failing); it is not a fallback for an id that failed to load,
// which is a 404 instead.
router.post('/chat', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const body = req.body as {
    messages?: ChatMessage[];
    conversation_id?: string | null;
    message?: string | null;
  };
  const supplied = Array.isArray(body.messages)
    ? body.messages.filter(
        (m): m is ChatMessage =>
          (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string'
      )
    : null;

  const turns = buildChatTurns(getDb(), {
    conversationId: body.conversation_id,
    message: body.message,
    clientMessages: supplied,
  });
  if (!turns.ok) {
    if (turns.reason === 'conversation_not_found') {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.status(400).json({ error: 'messages array, or conversation_id with message, is required' });
    return;
  }
  const messages = turns.messages;

  const db = getDb();
  const { model, effort } = getAdvisorSettings(db);

  let provider;
  try {
    provider = providerForModel(model);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
    return;
  }
  if (!provider.isConfigured()) {
    res.status(503).json({
      error: `No credentials configured for ${provider.id}. Add a key in Settings, or pick a model from a provider that has one.`,
    });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const snapshot = buildAdvisorContextSnapshot();
  // The stable prefix, identical for every provider. The financial context does not change
  // shape to suit a caching mechanism; each adapter decides how to cache THIS text, and none
  // of them may alter it. Every figure in it must stay true whoever is being asked.
  const systemText = `${ADVISOR_SYSTEM_PROMPT}\n\n${snapshot.context}`;

  const emit = (event: ChatStreamEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const result = await provider.streamChat(
      {
        model,
        effort,
        systemText,
        tools: ADVISOR_TOOL_SPECS,
        turns: messages.map((m) => ({ role: m.role, content: m.content })),
        // Bounded by what the model itself accepts, from the capability table, so a request
        // can never ask a 64K-output model for 64,000 tokens it will not give.
        maxOutputTokens: Math.min(
          CHAT_MAX_OUTPUT_TOKENS,
          MODEL_CAPABILITIES[model]?.maxOutputTokens ?? CHAT_MAX_OUTPUT_TOKENS
        ),
        timeoutMs: CHAT_TIMEOUT_MS,
        maxToolRounds: MAX_TOOL_ROUNDS,
        // Most tools are pure SELECTs; two (categorize_transactions, create_merchant_rule)
        // write, scoped to the autonomous domain and routed through confirmAdvisorDraft so
        // each one lands in the audit trail and is undoable by action id. Model-authored SQL
        // still runs on the read-only connection only.
        runTool: (name, input) => runAdvisorTool(db, name, input),
      },
      emit
    );

    // Cache effectiveness is REPORTED, per provider, not assumed. A breakpoint that never
    // gets read still bills its write premium, and the usage figures are the only way to
    // tell that apart from a working cache.
    console.log(
      `[ai/chat] ${provider.id}/${model}: ${result.cacheNote}, uncached input ${result.usage.uncachedInputTokens} tok, output ${result.usage.outputTokens} tok`
    );

    if (result.failure) {
      emit_error(res, result.failure.message);
      return;
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    emit_error(res, (err as Error).message || 'AI request failed');
  }
});

/** Every non-answer leaves the stream the same way: an error frame, then close. */
function emit_error(res: Response, message: string): void {
  res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
  res.end();
}

// --- Per-provider credentials ---
//
// Keys land in the same AES-256-GCM store as the bank credentials, with `.env` taking
// precedence exactly as it does for Coinbase. Nothing here ever returns a key: the response
// says which source is in use and whether one exists, and that is all a settings screen needs.

function parseProviderId(raw: unknown): AiProviderId | null {
  const id = Array.isArray(raw) ? raw[0] : raw;
  return AI_PROVIDER_IDS.includes(id as AiProviderId) ? (id as AiProviderId) : null;
}

// GET /api/ai/providers - which providers can be reached, and how
router.get('/providers', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: { providers: providerStatuses() } });
  } catch (err) {
    next(err);
  }
});

// PUT /api/ai/providers/:provider/key - store a key for one provider
router.put('/providers/:provider/key', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const provider = parseProviderId(req.params.provider);
    if (!provider) {
      res.status(404).json({ error: 'Unknown provider' });
      return;
    }
    const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
    if (!apiKey) {
      res.status(400).json({ error: 'api_key (non-empty string) is required' });
      return;
    }
    setProviderKey(provider, apiKey);
    res.json({ data: { providers: providerStatuses() } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/ai/providers/:provider/key - forget a stored key.
// A key supplied through `.env` is not reachable from here and the response says so, rather
// than reporting success on a deletion that changed nothing the owner can see.
router.delete('/providers/:provider/key', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const provider = parseProviderId(req.params.provider);
    if (!provider) {
      res.status(404).json({ error: 'Unknown provider' });
      return;
    }
    clearProviderKey(provider);
    const after = providerStatuses().find((p) => p.id === provider);
    if (after?.source === 'env') {
      res.status(409).json({
        error: `The stored key was removed, but ${provider} is still configured from the environment.`,
      });
      return;
    }
    res.json({ data: { providers: providerStatuses() } });
  } catch (err) {
    next(err);
  }
});

export default router;
