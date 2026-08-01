import { Router, Request, Response, NextFunction } from 'express';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { getDb } from '../db/index';
import { calculateGoalProgress } from '../services/goalProgress';
import { getDataQualitySummary } from '../services/dataQuality';
import { buildRecurringForecast } from '../services/recurringForecast';
import { suggestMerchantRules } from '../services/rules';
import { getAnomalyInsights } from '../services/anomalyInsights';
import { computeSafeToSpend } from '../services/safeToSpend';
import { reconcileAccounts, unreconciledResidual } from '../services/reconciliation';
import { findFlowConservationViolations } from '../services/flowConservation';
import { getMonthlyBudgetsWithProjection } from '../services/budgetProjection';
import { getSyncHealth } from '../services/syncHealth';
import { toDollars } from '../services/money';
import type { Insight, InsightSeverity, SyncHealthConnection } from '../../../shared/types';

const router = Router();

interface ScoredInsight extends Insight {
  rank: number;
}

interface AccountSummary {
  total_accounts: number;
  liquid_assets: number;
}

interface ReviewQueueRow {
  posted_transactions: number;
  uncategorized_transactions: number;
  live_merchant_rules: number;
  detected_recurring: number;
}

interface GoalInsightRow {
  name: string;
  type: 'savings' | 'debt';
  target_amount: number;
  current_amount: number;
  starting_amount: number | null;
  target_date: string | null;
  created_at: string;
  account_balance: number | null;
}

const severityRank: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  positive: 2,
  info: 3,
};

