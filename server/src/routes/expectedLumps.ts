import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import { ExpectedLumpDecisionSchema } from '../../../shared/schemas';
import type { ExpectLumpPayload, ExpectedLumpsResponse } from '../../../shared/types';
import { dismissConfirmedLump, pendingConfirmedLumps } from '../services/expectedLumps';
import { openLumpCandidates } from '../services/expectedLumpCandidates';
import { proposeChanges } from '../services/advisorProposals';
import { confirmAdvisorDraftsByIds, dismissAdvisorDraft } from '../services/advisorDrafts';
import { toDollars } from '../services/money';

const router = Router();

router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const data: ExpectedLumpsResponse = {
      confirmed: pendingConfirmedLumps(db).map((lump) => ({
        id: lump.id,
        label: lump.label,
        amount_low: toDollars(lump.amount_low_cents),
        amount_high: toDollars(lump.amount_high_cents),
        window_start: lump.window_start,
        window_end: lump.window_end,
      })),
      candidates: openLumpCandidates(db).map((candidate) => ({
        payload: candidate.payload,
        occurrences: candidate.occurrences.map((o) => ({ date: o.date, amount: toDollars(o.amount) })),
        draft_id: candidate.draft_id,
      })),
    };
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post('/decide', validate(ExpectedLumpDecisionSchema), (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { payload, decision } = req.body as { payload: ExpectLumpPayload; decision: 'confirm' | 'dismiss' };
    const proposed = proposeChanges(db, {
      changes: [{ label: `Expect ${payload.label}`, summary: `${payload.label} has come back at irregular intervals.`, payload }],
    });
    const draft = proposed.proposed[0];
    if (!draft) {
      res.status(409).json({ error: proposed.refused[0]?.reason ?? 'That lump cannot be proposed' });
      return;
    }
    if (decision === 'dismiss') {
      dismissAdvisorDraft(db, draft.id);
      res.json({ data: { dismissed: true } });
      return;
    }
    const outcome = confirmAdvisorDraftsByIds(db, [draft.id]);
    if (outcome.applied !== 1) {
      const reason = outcome.outcomes[0]?.reason;
      res.status(409).json({ error: reason && reason !== 'apply_failed' ? reason : 'That lump could not be confirmed' });
      return;
    }
    res.json({ data: { confirmed: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/dismiss', (req: Request, res: Response, next: NextFunction): void => {
  try {
    if (!dismissConfirmedLump(getDb(), String(req.params.id))) {
      res.status(404).json({ error: 'No confirmed lump with that id' });
      return;
    }
    res.json({ data: { dismissed: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
