import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import {
  getCashflowReport,
  getNetWorthAttribution,
  getReportSummary,
  getSpendingReport,
  getSpendingTrendsReport,
  getTopMerchantsReport,
} from '../services/reporting';
import type {
  CashflowReport,
  ReportCategoryChange,
  ReportComparisonMode,
  ReportMetricSummary,
  ReportSummary,
  SpendingReport,
} from '../../../shared/types';
import { dollarizeFields, toDollars } from '../services/money';
import {
  parseSnapshotPortfolio,
  readPortfolioAccounts,
  type PortfolioMembershipSource,
  type SnapshotPortfolioColumns,
} from '../services/netWorthHistory';

const router = Router();

interface SnapshotPortfolio {
  /** Integer cents, summed over the portfolio accounts this breakdown carried a number for. */
  value: number;
  /** How many of them that was. Fewer than the whole set means the point is not the whole hero. */
  covered: number;
}

/**
 * The portfolio's value inside one snapshot, or null when the row cannot be read.
 *
 * Null rather than 0: an unparseable breakdown is a snapshot this code could not read, and
 * plotting it as zero would draw a portfolio that emptied and refilled. The caller drops the
 * point instead, so the series only carries dates whose balances were actually recovered.
 *
 * `accountIds` is the set THIS snapshot recorded, not today's portfolio. Membership is frozen at
 * write time (migration 056) precisely so this function cannot be handed a set the row never knew
 * about, which is what made an account edit today rewrite every point in the series.
 *
 * `covered` is returned beside the value because a sum over a subset of the accounts is not a
 * smaller portfolio, it is a different quantity. `takeSnapshot` writes a breakdown entry only for
 * `is_hidden = 0` accounts, and an account can be created, hidden or unhidden between snapshots,
 * so a breakdown carrying four of five portfolio accounts is routine and the difference must not
 * be read as money moving. It is counted against the breakdown rather than taken as the size of
 * `accountIds`, so an id with no readable value beside it lowers the count instead of being
 * asserted into it.
 *
 * What a count still cannot see is two consecutive points whose sets are the same SIZE and
 * different MEMBERS: one account leaving as another arrives. TrendChart compares counts, so that
 * segment joins. The ids are on the row now, so it is answerable, but answering it means changing
 * what TrendChart consumes and is not claimed here.
 */
function portfolioInSnapshot(breakdownJson: string, accountIds: Set<string>): SnapshotPortfolio | null {
  let breakdown: unknown;
  try {
    breakdown = JSON.parse(breakdownJson);
  } catch {
    return null;
  }
  if (typeof breakdown !== 'object' || breakdown === null) return null;

  let value = 0;
  let covered = 0;
  for (const [accountId, entry] of Object.entries(breakdown as Record<string, unknown>)) {
    if (!accountIds.has(accountId)) continue;
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
    value += entry;
    covered += 1;
  }
  return { value, covered };
}

// The reporting service returns every money total in integer cents. These helpers
// dollarize the money fields of each report at this route boundary. Percentages
// (percentage, delta_percent, savings_rate), counts, and dates pass through.
type SpendingCategory = SpendingReport['categories'][number];

function spendingCategoryToDollars(node: SpendingCategory): SpendingCategory {
  return {
    ...node,
    amount: toDollars(node.amount),
    ...(node.children ? { children: node.children.map(spendingCategoryToDollars) } : {}),
  };
}

function spendingReportToDollars(report: SpendingReport): SpendingReport {
  return {
    categories: report.categories.map(spendingCategoryToDollars),
    total: toDollars(report.total),
  };
}

function cashflowToDollars(report: CashflowReport): CashflowReport {
  return {
    months: report.months.map((month) => ({
      month: month.month,
      income: toDollars(month.income),
      expenses: toDollars(month.expenses),
      net: toDollars(month.net),
    })),
  };
}

function metricToDollars(metric: ReportMetricSummary): ReportMetricSummary {
  return {
    current: toDollars(metric.current),
    previous: toDollars(metric.previous),
    delta: toDollars(metric.delta),
    delta_percent: metric.delta_percent,
  };
}

function categoryChangeToDollars(change: ReportCategoryChange): ReportCategoryChange {
  return {
    ...change,
    current: toDollars(change.current),
    previous: toDollars(change.previous),
    delta: toDollars(change.delta),
  };
}

function summaryToDollars(summary: ReportSummary): ReportSummary {
  return {
    ...summary,
    income: metricToDollars(summary.income),
    expenses: metricToDollars(summary.expenses),
    net: metricToDollars(summary.net),
    // savings_rate is a percentage metric, not money. Pass through.
    top_spending: summary.top_spending.map(categoryChangeToDollars),
    top_income: summary.top_income.map(categoryChangeToDollars),
    spending_movers: summary.spending_movers.map(categoryChangeToDollars),
    excluded_flows: summary.excluded_flows.map((flow) => ({
      ...flow,
      inflows: toDollars(flow.inflows),
      outflows: toDollars(flow.outflows),
      net: toDollars(flow.net),
    })),
  };
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function reportComparison(value: unknown): ReportComparisonMode | undefined {
  const parsed = firstQueryValue(value);
  if (
    parsed === 'prior_period' ||
    parsed === 'prior_month' ||
    parsed === 'same_month_last_year' ||
    parsed === 'trailing_3' ||
    parsed === 'trailing_12'
  ) {
    return parsed;
  }
  return undefined;
}

// GET /cashflow?startDate&endDate
router.get('/cashflow', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    res.json({ data: cashflowToDollars(getCashflowReport(db, { startDate, endDate })) });
  } catch (err) {
    next(err);
  }
});

