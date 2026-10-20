import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { format, getDaysInMonth, parseISO, startOfMonth, subDays, subMonths } from 'date-fns';
import { NotificationRuleParamsSchemas } from '../../../shared/schemas';
import { SCHEDULED_ROUTE } from '../../../shared/routes';
import {
  NOTIFICATION_RULE_KINDS,
  PARTIAL_RUNS_BEFORE_NOTIFYING,
  type AppNotification,
  type ProjectedBudget,
  type NotificationEvaluationError,
  type NotificationEvaluationSummary,
  type NotificationRule,
  type NotificationRuleCreator,
  type NotificationRuleKind,
  type NotificationRuleParamsByKind,
  type NotificationRuleSpec,
  type NotificationSeverity,
  type RecurringForecast,
  type SpendingReport,
} from '../../../shared/types';
import { getMonthlyBudgetsWithProjection } from './budgetProjection';
import { calculateGoalProgress, type GoalProgressInput } from './goalProgress';
import { buildRecurringForecast } from './recurringForecast';
import { getSpendingReport } from './reporting';
import { computeSafeToSpend, type SafeToSpendBreakdown } from './safeToSpend';
import { excludedFromTotalsSql, expenseSideSql, reportDateSql, spendAmountSql } from './transactionFilters';
import { dollarizeFields, toCents } from './money';
import { projectedShortfalls } from './accountCoverage';
import { cardPaidSince } from './cardPayments';

/** Money fields inside each kind's params, cents in the database and dollars over the API. */
export const NOTIFICATION_PARAM_MONEY_FIELDS: Readonly<Record<NotificationRuleKind, readonly string[]>> = {
  budget_threshold: [],
  large_transaction: ['min_amount'],
  bill_due: [],
  low_balance: ['threshold'],
  safe_to_spend_negative: [],
  sync_failed: [],
  goal_milestone: [],
  unusual_spending: ['min_amount'],
  recurring_amount_changed: [],
  income_late: [],
  account_shortfall: [],
  card_payment_missing: [],
};

/** Money fields inside each kind's notification payload. */
export const NOTIFICATION_PAYLOAD_MONEY_FIELDS: Readonly<Record<NotificationRuleKind, readonly string[]>> = {
  budget_threshold: ['spent', 'available'],
  large_transaction: ['amount'],
  bill_due: ['amount'],
  low_balance: ['balance', 'threshold'],
  safe_to_spend_negative: ['free'],
  sync_failed: [],
  goal_milestone: ['progress_amount', 'target_amount'],
  unusual_spending: ['month_to_date', 'baseline'],
  recurring_amount_changed: ['amount', 'changed_from'],
  income_late: ['amount'],
  account_shortfall: ['balance', 'balance_now'],
  card_payment_missing: ['amount', 'owed'],
};

export type UpsertNotificationRuleInput = NotificationRuleSpec & {
  /** Present to edit an existing rule. A rule's kind cannot change. */
  id?: string;
  enabled?: boolean;
  created_by?: NotificationRuleCreator;
};

export type UpsertNotificationRuleResult =
  | { ok: true; rule: NotificationRule; created: boolean }
  | { ok: false; error: string };

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  limit?: number;
}

interface RuleRow {
  id: string;
  kind: string;
  params: string;
  enabled: number;
  created_by: NotificationRuleCreator;
  created_at: string;
  updated_at: string;
}

interface NotificationRow extends Omit<AppNotification, 'payload' | 'kind'> {
  kind: string;
  payload: string;
}

interface Candidate {
  dedupe_key: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  payload: Record<string, unknown>;
  route: string | null;
}

