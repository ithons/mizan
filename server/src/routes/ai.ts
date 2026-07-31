import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index';
import {
  anthropicCredentialSource,
  getAnthropicClient,
  hasAnthropicCredentials,
} from '../services/anthropicClient';
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
  undoAdvisorAction,
} from '../services/advisorDrafts';
import { DRAFT_KIND_AUTONOMY } from '../services/draftAutonomy';
import { analyzeAdvisorQuestion } from '../services/advisorTools';
import { createMemory, deleteMemory, listMemories, supersedeMemory } from '../services/aiMemory';
import { ADVISOR_TOOLS, runAdvisorTool } from '../services/advisorChatTools';
import { buildModelRequestShape, getAdvisorSettings, updateAdvisorSettings } from '../services/advisorSettings';
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

function getClient(): Anthropic {
  const client = getAnthropicClient();
  if (!client) {
    throw new Error(
      'No Anthropic credentials found. Set ANTHROPIC_API_KEY in .env, or ANTHROPIC_AUTH_TOKEN, or sign in with `ant auth login`.'
    );
  }
  return client;
}

// GET /api/ai/context - return the financial context snapshot (for the UI preview panel)
router.get('/context', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const snapshot = buildAdvisorContextSnapshot();
    res.json({
      data: {
        ...snapshot,
        configured: hasAnthropicCredentials(),
        credential_source: anthropicCredentialSource(),
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
    if (!hasAnthropicCredentials()) {
      res.status(503).json({ error: 'No Anthropic credentials configured — AI suggestions are unavailable' });
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

  let anthropic: Anthropic;
  try {
    anthropic = getClient();
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const db = getDb();
  const { model, effort } = getAdvisorSettings(db);
  const snapshot = buildAdvisorContextSnapshot();
  const systemText = `${ADVISOR_SYSTEM_PROMPT}\n\n${snapshot.context}`;

  // Seed from the reconstructed turns, then grow it as the model calls tools.
  const conversation: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));

  // Set once a turn ends with something other than another tool request. If the loop below
  // runs out of rounds while the model is still asking for tools, this stays false: the owner
  // would otherwise get a completed stream carrying tool_use events and no answer, the same
  // silent partial as a refusal or an empty content array.
  let answered = false;

  // Accumulated across every tool round so we can confirm the ephemeral cache on the stable
  // prefix (system prompt + snapshot + tool list) actually gets read back rather than re-billed.
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let uncachedInputTokens = 0;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = anthropic.messages.stream(
        {
          // model + effort are user-configurable (Settings -> Advisor), server-whitelisted to
          // the current Claude family in advisorSettings.ts.
          model,
          // Thinking tokens count against max_tokens, and this loop runs up to MAX_TOOL_ROUNDS
          // turns at an effort the owner picks. 64000 is not a measured figure: no token count
          // was ever taken for a turn here. It is a deliberately generous ceiling, set so that
          // truncation cannot be the failure mode. The SDK's non-streaming guard, which refuses
          // a large max_tokens and tells you to stream (`calculateNonstreamingTimeout` in
          // @anthropic-ai/sdk/client.js), never sees this request: it runs only for a
          // non-streaming create on a client with no timeout set, and this call streams.
          // What bounds the wall clock is the explicit per-request timeout below.
          max_tokens: 64000,
          // Derived from the model, never assumed: thinking mode, effort support and structured
          // output all differ across the family, and a request built without reference to the
          // model it names is the same latent defect the migration comments in db/migrations
          // record. A model this table does not know gets a bare request.
          ...buildModelRequestShape(model, { effort, thinkingDisplay: 'summarized' }),
          // Stable prefix (prompt + snapshot) is cached; ADVISOR_TOOLS is a fixed list, so the
          // cached prefix holds across every tool round of the conversation.
          system: [
            {
              type: 'text',
              text: systemText,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: ADVISOR_TOOLS,
          messages: conversation,
        },
        // Longer than the client default: the owner is watching this one, it streams, and a
        // turn at 'max' effort with tool rounds can legitimately run for minutes.
        { timeout: 600_000 }
      );

      let thinkingBlockIndex: number | null = null;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'thinking') {
            thinkingBlockIndex = event.index;
            res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
          } else if (event.content_block.type === 'tool_use') {
            // Surface tool activity so the UI can show e.g. "Looking at your transactions…".
            res.write(`data: ${JSON.stringify({ type: 'tool_use', name: event.content_block.name })}\n\n`);
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            res.write(`data: ${JSON.stringify({ type: 'chunk', text: event.delta.text })}\n\n`);
          } else if (event.delta.type === 'thinking_delta') {
            res.write(`data: ${JSON.stringify({ type: 'thinking', text: event.delta.thinking })}\n\n`);
          }
        } else if (event.type === 'content_block_stop' && event.index === thinkingBlockIndex) {
          res.write(`data: ${JSON.stringify({ type: 'thinking_end' })}\n\n`);
        }
      }

      const message = await stream.finalMessage();
      cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += message.usage.cache_creation_input_tokens ?? 0;
      uncachedInputTokens += message.usage.input_tokens;

      // A safety classifier can decline with an HTTP 200 and no content at all. Left
      // unhandled that reads as a successful, empty answer, so say what happened instead.
      if (message.stop_reason === 'refusal') {
        const detail = message.stop_details?.explanation ?? message.stop_details?.category ?? null;
        const reason = detail ? `The model declined to answer: ${detail}` : 'The model declined to answer.';
        res.write(`data: ${JSON.stringify({ type: 'error', message: reason })}\n\n`);
        res.end();
        return;
      }

      if (message.stop_reason !== 'tool_use') {
        // Same class: a 200 with an empty content array is not an answer.
        if (message.content.length === 0) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'The model returned an empty response.' })}\n\n`);
          res.end();
          return;
        }
        answered = true;
        break;
      }

      // Run every requested tool and feed the results back. Most are pure SELECTs; two
      // (categorize_transactions, create_merchant_rule) write, scoped to the autonomous domain
      // and routed through confirmAdvisorDraft so each one lands in the audit trail and is
      // undoable by action id. Model-authored SQL still runs on the read-only connection only.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          const result = runAdvisorTool(db, block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
      conversation.push({ role: 'assistant', content: message.content });
      conversation.push({ role: 'user', content: toolResults });
    }

    console.log(
      `[ai/chat] cache read ${cacheReadTokens} tok, cache write ${cacheCreationTokens} tok, uncached input ${uncachedInputTokens} tok`
    );

    // Ran out of rounds with the model still asking for tools. Every tool it asked for did run,
    // but no turn ever produced an answer, so this stream is not a completed one.
    if (!answered) {
      const message = `The advisor stopped after ${MAX_TOOL_ROUNDS} tool rounds without finishing its answer. Ask again, more narrowly.`;
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    const msg = (err as Error).message || 'AI request failed';
    res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
    res.end();
  }
});

export default router;