// GET /summary?startDate&endDate
router.get('/summary', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const comparison = reportComparison(req.query.comparison);
    res.json({ data: summaryToDollars(getReportSummary(db, { startDate, endDate, comparison })) });
  } catch (err) {
    next(err);
  }
});

// GET /spending?startDate&endDate&parentOnly
router.get('/spending', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const parentOnly = firstQueryValue(req.query.parentOnly);
    res.json({
      data: spendingReportToDollars(getSpendingReport(db, {
        startDate,
        endDate,
        parentOnly: parentOnly === 'true',
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /trends?startDate&endDate&categoryIds=a,b
// Per-category monthly spend series. The service existed but had no route, so nothing could reach it.
router.get('/trends', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const rawCategoryIds = firstQueryValue(req.query.categoryIds);
    const categoryIds = rawCategoryIds
      ? rawCategoryIds.split(',').map((id) => id.trim()).filter(Boolean)
      : undefined;

    const report = getSpendingTrendsReport(db, { startDate, endDate, categoryIds });
    res.json({
      data: {
        months: report.months,
        series: report.series.map((s) => ({ ...s, values: s.values.map(toDollars) })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /merchants?startDate&endDate&limit
router.get('/merchants', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const rawLimit = firstQueryValue(req.query.limit);
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

    const report = getTopMerchantsReport(db, { startDate, endDate, limit });
    res.json({
      data: {
        merchants: report.merchants.map((m) => ({ ...m, total: toDollars(m.total) })),
        total: toDollars(report.total),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /networth-attribution?startDate&endDate
// Returns null when the window holds fewer than two snapshots: nothing moved to attribute.
router.get('/networth-attribution', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);

    const report = getNetWorthAttribution(db, { startDate, endDate });
    if (!report) {
      res.json({ data: null });
      return;
    }

    res.json({
      data: {
        ...report,
        start_net_worth: toDollars(report.start_net_worth),
        end_net_worth: toDollars(report.end_net_worth),
        delta: toDollars(report.delta),
        accounts: report.accounts.map((a) => ({
          ...a,
          start_balance: toDollars(a.start_balance),
          end_balance: toDollars(a.end_balance),
          delta: toDollars(a.delta),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /investments?startDate&endDate
router.get('/investments', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const { startDate, endDate } = req.query as Record<string, string>;

    // One definition of "the portfolio", used by every figure this endpoint serves about TODAY and
    // by the account set the screen renders its holdings list over.
    //
    // The screen used to carry two. The headline summed the balances of accounts holding a
    // position ($2,436.21 on the live ledger); the chart directly beneath it, labelled
    // "Portfolio value", plotted `deriveAssetBuckets(...).investment`, whose INVESTMENT_TYPES
    // set leaves `crypto_wallet` in its own bucket, so it ended at $2,045.04. The gap was the
    // Coinbase wallet exactly, nothing on the screen said so, and the "since last snapshot"
    // delta under the headline was computed off the crypto-free series: it read $0 on a day
    // the headline moved. Crypto belongs in whichever total the holdings list shows, and this
    // list shows it, so `crypto_value` is served beside the headline and the screen prints the
    // split rather than leaving it to a source comment.
    //
    // This set decides nothing about a past snapshot any more, and that is the change migration 056
    // exists for. It used to be applied to every breakdown ever written, so an account edit today
    // silently rewrote the whole series: on a `.backup` copy of the live ledger taken 2026-08-01,
    // retyping Wealthfront Cash to `brokerage` moved the 2026-07-30 point from $2,445.89 to
    // $3,447.59, and hiding Coinbase moved the same point to $2,045.04, with no snapshot touched.
    // Each point now carries the set it was written with, and this one is only the fallback for a
    // row that carries none (see `parseSnapshotPortfolio`).
    const portfolioAccounts = readPortfolioAccounts(db);
    const portfolioAccountIds = portfolioAccounts.map((account) => account.id);
    const portfolioAccountIdSet = new Set(portfolioAccountIds);
    const portfolioValue = portfolioAccounts.reduce((sum, account) => sum + account.current_balance, 0);
    // The balances of the accounts that actually hold something. This, not `portfolioValue`, is
    // what a position list can be reconciled against: an IRA funded and not yet invested makes
    // the two totals disagree with every holding sitting exactly where it should, which is an
    // ordinary account and must not raise a note. The rest of the headline is reported as
    // uninvested balance, which explains the same difference without accusing anything.
    const investedBalance = portfolioAccounts
      .filter((account) => account.holds_position === 1)
      .reduce((sum, account) => sum + account.current_balance, 0);
    const cryptoValue = portfolioAccounts
      .filter((account) => account.type === 'crypto_wallet')
      .reduce((sum, account) => sum + account.current_balance, 0);

    // `IN ()` is not valid SQLite, so an empty portfolio has to be spelled as a false predicate
    // rather than an empty list.
    const inPortfolio = portfolioAccountIds.length > 0
      ? `h.account_id IN (${portfolioAccountIds.map(() => '?').join(', ')})`
      : '0';

    // Current allocation by security type, over the same accounts as every other figure here.
    const allocation = (db.prepare(`
      SELECT
        s.type AS security_type,
        SUM(h.institution_value) AS total_value
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      WHERE ${inPortfolio}
      GROUP BY s.type
      ORDER BY total_value DESC
    `).all(...portfolioAccountIds) as Array<Record<string, unknown>>).map((row) =>
      dollarizeFields(row, ['total_value'])
    );

    // P&L table: holdings with cost_basis. institution_price/quantity are per-unit and
    // stay as-is; the value/basis/gain columns are cents and convert to dollars.
    const holdings = (db.prepare(`
      SELECT
        h.*,
        s.ticker,
        s.name AS security_name,
        s.type AS security_type,
        -- COALESCE(cost_basis, 0) would charge the whole market value against a basis of zero and
        -- report an unknown-basis position as 100% gain. A money-market sweep has no basis to
        -- know, so the honest answer is NULL and the caller renders nothing.
        CASE
          WHEN COALESCE(h.manual_cost_basis, h.cost_basis) > 0
          THEN h.institution_value - COALESCE(h.manual_cost_basis, h.cost_basis)
        END AS unrealized_gain
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      WHERE ${inPortfolio}
      ORDER BY h.institution_value DESC
    `).all(...portfolioAccountIds) as Array<Record<string, unknown>>).map((row) =>
      dollarizeFields(row, ['institution_value', 'cost_basis', 'manual_cost_basis', 'unrealized_gain'])
    );

    // What the positions in those same accounts add up to. It can differ from the balances (an
    // unsettled sweep), and the screen says so rather than picking one silently, so both sides
    // have to come from the same account set to be comparable at all.
    const heldValue = (db.prepare(
      `SELECT SUM(h.institution_value) AS total FROM holdings h WHERE ${inPortfolio}`
    ).get(...portfolioAccountIds) as { total: number | null }).total ?? 0;

    // Portfolio value over time from net worth snapshots. Investment transaction
    // volume is not portfolio value and should not drive a value-history chart.
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push('date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('date <= ?');
      params.push(endDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // is_estimated travels with the point. TrendChart already knows how to draw a reconstruction
    // differently from a measurement; this endpoint was the one consumer that never told it.
    //
    // The value is derived from the breakdown rather than read from `investment_assets`, because
    // that column was frozen from the account types in force when the row was written. Both Fidelity
    // accounts were auto-typed `checking` before being corrected, so the stored column still says
    // $0.00 for two days when the portfolio held $1,661.66. `portfolio_accounts` is the opposite
    // case and is read, not recomputed: it is not a number, it is which accounts the number is a sum
    // over, and that IS a fact about the day the row was written.
    const snapshots = db.prepare(`
      SELECT date, breakdown, is_estimated, portfolio_accounts, portfolio_accounts_source
      FROM net_worth_snapshots
      ${where}
      ORDER BY date ASC
    `).all(...params) as Array<
      { date: string; breakdown: string; is_estimated: number } & SnapshotPortfolioColumns
    >;

    interface HistoryPoint {
      date: string;
      value: number;
      estimated: boolean;
      covered_accounts: number;
      /** Whether this point's account set was written with it, or worked out afterwards. */
      membership: PortfolioMembershipSource;
    }

    const history = snapshots
      .map((snapshot): HistoryPoint | null => {
        const membership = parseSnapshotPortfolio(snapshot, portfolioAccountIdSet);
        const point = portfolioInSnapshot(snapshot.breakdown, membership.accountIds);
        return point === null
          ? null
          : {
            date: snapshot.date,
            value: toDollars(point.value),
            estimated: snapshot.is_estimated === 1,
            covered_accounts: point.covered,
            membership: membership.source,
          };
      })
      .filter((point): point is HistoryPoint => point !== null);

    // `portfolio_account_ids` is served rather than a count so the screen filters its holdings
    // list against the same set instead of re-deriving membership from account types on the
    // client. There have been four hand-maintained copies of a set in this codebase before.
    res.json({
      data: {
        portfolio_value: toDollars(portfolioValue),
        holdings_value: toDollars(heldValue),
        invested_balance: toDollars(investedBalance),
        crypto_value: toDollars(cryptoValue),
        portfolio_account_ids: portfolioAccountIds,
        allocation,
        holdings,
        history,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