function isRuleKind(kind: string): kind is NotificationRuleKind {
  return (NOTIFICATION_RULE_KINDS as readonly string[]).includes(kind);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseParams(
  kind: NotificationRuleKind,
  raw: unknown
): { ok: true; spec: NotificationRuleSpec } | { ok: false; error: string } {
  const parsed = NotificationRuleParamsSchemas[kind].safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Invalid ${kind} params: ${issue.path.join('.') || 'params'} ${issue.message}` };
  }
  return { ok: true, spec: { kind, params: parsed.data } as NotificationRuleSpec };
}

function rowToRule(row: RuleRow): NotificationRule {
  if (!isRuleKind(row.kind)) throw new Error(`Notification rule ${row.id} has unknown kind ${row.kind}`);
  const parsed = parseParams(row.kind, parseJson(row.params));
  if (!parsed.ok) throw new Error(`Notification rule ${row.id}: ${parsed.error}`);
  return {
    ...parsed.spec,
    id: row.id,
    enabled: row.enabled === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToNotification(row: NotificationRow): AppNotification {
  const payload = parseJson(row.payload);
  return {
    ...row,
    kind: row.kind as NotificationRuleKind,
    payload: payload && typeof payload === 'object' ? payload as Record<string, unknown> : {},
  };
}

function getRuleRow(db: Database.Database, id: string): RuleRow | undefined {
  return db.prepare('SELECT * FROM notification_rules WHERE id = ?').get(id) as RuleRow | undefined;
}

/** Rules oldest first. Cents in params. */
export function listNotificationRules(db: Database.Database): NotificationRule[] {
  const rows = db.prepare('SELECT * FROM notification_rules ORDER BY created_at ASC, id ASC').all() as RuleRow[];
  return rows.map(rowToRule);
}

function referenceError(db: Database.Database, spec: NotificationRuleSpec): string | null {
  const exists = (table: string, id: string) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
  switch (spec.kind) {
    case 'budget_threshold':
    case 'unusual_spending':
      return spec.params.category_id && !exists('categories', spec.params.category_id)
        ? `No category ${spec.params.category_id}` : null;
    case 'large_transaction':
      return spec.params.account_id && !exists('accounts', spec.params.account_id)
        ? `No account ${spec.params.account_id}` : null;
    case 'low_balance': {
      if (!spec.params.account_id) return null;
      const account = db.prepare('SELECT is_liability FROM accounts WHERE id = ?')
        .get(spec.params.account_id) as { is_liability: number } | undefined;
      if (!account) return `No account ${spec.params.account_id}`;
      return account.is_liability ? 'A low balance rule needs an asset account, not a card or loan' : null;
    }
    case 'goal_milestone':
      return spec.params.goal_id && !exists('goals', spec.params.goal_id) ? `No goal ${spec.params.goal_id}` : null;
    default:
      return null;
  }
}

/**
 * Create a rule, or edit one when `input.id` names an existing rule. Params are cents. Bad input
 * comes back as `{ ok: false }` rather than a throw.
 */
export function upsertNotificationRule(
  db: Database.Database,
  input: UpsertNotificationRuleInput
): UpsertNotificationRuleResult {
  const kind = (input as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !isRuleKind(kind)) return { ok: false, error: `Unknown rule kind ${String(kind)}` };
  const parsed = parseParams(kind, input.params);
  if (!parsed.ok) return parsed;
  const missing = referenceError(db, parsed.spec);
  if (missing) return { ok: false, error: missing };

  const now = new Date().toISOString();
  const params = JSON.stringify(parsed.spec.params);
  const existing = input.id ? getRuleRow(db, input.id) : undefined;
  if (input.id && !existing) return { ok: false, error: `No notification rule ${input.id}` };

  if (existing) {
    if (existing.kind !== kind) return { ok: false, error: 'A rule cannot change kind; create a new rule instead' };
    db.prepare('UPDATE notification_rules SET params = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(params, input.enabled === undefined ? existing.enabled : Number(input.enabled), now, existing.id);
    return { ok: true, rule: rowToRule(getRuleRow(db, existing.id) as RuleRow), created: false };
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO notification_rules (id, kind, params, enabled, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, kind, params, Number(input.enabled ?? true), input.created_by ?? 'owner', now, now);
  return { ok: true, rule: rowToRule(getRuleRow(db, id) as RuleRow), created: true };
}

/** Null when no rule has that id. */
export function setNotificationRuleEnabled(
  db: Database.Database,
  id: string,
  enabled: boolean
): NotificationRule | null {
  const result = db.prepare('UPDATE notification_rules SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(Number(enabled), new Date().toISOString(), id);
  return result.changes === 0 ? null : rowToRule(getRuleRow(db, id) as RuleRow);
}

/** False when no rule has that id. Notifications it raised stay, with `rule_id` null. */
export function deleteNotificationRule(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM notification_rules WHERE id = ?').run(id).changes > 0;
}

/** Newest first, dismissed ones left out. Cents in payloads. */
export function listNotifications(
  db: Database.Database,
  options: ListNotificationsOptions = {}
): AppNotification[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE dismissed_at IS NULL ${options.unreadOnly ? 'AND read_at IS NULL' : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit) as NotificationRow[];
  return rows.map(rowToNotification);
}

/** How many rows this marked; already-read and dismissed ones are not counted. */
export function markNotificationsRead(db: Database.Database, ids: readonly string[] | 'all'): number {
  const now = new Date().toISOString();
  if (ids === 'all') {
    return db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND dismissed_at IS NULL').run(now).changes;
  }
  if (ids.length === 0) return 0;
  return db.prepare(`
    UPDATE notifications SET read_at = ?
    WHERE read_at IS NULL AND dismissed_at IS NULL AND id IN (${ids.map(() => '?').join(',')})
  `).run(now, ...ids).changes;
}

/** False when no undismissed notification has that id. Dismissing also marks it read. */
export function dismissNotification(db: Database.Database, id: string): boolean {
  const now = new Date().toISOString();
  return db.prepare(`
    UPDATE notifications SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
    WHERE id = ? AND dismissed_at IS NULL
  `).run(now, now, id).changes > 0;
}

export function unreadCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL')
    .get() as { n: number };
  return row.n;
}

/** Params with money in dollars, for the API. */
export function notificationRuleToDollars(rule: NotificationRule): NotificationRule {
  return { ...rule, params: dollarizeFields(rule.params, NOTIFICATION_PARAM_MONEY_FIELDS[rule.kind]) } as NotificationRule;
}

/** Payload with money in dollars, for the API. */
export function notificationToDollars(notification: AppNotification): AppNotification {
  return { ...notification, payload: dollarizeFields(notification.payload, NOTIFICATION_PAYLOAD_MONEY_FIELDS[notification.kind]) };
}

/** Params as the API sends them (dollars), converted to cents. Unknown shapes pass through for validation to refuse. */
export function notificationParamsFromDollars(kind: string, params: Record<string, unknown>): Record<string, unknown> {
  if (!isRuleKind(kind)) return params;
  const converted = { ...params };
  for (const field of NOTIFICATION_PARAM_MONEY_FIELDS[kind]) {
    const value = converted[field];
    if (typeof value === 'number' && Number.isFinite(value)) converted[field] = toCents(value);
  }
  return converted;
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function money(cents: number): string {
  return USD.format(cents / 100);
}

function shortDate(date: string): string {
  return format(parseISO(date), 'EEE, MMM d');
}

/** Shared figures, each computed at most once per evaluation and only when a rule asks. */
class EvaluationContext {
  readonly month: string;
  private budgetsMemo: ProjectedBudget[] | null = null;
  private safeToSpendMemo: SafeToSpendBreakdown | null = null;
  private forecasts = new Map<number, RecurringForecast>();

  constructor(readonly db: Database.Database, readonly now: Date) {
    this.month = format(now, 'yyyy-MM');
  }

  budgets(): ProjectedBudget[] {
    this.budgetsMemo ??= getMonthlyBudgetsWithProjection(this.db, this.now.getFullYear(), this.now.getMonth() + 1, this.now);
    return this.budgetsMemo;
  }

  // The same inputs routes/insights.ts hands it, so this and the Balance screen agree.
  safeToSpend(): SafeToSpendBreakdown {
    this.safeToSpendMemo ??= computeSafeToSpend(this.db, { budgets: this.budgets() });
    return this.safeToSpendMemo;
  }

  forecast(days: number): RecurringForecast {
    const cached = this.forecasts.get(days);
    if (cached) return cached;
    const built = buildRecurringForecast(this.db, days);
    this.forecasts.set(days, built);
    return built;
  }
}

type Evaluator<K extends NotificationRuleKind> = (
  ctx: EvaluationContext,
  params: NotificationRuleParamsByKind[K]
) => Candidate[];

const budgetThreshold: Evaluator<'budget_threshold'> = (ctx, params) =>
  ctx.budgets().flatMap((budget) => {
    if (params.category_id && budget.category_id !== params.category_id) return [];
    const available = budget.available_amount;
    const spent = budget.spent ?? 0;
    if (available <= 0) return [];
    const percentSpent = (spent / available) * 100;
    if (percentSpent < params.percent) return [];
    const name = budget.category_name ?? 'A budget';
    return [{
      dedupe_key: `budget_threshold:${budget.id}:${ctx.month}:${params.percent}`,
      title: percentSpent >= 100 ? `${name} is over budget` : `${name} has used ${Math.floor(percentSpent)}% of its budget`,
      body: `${money(spent)} spent of ${money(available)} this month.`,
      severity: percentSpent >= 100 ? 'warning' : 'info',
      payload: { budget_id: budget.id, category_id: budget.category_id, month: ctx.month, spent, available, percent_spent: percentSpent },
      route: '/plan',
    }];
  });

const largeTransaction: Evaluator<'large_transaction'> = (ctx, params) => {
  const since = format(subDays(ctx.now, params.lookback_days - 1), 'yyyy-MM-dd');
  const rows = ctx.db.prepare(`
    SELECT t.id, t.date, t.amount, t.account_id,
           COALESCE(t.merchant_name, t.original_name) AS name, a.account_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.pending = 0
      AND ${excludedFromTotalsSql('t')}
      AND t.amount <= ?
      AND t.date >= ?
      AND (? IS NULL OR t.account_id = ?)
    ORDER BY t.date DESC, t.id ASC
  `).all(-params.min_amount, since, params.account_id, params.account_id) as Array<{
    id: string; date: string; amount: number; account_id: string; name: string; account_name: string | null;
  }>;
  return rows.map((row) => ({
    dedupe_key: `large_transaction:${row.id}`,
    title: `${money(-row.amount)} at ${row.name}`,
    body: `Posted ${shortDate(row.date)}${row.account_name ? ` on ${row.account_name}` : ''}, at or above your ${money(params.min_amount)} alert.`,
    severity: 'info',
    payload: { transaction_id: row.id, account_id: row.account_id, date: row.date, amount: -row.amount },
    route: `/ledger?accountId=${encodeURIComponent(row.account_id)}&range=all`,
  }));
};

const billDue: Evaluator<'bill_due'> = (ctx, params) =>
  ctx.forecast(params.days_ahead).occurrences
    .filter((o) => o.kind === 'flow' && o.amount < 0 && o.adjustment_action !== 'skip'
      && o.status === 'upcoming' && o.days_until >= 0 && o.days_until <= params.days_ahead)
    .map((o) => ({
      dedupe_key: `bill_due:${o.id}`,
      title: `${o.merchant_name} due ${shortDate(o.expected_date)}`,
      body: o.amount_varies
        ? `Expected around ${money(-o.amount)}; this bill's amount varies.`
        : `Expected ${money(-o.amount)}.`,
      severity: 'info',
      payload: { pattern_id: o.pattern_id, expected_date: o.expected_date, amount: -o.amount },
      route: SCHEDULED_ROUTE,
    }));

