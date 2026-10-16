import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate, validateQuery } from '../middleware/validate';
import {
  CreateNotificationRuleSchema,
  ListNotificationsQuerySchema,
  MarkNotificationsReadSchema,
  UpdateNotificationRuleSchema,
} from '../../../shared/schemas';
import {
  deleteNotificationRule,
  dismissNotification,
  evaluateNotifications,
  listNotificationRules,
  listNotifications,
  markNotificationsRead,
  notificationParamsFromDollars,
  notificationRuleToDollars,
  notificationToDollars,
  setNotificationRuleEnabled,
  unreadCount,
  upsertNotificationRule,
  type UpsertNotificationRuleInput,
} from '../services/notifications';

const router = Router();

interface ListQuery {
  unread_only: boolean;
  limit: number;
}

function paramId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

router.get('/', validateQuery(ListNotificationsQuerySchema), (req: Request, res: Response, next: NextFunction): void => {
  try {
    const query = (req as Request & { parsedQuery: ListQuery }).parsedQuery;
    const rows = listNotifications(getDb(), { unreadOnly: query.unread_only, limit: query.limit });
    res.json({ data: rows.map(notificationToDollars) });
  } catch (err) {
    next(err);
  }
});

router.get('/unread-count', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: { count: unreadCount(getDb()) } });
  } catch (err) {
    next(err);
  }
});

router.post('/read', validate(MarkNotificationsReadSchema), (req: Request, res: Response, next: NextFunction): void => {
  try {
    const { ids } = req.body as { ids: string[] | 'all' };
    res.json({ data: { marked: markNotificationsRead(getDb(), ids) } });
  } catch (err) {
    next(err);
  }
});

router.post('/evaluate', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const summary = evaluateNotifications(getDb());
    res.json({ data: { ...summary, created: summary.created.map(notificationToDollars) } });
  } catch (err) {
    next(err);
  }
});

router.get('/rules', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    res.json({ data: listNotificationRules(getDb()).map(notificationRuleToDollars) });
  } catch (err) {
    next(err);
  }
});

router.post('/rules', validate(CreateNotificationRuleSchema), (req: Request, res: Response, next: NextFunction): void => {
  try {
    const body = req.body as { kind: string; params: Record<string, unknown>; enabled?: boolean };
    const result = upsertNotificationRule(getDb(), {
      kind: body.kind,
      params: notificationParamsFromDollars(body.kind, body.params),
      enabled: body.enabled,
      created_by: 'owner',
    } as UpsertNotificationRuleInput);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json({ data: notificationRuleToDollars(result.rule) });
  } catch (err) {
    next(err);
  }
});

router.patch('/rules/:id', validate(UpdateNotificationRuleSchema), (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const id = paramId(req.params.id);
    const existing = id ? listNotificationRules(db).find((rule) => rule.id === id) : undefined;
    if (!existing) {
      res.status(404).json({ error: 'Notification rule not found' });
      return;
    }
    const body = req.body as { enabled?: boolean; params?: Record<string, unknown> };
    if (body.params === undefined) {
      res.json({ data: notificationRuleToDollars(setNotificationRuleEnabled(db, existing.id, body.enabled ?? existing.enabled) ?? existing) });
      return;
    }
    const result = upsertNotificationRule(db, {
      id: existing.id,
      kind: existing.kind,
      params: notificationParamsFromDollars(existing.kind, body.params),
      enabled: body.enabled,
    } as UpsertNotificationRuleInput);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ data: notificationRuleToDollars(result.rule) });
  } catch (err) {
    next(err);
  }
});

router.delete('/rules/:id', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = paramId(req.params.id);
    if (!id || !deleteNotificationRule(getDb(), id)) {
      res.status(404).json({ error: 'Notification rule not found' });
      return;
    }
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const id = paramId(req.params.id);
    if (!id || !dismissNotification(getDb(), id)) {
      res.status(404).json({ error: 'Notification not found or already dismissed' });
      return;
    }
    res.json({ data: { dismissed: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
