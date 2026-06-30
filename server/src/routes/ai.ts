import { Router, Request, Response, NextFunction } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { buildAdvisorContextSnapshot, ADVISOR_SYSTEM_PROMPT } from '../services/aiContext';
import type { ChatMessage } from '../../../shared/types';

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
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: `${ADVISOR_SYSTEM_PROMPT}\n\n${snapshot.context}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: event.delta.text })}\n\n`);
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
