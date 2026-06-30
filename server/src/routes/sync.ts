import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { addSseClient, removeSseClient, runFullSync } from '../services/syncManager';
import { getSyncHealth } from '../services/syncHealth';
import { getSyncRunDetail, listSyncRuns } from '../services/syncHistory';

const router = Router();

router.post('/run', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await runFullSync();
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

router.get('/health', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    res.json({ data: getSyncHealth(db) });
  } catch (err) {
    next(err);
  }
});

// GET /history - list recent sync runs
router.get('/history', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const parsedLimit = rawLimit ? Number(rawLimit) : 20;
    const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 20;

    res.json({ data: listSyncRuns(db, limit) });
  } catch (err) {
    next(err);
  }
});

// GET /history/:id - sync run detail with provider items and changes
router.get('/history/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const runId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    res.json({ data: getSyncRunDetail(db, runId) });
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
