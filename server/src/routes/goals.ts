import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { CreateGoalSchema, UpdateGoalSchema } from '../../../shared/schemas';
import { calculateGoalProgress } from '../services/goalProgress';
import { createGoal, updateGoal, type CreateGoalInput, type UpdateGoalInput } from '../services/goals';
import { toDollars, toDollarsOrNull } from '../services/money';
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
      const result = createGoal(db, req.body as CreateGoalInput);
      if (!result.ok) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }
      const id = result.id;

      res.status(201).json({ data: getGoal(db, id) });
    } catch (err) {
      next(err);
    }
  }
);

const UPDATE_REFUSALS = {
  goal_not_found: { status: 404, error: 'Goal not found' },
  account_not_found: { status: 404, error: 'Account not found' },
  saved_amount_on_linked_goal: {
    status: 400,
    error: 'A linked goal has no saved amount of its own; its account balance is what it has saved. Unlink it to record one.',
  },
} as const;

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
      const result = updateGoal(db, id, req.body as UpdateGoalInput);
      if (!result.ok) {
        const refusal = UPDATE_REFUSALS[result.reason];
        res.status(refusal.status).json({ error: refusal.error });
        return;
      }
      res.json({ data: getGoal(db, id) });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