const lowBalance: Evaluator<'low_balance'> = (ctx, params) => {
  if (params.account_id === null) {
    const liquid = ctx.safeToSpend().liquid;
    if (liquid >= params.threshold) return [];
    return [{
      dedupe_key: `low_balance:pool:${ctx.month}`,
      title: `Checking, savings and cash are below ${money(params.threshold)}`,
      body: `Together they hold ${money(liquid)}.`,
      severity: 'warning',
      payload: { account_id: null, balance: liquid, threshold: params.threshold },
      route: '/accounts',
    }];
  }
  const account = ctx.db.prepare('SELECT id, account_name, current_balance, type, is_liability FROM accounts WHERE id = ?')
    .get(params.account_id) as { id: string; account_name: string; current_balance: number; type: string; is_liability: number } | undefined;
  if (!account) throw new Error(`Account ${params.account_id} no longer exists; edit or delete this rule`);
  if (account.is_liability) throw new Error(`${account.account_name} is a liability; a low balance rule needs an asset account`);
  if (account.type === 'closed' || account.current_balance >= params.threshold) return [];
  return [{
    dedupe_key: `low_balance:${account.id}:${ctx.month}`,
    title: `${account.account_name} is below ${money(params.threshold)}`,
    body: `Its balance is ${money(account.current_balance)}.`,
    severity: 'warning',
    payload: { account_id: account.id, balance: account.current_balance, threshold: params.threshold },
    route: `/accounts/${encodeURIComponent(account.id)}`,
  }];
};

