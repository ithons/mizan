import { Router, Request, Response, NextFunction } from 'express';
import { addSseClient, removeSseClient, runFullSync } from '../services/syncManager';

const router = Router();

router.post('/run', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await runFullSync();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// GET /status - SSE endpoint
router.get('/status', (req: Request, res: Response): void => {
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
