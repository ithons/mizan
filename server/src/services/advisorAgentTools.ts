import type Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { toDollars } from './money';
import { readSafeToSpend } from './safeToSpend';
import { getAnomalyInsights } from './anomalyInsights';
import { createMemory, deleteMemory, listMemories } from './aiMemory';
import { proposeChanges, MAX_PROPOSALS_PER_CALL } from './advisorProposals';
import { cashRunway, compoundGrowth, debtPayoff, goalTimeline, goalTimelineFor, projectFree, type ProjectionAdjustment } from './simulations';

type ToolInput = Record<string, unknown>;

const PAYLOAD_GUIDE = [
  'update_budget {category_id, amount (dollars per month), period:"monthly", rollover:boolean}: create or change a monthly budget.',
  'delete_budget {category_id}: remove the budget on a category.',
  'create_goal {name, type:"savings"|"debt", target_amount (dollars), target_date?:"YYYY-MM-DD", account_id?}.',
  'update_goal_target {goal_id, target_amount (dollars)}.',
  'categorize_transaction {transaction_id, category_id}.',
  'create_merchant_rule {pattern, category_id, apply_existing:boolean}.',
  'retire_merchant_rule {rule_id}.',
  'confirm_recurring {recurring_id} / dismiss_recurring {recurring_id}.',
  'create_recurring_adjustment {recurring_id, original_date, action:"skip"|"snooze"|"adjust", adjusted_date?, adjusted_amount? (dollars), note?}.',
  'update_account {account_id, account_name?, is_hidden?, current_balance? (dollars, manual accounts only), statement_balance? (dollars owed), statement_due_date?}.',
  'set_manual_cost_basis {holding_id, manual_cost_basis (dollars) | null, note?}.',
].join(' ');

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_changes',
    description:
      `Put one or more changes in front of the owner as cards they confirm or dismiss in the chat. Nothing applies until they confirm. Use it whenever the owner asks you to set, change, add, remove, rename, hide or update something, and when you recommend a specific change. Look up real ids first (get_categories, get_accounts, list_goals, get_budgets, get_recurring_patterns); never invent one. Each change is {label (short imperative), summary (one sentence: what changes and why), payload}. Payload kinds: ${PAYLOAD_GUIDE} Up to ${MAX_PROPOSALS_PER_CALL} changes per call.`,
    input_schema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              summary: { type: 'string' },
              payload: { type: 'object', description: 'Must include `kind` and that kind\'s fields.' },
            },
            required: ['label', 'summary', 'payload'],
          },
        },
      },
      required: ['changes'],
    },
  },
  {
    name: 'get_accounts',
    description:
      'Every account with its id, name, institution, type, signed balance in dollars (a card shows what is owed as positive), whether it is hidden, manual, or balance-only, its card statement, and when it last updated.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_categories',
    description: 'Every category with id, name, parent id and whether it is income. Use these ids in proposals.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_safe_to_spend',
    description:
      'The same free-to-spend breakdown the Balance and Plan screens show, in dollars: liquid, expected income, card balances, card payments from outside the pool, bills, transfers, budgets, unbudgeted pace, goals, free.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Forecast window, default 30, max 120.' } } },
  },
  {
    name: 'get_recurring_patterns',
    description:
      'Recurring bills, income and transfers mizan has detected or the owner entered: id, name, kind, amount in dollars, frequency, next expected date, confirmed or not, and any recent amount change.',
    input_schema: { type: 'object', properties: { include_inactive: { type: 'boolean' } } },
  },
  {
    name: 'get_insights',
    description: 'Unusual spending and other ranked observations the app has computed about the current month.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_memories',
    description: 'What has been recorded about the owner: preferences, constraints, intentions and interpretations, with who recorded each.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'remember',
    description:
      'Record something durable the owner told you or that you established, so every later conversation knows it. Use for stated preferences, constraints, plans and how they want things interpreted. Not for figures the ledger already holds. The owner sees and can delete every memory in Settings.',
    input_schema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'One sentence, in the owner\'s terms.' },
        kind: { type: 'string', enum: ['preference', 'constraint', 'intent', 'interpretation'] },
        scope: { type: 'string', enum: ['household', 'account', 'category', 'merchant', 'goal'] },
        subject: { type: 'string', description: 'The account, category, merchant or goal it is about. Omit for household.' },
        evidence: { type: 'string', description: 'What was said or observed that supports it.' },
      },
      required: ['statement', 'kind', 'scope', 'evidence'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a memory you recorded yourself, by id, when it is wrong or the owner withdraws it. Memories the owner wrote are theirs to delete.',
    input_schema: { type: 'object', properties: { memory_id: { type: 'string' } }, required: ['memory_id'] },
  },
  {
    name: 'run_simulation',
    description:
      'Estimates and what-ifs computed from the owner\'s real data. type "project": what is free day by day over `days` (default 30, max 120), its lowest point and the first day it goes short, built from the same inputs as free to spend; pass `adjustments` for a what-if: {kind:"one_off", date, amount (dollars, negative to spend)}, {kind:"monthly", amount, start_date?}, {kind:"cancel_recurring", pattern_id}, {kind:"scale_unbudgeted", percent (e.g. -20)}. Use it for "can I afford X", "what if I cut Y", "when do I run short". type "debt_payoff": {account_id or balance, apr, monthly_payment}. type "goal_timeline": {goal_id or target and current, monthly_contribution, annual_return?}. type "runway": {months?} months the liquid accounts cover at recent spending. type "growth": {principal, monthly_contribution, annual_return, years}. Every result states its assumptions; repeat them when you quote it.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['project', 'debt_payoff', 'goal_timeline', 'runway', 'growth'] },
        params: { type: 'object' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_open_proposals',
    description: 'Changes already proposed and still waiting for the owner, so you do not propose them twice.',
    input_schema: { type: 'object', properties: {} },
  },
];

