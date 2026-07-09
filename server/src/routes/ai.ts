import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index';
import { buildAdvisorContextSnapshot, ADVISOR_SYSTEM_PROMPT } from '../services/aiContext';
import { confirmAdvisorDraft, dismissAdvisorDraft } from '../services/advisorDrafts';
import { analyzeAdvisorQuestion } from '../services/advisorTools';
import type { AdvisorConfirmRequest, ChatMessage } from '../../../shared/types';

const router = Router();

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in your .env file');
  return new Anthropic({ apiKey });
}

// GET /api/ai/context - return the financial context snapshot (for the UI preview panel)
router.get('/context', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const snapshot = buildAdvisorContextSnapshot();
    res.json({
      data: {
        ...snapshot,
        configured: Boolean(process.env.ANTHROPIC_API_KEY),
      },
    });
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

// POST /api/ai/chat - streaming chat with financial advisor
router.post('/chat', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const { messages } = req.body as { messages: ChatMessage[] };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array is required' });
    return;
  }

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

  try {
    const snapshot = buildAdvisorContextSnapshot();

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5',
      // Thinking tokens count against max_tokens; adaptive thinking at medium effort can
      // spend most of a smaller budget reasoning before ever writing the answer, truncating
      // the response (same class of bug fixed once already in aiWorker.ts, 1024->4096).
      max_tokens: 8192,
      // 'adaptive' is the only valid thinking mode for claude-sonnet-5 (budget_tokens 400s).
      // display: 'summarized' is required to get visible reasoning text back - the default
      // 'omitted' returns empty thinking blocks, making "thinking on" invisible to the user.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      system: [
        {
          type: 'text',
          text: `${ADVISOR_SYSTEM_PROMPT}\n\n${snapshot.context}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    let thinkingBlockIndex: number | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        thinkingBlockIndex = event.index;
        res.write(`data: ${JSON.stringify({ type: 'thinking_start' })}\n\n`);
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

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    const msg = (err as Error).message || 'AI request failed';
    res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
    res.end();
  }
});

export default router;
