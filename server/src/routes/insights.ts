import { Router, Request, Response, NextFunction } from 'express';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import { getDb } from '../db/index';
import { calculateGoalProgress } from '../services/goalProgress';
import { getDataQualitySummary } from '../services/dataQuality';
import { buildRecurringForecast } from '../services/recurringForecast';
import { suggestMerchantRules } from '../services/rules';
import { getAnomalyInsights } from '../services/anomalyInsights';
import { toDollars } from '../services/money';
import type { Insight, InsightSeverity } from '../../../shared/types';

const router = Router();

interface ScoredInsight extends Insight {
  rank: number;
}

interface AccountSummary {
  total_accounts: number;
  liquid_assets: number;
}

interface ConnectionRow {
  institution_name: string | null;
  last_synced_at: string | null;
  status: string;
}

interface ReviewQueueRow {
  posted_transactions: number;
  uncategorized_transactions: number;
  merchant_rules: number;
  detected_recurring: number;
}

interface BudgetPressureRow {
  category_name: string;
  amount: number;
  spent: number;
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

function ageInDays(iso: string | null): number | null {
  if (!iso) return null;

  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return null;

  return differenceInCalendarDays(new Date(), parsed);
}

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

    const simplefinConnections = db.prepare(`
      SELECT 'SimpleFIN' AS institution_name, last_synced_at, status
      FROM simplefin_connections
      WHERE status != 'removed'
    `).all() as ConnectionRow[];
    const coinbaseConnections = db.prepare(`
      SELECT display_name AS institution_name, last_synced_at, status
      FROM coinbase_connections
    `).all() as ConnectionRow[];
    const connections = [...simplefinConnections, ...coinbaseConnections];
    const brokenConnections = connections.filter((connection) => connection.status !== 'active');
    const staleConnections = connections.filter((connection) => {
      if (connection.status !== 'active') return false;
      const age = ageInDays(connection.last_synced_at);
      return age === null || age >= 3;
    });

    if (brokenConnections.length > 0) {
      addInsight(insights, {
        id: 'sync-reconnect',
        severity: 'critical',
        rank: 0,
        title: 'Connection needs attention',
        message: `${brokenConnections.length} connection${brokenConnections.length === 1 ? '' : 's'} cannot sync until reconnected.`,
        metric: `${brokenConnections.length} blocked`,
        action_label: 'Fix sync',
        action_route: '/accounts',
      });
    } else if (staleConnections.length > 0) {
      const names = staleConnections
        .slice(0, 2)
        .map((connection) => connection.institution_name || 'Connection')
        .join(', ');
      addInsight(insights, {
        id: 'sync-stale',
        severity: 'warning',
        rank: 20,
        title: 'Sync is getting stale',
        message: `${names}${staleConnections.length > 2 ? ' and others' : ''} have not synced in at least 3 days.`,
        metric: `${staleConnections.length} stale`,
        action_label: 'Review',
        action_route: '/accounts',
      });
    }

    const reviewQueue = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM transactions WHERE pending = 0) AS posted_transactions,
        (SELECT COUNT(*) FROM transactions WHERE pending = 0 AND category_id IS NULL) AS uncategorized_transactions,
        (SELECT COUNT(*) FROM merchant_rules) AS merchant_rules,
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
        action_route: '/transactions',
      });
    } else if (reviewQueue.posted_transactions > 0 && reviewQueue.merchant_rules > 0) {
      addInsight(insights, {
        id: 'rules-working',
        severity: 'positive',
        rank: 70,
        title: 'Categorization is clean',
        message: `All posted transactions are categorized and ${reviewQueue.merchant_rules} merchant rule${reviewQueue.merchant_rules === 1 ? '' : 's'} are active.`,
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
        action_route: '/bills',
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
    const monthStart = format(new Date(now.getFullYear(), now.getMonth(), 1), 'yyyy-MM-dd');
    const monthEnd = format(new Date(now.getFullYear(), now.getMonth() + 1, 0), 'yyyy-MM-dd');
    const currentMonth = format(now, 'yyyy-MM');

    for (const anomaly of getAnomalyInsights(db, now)) {
      addInsight(insights, anomaly);
    }

    const budgetRows = db.prepare(`
      WITH RECURSIVE budget_categories(root_id, category_id) AS (
        SELECT id, id FROM categories
        UNION ALL
        SELECT bc.root_id, c.id
        FROM categories c
        JOIN budget_categories bc ON c.parent_id = bc.category_id
      )
      SELECT
        c.name AS category_name,
        b.amount,
        COALESCE(SUM(ABS(t.amount)), 0) AS spent
      FROM budgets b
      JOIN categories c ON c.id = b.category_id
      LEFT JOIN budget_categories bc ON bc.root_id = b.category_id
      LEFT JOIN transactions t
        ON t.category_id = bc.category_id
       AND t.date BETWEEN ? AND ?
       AND t.amount < 0
       AND t.pending = 0
      WHERE b.period = 'monthly' OR b.period = ?
      GROUP BY b.id
      ORDER BY spent / NULLIF(b.amount, 0) DESC
      LIMIT 1
    `).all(monthStart, monthEnd, currentMonth) as BudgetPressureRow[];
    const tightestBudget = budgetRows[0];

    if (tightestBudget && tightestBudget.amount > 0) {
      const used = (tightestBudget.spent / tightestBudget.amount) * 100;
      if (used >= 100) {
        addInsight(insights, {
          id: 'budget-over',
          severity: 'warning',
          rank: 25,
          title: 'Budget is over plan',
          message: `${tightestBudget.category_name} is at ${percent(used)} of its monthly budget.`,
          metric: `${money(toDollars(tightestBudget.spent))} / ${money(toDollars(tightestBudget.amount))}`,
          action_label: 'Open budget',
          action_route: '/budget',
        });
      } else if (used >= 80) {
        addInsight(insights, {
          id: 'budget-tight',
          severity: 'info',
          rank: 45,
          title: 'Budget is getting tight',
          message: `${tightestBudget.category_name} has used ${percent(used)} of its monthly budget.`,
          metric: `${money(toDollars(tightestBudget.amount - tightestBudget.spent))} left`,
          action_label: 'Open budget',
          action_route: '/budget',
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
        action_route: '/bills',
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
        action_route: '/bills',
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
          action_route: '/goals',
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
          action_route: '/goals',
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