function getAccountsTool(db: Database.Database): unknown {
  const rows = db.prepare(`
    SELECT id, account_name, institution_name, type, connection_type, current_balance, is_liability,
           is_hidden, balance_only, statement_balance, statement_due_date, provider_seen_at, updated_at
    FROM accounts ORDER BY is_hidden, account_name
  `).all() as Array<Record<string, unknown> & { current_balance: number; statement_balance: number | null }>;
  return {
    accounts: rows.map((row) => ({
      id: row.id,
      name: row.account_name,
      institution: row.institution_name,
      type: row.type,
      connection: row.connection_type,
      balance: toDollars(row.current_balance),
      is_liability: row.is_liability === 1,
      hidden: row.is_hidden === 1,
      balance_only: row.balance_only === 1,
      statement_balance: row.statement_balance === null ? null : toDollars(row.statement_balance),
      statement_due_date: row.statement_due_date,
      last_seen_by_provider: row.provider_seen_at,
      last_updated: row.updated_at,
    })),
  };
}

function getCategoriesTool(db: Database.Database): unknown {
  return {
    categories: db.prepare('SELECT id, name, parent_id, is_income FROM categories ORDER BY parent_id IS NOT NULL, name').all(),
  };
}

function getRecurringPatternsTool(db: Database.Database, input: ToolInput): unknown {
  const rows = db.prepare(`
    SELECT rp.id, rp.merchant_name, rp.kind, rp.average_amount, rp.frequency, rp.next_expected, rp.last_seen,
           rp.is_confirmed, rp.is_active, rp.transaction_count, rp.amount_changed_from, rp.amount_changed_on,
           c.name AS category
    FROM recurring_patterns rp LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.dismissed_at IS NULL ${input.include_inactive === true ? '' : 'AND rp.is_active = 1'}
    ORDER BY rp.next_expected
  `).all() as Array<Record<string, unknown> & { average_amount: number; amount_changed_from: number | null }>;
  return {
    patterns: rows.map((row) => ({
      ...row,
      average_amount: toDollars(row.average_amount),
      amount_changed_from: row.amount_changed_from === null ? null : toDollars(row.amount_changed_from),
      is_confirmed: row.is_confirmed === 1,
      is_active: row.is_active === 1,
    })),
  };
}