const safeToSpendNegative: Evaluator<'safe_to_spend_negative'> = (ctx) => {
  const breakdown = ctx.safeToSpend();
  if (breakdown.free >= 0) return [];
  return [{
    dedupe_key: `safe_to_spend_negative:${ctx.month}`,
    title: `Short ${money(-breakdown.free)} over the next ${breakdown.forecastDays} days`,
    body: 'Card balances, scheduled bills and transfers, budgets, goals and the usual unbudgeted spending claim more than checking, savings, cash and expected income cover.',
    severity: 'warning',
    payload: { free: breakdown.free, forecast_days: breakdown.forecastDays },
    route: '/',
  }];
};

interface SyncRunRow {
  id: string;
  status: 'succeeded' | 'partial' | 'failed';
  error_message: string | null;
}

/** One notification per run of consecutive failures, keyed by the first run in it. */
const syncFailed: Evaluator<'sync_failed'> = (ctx, params) => {
  const failing = params.include_partial ? ['failed', 'partial'] : ['failed'];
  const latest = ctx.db.prepare(`
    SELECT id, status, error_message FROM sync_runs WHERE status != 'running'
    ORDER BY started_at DESC, id DESC LIMIT 1
  `).get() as SyncRunRow | undefined;
  if (!latest || !failing.includes(latest.status)) return [];
  const streak = ctx.db.prepare(`
    SELECT id, status, error_message FROM sync_runs
    WHERE status IN (${failing.map(() => '?').join(',')})
      AND started_at > COALESCE((
        SELECT MAX(started_at) FROM sync_runs
        WHERE status != 'running' AND status NOT IN (${failing.map(() => '?').join(',')})
      ), '')
    ORDER BY started_at ASC, id ASC
  `).all(...failing, ...failing) as SyncRunRow[];
  const anyFailed = streak.some((run) => run.status === 'failed');
  if (!anyFailed && streak.length < PARTIAL_RUNS_BEFORE_NOTIFYING) return [];
  const message = latest.error_message ?? 'No error message was recorded for this run.';
  return [{
    dedupe_key: `sync_failed:${streak[0].id}`,
    title: latest.status === 'failed' ? 'Sync failed' : 'Sync finished with issues',
    body: anyFailed ? message : `The last ${streak.length} syncs each finished with issues. The latest: ${message}`,
    severity: latest.status === 'failed' ? 'critical' : 'warning',
    payload: { run_id: latest.id, first_failed_run_id: streak[0].id, status: latest.status },
    route: connectionRouteFor(ctx.db, latest.id),
  }];
};

