import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { CreateGoalSchema, UpdateGoalSchema } from '../../../shared/schemas';
import { calculateGoalProgress } from '../services/goalProgress';
import { toCents, toCentsOrNull, toDollars, toDollarsOrNull } from '../services/money';
import type { Goal, GoalType } from '../../../shared/types';

const router = Router();

interface GoalRow {
  id: string;
  name: string;
  type: GoalType;
  target_amount: number;
  current_amount: number;
  starting_amount: number | null;
  account_id: string | null;
  target_date: string | null;
  color: string | null;
  is_archived: number;
  created_at: string;
  updated_at: string;
  account_name: string | null;
  institution_name: string | null;
  account_balance: number | null;
  account_is_liability: number | null;
}

function goalSelect(where: string): string {
  return `
    SELECT
      g.*,
      a.account_name,
      a.institution_name,
      a.current_balance AS account_balance,
      a.is_liability AS account_is_liability
    FROM goals g
    LEFT JOIN accounts a ON a.id = g.account_id
    ${where}
  `;
}

function accountExists(db: Database.Database, accountId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId));
}

function normalizeAccountId(accountId: string | null | undefined): string | null {
  return accountId && accountId.trim().length > 0 ? accountId : null;
}

function getParamId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function toGoal(row: GoalRow): Goal {
  const progress = calculateGoalProgress(row);

  // Row and progress money fields are cents; dollarize at this response boundary.
  // progress_percent is a ratio, not money.
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    target_amount: toDollars(row.target_amount),
    current_amount: toDollars(progress.current_amount),
    starting_amount: toDollarsOrNull(row.starting_amount),
    account_id: row.account_id,
    target_date: row.target_date,
    color: row.color,
    is_archived: Boolean(row.is_archived),
    created_at: row.created_at,
    updated_at: row.updated_at,
    progress_amount: toDollars(progress.progress_amount),
    remaining_amount: toDollars(progress.remaining_amount),
    progress_percent: progress.progress_percent,
    account_name: row.account_name,
    institution_name: row.institution_name,
    account_balance: toDollarsOrNull(row.account_balance),
    account_is_liability: row.account_is_liability === null
      ? null
      : Boolean(row.account_is_liability),
  };
}

function getGoal(db: Database.Database, id: string): Goal | null {
  const row = db.prepare(`${goalSelect('WHERE g.id = ?')} LIMIT 1`).get(id) as GoalRow | undefined;
  return row ? toGoal(row) : null;
}

// GET / - list active goals
router.get('/', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const includeArchived = req.query.includeArchived === 'true';
    const rows = db.prepare(`
      ${goalSelect(includeArchived ? '' : 'WHERE g.is_archived = 0')}
      ORDER BY g.is_archived ASC, g.created_at ASC
    `).all() as GoalRow[];

    res.json({ data: rows.map(toGoal) });
  } catch (err) {
    next(err);
  }
});

// POST / - create goal
router.post(
  '/',
  validate(CreateGoalSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const body = req.body as {
        name: string;
        type: GoalType;
        target_amount: number;
        current_amount?: number;
        starting_amount?: number | null;
        account_id?: string | null;
        target_date?: string | null;
        color?: string | null;
      };
      const accountId = normalizeAccountId(body.account_id);

      if (accountId && !accountExists(db, accountId)) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }

      const now = new Date().toISOString();
      const id = uuidv4();
      // User-supplied starting_amount is dollars -> cents; the account-seeded value
      // reads current_balance which is already cents.
      let startingAmount = toCentsOrNull(body.starting_amount ?? null);

      if (body.type === 'debt' && accountId && startingAmount === null) {
        const account = db.prepare(
          'SELECT current_balance FROM accounts WHERE id = ?'
        ).get(accountId) as { current_balance: number };
        startingAmount = Math.max(account.current_balance, 0);
      }

      db.prepare(`
        INSERT INTO goals
          (id, name, type, target_amount, current_amount, starting_amount,
           account_id, target_date, color, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        id,
        body.name,
        body.type,
        toCents(body.target_amount),
        toCents(body.current_amount ?? 0),
        startingAmount,
        accountId,
        body.target_date ?? null,
        body.color ?? null,
        now,
        now
      );

      res.status(201).json({ data: getGoal(db, id) });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /:id - update goal
router.patch(
  '/:id',
  validate(UpdateGoalSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const id = getParamId(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Invalid goal id' });
        return;
      }

      const existing = getGoal(db, id);
      if (!existing) {
        res.status(404).json({ error: 'Goal not found' });
        return;
      }

      const body = req.body as {
        name?: string;
        type?: GoalType;
        target_amount?: number;
        current_amount?: number;
        starting_amount?: number | null;
        account_id?: string | null;
        target_date?: string | null;
        color?: string | null;
        is_archived?: boolean;
      };

      const updates: string[] = [];
      const values: unknown[] = [];
      const addUpdate = (column: string, value: unknown): void => {
        updates.push(`${column} = ?`);
        values.push(value);
      };

      if (body.name !== undefined) addUpdate('name', body.name);
      if (body.type !== undefined) addUpdate('type', body.type);
      if (body.target_amount !== undefined) addUpdate('target_amount', toCents(body.target_amount));
      if (body.current_amount !== undefined) addUpdate('current_amount', toCents(body.current_amount));
      if (body.starting_amount !== undefined) addUpdate('starting_amount', toCentsOrNull(body.starting_amount));
      if (body.account_id !== undefined) {
        const accountId = normalizeAccountId(body.account_id);
        if (accountId && !accountExists(db, accountId)) {
          res.status(404).json({ error: 'Account not found' });
          return;
        }
        addUpdate('account_id', accountId);
      }
      if (body.target_date !== undefined) addUpdate('target_date', body.target_date);
      if (body.color !== undefined) addUpdate('color', body.color);
      if (body.is_archived !== undefined) addUpdate('is_archived', body.is_archived ? 1 : 0);

      if (updates.length > 0) {
        addUpdate('updated_at', new Date().toISOString());
        values.push(id);
        db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }

      res.json({ data: getGoal(db, id) });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /:id - delete goal
router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = getParamId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid goal id' });
      return;
    }

    const existing = db.prepare('SELECT id FROM goals WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
