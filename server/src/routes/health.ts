import { Router, Request, Response, NextFunction } from 'express';
import { getDb, DB_PATH } from '../db/index';

const router = Router();

// GET / — health check
router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();

    const countRow = db.prepare(
      "SELECT COUNT(*) as count FROM accounts WHERE is_hidden = 0"
    ).get() as { count: number };

    res.json({
      data: {
        status: 'ok',
        version: '0.1.0',
        dbPath: DB_PATH,
        connectedAccounts: countRow.count,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