/** The connection panel for the provider whose stage reported trouble, when exactly one did. */
function connectionRouteFor(db: Database.Database, runId: string): string {
  const providers = (db.prepare(`
    SELECT DISTINCT provider FROM sync_run_items
    WHERE run_id = ? AND (status IN ('failed', 'reauth_required') OR error_message IS NOT NULL)
  `).all(runId) as Array<{ provider: string }>).map((row) => row.provider);
  if (providers.length === 1 && providers[0] === 'coinbase') return '/settings?section=coinbase';
  return '/settings?section=connections';
}

type GoalRow = GoalProgressInput & { id: string; name: string };

const goalMilestone: Evaluator<'goal_milestone'> = (ctx, params) => {
  const goals = ctx.db.prepare(`
    SELECT g.id, g.name, g.type, g.target_amount, g.current_amount, g.starting_amount,
           a.current_balance AS account_balance
    FROM goals g
    LEFT JOIN accounts a ON a.id = g.account_id
    WHERE g.is_archived = 0 AND (? IS NULL OR g.id = ?)
  `).all(params.goal_id, params.goal_id) as GoalRow[];
  return goals.flatMap((goal) => {
    const progress = calculateGoalProgress(goal);
    const reached = params.milestones.filter((m) => progress.progress_percent >= m);
    if (reached.length === 0) return [];
    const milestone = Math.max(...reached);
    const verb = goal.type === 'debt' ? 'paid down' : 'saved';
    return [{
      dedupe_key: `goal_milestone:${goal.id}:${milestone}`,
      title: milestone >= 100 ? `${goal.name} reached its target` : `${goal.name} has passed ${milestone}% of its target`,
      body: `${money(progress.progress_amount)} of ${money(goal.target_amount)} ${verb}.`,
      severity: 'info',
      payload: { goal_id: goal.id, milestone, progress_amount: progress.progress_amount, target_amount: goal.target_amount },
      route: '/plan',
    }];
  });
};

function flattenSpending(categories: SpendingReport['categories']): Map<string, { name: string; amount: number }> {
  const out = new Map<string, { name: string; amount: number }>();
  const walk = (nodes: SpendingReport['categories']) => {
    for (const node of nodes) {
      if (node.category_id) out.set(node.category_id, { name: node.category_name, amount: node.amount });
      if (node.children) walk(node.children);
    }
  };
  walk(categories);
  return out;
}

const BASELINE_MONTHS = 3;
const TIMING_TOLERANCE_DAYS = 3;

