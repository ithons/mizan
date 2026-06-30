import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { SimplefinCredentialsSchema } from '../../../shared/schemas';
import { updateSimplefin, removeSimplefin } from '../services/credentials';
import axios from 'axios';

const router = Router();

// POST /setup
router.post(
  '/setup',
  validate(SimplefinCredentialsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { setupToken } = req.body as { setupToken: string };

      // Decode the base64 setup token to get the claim URL
      const decoded = Buffer.from(setupToken, 'base64').toString('utf-8');
      const accessUrl = await axios.post(decoded).then(r => r.data as string);

      updateSimplefin(accessUrl);

      const db = getDb();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO simplefin_connections (id, access_url, status, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(access_url) DO UPDATE SET status = 'active'`
      ).run('simplefin_primary', accessUrl, 'active', now);

      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

// GET /connection
router.get('/connection', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const item = db.prepare(
      "SELECT * FROM simplefin_connections WHERE status != 'removed' LIMIT 1"
    ).get();

    res.json({ data: item || null });
  } catch (err) {
    next(err);
  }
});

// DELETE /connection
router.delete('/connection', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      "UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE connection_type = 'simplefin'"
    ).run(now);

    removeSimplefin();

    db.prepare(
      "UPDATE simplefin_connections SET status = 'removed'"
    ).run();

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
