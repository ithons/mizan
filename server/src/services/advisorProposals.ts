import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { AdvisorDraftPayloadSchema, NotificationRuleParamsSchemas } from '../../../shared/schemas';
import { SCHEDULED_ROUTE } from '../../../shared/routes';
import type { AdvisorDraftAction, AdvisorDraftActionKind, AdvisorDraftPayload } from '../../../shared/types';
import { isDraftStillActionable, unpaidCardSentence } from './advisorDrafts';
import { unpaidCardPayment } from './cardPayments';
import { describeDraftChanges } from './draftDescriptions';
import { listNotificationRules, notificationParamsFromDollars } from './notifications';
import { expectLumpProblem } from './expectedLumps';

const ROUTE_FOR_KIND: Readonly<Record<AdvisorDraftActionKind, string>> = {
  categorize_transaction: '/ledger',
  link_reimbursement: '/ledger',
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
  expect_lump: '/plan',
};

export const MAX_PROPOSALS_PER_CALL = 20;

const exists = (db: Database.Database, sql: string, id: string | null | undefined) => !id || db.prepare(sql).get(id) !== undefined;

/** A proposal about a row that is not there is refused before it becomes a card. */
function referenceProblem(db: Database.Database, payload: AdvisorDraftPayload): string | null {
  const category = (id: string | null | undefined) => exists(db, 'SELECT 1 FROM categories WHERE id = ?', id);
  const account = (id: string | null | undefined) => exists(db, 'SELECT 1 FROM accounts WHERE id = ?', id);
  const pattern = (id: string) => exists(db, 'SELECT 1 FROM recurring_patterns WHERE id = ?', id);
  switch (payload.kind) {
    case 'update_budget': return category(payload.category_id) ? null : 'no category has that category_id';
    case 'delete_budget':
      if (!category(payload.category_id)) return 'no category has that category_id';
      return exists(db, 'SELECT 1 FROM budgets WHERE category_id = ?', payload.category_id) ? null : 'that category has no budget to remove';
    case 'create_goal': return account(payload.account_id) ? null : 'no account has that account_id';
    case 'update_goal_target': return exists(db, 'SELECT 1 FROM goals WHERE id = ?', payload.goal_id) ? null : 'no goal has that goal_id';
    case 'categorize_transaction':
      if (!exists(db, 'SELECT 1 FROM transactions WHERE id = ?', payload.transaction_id)) return 'no transaction has that transaction_id';
      return category(payload.category_id) ? null : 'no category has that category_id';
    case 'create_merchant_rule': return category(payload.category_id) ? null : 'no category has that category_id';
    case 'retire_merchant_rule': return exists(db, 'SELECT 1 FROM merchant_rules WHERE id = ? AND retired_at IS NULL', payload.rule_id) ? null : 'no live merchant rule has that rule_id';
    case 'confirm_recurring':
    case 'dismiss_recurring': return pattern(payload.recurring_id) ? null : 'no recurring pattern has that recurring_id';
    case 'create_recurring_adjustment': {
      if (!pattern(payload.recurring_id)) return 'no recurring pattern has that recurring_id';
      const unpaid = payload.action === 'skip' ? unpaidCardPayment(db, payload.recurring_id) : null;
      return unpaid ? unpaidCardSentence(unpaid) : null;
    }
    case 'link_reimbursement':
      return exists(db, 'SELECT 1 FROM transactions WHERE id = ? AND amount > 0', payload.reimbursement_id)
        && exists(db, 'SELECT 1 FROM transactions WHERE id = ? AND amount < 0', payload.purchase_id)
        ? null : 'reimbursement_id must name money in and purchase_id money out';
    case 'update_account': return account(payload.account_id) ? null : 'no account has that account_id';
    case 'set_manual_cost_basis': return exists(db, 'SELECT 1 FROM holdings WHERE id = ?', payload.holding_id) ? null : 'no holding has that holding_id';
    case 'set_sector_metadata': return exists(db, 'SELECT 1 FROM securities WHERE id = ?', payload.security_id) ? null : 'no security has that security_id';
    case 'set_notification_rule': return notificationRuleProblem(db, payload);
    case 'delete_notification_rule':
      return exists(db, 'SELECT 1 FROM notification_rules WHERE id = ?', payload.rule_id) ? null : 'no notification rule has that rule_id';
    case 'expect_lump': return expectLumpProblem(payload);
  }
}