function money(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function addInsight(insights: ScoredInsight[], insight: ScoredInsight): void {
  insights.push(insight);
}

/**
 * EVERY `action_route` NAMES A SCREEN THAT EXISTS.
 *
 * The nav holds at six routes and `client/src/App.tsx` keeps `LEGACY_TARGETS` so an old bookmark
 * still lands. This file was emitting a mix of both: `/plan` on two budget rows beside
 * `/transactions`, `/bills` and `/goals` on six others, with `anomalyInsights.ts` emitting
 * `/reports`. The redirects meant nothing was broken, which is exactly why it could sit half
 * converted. They are all canonical now, each at the destination its own legacy entry redirects to
 * (`/transactions` and `/bills` -> `/ledger`, `/goals` -> `/plan`, `/reports` ->
 * `/?window=this-month`), so the served payload and the router agree without a hop.
 *
 * `tests/insightsRoute.test.ts` walks the served rows against `LEGACY_TARGETS` itself, so adding a
 * row that points at a retired path fails rather than quietly relying on the redirect.
 */
function toPublicInsight(insight: ScoredInsight): Insight {
  return {
    id: insight.id,
    severity: insight.severity,
    title: insight.title,
    message: insight.message,
    metric: insight.metric,
    action_label: insight.action_label,
    action_route: insight.action_route,
  };
}

/**
 * Name the connections a row is about, at most two, and say so when there are more.
 *
 * `institution_name` is already the classifier's resolved name (it falls back per provider), so
 * this never invents one.
 */
function nameConnections(connections: SyncHealthConnection[]): string {
  const named = connections.slice(0, 2).map((connection) => connection.institution_name).join(', ');
  return connections.length > 2 ? `${named} and others` : named;
}

// GET /reconciliation - does the ledger explain each account's balance?
// The one check that decides whether every other number in the app is true. Nothing checked this
// relationship before, and the app's silence about it read as a claim of completeness.
router.get('/reconciliation', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const report = reconcileAccounts(db);
    const toDollarFields = (account: (typeof report.accounts)[number]) => ({
      ...account,
      observed_delta: toDollars(account.observed_delta),
      explained_delta: toDollars(account.explained_delta),
      residual: toDollars(account.residual),
      boundary_amount: toDollars(account.boundary_amount),
      adjusted_residual: toDollars(account.adjusted_residual),
      largest_window_residual: toDollars(account.largest_window_residual),
    });
    // The other half of "does the ledger hold up": a residual asks whether an account's own rows
    // explain its balance, this asks whether two accounts' rows explain each other.
    const flowConservation = findFlowConservationViolations(db).map(
      ({ movement_cents, ...finding }) => ({ ...finding, movement: toDollars(movement_cents) })
    );
    res.json({
      data: {
        accounts: report.accounts.map(toDollarFields),
        unreconciled: report.unreconciled.map(toDollarFields),
        // The figure judged, over the accounts judged, as a magnitude: see `unreconciledResidual`,
        // which sums `Math.abs` precisely so two accounts unexplained in opposite directions cannot
        // cancel to a clean bill of health. `total_residual` sums raw `residual` over every account,
        // including the market-driven ones the filter exempts and the boundary artifact
        // `adjusted_residual` removes, so it can be large beside an empty `unreconciled`. Both are
        // published, each under a name that says which population it covers.
        unreconciled_residual: toDollars(unreconciledResidual(report)),
        residual_all_accounts: toDollars(report.total_residual),
        measured_snapshot_count: report.measured_snapshot_count,
        flow_conservation: flowConservation,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /safe-to-spend - what is left after every claim already made on the liquid pool.
// Served from the server so the Today screen and the advisor cannot disagree about it.
router.get('/safe-to-spend', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const now = new Date();
    const budgets = getMonthlyBudgetsWithProjection(db, now.getFullYear(), now.getMonth() + 1);
    const breakdown = computeSafeToSpend(db, { budgets });
    res.json({
      data: {
        liquid: toDollars(breakdown.liquid),
        card_balances: toDollars(breakdown.cardBalances),
        upcoming_bills: toDollars(breakdown.upcomingBills),
        allocated_budgets: toDollars(breakdown.allocatedBudgets),
        allocated_goals: toDollars(breakdown.allocatedGoals),
        free: toDollars(breakdown.free),
        forecast_days: breakdown.forecastDays,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/quality', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    res.json({ data: getDataQualitySummary(db) });
  } catch (err) {
    next(err);
  }
});

router.get('/', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const insights: ScoredInsight[] = [];

    const accountSummary = db.prepare(`
      SELECT
        COUNT(*) AS total_accounts,
        COALESCE(SUM(
          CASE
            WHEN is_hidden = 0 AND is_liability = 0 AND type IN ('checking', 'savings', 'cash')
            THEN current_balance
            ELSE 0
          END
        ), 0) AS liquid_assets
      FROM accounts
      WHERE is_hidden = 0 AND type != 'closed'
    `).get() as AccountSummary;

    if (accountSummary.total_accounts === 0) {
      addInsight(insights, {
        id: 'connect-accounts',
        severity: 'info',
        rank: 10,
        title: 'Connect accounts',
        message: 'Mizan needs live accounts before balances, cash flow, and goals can become trustworthy.',
        action_label: 'Add account',
        action_route: '/accounts',
      });
    }

    /*
     * ONE CLASSIFICATION OF A CONNECTION, NOT TWO.
     *
     * This block used to run its own pair of queries and its own rule, and it disagreed with
     * `syncHealth` about the same row in both directions. It said "N connections cannot sync until
     * reconnected" for every status that is not 'active', so a `sync_error` (which `classifyStatus`
     * calls "Retry this sync. If it fails again, reconnect the institution.") was reported as a
     * login that had expired: a cause nothing here established. It also read
     * `coinbase_connections` unfiltered where `getSyncHealth` drops `disconnected` rows, so a
     * connection the owner had disconnected counted as blocked on one surface and did not exist on
     * the other. The live database is exactly this case: `simplefin_primary` sits at `sync_error`.
     *
     * The classifier is now asked, and only what it decided is stated.
     */
    const syncHealth = getSyncHealth(db);
    const attentionConnections = syncHealth.connections.filter((c) => c.needs_attention);
    const staleConnections = syncHealth.connections.filter((c) => c.is_stale);

    if (attentionConnections.length > 0) {
      addInsight(insights, {
        id: 'sync-attention',
        severity: 'critical',
        rank: 0,
        title: 'Connection needs attention',
        message: attentionConnections.length === 1
          ? `${attentionConnections[0].institution_name}: ${attentionConnections[0].status_detail}`
          : `${attentionConnections
              .map((c) => `${c.institution_name} (${c.status_label})`)
              .join(', ')} need action before these balances can be trusted.`,
        metric: `${attentionConnections.length} to fix`,
        action_label: 'Fix sync',
        action_route: '/accounts',
      });
    } else if (staleConnections.length > 0) {
      addInsight(insights, {
        id: 'sync-stale',
        severity: 'warning',
        rank: 20,
        title: 'Sync is getting stale',
        message: staleConnections.length === 1
          ? `${staleConnections[0].institution_name}: ${staleConnections[0].status_detail}`
          : `${nameConnections(staleConnections)} should be synced before relying on current totals.`,
        metric: `${staleConnections.length} stale`,
        action_label: 'Review',
        action_route: '/accounts',
      });
    }

    const reviewQueue = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM transactions WHERE pending = 0) AS posted_transactions,
        -- Must match the uncategorized predicate in services/transactionReview.ts getCounts(),
        -- or this insight and the review badge disagree about the same number.
        (SELECT COUNT(*) FROM transactions WHERE pending = 0 AND category_id IS NULL AND review_status <> 'dismissed') AS uncategorized_transactions,
        -- retired_at IS NULL is the whole difference between "rules that exist" and "rules that
        -- run". Migration 045 retired two AI rules that contended with the owner's, and this count
        -- kept reporting them: the row read "236 merchant rules are active" where 234 were.
        (SELECT COUNT(*) FROM merchant_rules WHERE retired_at IS NULL) AS live_merchant_rules,
        (
          SELECT COUNT(*)
          FROM recurring_patterns
          WHERE is_active = 1 AND is_confirmed = 0 AND transaction_count >= 3
        ) AS detected_recurring
    `).get() as ReviewQueueRow;

    if (reviewQueue.uncategorized_transactions > 0) {
      const ratio = reviewQueue.posted_transactions > 0
        ? (reviewQueue.uncategorized_transactions / reviewQueue.posted_transactions) * 100
        : 0;
      addInsight(insights, {
        id: 'uncategorized-transactions',
        severity: ratio >= 10 ? 'warning' : 'info',
        rank: 30,
        title: 'Transactions need categorizing',
        message: `${reviewQueue.uncategorized_transactions} posted transaction${reviewQueue.uncategorized_transactions === 1 ? '' : 's'} are uncategorized, which weakens budgets and reports.`,
        metric: percent(ratio),
        action_label: 'Review',
        action_route: '/ledger',
      });
    } else if (reviewQueue.posted_transactions > 0 && reviewQueue.live_merchant_rules > 0) {
      addInsight(insights, {
        id: 'rules-working',
        severity: 'positive',
        rank: 70,
        title: 'Categorization is clean',
        message: `All posted transactions are categorized and ${reviewQueue.live_merchant_rules} merchant rule${reviewQueue.live_merchant_rules === 1 ? ' is' : 's are'} live.`,
        action_label: 'Rules',
        action_route: '/settings',
      });
    }

    if (reviewQueue.detected_recurring > 0) {
      addInsight(insights, {
        id: 'confirm-recurring',
        severity: 'info',
        rank: 40,
        title: 'Recurring activity detected',
        message: `${reviewQueue.detected_recurring} detected pattern${reviewQueue.detected_recurring === 1 ? '' : 's'} should be confirmed or dismissed so forecasts stay honest.`,
        metric: `${reviewQueue.detected_recurring} pending`,
        action_label: 'Confirm',
        action_route: '/ledger',
      });
    }

    const ruleSuggestions = suggestMerchantRules(db);
    if (ruleSuggestions.length > 0) {
      const uncategorizedMatches = ruleSuggestions.reduce(
        (sum, suggestion) => sum + suggestion.uncategorized_count,
        0
      );
      addInsight(insights, {
        id: 'rule-suggestions',
        severity: 'info',
        rank: 35,
        title: 'Categorization rules are ready',
        message: `${ruleSuggestions.length} suggested rule${ruleSuggestions.length === 1 ? '' : 's'} could clean up ${uncategorizedMatches} uncategorized transaction${uncategorizedMatches === 1 ? '' : 's'}.`,
        metric: `${ruleSuggestions.length} ready`,
        action_label: 'Review',
        action_route: '/settings',
      });
    }

    const now = new Date();

    for (const anomaly of getAnomalyInsights(db, now)) {
      addInsight(insights, anomaly);
    }

    /*
     * ONE DEFINITION OF BUDGET SPEND, AND IT IS THE SHARED SERVICE'S.
     *
     * This block ran its own copy of the /plan query with one clause changed:
     * `SUM(ABS(t.amount))` behind `t.amount < 0`, where `getMonthlyBudgetsWithProjection` sums
     * `SUM(-t.amount)` over every row. The two are equal for a pure-outflow month and differ by
     * exactly the refunds otherwise, which is the defect `transactionFilters.spendAmountSql`
     * exists to stop. Measured 2026-07-31 against a copy of `.mizan/mizan.db` at migration 054,
     * for 2026-07: this route computed Shopping at 102459 cents against a 50000 cent budget and
     * rendered "Shopping is at 204.9% of its monthly budget", while /plan computed -102863 cents
     * on the same rows. July's Shopping credits exceeded its purchases by $1,028.63; there was no
     * overspend to report.
     *
     * A signed total can be negative, so the two thresholds below are one-sided by construction:
     * a net-refund month lands far under 80 and this stays silent, which is the healthy case.
     */
    const monthlyBudgets = getMonthlyBudgetsWithProjection(db, now.getFullYear(), now.getMonth() + 1, now);
    const tightestBudget = monthlyBudgets
      .filter((budget) => budget.amount > 0)
      .sort((a, b) => (b.spent ?? 0) / b.amount - (a.spent ?? 0) / a.amount)[0];

    if (tightestBudget) {
      const spent = tightestBudget.spent ?? 0;
      const used = (spent / tightestBudget.amount) * 100;
      const categoryName = tightestBudget.category_name ?? 'This budget';
      if (used >= 100) {
        addInsight(insights, {
          id: 'budget-over',
          severity: 'warning',
          rank: 25,
          title: 'Budget is over plan',
          message: `${categoryName} is at ${percent(used)} of its monthly budget.`,
          metric: `${money(toDollars(spent))} / ${money(toDollars(tightestBudget.amount))}`,
          action_label: 'Open budget',
          action_route: '/plan',
        });
      } else if (used >= 80) {
        addInsight(insights, {
          id: 'budget-tight',
          severity: 'info',
          rank: 45,
          title: 'Budget is getting tight',
          message: `${categoryName} has used ${percent(used)} of its monthly budget.`,
          metric: `${money(toDollars(tightestBudget.amount - spent))} left`,
          action_label: 'Open budget',
          action_route: '/plan',
        });
      }
    }

    // liquid_assets (inline-SQL SUM) and buildRecurringForecast both return integer cents;
    // dollarize each before combining and feeding the money() string formatter.
    const forecast = buildRecurringForecast(db, 30);
    const liquidAssets = toDollars(accountSummary.liquid_assets);
    const forecastNet = toDollars(forecast.net);
    if (forecast.occurrences.length > 0 && liquidAssets + forecastNet < 0) {
      addInsight(insights, {
        id: 'cash-projection-negative',
        severity: 'critical',
        rank: 5,
        title: 'Projected cash shortfall',
        message: `Scheduled recurring activity would take liquid cash below zero over the next 30 days.`,
        metric: money(liquidAssets + forecastNet),
        action_label: 'Open bills',
        action_route: '/ledger',
      });
    } else if (forecast.occurrences.length > 0 && forecastNet < 0) {
      addInsight(insights, {
        id: 'cash-projection-down',
        severity: 'info',
        rank: 50,
        title: 'Cash is scheduled to move down',
        message: `Known recurring bills exceed recurring income by ${money(Math.abs(forecastNet))} over the next 30 days.`,
        metric: money(forecastNet),
        action_label: 'Open bills',
        action_route: '/ledger',
      });
    }

    const goals = db.prepare(`
      SELECT
        g.name,
        g.type,
        g.target_amount,
        g.current_amount,
        g.starting_amount,
        g.target_date,
        g.created_at,
        a.current_balance AS account_balance
      FROM goals g
      LEFT JOIN accounts a ON a.id = g.account_id
      WHERE g.is_archived = 0
      ORDER BY g.target_date IS NULL ASC, g.target_date ASC, g.created_at ASC
      LIMIT 8
    `).all() as GoalInsightRow[];
    const soonestOpenGoal = goals
      .map((goal) => {
        // calculateGoalProgress and target_amount are both integer cents; dollarize both.
        const progressAmount = toDollars(calculateGoalProgress(goal).progress_amount);
        const target = toDollars(goal.target_amount);
        return {
          goal,
          progressAmount,
          remaining: Math.max(target - progressAmount, 0),
          percentComplete: target > 0 ? (progressAmount / target) * 100 : 0,
        };
      })
      .find((goal) => goal.remaining > 0 && goal.goal.target_date !== null);

    if (soonestOpenGoal?.goal.target_date) {
      const daysUntilTarget = differenceInCalendarDays(parseISO(soonestOpenGoal.goal.target_date), now);
      if (daysUntilTarget <= 30) {
        addInsight(insights, {
          id: 'goal-deadline',
          severity: daysUntilTarget < 0 ? 'warning' : 'info',
          rank: 55,
          title: 'Goal deadline is close',
          message: `${soonestOpenGoal.goal.name} has ${money(soonestOpenGoal.remaining)} remaining${daysUntilTarget >= 0 ? ` with ${daysUntilTarget} days left` : ''}.`,
          metric: percent(soonestOpenGoal.percentComplete),
          action_label: 'Open goals',
          action_route: '/plan',
        });
      }
    } else {
      const almostDone = goals
        .map((goal) => {
          const progressAmount = toDollars(calculateGoalProgress(goal).progress_amount);
          const target = toDollars(goal.target_amount);
          return {
            goal,
            remaining: Math.max(target - progressAmount, 0),
            percentComplete: target > 0 ? (progressAmount / target) * 100 : 0,
          };
        })
        .find((goal) => goal.percentComplete >= 90 && goal.remaining > 0);

      if (almostDone) {
        addInsight(insights, {
          id: 'goal-close',
          severity: 'positive',
          rank: 65,
          title: 'Goal is close',
          message: `${almostDone.goal.name} is ${percent(almostDone.percentComplete)} complete with ${money(almostDone.remaining)} left.`,
          action_label: 'Open goals',
          action_route: '/plan',
        });
      }
    }

    const output = insights
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.rank - b.rank)
      .slice(0, 6)
      .map(toPublicInsight);

    res.json({ data: output });
  } catch (err) {
    next(err);
  }
});

export default router;