const unusualSpending: Evaluator<'unusual_spending'> = (ctx, params) => {
  const day = ctx.now.getDate();
  const monthStart = startOfMonth(ctx.now);
  const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
  const priorWindows = Array.from({ length: BASELINE_MONTHS }, (_, i) => {
    const start = subMonths(monthStart, i + 1);
    // A few days past the same day, so a payment that lands a little early is not read as a spike.
    const end = new Date(start.getFullYear(), start.getMonth(), Math.min(day + TIMING_TOLERANCE_DAYS, getDaysInMonth(start)));
    return { startDate: ymd(start), endDate: ymd(end) };
  });
  // A ledger younger than the baseline would read its missing months as zero spend.
  const earliest = ctx.db.prepare('SELECT MIN(date) AS d FROM transactions WHERE pending = 0').get() as { d: string | null };
  if (!earliest.d || earliest.d > priorWindows[BASELINE_MONTHS - 1].startDate) return [];

  const parentOnly = params.category_id === null;
  const parents = new Map((ctx.db.prepare('SELECT id, parent_id FROM categories').all() as Array<{ id: string; parent_id: string | null }>).map((row) => [row.id, row.parent_id]));
  const recurringSpend = (range: { startDate: string; endDate: string }) => {
    const rows = ctx.db.prepare(`
      SELECT t.category_id, SUM(${spendAmountSql('t')}) AS cents
      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      JOIN recurring_patterns rp ON rp.id = t.recurring_id AND rp.is_active = 1
      WHERE t.pending = 0 AND ${excludedFromTotalsSql('t')} AND ${expenseSideSql('t', 'c')}
        AND ${reportDateSql('t')} BETWEEN ? AND ?
      GROUP BY t.category_id
    `).all(range.startDate, range.endDate) as Array<{ category_id: string | null; cents: number }>;
    const out = new Map<string, number>();
    for (const row of rows) {
      if (!row.category_id) continue;
      const parent = parents.get(row.category_id) ?? null;
      for (const key of parentOnly ? [parent ?? row.category_id] : [row.category_id, ...(parent ? [parent] : [])]) {
        out.set(key, (out.get(key) ?? 0) + row.cents);
      }
    }
    return out;
  };
  // Recurring bills are expected and forecast; a bill landing a day early is not unusual spending.
  const report = (range: { startDate: string; endDate: string }) => {
    const spending = flattenSpending(getSpendingReport(ctx.db, { ...range, parentOnly }).categories);
    const recurring = recurringSpend(range);
    for (const [id, entry] of spending) spending.set(id, { ...entry, amount: entry.amount - (recurring.get(id) ?? 0) });
    return spending;
  };
  const current = report({ startDate: ymd(monthStart), endDate: ymd(ctx.now) });
  const prior = priorWindows.map(report);

  const candidates: Candidate[] = [];
  for (const [categoryId, { name, amount }] of current) {
    if (params.category_id && categoryId !== params.category_id) continue;
    const baseline = Math.round(prior.reduce((sum, m) => sum + (m.get(categoryId)?.amount ?? 0), 0) / BASELINE_MONTHS);
    if (baseline <= 0 || amount < baseline * params.ratio || amount - baseline < params.min_amount) continue;
    candidates.push({
      dedupe_key: `unusual_spending:${categoryId}:${ctx.month}`,
      title: `${name} is at ${(amount / baseline).toFixed(1)}x its usual pace`,
      body: `${money(amount)} so far this month, against an average of ${money(baseline)} by this point in each of the last ${BASELINE_MONTHS} months, allowing a few days of timing and leaving out recurring bills.`,
      severity: 'info',
      payload: { category_id: categoryId, month: ctx.month, month_to_date: amount, baseline },
      route: `/ledger?categoryId=${encodeURIComponent(categoryId)}&range=this-month`,
    });
  }
  return candidates;
};

/** A change detection still reports this long after it began is old news, not a notification. */
const AMOUNT_CHANGE_RECENT_DAYS = 45;

/** Detection stores both amounts as magnitudes and reports a shift for its first few payments only. */
const recurringAmountChanged: Evaluator<'recurring_amount_changed'> = (ctx) => {
  const since = format(subDays(ctx.now, AMOUNT_CHANGE_RECENT_DAYS), 'yyyy-MM-dd');
  const rows = ctx.db.prepare(`
    SELECT id, merchant_name, average_amount, amount_changed_from, amount_changed_on
    FROM recurring_patterns
    WHERE is_active = 1 AND dismissed_at IS NULL
      AND amount_changed_from IS NOT NULL AND amount_changed_on >= ?
  `).all(since) as Array<{ id: string; merchant_name: string; average_amount: number; amount_changed_from: number; amount_changed_on: string }>;
  return rows.map((row) => {
    const amount = Math.abs(row.average_amount);
    const from = Math.abs(row.amount_changed_from);
    return {
      dedupe_key: `recurring_amount_changed:${row.id}:${row.amount_changed_on}`,
      title: `${row.merchant_name} ${amount > from ? 'went up' : 'went down'} to ${money(amount)}`,
      body: `It was ${money(from)}. The first payment at the new amount was on ${shortDate(row.amount_changed_on)}.`,
      severity: 'info',
      payload: { pattern_id: row.id, amount, changed_from: from, changed_on: row.amount_changed_on },
      route: SCHEDULED_ROUTE,
    };
  });
};

/** The 95th percentile of how far a pattern's gaps strayed from their median, or null under three postings. */
function usualStrayDays(db: Database.Database, patternId: string): number | null {
  const dates = (db.prepare('SELECT date FROM transactions WHERE recurring_id = ? AND pending = 0 ORDER BY date')
    .all(patternId) as Array<{ date: string }>).map((row) => parseISO(row.date).getTime());
  if (dates.length < 3) return null;
  const gaps = dates.slice(1).map((time, i) => Math.round((time - dates[i]) / 86_400_000));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const strays = gaps.map((gap) => Math.abs(gap - medianGap)).sort((a, b) => a - b);
  return strays[Math.min(strays.length - 1, Math.floor(strays.length * 0.95))];
}

