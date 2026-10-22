import type Database from 'better-sqlite3';
import { AdvisorDraftPayloadSchema } from '../../../shared/schemas';
import { draftLiveness } from './advisorDrafts';
import { safeJsonParse } from './jsonSafe';
import { candidatePayload, detectExpectedLumps, type ExpectLumpPayload, type LumpCandidate } from './expectedLumps';

export interface OpenLumpCandidate {
  payload: ExpectLumpPayload;
  occurrences: LumpCandidate['occurrences'];
  /** The open draft carrying this proposal, when one exists. */
  draft_id: string | null;
}

function openLumpDrafts(db: Database.Database): Array<{ id: string; payload: ExpectLumpPayload }> {
  const rows = db.prepare(`
    SELECT id, payload FROM advisor_drafts WHERE status = 'open' AND kind = 'expect_lump' ORDER BY created_at DESC
  `).all() as Array<{ id: string; payload: string }>;
  return rows.flatMap((row) => {
    const parsed = AdvisorDraftPayloadSchema.safeParse(safeJsonParse<unknown>(row.payload, null, `advisor_drafts.payload for ${row.id}`));
    return parsed.success && parsed.data.kind === 'expect_lump' ? [{ id: row.id, payload: parsed.data }] : [];
  });
}

/**
 * Every lump the owner could confirm now: open expect_lump drafts first, then the detector's
 * groups no draft already covers. Anything declined, lapsed or already confirmed is left out.
 */
export function openLumpCandidates(db: Database.Database, today = new Date()): OpenLumpCandidate[] {
  const detected = detectExpectedLumps(db, today);
  const occurrencesOf = (key: string) => detected.find((candidate) => candidate.merchant_key === key)?.occurrences ?? [];
  const out: OpenLumpCandidate[] = [];
  const seen = new Set<string>();
  for (const draft of openLumpDrafts(db)) {
    if (seen.has(draft.payload.merchant_key) || draftLiveness(db, draft.payload) === 'lapsed') continue;
    seen.add(draft.payload.merchant_key);
    out.push({ payload: draft.payload, occurrences: occurrencesOf(draft.payload.merchant_key), draft_id: draft.id });
  }
  for (const candidate of detected) {
    const payload = candidatePayload(candidate);
    if (seen.has(payload.merchant_key) || draftLiveness(db, payload) === 'lapsed') continue;
    seen.add(payload.merchant_key);
    out.push({ payload, occurrences: candidate.occurrences, draft_id: null });
  }
  return out;
}