// The same merge confirmSetNotificationRule makes, judged now, so a card that could only fail on
// confirm is never stored.
function notificationRuleProblem(
  db: Database.Database,
  payload: Extract<AdvisorDraftPayload, { kind: 'set_notification_rule' }>
): string | null {
  const existing = payload.rule_id ? listNotificationRules(db).find((rule) => rule.id === payload.rule_id) : undefined;
  if (payload.rule_id && !existing) return 'no notification rule has that rule_id';
  if (!Object.hasOwn(NotificationRuleParamsSchemas, payload.rule_kind)) {
    return `rule_kind must be one of ${Object.keys(NotificationRuleParamsSchemas).join(', ')}`;
  }
  if (existing && existing.kind !== payload.rule_kind) return 'a rule\'s kind cannot change';
  const kind = payload.rule_kind as keyof typeof NotificationRuleParamsSchemas;
  const params = { ...(existing?.params ?? {}), ...notificationParamsFromDollars(kind, payload.params) };
  const parsed = NotificationRuleParamsSchemas[kind].safeParse(params);
  return parsed.success ? null : `params: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`;
}

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
  const sameOpen = db.prepare("SELECT id FROM advisor_drafts WHERE status = 'open' AND payload = ? LIMIT 1");
  // Proposing the same change again proposes it now, against the ledger as it stands now.
  const reword = db.prepare('UPDATE advisor_drafts SET label = ?, summary = ?, changes = ?, created_at = ?, updated_at = ? WHERE id = ?');
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
    const problem = referenceProblem(db, payload);
    if (problem) {
      result.refused.push({ index, reason: problem });
      return;
    }
    const payloadJson = JSON.stringify(payload);
    const changesOf = describeDraftChanges(db, payload);
    const existing = sameOpen.get(payloadJson) as { id: string } | undefined;
    const draft: AdvisorDraftAction = {
      id: existing?.id ?? uuidv4(),
      kind: payload.kind,
      label: text(change.label, payload.kind.replace(/_/g, ' '), 80),
      summary: text(change.summary, '', 400),
      route: ROUTE_FOR_KIND[payload.kind],
      payload,
      changes: changesOf,
      citations: [],
      confirmation_required: true,
    };
    if (existing) reword.run(draft.label, draft.summary, JSON.stringify(changesOf), now, now, draft.id);
    else insert.run(draft.id, draft.kind, draft.label, draft.summary, draft.route, payloadJson, JSON.stringify(changesOf), now, now);
    result.proposed.push(draft);
  });
  if (!Array.isArray(input.changes)) result.refused.push({ index: -1, reason: 'changes must be an array' });
  return result;
}

/** Open drafts whose premise still holds, newest first: what is waiting for the owner. */
export function listOpenDrafts(db: Database.Database, limit = 100): AdvisorDraftAction[] {
  const rows = db.prepare(`
    SELECT id, kind, label, summary, route, payload, created_at FROM advisor_drafts
    WHERE status = 'open' ORDER BY created_at DESC, id LIMIT ?
  `).all(limit) as Array<{ id: string; kind: AdvisorDraftActionKind; label: string; summary: string; route: string; payload: string; created_at: string }>;
  const drafts: AdvisorDraftAction[] = [];
  for (const row of rows) {
    const parsed = AdvisorDraftPayloadSchema.safeParse(JSON.parse(row.payload));
    if (!parsed.success || !isDraftStillActionable(db, parsed.data, row.created_at)) continue;
    drafts.push({ id: row.id, kind: row.kind, label: row.label, summary: row.summary, route: row.route, payload: parsed.data, changes: describeDraftChanges(db, parsed.data), citations: [], confirmation_required: true });
  }
  return drafts;
}