/**
 * Income past its expected date by more than its own timing usually wanders: the 95th percentile
 * of how far its past gaps strayed from their median gap, and never less than `min_days_late`.
 */
const incomeLate: Evaluator<'income_late'> = (ctx, params) => {
  const today = format(ctx.now, 'yyyy-MM-dd');
  const patterns = ctx.db.prepare(`
    SELECT rp.id, rp.merchant_name, rp.next_expected, rp.average_amount
    FROM recurring_patterns rp LEFT JOIN categories c ON c.id = rp.category_id
    WHERE rp.is_active = 1 AND rp.dismissed_at IS NULL AND rp.kind = 'flow' AND rp.next_expected < ?
      AND (c.is_income = 1 OR (SELECT AVG(t.amount) FROM transactions t WHERE t.recurring_id = rp.id) > 0)
  `).all(today) as Array<{ id: string; merchant_name: string; next_expected: string; average_amount: number }>;
  const adjustmentOf = ctx.db.prepare('SELECT action, adjusted_date FROM recurring_occurrence_adjustments WHERE recurring_id = ? AND original_date = ?');
  return patterns.flatMap((pattern) => {
    const adjustment = adjustmentOf.get(pattern.id, pattern.next_expected) as { action: string; adjusted_date: string | null } | undefined;
    if (adjustment?.action === 'skip') return [];
    const expectedOn = adjustment?.adjusted_date ?? pattern.next_expected;
    if (expectedOn >= today) return [];
    const usualStray = usualStrayDays(ctx.db, pattern.id);
    if (usualStray === null) return [];
    const tolerance = Math.max(params.min_days_late, usualStray);
    const daysLate = Math.round((parseISO(today).getTime() - parseISO(expectedOn).getTime()) / 86_400_000);
    if (daysLate <= tolerance) return [];
    return [{
      dedupe_key: `income_late:${pattern.id}:${expectedOn}`,
      title: `${pattern.merchant_name} is ${daysLate} days late`,
      body: `It was expected on ${shortDate(expectedOn)}${usualStray > 0 ? `, and its timing usually varies by up to ${usualStray} day${usualStray === 1 ? '' : 's'}` : ''}. Nothing has posted yet.`,
      severity: 'warning' as const,
      payload: { pattern_id: pattern.id, expected_on: expectedOn, days_late: daysLate, amount: Math.abs(pattern.average_amount) },
      route: SCHEDULED_ROUTE,
    }];
  });
};

/** A cash account the schedule takes below zero, keyed on the item that does it so a late payment does not re-alert daily. */
const accountShortfall: Evaluator<'account_shortfall'> = (ctx, params) =>
  projectedShortfalls(ctx.db, params.days_ahead, ctx.now).map((shortfall) => {
    const outflows = shortfall.that_day.filter((movement) => movement.cents < 0);
    const trigger = outflows[0] ?? shortfall.that_day[0];
    const items = shortfall.that_day.map((movement) => `${movement.label} ${money(movement.cents)}${movement.overdue ? ' (overdue)' : ''}`).join(', ');
    return {
      dedupe_key: `account_shortfall:${shortfall.account_id}:${trigger.patternId}:${trigger.expectedDate}`,
      title: `${shortfall.account_name} would be ${money(-shortfall.cents)} below zero on ${shortDate(shortfall.date)}`,
      body: `Scheduled that day: ${items}. It holds ${money(shortfall.balance_now)} now. Spending from it that is not scheduled is not counted.`,
      severity: 'warning' as const,
      payload: { account_id: shortfall.account_id, date: shortfall.date, balance: shortfall.cents, balance_now: shortfall.balance_now },
      route: `/accounts/${encodeURIComponent(shortfall.account_id)}`,
    };
  });

