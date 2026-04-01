import { Router, Request, Response } from 'express';
import { addSseClient, removeSseClient } from '../services/syncManager';

const router = Router();

// GET / — SSE endpoint
router.get('/', (req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Flush headers immediately
  res.flushHeaders();

  // Send initial keepalive comment
  res.write(': keepalive\n\n');

  addSseClient(res);

  // Send periodic keepalive to prevent proxy timeouts
  const keepaliveInterval = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepaliveInterval);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepaliveInterval);
    removeSseClient(res);
  });
});

export default router;
