import type Database from 'better-sqlite3';
import type { AdvisorDraftChange, AdvisorDraftPayload } from '../../../shared/types';

const money = (dollars: number) =>
  `${dollars < 0 ? '-' : ''}$${Math.abs(dollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fromCents = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : money(cents / 100));

function name(db: Database.Database, sql: string, id: string | null | undefined, fallback = 'unknown'): string {
  if (!id) return fallback;
  const row = db.prepare(sql).get(id) as { name: string | null } | undefined;
  return row?.name ?? `${fallback} (${id})`;
}

const categoryName = (db: Database.Database, id: string | null | undefined) => name(db, 'SELECT name FROM categories WHERE id = ?', id, 'category');
const accountName = (db: Database.Database, id: string | null | undefined) => name(db, 'SELECT account_name AS name FROM accounts WHERE id = ?', id, 'account');

/**
 * What a draft will change, read from its payload and the stored rows, never from the model's own
 * words, so the owner confirms the change itself.
 */
export function describeDraftChanges(db: Database.Database, payload: AdvisorDraftPayload): AdvisorDraftChange[] {
  switch (payload.kind) {
    case 'update_budget': {
      const current = db.prepare('SELECT amount FROM budgets WHERE category_id = ?').get(payload.category_id) as { amount: number } | undefined;
      return [{ field: `${categoryName(db, payload.category_id)} budget`, before: current ? `${fromCents(current.amount)} a month` : 'none', after: `${money(payload.amount)} a month${payload.rollover ? ', unspent rolls over' : ''}` }];
    }
    case 'delete_budget': {
      const current = db.prepare('SELECT amount FROM budgets WHERE category_id = ?').get(payload.category_id) as { amount: number } | undefined;
      return [{ field: `${categoryName(db, payload.category_id)} budget`, before: current ? `${fromCents(current.amount)} a month` : 'no budget set', after: current ? 'removed' : 'nothing to remove' }];
    }
    case 'create_goal':
      return [{ field: 'New goal', before: null, after: `${payload.name}: ${payload.type} ${money(payload.target_amount)}${payload.target_date ? ` by ${payload.target_date}` : ''}${payload.account_id ? `, linked to ${accountName(db, payload.account_id)}` : ''}` }];
    case 'update_goal_target': {
      const goal = db.prepare('SELECT name, target_amount FROM goals WHERE id = ?').get(payload.goal_id) as { name: string; target_amount: number } | undefined;
      return [{ field: `${goal?.name ?? 'Goal'} target`, before: fromCents(goal?.target_amount), after: money(payload.target_amount) }];
    }
    case 'categorize_transaction': {
      const row = db.prepare('SELECT date, amount, COALESCE(merchant_name, original_name) AS label, category_id FROM transactions WHERE id = ?').get(payload.transaction_id) as { date: string; amount: number; label: string; category_id: string | null } | undefined;
      if (!row) return [{ field: 'Transaction', before: 'no longer exists', after: categoryName(db, payload.category_id) }];
      return [{ field: `${row.label}, ${row.date}, ${fromCents(row.amount)}`, before: row.category_id ? categoryName(db, row.category_id) : 'uncategorized', after: categoryName(db, payload.category_id) }];
    }
    case 'create_merchant_rule':
      return [{ field: `Rule for "${payload.pattern}"`, before: null, after: `${categoryName(db, payload.category_id)}${payload.apply_existing ? ', including past transactions' : ', new transactions only'}` }];
    case 'retire_merchant_rule': {
      const rule = db.prepare('SELECT pattern, category_id FROM merchant_rules WHERE id = ?').get(payload.rule_id) as { pattern: string; category_id: string } | undefined;
      return [{ field: `Rule for "${rule?.pattern ?? payload.rule_id}"`, before: rule ? categoryName(db, rule.category_id) : null, after: 'retired' }];
    }
    case 'confirm_recurring':
    case 'dismiss_recurring': {
      const pattern = db.prepare('SELECT merchant_name, average_amount, frequency FROM recurring_patterns WHERE id = ?').get(payload.recurring_id) as { merchant_name: string; average_amount: number; frequency: string } | undefined;
      return [{ field: pattern ? `${pattern.merchant_name}, ${pattern.frequency}, ${fromCents(pattern.average_amount)}` : 'Recurring item', before: null, after: payload.kind === 'confirm_recurring' ? 'confirmed as recurring' : 'dismissed, not recurring' }];
    }
    case 'create_recurring_adjustment': {
      const pattern = db.prepare('SELECT merchant_name FROM recurring_patterns WHERE id = ?').get(payload.recurring_id) as { merchant_name: string } | undefined;
      const after = payload.action === 'skip' ? 'skipped'
        : payload.action === 'snooze' ? `moved to ${payload.adjusted_date ?? 'a later date'}`
        : `amount ${payload.adjusted_amount === null || payload.adjusted_amount === undefined ? 'unchanged' : money(payload.adjusted_amount)}${payload.adjusted_date ? ` on ${payload.adjusted_date}` : ''}`;
      return [{ field: `${pattern?.merchant_name ?? 'Recurring item'} on ${payload.original_date}`, before: null, after }];
    }
    case 'update_account': {
      const account = db.prepare('SELECT account_name, is_hidden, current_balance, statement_balance, statement_due_date, credit_limit FROM accounts WHERE id = ?').get(payload.account_id) as Record<string, number | string | null> | undefined;
      if (!account) return [{ field: 'Account', before: 'no longer exists', after: 'unchanged' }];
      const label = account.account_name as string;
      const changes: AdvisorDraftChange[] = [];
      if (payload.account_name !== undefined) changes.push({ field: `${label} name`, before: label, after: payload.account_name });
      if (payload.is_hidden !== undefined) changes.push({ field: `${label} visibility`, before: account?.is_hidden ? 'hidden' : 'shown', after: payload.is_hidden ? 'hidden' : 'shown' });
      if (payload.current_balance !== undefined) changes.push({ field: `${label} balance`, before: fromCents(account?.current_balance as number), after: money(payload.current_balance) });
      if (payload.statement_balance !== undefined) changes.push({ field: `${label} statement balance`, before: fromCents(account?.statement_balance as number | null), after: payload.statement_balance === null ? 'cleared' : money(payload.statement_balance) });
      if (payload.statement_due_date !== undefined) changes.push({ field: `${label} statement due`, before: (account?.statement_due_date as string | null) ?? null, after: payload.statement_due_date ?? 'cleared' });
      if (payload.credit_limit !== undefined) changes.push({ field: `${label} credit limit`, before: fromCents(account?.credit_limit as number | null), after: payload.credit_limit === null ? 'cleared' : money(payload.credit_limit) });
      return changes;
    }
    case 'set_manual_cost_basis': {
      const holding = db.prepare('SELECT COALESCE(s.ticker, s.name) AS name, h.manual_cost_basis FROM holdings h LEFT JOIN securities s ON s.id = h.security_id WHERE h.id = ?').get(payload.holding_id) as { name: string | null; manual_cost_basis: number | null } | undefined;
      return [{ field: `${holding?.name ?? 'Holding'} cost basis`, before: fromCents(holding?.manual_cost_basis), after: payload.manual_cost_basis === null ? 'cleared' : money(payload.manual_cost_basis) }];
    }
    case 'set_sector_metadata':
      return [{ field: 'Security sector', before: null, after: payload.sector ?? 'cleared' }];
    case 'set_notification_rule': {
      const moneyFields = new Set(['min_amount', 'threshold']);
      const nobody: Record<string, string> = {
        category_id: payload.rule_kind === 'budget_threshold' ? 'any budget' : 'any top-level category',
        account_id: payload.rule_kind === 'low_balance' ? 'checking, savings and cash together' : 'any account',
        goal_id: 'any goal',
      };
      const show = (key: string, value: unknown): string => {
        if (value === null && key in nobody) return nobody[key];
        if (key === 'category_id') return categoryName(db, value as string);
        if (key === 'account_id') return accountName(db, value as string);
        if (key === 'goal_id') return name(db, 'SELECT name FROM goals WHERE id = ?', value as string, 'goal');
        if (moneyFields.has(key) && typeof value === 'number') return money(value);
        if (key === 'percent' || key === 'milestones') return `${Array.isArray(value) ? value.join('%, ') : String(value)}%`;
        return Array.isArray(value) ? value.join(', ') : String(value);
      };
      const params = Object.entries(payload.params).map(([key, value]) => `${key.replace(/_id$/, '').replace(/_/g, ' ')}: ${show(key, value)}`).join('; ');
      return [{ field: payload.rule_id ? `Notification rule (${payload.rule_kind.replace(/_/g, ' ')})` : `New notification: ${payload.rule_kind.replace(/_/g, ' ')}`, before: null, after: `${params || 'default settings'}${payload.enabled === false ? ', off' : ''}` }];
    }
    case 'delete_notification_rule':
      return [{ field: 'Notification rule', before: payload.rule_id, after: 'removed' }];
  }
}