const cardPaymentMissing: Evaluator<'card_payment_missing'> = (ctx, params) => {
  const today = format(ctx.now, 'yyyy-MM-dd');
  const patterns = ctx.db.prepare(`
    SELECT rp.id, rp.next_expected, rp.last_seen, rp.average_amount, card.id AS card_id, card.account_name AS card_name,
           card.current_balance AS owed, src.account_name AS from_name
    FROM recurring_patterns rp
    JOIN accounts card ON card.id = rp.counterparty_account_id AND card.is_liability = 1 AND card.type <> 'closed'
    LEFT JOIN accounts src ON src.id = rp.account_id
    WHERE rp.kind = 'transfer' AND rp.is_active = 1 AND rp.dismissed_at IS NULL AND rp.next_expected < ? AND card.current_balance > 0
  `).all(today) as Array<{ id: string; next_expected: string; last_seen: string; average_amount: number; card_id: string; card_name: string; owed: number; from_name: string | null }>;
  const adjustmentOf = ctx.db.prepare('SELECT action, adjusted_date FROM recurring_occurrence_adjustments WHERE recurring_id = ? AND original_date = ?');
  return patterns.flatMap((pattern) => {
    const adjustment = adjustmentOf.get(pattern.id, pattern.next_expected) as { action: string; adjusted_date: string | null } | undefined;
    if (adjustment?.action === 'skip') return [];
    const expectedOn = adjustment?.adjusted_date ?? pattern.next_expected;
    if (expectedOn >= today || cardPaidSince(ctx.db, pattern.card_id, pattern.last_seen)) return [];
    const usualStray = usualStrayDays(ctx.db, pattern.id) ?? 0;
    const daysLate = Math.round((parseISO(today).getTime() - parseISO(expectedOn).getTime()) / 86_400_000);
    if (daysLate <= Math.max(params.min_days_late, usualStray)) return [];
    const amount = Math.abs(pattern.average_amount);
    return [{
      dedupe_key: `card_payment_missing:${pattern.id}:${expectedOn}`,
      title: `No ${pattern.card_name} payment since ${shortDate(pattern.last_seen)}`,
      body: `The usual ${money(amount)} payment${pattern.from_name ? ` from ${pattern.from_name}` : ''} was expected on ${shortDate(expectedOn)}, ${daysLate} days ago, and nothing has paid the card since. It owes ${money(pattern.owed)}.`,
      severity: 'warning' as const,
      payload: { pattern_id: pattern.id, card_id: pattern.card_id, expected_on: expectedOn, days_late: daysLate, amount, owed: pattern.owed },
      route: SCHEDULED_ROUTE,
    }];
  });
};

const EVALUATORS: { [K in NotificationRuleKind]: Evaluator<K> } = {
  budget_threshold: budgetThreshold,
  large_transaction: largeTransaction,
  bill_due: billDue,
  low_balance: lowBalance,
  safe_to_spend_negative: safeToSpendNegative,
  sync_failed: syncFailed,
  goal_milestone: goalMilestone,
  unusual_spending: unusualSpending,
  recurring_amount_changed: recurringAmountChanged,
  income_late: incomeLate,
  account_shortfall: accountShortfall,
  card_payment_missing: cardPaymentMissing,
};

function candidatesFor(ctx: EvaluationContext, spec: NotificationRuleSpec): Candidate[] {
  const evaluate = EVALUATORS[spec.kind] as Evaluator<typeof spec.kind>;
  return evaluate(ctx, spec.params as never);
}

function insertCandidate(
  db: Database.Database,
  rule: { id: string; kind: NotificationRuleKind },
  candidate: Candidate,
  createdAt: string
): AppNotification | null {
  const id = uuidv4();
  const changes = db.prepare(`
    INSERT INTO notifications (id, rule_id, kind, title, body, severity, dedupe_key, created_at, payload, route)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(
    id, rule.id, rule.kind, candidate.title, candidate.body, candidate.severity,
    candidate.dedupe_key, createdAt, JSON.stringify(candidate.payload), candidate.route
  ).changes;
  if (changes === 0) return null;
  return rowToNotification(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow);
}

/**
 * Run every enabled rule and insert what fired. A condition already notified in its period is
 * skipped by `dedupe_key`, so running this twice notifies once. A rule that throws is reported in
 * `errors` and the others still run.
 */
export function evaluateNotifications(db: Database.Database, now: Date = new Date()): NotificationEvaluationSummary {
  const ctx = new EvaluationContext(db, now);
  const rows = db.prepare('SELECT * FROM notification_rules WHERE enabled = 1 ORDER BY created_at ASC, id ASC').all() as RuleRow[];
  const created: AppNotification[] = [];
  const errors: NotificationEvaluationError[] = [];
  const createdAt = now.toISOString();

  for (const row of rows) {
    try {
      const rule = rowToRule(row);
      const candidates = candidatesFor(ctx, rule);
      const inserted = db.transaction(() => candidates
        .map((candidate) => insertCandidate(db, rule, candidate, createdAt))
        .filter((n): n is AppNotification => n !== null))();
      created.push(...inserted);
    } catch (err) {
      errors.push({
        rule_id: row.id,
        kind: row.kind as NotificationRuleKind,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { rules_evaluated: rows.length, created, errors };
}
