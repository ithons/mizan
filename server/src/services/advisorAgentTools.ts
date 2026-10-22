import type Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { toDollars } from './money';
import { readSafeToSpend } from './safeToSpend';
import { getAnomalyInsights } from './anomalyInsights';
import { createMemory, deleteMemory, listMemories } from './aiMemory';
import { proposeChanges, MAX_PROPOSALS_PER_CALL } from './advisorProposals';
import { listNotificationRules, listNotifications, notificationRuleToDollars, notificationToDollars } from './notifications';
import { format, subMonths } from 'date-fns';
import { explainMonth, fundingMix } from './monthStudies';
import { accountCoverage } from './accountCoverage';
import { retirementRoom } from './retirementRoom';
import { findReimbursements } from './reimbursements';
import { counterpartiesToDollars, findCounterparties } from './counterparties';
import { cardReview, cardReviewToDollars } from './cardReview';
import { openLumpCandidates } from './expectedLumpCandidates';
import { listConfirmedLumps } from './expectedLumps';
import { cashRunway, checkAdjustments, compoundGrowth, emergencyFund, projectFreeBand, debtPayoff, goalTimeline, goalTimelineFor, horizonDays, MAX_HORIZON_DAYS, projectFree, runwayTo, type Horizon } from './simulations';
import { investmentReturns, investmentReturnsToDollars } from './investmentReturns';
import { detectStarterBudgets, starterBudgetToDollars } from './starterBudgets';

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
  'link_reimbursement {reimbursement_id, purchase_id}: money someone paid the owner back for a purchase; ids from find_reimbursements.',
  'create_recurring_adjustment {recurring_id, original_date, action:"skip"|"snooze"|"adjust", adjusted_date?, adjusted_amount? (dollars), note?}.',
  'update_account {account_id, account_name?, is_hidden?, current_balance? (dollars, manual accounts only), statement_balance? (dollars owed), statement_due_date?, credit_limit? (dollars)}.',
  'set_manual_cost_basis {holding_id, manual_cost_basis (dollars) | null, note?}.',
  'set_notification_rule {rule_id? (to edit), rule_kind, params, enabled?}: rule_kind and params are budget_threshold {category_id|null, percent}, large_transaction {min_amount (dollars), account_id|null, lookback_days}, bill_due {days_ahead}, low_balance {account_id|null, threshold (dollars)}, safe_to_spend_negative {}, sync_failed {include_partial}, goal_milestone {goal_id|null, milestones:[percents]}, unusual_spending {category_id|null, ratio, min_amount (dollars)}, recurring_amount_changed {}, income_late {min_days_late}, account_shortfall {days_ahead}, card_payment_missing {min_days_late}.',
  'delete_notification_rule {rule_id}.',
  'expect_lump {label, merchant_key, amount_low, amount_high (dollars), window_start, window_end, last_occurrence}: an irregular deposit the owner expects; copy a candidate from find_expected_lumps. It is an estimate and never counts toward free to spend.',
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
      'Estimates and what-ifs computed from the owner\'s real data. type "project": what is free day by day over `days` (default 30, max 120) or up to `end_date` (YYYY-MM-DD, up to 400 days ahead), its lowest point and the first day it drops below the claims already on the money (not an overdraft), built from the same inputs as free to spend; pass `adjustments` for a what-if: {kind:"one_off", date, amount (dollars, negative to spend)}, {kind:"monthly", amount, start_date?}, {kind:"cancel_recurring", pattern_id}, {kind:"scale_unbudgeted", percent (e.g. -20)}. Pass band:true for a 10th/50th/90th percentile range and the chance of dropping below claims (with adjustments it also returns the scenario, on the same simulated futures), from replaying the owner\'s own spending and pay. When the owner has confirmed expected lumps (find_expected_lumps), the result adds with_expected_lumps, counting each at its low amount on the last day of its window; baseline never includes them. Use it for "can I afford X", "what if I cut Y", "when do I run short". type "runway_to": {end_date? (default Dec 31)} the lowest projected point to that date and its date, with confirmed lumps, the 10th/50th/90th percentile of that low point, and the one scheduled outflow whose removal raises it most. type "debt_payoff": {account_id or balance, apr, monthly_payment}. type "goal_timeline": {goal_id or target and current, monthly_contribution, annual_return?}. type "runway": {months?} months the liquid accounts, less card balances, cover at recent spending. type "growth": {principal, monthly_contribution, annual_return, years}. type "emergency_fund": {months? (default 3), confidence? 0.8|0.9|0.95, categories? (category ids counted as essential), history? months} sizes a cushion from how much essential spending varies. Every result states its assumptions; repeat them when you quote it.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['project', 'runway_to', 'debt_payoff', 'goal_timeline', 'runway', 'growth', 'emergency_fund'] },
        params: { type: 'object' },
      },
      required: ['type'],
    },
  },
  {
    name: 'explain_month',
    description: 'What changed in a month against the three before it: categories that moved past their usual range, large one-off items, recurring items that changed price, income and spending against usual, and what the named moves leave unexplained. Use for "why was this month different", "where did my money go", monthly reviews.',
    input_schema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM; default the last complete month.' } } },
  },
  {
    name: 'get_funding_mix',
    description: 'Per month: income from recurring patterns (pay), other income (one-off deposits, refunds), spending, money moved into investments, and the share of spending recurring income covers. Use for "is my pay covering my life", "what is funding my investing".',
    input_schema: { type: 'object', properties: { months: { type: 'integer', description: 'Complete months back, default 6, max 24.' } } },
  },
  {
    name: 'get_account_coverage',
    description: 'Each checking, savings and cash account walked forward through the scheduled income, bills and transfers that touch it (lowest point, first day below zero), and each card judged against the account its next scheduled payment comes from: covered, short, or unjudged when nothing schedules a payment. Use for "can I pay my cards", "will checking overdraw", "do I need to move money from savings".',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'Window, default 45, max 120.' } } },
  },
  {
    name: 'get_retirement_room',
    description: 'How much IRA room is left for a tax year: the annual limit capped at earned income so far, less deposits into IRA accounts this year, with the deadline. annual_limit must come from the owner (ask, or use what they told you and you remembered); never supply a limit yourself. Eligibility and residency are not checked; say so.',
    input_schema: { type: 'object', properties: { annual_limit: { type: 'number', description: 'Dollars, as the owner stated it.' }, tax_year: { type: 'integer', description: 'Default: the current year.' } }, required: ['annual_limit'] },
  },
  {
    name: 'find_reimbursements',
    description: 'Zelle, Venmo, Cash App and PayPal money in that nothing pairs or links yet, each with the purchases from the two weeks before it that it could be paying back (a friend covering their share of dinner). Use to propose link_reimbursement drafts, one per inflow you are confident about; the linked money then nets against the purchase and takes its category. When unsure which purchase, or whether it is a reimbursement at all, ask the owner instead.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'How far back, default 120, max 365.' } } },
  },
  {
    name: 'get_counterparties',
    description: 'Money between the owner and other people (Zelle, by name), wallets the owner does not track (Venmo, PayPal), wires and ATM cash, all of which reports leave out of spending. Per person: sent, received, net (received minus sent, dollars), last date, and state: settled (net within settle_tolerance), sent_more, or received_more. Use when asked whether anyone owes the owner. Only the transfers are visible: a friend paying back a dinner the owner put on a card shows as received_more, and a payment for the owner\'s own share shows as sent_more, so neither state is a debt: sent_more is a possibility to ask the owner about, and received_more may be a share paid back, a gift, or money fronted to the owner, which the transfers cannot tell apart. Wallets, wires and cash are pass-through totals with no state; ATM withdrawals are cash that left tracking. unclassified counts transfer rows that matched none of these.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_card_review',
    description: 'Per credit card, over the whole recorded ledger and the trailing 12 months: rewards redeemed (credits on the card, and bank deposits whose descriptor names exactly one card\'s program), issuer fees (annual, foreign transaction, late, interest, returned payment, cash advance or balance transfer, each read from a descriptor that begins with the charge; a merchant\'s fee is spend), net (redeemed less fees) and spend, with each row behind them and the next annual fee date a year after the last one (an estimate: the fee posts on a statement close, often days after it, and a waived fee never posts, so never call one missing). The whole-ledger sums start at the card\'s ledger_from (its first recorded row); a bank redemption dated before it is listed in redemptions but not counted. Redemptions that land in a bank account and name no single card are listed as unattributed; never assign them to a card or call any credit a bonus. Report the numbers; do not judge whether a card is worth keeping unless asked, and then say what the numbers leave out (rewards not yet redeemed, anything before ledger_from).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_expected_lumps',
    description: 'Large deposits (a term refund, a family check) that came at least three times at irregular intervals, each with a next window and an amount range ready to propose as expect_lump, plus the lumps the owner already confirmed and whether each has arrived. Paychecks, paired transfers and scheduled items are not here. A confirmed lump is an estimate: it never counts toward free to spend.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_starter_budgets',
    description: 'For each top-level spending category with no budget, spending in at least 9 of the last 12 complete months and no starter budget the owner declined: the median monthly spend, that median rounded to $10 as a starting budget, each month\'s signed spend, and how many months came in at or under it. Measured the way a budget on the category would measure it (the whole category tree, refunds netting down). Propose one with update_budget {category_id, amount, period: "monthly", rollover: false} only when the owner asks for budgets; state that it is a median, not a target.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_investment_returns',
    description: 'Annualized money-weighted return (XIRR) per investment and crypto account and for the whole portfolio over the last N months (default 12) or the whole history (months = 0): start and end value, net money moved in (dollars), and annualized as a fraction (0.05 is 5% a year). annualized is null with a reason when the money was held for under 90 days of the window, the end value is an estimate, coins moved between a crypto wallet and another wallet or the wallet held US dollars at an end of the window (the portfolio figure then leaves that account out and its name says so), or no single rate fits the flows; then say it was not computed and why, never estimate one. start_estimated = true means the start value is reconstructed; say so when quoting the rate. Always state the window (from, to) with the figure.',
    input_schema: { type: 'object', properties: { months: { type: 'integer', description: 'Months back (default 12, 0 for all history, max 120).' } } },
  },
  {
    name: 'get_notifications',
    description: 'What the inbox has told the owner: title, body, severity, when, read or not. Use when they ask what they missed or what needs attention.',
    input_schema: { type: 'object', properties: { unread_only: { type: 'boolean' }, limit: { type: 'integer', description: 'Default 30, max 200.' } } },
  },
  {
    name: 'get_notification_rules',
    description: 'The rules that decide what the owner is notified about, with ids, params (money in dollars) and whether each is on. Read before proposing a rule change.',
    input_schema: { type: 'object', properties: {} },
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
           is_hidden, balance_only, statement_balance, statement_due_date, credit_limit, provider_seen_at, updated_at
    FROM accounts ORDER BY is_hidden, account_name
  `).all() as Array<Record<string, unknown> & { current_balance: number; statement_balance: number | null; credit_limit: number | null }>;
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
      credit_limit: row.credit_limit === null ? null : toDollars(row.credit_limit),
      utilization: row.is_liability === 1 && row.credit_limit ? Math.round((row.current_balance / row.credit_limit) * 1000) / 10 : null,
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

function findExpectedLumpsTool(db: Database.Database): unknown {
  return {
    candidates: openLumpCandidates(db).map((candidate) => ({
      payload: candidate.payload,
      already_proposed: candidate.draft_id !== null,
      occurrences: candidate.occurrences.map((o) => ({ date: o.date, amount: toDollars(o.amount) })),
    })),
    confirmed: listConfirmedLumps(db).map((lump) => ({
      id: lump.id,
      label: lump.label,
      amount_low: toDollars(lump.amount_low_cents),
      amount_high: toDollars(lump.amount_high_cents),
      window_start: lump.window_start,
      window_end: lump.window_end,
      state: lump.state,
      arrived_on: lump.arrived_on,
    })),
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
      const horizon: Horizon = typeof params.end_date === 'string'
        ? params.end_date
        : Math.min(Math.max(Math.round(num(params.days, 30)), 1), 120);
      if (horizonDays(horizon) === null) return { error: `end_date must be a YYYY-MM-DD date 1 to ${MAX_HORIZON_DAYS} days ahead` };
      const checked = checkAdjustments(db, params.adjustments, horizon);
      if (!checked.ok) return { error: 'Some adjustments were refused', details: checked.errors };
      if (params.band === true) return projectFreeBand(db, horizon, undefined, undefined, undefined, checked.adjustments);
      return projectFree(db, horizon, checked.adjustments);
    }
    case 'runway_to':
      if (params.end_date !== undefined && (typeof params.end_date !== 'string' || horizonDays(params.end_date) === null)) {
        return { error: `end_date must be a YYYY-MM-DD date 1 to ${MAX_HORIZON_DAYS} days ahead` };
      }
      return runwayTo(db, typeof params.end_date === 'string' ? params.end_date : undefined);
    case 'debt_payoff': {
      let balance = num(params.balance, NaN);
      if (!Number.isFinite(balance) && typeof params.account_id === 'string') {
        const row = db.prepare('SELECT current_balance FROM accounts WHERE id = ? AND is_liability = 1').get(params.account_id) as { current_balance: number } | undefined;
        if (!row) return { error: 'No card or loan account with that id' };
        balance = toDollars(row.current_balance);
      }
      if (!Number.isFinite(balance) || balance <= 0) return { error: 'Give a positive balance or the id of an account that owes one' };
      const apr = num(params.apr, NaN);
      if (!Number.isFinite(apr) || apr < 0) return { error: 'Give the card\'s APR; none is stored in mizan' };
      return { balance, apr, ...debtPayoff(balance, apr, num(params.monthly_payment, 0)) };
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
    case 'emergency_fund': {
      const confidence = [0.8, 0.9, 0.95].includes(num(params.confidence, 0.9)) ? (num(params.confidence, 0.9) as 0.8 | 0.9 | 0.95) : 0.9;
      return emergencyFund(db, {
        months: Math.min(Math.max(num(params.months, 3), 1), 12),
        confidence,
        categories: Array.isArray(params.categories) ? params.categories.filter((c): c is string => typeof c === 'string') : undefined,
        history: num(params.history, 6),
      });
    }
    default:
      return { error: 'type must be one of project, runway_to, debt_payoff, goal_timeline, runway, growth, emergency_fund' };
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
    case 'get_notifications':
      return {
        notifications: listNotifications(db, {
          unreadOnly: input.unread_only === true,
          limit: Math.min(Math.max(Math.round(num(input.limit, 30)), 1), 200),
        }).map(notificationToDollars),
      };
    case 'get_notification_rules': return { rules: listNotificationRules(db).map(notificationRuleToDollars) };
    case 'run_simulation': return runSimulationTool(db, input);
    case 'explain_month': {
      const month = typeof input.month === 'string' && input.month ? input.month : format(subMonths(new Date(), 1), 'yyyy-MM');
      return explainMonth(db, month);
    }
    case 'get_account_coverage': return accountCoverage(db, Math.min(Math.max(Math.round(num(input.days, 45)), 1), 120));
    case 'get_retirement_room': return retirementRoom(db, num(input.annual_limit, 0), Math.round(num(input.tax_year, new Date().getFullYear())));
    case 'get_counterparties': return counterpartiesToDollars(findCounterparties(db));
    case 'find_reimbursements': return findReimbursements(db, Math.min(Math.max(Math.round(num(input.days, 120)), 1), 365));
    case 'get_investment_returns': {
      const months = Math.min(Math.max(Math.round(num(input.months, 12)), 0), 120);
      const returns = investmentReturns(db, { from: months > 0 ? format(subMonths(new Date(), months), 'yyyy-MM-dd') : undefined });
      return returns ? investmentReturnsToDollars(returns) : { note: 'No investment or crypto accounts.' };
    }
    case 'get_card_review': return cardReviewToDollars(cardReview(db, format(new Date(), 'yyyy-MM-dd')));
    case 'find_expected_lumps': return findExpectedLumpsTool(db);
    case 'get_starter_budgets': return detectStarterBudgets(db).map(starterBudgetToDollars);
    case 'get_funding_mix': return fundingMix(db, Math.min(Math.max(Math.round(num(input.months, 6)), 1), 24));
    default: return undefined;
  }
}
