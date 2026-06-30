import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { TellerExchangeTokenSchema } from '../../../shared/schemas';
import { saveTellerItemToken, removeTellerItemToken } from '../services/credentials';
import { takeSnapshot } from '../services/snapshot';

const router = Router();

// POST /exchange-token
router.post(
  '/exchange-token',
  validate(TellerExchangeTokenSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const { enrollmentId, accessToken } = req.body as {
        enrollmentId: string;
        accessToken: string;
      };

      saveTellerItemToken(enrollmentId, accessToken);
      
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO teller_items (id, enrollment_id, institution_name, status, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(enrollment_id) DO UPDATE SET status = 'active'`
      ).run(`teller_${enrollmentId}`, enrollmentId, 'Teller Connection', 'active', now);

      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

// GET /items
router.get('/items', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const items = db.prepare(
      "SELECT * FROM teller_items WHERE status != 'removed' ORDER BY created_at ASC"
    ).all();

    res.json({ data: items });
  } catch (err) {
    next(err);
  }
});

// DELETE /items/:id
router.delete('/items/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { id } = req.params;

    const item = db.prepare('SELECT * FROM teller_items WHERE id = ?').get(id) as
      | { id: string; enrollment_id: string }
      | undefined;

    if (!item) {
      res.status(404).json({ error: 'Teller item not found' });
      return;
    }

    const now = new Date().toISOString();

    db.prepare(
      "UPDATE accounts SET is_hidden = 1, updated_at = ? WHERE connection_id = ? AND connection_type = 'teller'"
    ).run(now, id);

    removeTellerItemToken(item.enrollment_id);

    db.prepare(
      "UPDATE teller_items SET status = 'removed' WHERE id = ?"
    ).run(id);

    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
