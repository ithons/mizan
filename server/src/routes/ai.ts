import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index';
import { buildAdvisorContextSnapshot, ADVISOR_SYSTEM_PROMPT } from '../services/aiContext';
import { confirmAdvisorDraft, dismissAdvisorDraft } from '../services/advisorDrafts';
import { analyzeAdvisorQuestion } from '../services/advisorTools';
import { ADVISOR_TOOLS, runAdvisorTool } from '../services/advisorChatTools';
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

  const db = getDb();
  const snapshot = buildAdvisorContextSnapshot();
  const systemText = `${ADVISOR_SYSTEM_PROMPT}\n\n${snapshot.context}`;

  // Seed the conversation from the client turns, then grow it as the model calls tools.
  const conversation: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));

  // Agentic loop: stream a turn; if the model asks for a (read-only) tool, run it, feed the
  // result back, and stream again. Bounded so a misbehaving model can't loop forever.
  const MAX_TOOL_ROUNDS = 8;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-5',
        // Thinking tokens count against max_tokens; adaptive thinking at medium effort can
        // spend most of a smaller budget reasoning before ever writing the answer.
        max_tokens: 8192,
        // 'adaptive' is the only valid thinking mode for claude-sonnet-5 (budget_tokens 400s).
        // display: 'summarized' surfaces visible reasoning text ('omitted' returns empty blocks).
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'medium' },
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
      });

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
      if (message.stop_reason !== 'tool_use') break;

      // Run every requested tool (all strictly read-only) and feed the results back.
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

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    const msg = (err as Error).message || 'AI request failed';
    res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
    res.end();
  }
});

export default router;
