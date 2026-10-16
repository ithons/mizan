import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { AdvisorDraftPayloadSchema } from '../../../shared/schemas';
import { SCHEDULED_ROUTE } from '../../../shared/routes';
import type { AdvisorDraftAction, AdvisorDraftActionKind } from '../../../shared/types';
import { isDraftStillActionable } from './advisorDrafts';
import { describeDraftChanges } from './draftDescriptions';

const ROUTE_FOR_KIND: Readonly<Record<AdvisorDraftActionKind, string>> = {
  categorize_transaction: '/ledger',
  create_merchant_rule: '/settings',
  retire_merchant_rule: '/settings',
  update_budget: '/plan',
  delete_budget: '/plan',
  update_goal_target: '/plan',
  create_goal: '/plan',
  confirm_recurring: SCHEDULED_ROUTE,
  dismiss_recurring: SCHEDULED_ROUTE,
  create_recurring_adjustment: SCHEDULED_ROUTE,
  set_manual_cost_basis: '/investments',
  set_sector_metadata: '/investments',
  update_account: '/accounts',
  set_notification_rule: '/settings?section=notifications',
  delete_notification_rule: '/settings?section=notifications',
};

export const MAX_PROPOSALS_PER_CALL = 20;

export interface ProposalsResult {
  proposed: AdvisorDraftAction[];
  refused: Array<{ index: number; reason: string }>;
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

/**
 * Stores each well-formed change as an open draft the owner confirms or dismisses. Nothing is
 * applied here: confirmation goes through confirmAdvisorDraftsByIds like any other draft.
 */
export function proposeChanges(db: Database.Database, input: { changes?: unknown }): ProposalsResult {
  const changes = Array.isArray(input.changes) ? input.changes.slice(0, MAX_PROPOSALS_PER_CALL) : [];
  const insert = db.prepare(`
    INSERT INTO advisor_drafts (id, kind, label, summary, route, payload, changes, citations, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'open', ?, ?)
  `);
  const sameOpen = db.prepare("SELECT id, label, summary FROM advisor_drafts WHERE status = 'open' AND payload = ? LIMIT 1");
  const result: ProposalsResult = { proposed: [], refused: [] };
  const now = new Date().toISOString();
  changes.forEach((raw, index) => {
    const change = (raw ?? {}) as { payload?: unknown; label?: unknown; summary?: unknown };
    const parsed = AdvisorDraftPayloadSchema.safeParse(change.payload);
    if (!parsed.success) {
      result.refused.push({ index, reason: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      return;
    }
    const payload = parsed.data;
    const payloadJson = JSON.stringify(payload);
    const changesOf = describeDraftChanges(db, payload);
    const existing = sameOpen.get(payloadJson) as { id: string; label: string; summary: string } | undefined;
    const draft: AdvisorDraftAction = {
      id: existing?.id ?? uuidv4(),
      kind: payload.kind,
      label: existing?.label ?? text(change.label, payload.kind.replace(/_/g, ' '), 80),
      summary: existing?.summary ?? text(change.summary, '', 400),
      route: ROUTE_FOR_KIND[payload.kind],
      payload,
      changes: changesOf,
      citations: [],
      confirmation_required: true,
    };
    if (!existing) insert.run(draft.id, draft.kind, draft.label, draft.summary, draft.route, payloadJson, JSON.stringify(changesOf), now, now);
    result.proposed.push(draft);
  });
  if (!Array.isArray(input.changes)) result.refused.push({ index: -1, reason: 'changes must be an array' });
  return result;
}

/** Open drafts whose premise still holds, newest first: what is waiting for the owner. */
export function listOpenDrafts(db: Database.Database, limit = 100): AdvisorDraftAction[] {
  const rows = db.prepare(`
    SELECT id, kind, label, summary, route, payload FROM advisor_drafts
    WHERE status = 'open' ORDER BY created_at DESC, id LIMIT ?
  `).all(limit) as Array<{ id: string; kind: AdvisorDraftActionKind; label: string; summary: string; route: string; payload: string }>;
  const drafts: AdvisorDraftAction[] = [];
  for (const row of rows) {
    const parsed = AdvisorDraftPayloadSchema.safeParse(JSON.parse(row.payload));
    if (!parsed.success || !isDraftStillActionable(db, parsed.data)) continue;
    drafts.push({ id: row.id, kind: row.kind, label: row.label, summary: row.summary, route: row.route, payload: parsed.data, changes: describeDraftChanges(db, parsed.data), citations: [], confirmation_required: true });
  }
  return drafts;
}