function rememberTool(db: Database.Database, input: ToolInput): unknown {
  const scope = input.scope;
  const result = createMemory(db, { ...input, subject: scope === 'household' ? undefined : input.subject }, 'ai');
  return result;
}

function forgetTool(db: Database.Database, input: ToolInput): unknown {
  const id = typeof input.memory_id === 'string' ? input.memory_id : '';
  const memory = listMemories(db).find((entry) => entry.id === id);
  if (!memory) return { ok: false, error: 'No live memory has that id' };
  if (memory.source !== 'ai') return { ok: false, error: 'That memory was written by the owner; only they can delete it' };
  return { ok: deleteMemory(db, id).changed === 1 };
}

function getOpenProposalsTool(db: Database.Database): unknown {
  return {
    open: db.prepare(`
      SELECT id, kind, label, summary, payload, created_at FROM advisor_drafts
      WHERE status = 'open' ORDER BY created_at DESC LIMIT 100
    `).all(),
  };
}

function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runSimulationTool(db: Database.Database, input: ToolInput): unknown {
  const params = (input.params && typeof input.params === 'object' ? input.params : {}) as Record<string, unknown>;
  switch (input.type) {
    case 'project': {
      const days = Math.min(Math.max(Math.round(num(params.days, 30)), 1), 120);
      const adjustments = Array.isArray(params.adjustments) ? (params.adjustments as ProjectionAdjustment[]) : [];
      return projectFree(db, days, adjustments);
    }
    case 'debt_payoff': {
      let balance = num(params.balance, NaN);
      if (!Number.isFinite(balance) && typeof params.account_id === 'string') {
        const row = db.prepare('SELECT current_balance FROM accounts WHERE id = ? AND is_liability = 1').get(params.account_id) as { current_balance: number } | undefined;
        if (!row) return { error: 'No card or loan account with that id' };
        balance = toDollars(row.current_balance);
      }
      if (!Number.isFinite(balance) || balance <= 0) return { error: 'Give a positive balance or the id of an account that owes one' };
      return { balance, ...debtPayoff(balance, num(params.apr, 0), num(params.monthly_payment, 0)) };
    }
    case 'goal_timeline':
      if (typeof params.goal_id === 'string') {
        return goalTimelineFor(db, params.goal_id, num(params.monthly_contribution, 0), num(params.annual_return, 0));
      }
      return goalTimeline(num(params.target, 0), num(params.current, 0), num(params.monthly_contribution, 0), num(params.annual_return, 0));
    case 'runway':
      return cashRunway(db, Math.min(Math.max(Math.round(num(params.months, 3)), 1), 12));
    case 'growth':
      return compoundGrowth(num(params.principal, 0), num(params.monthly_contribution, 0), num(params.annual_return, 0), Math.min(num(params.years, 10), 60));
    default:
      return { error: 'type must be one of project, debt_payoff, goal_timeline, runway, growth' };
  }
}

/** Undefined when the name is not one of these tools, so the caller can fall through. */
export function runAgentTool(db: Database.Database, name: string, input: ToolInput): unknown {
  switch (name) {
    case 'propose_changes': return proposeChanges(db, input);
    case 'get_accounts': return getAccountsTool(db);
    case 'get_categories': return getCategoriesTool(db);
    case 'get_safe_to_spend': {
      const days = Math.min(Math.max(Number(input.days) || 30, 1), 120);
      return readSafeToSpend(db, days);
    }
    case 'get_recurring_patterns': return getRecurringPatternsTool(db, input);
    case 'get_insights': return { insights: getAnomalyInsights(db) };
    case 'get_memories': return { memories: listMemories(db) };
    case 'remember': return rememberTool(db, input);
    case 'forget': return forgetTool(db, input);
    case 'get_open_proposals': return getOpenProposalsTool(db);
    case 'run_simulation': return runSimulationTool(db, input);
    default: return undefined;
  }
}
