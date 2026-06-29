import { format, subMonths, startOfMonth } from 'date-fns';
import { getDb } from '../db/index';

export const ADVISOR_SYSTEM_PROMPT = `You are a sharp, honest personal financial advisor with access to the user's complete financial picture. Their real balances, transactions, and portfolio are provided below.

Give specific, actionable advice using their actual numbers. Be direct - if something looks concerning (overspending, under-diversification, thin emergency fund, too much in a single position), say so clearly. If something looks healthy, say that too.

For investments: discuss asset allocation, concentration risk, tax-advantaged account usage, and whether holdings match a reasonable time horizon. Ask if you need to know their tax bracket or risk tolerance before giving tax/risk advice.

Keep responses concise unless depth is clearly warranted. Use dollar amounts and percentages from their data. Never fabricate numbers.`;

function fmt(n: number | null | undefined, prefix = '$'): string {
  if (n == null) return 'N/A';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${prefix}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${prefix}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${prefix}${abs.toFixed(2)}`;
}

function pct(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

export function buildFinancialContext(): string {
  const db = getDb();
  const today = new Date();
  const thisMonthStart = format(startOfMonth(today), 'yyyy-MM-dd');
  const threeMonthsAgo = format(startOfMonth(subMonths(today, 3)), 'yyyy-MM-dd');
  const sixMonthsAgo = format(startOfMonth(subMonths(today, 6)), 'yyyy-MM-dd');

  const lines: string[] = [`## Financial Snapshot - ${format(today, 'MMMM d, yyyy')}`];

  // ── Accounts & Net Worth ─────────────────────────────────────────────────
  const accounts = db.prepare(`
    SELECT type, current_balance, available_balance, is_liability, is_hidden, account_name, institution_name
    FROM accounts
    WHERE is_hidden = 0
    ORDER BY type
  `).all() as Array<{
    type: string; current_balance: number; available_balance: number | null;
    is_liability: number; is_hidden: number; account_name: string; institution_name: string;
  }>;

  const liquidTypes = new Set(['checking', 'savings', 'cash']);
  const investTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth']);
  const cryptoTypes = new Set(['crypto_wallet']);

  let liquid = 0, investments = 0, crypto = 0, liabilities = 0, otherAssets = 0;
  const acctLines: string[] = [];

  for (const a of accounts) {
    const bal = a.current_balance;
    if (a.is_liability) {
      liabilities += Math.abs(bal);
      acctLines.push(`  ${a.account_name} (${a.institution_name || a.type}): ${fmt(bal)} owed`);
    } else if (liquidTypes.has(a.type)) {
      liquid += bal;
      acctLines.push(`  ${a.account_name} (${a.type}): ${fmt(bal)}`);
    } else if (investTypes.has(a.type)) {
      investments += bal;
      acctLines.push(`  ${a.account_name} (${a.type}): ${fmt(bal)}`);
    } else if (cryptoTypes.has(a.type)) {
      crypto += bal;
      acctLines.push(`  ${a.account_name} (crypto): ${fmt(bal)}`);
    } else {
      otherAssets += bal;
      acctLines.push(`  ${a.account_name} (${a.type}): ${fmt(bal)}`);
    }
  }

  const totalAssets = liquid + investments + crypto + otherAssets;
  const netWorth = totalAssets - liabilities;

  // Net worth vs last month
  const lastMonthSnapshot = db.prepare(`
    SELECT net_worth FROM net_worth_snapshots
    WHERE date < ? ORDER BY date DESC LIMIT 1
  `).get(thisMonthStart) as { net_worth: number } | undefined;

  const nwDelta = lastMonthSnapshot ? netWorth - lastMonthSnapshot.net_worth : null;

  lines.push('');
  lines.push(`### Net Worth: ${fmt(netWorth)}${nwDelta != null ? ` (${nwDelta >= 0 ? '+' : ''}${fmt(nwDelta)} vs last month)` : ''}`);
  lines.push(`  Liquid assets:    ${fmt(liquid)}`);
  if (investments > 0) lines.push(`  Investments:      ${fmt(investments)}`);
  if (crypto > 0) lines.push(`  Crypto:           ${fmt(crypto)}`);
  if (otherAssets > 0) lines.push(`  Other assets:     ${fmt(otherAssets)}`);
  if (liabilities > 0) lines.push(`  Liabilities:      ${fmt(liabilities)}`);
  lines.push('');
  lines.push('Account breakdown:');
  lines.push(...acctLines);

  // ── Cash Flow (3-month average) ──────────────────────────────────────────
  const cashflow = db.prepare(`
    SELECT
      SUM(CASE WHEN t.amount > 0 AND COALESCE(c.is_investment, 0) = 0 THEN t.amount ELSE 0 END) AS total_income,
      SUM(CASE WHEN t.amount < 0 AND COALESCE(c.is_investment, 0) = 0 THEN ABS(t.amount) ELSE 0 END) AS total_expenses
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.date >= ? AND t.pending = 0
  `).get(threeMonthsAgo) as { total_income: number; total_expenses: number };

  const avgIncome = (cashflow?.total_income ?? 0) / 3;
  const avgExpenses = (cashflow?.total_expenses ?? 0) / 3;
  const avgNet = avgIncome - avgExpenses;

  lines.push('');
  lines.push('### Cash Flow - 3-month average');
  lines.push(`  Income:   ${fmt(avgIncome)}/mo`);
  lines.push(`  Expenses: ${fmt(avgExpenses)}/mo`);
  lines.push(`  Net:      ${fmt(avgNet)}/mo`);

  // ── Top Spending Categories (this month) ────────────────────────────────
  const thisMonthSpending = db.prepare(`
    SELECT
      COALESCE(pc.name, c.name, 'Uncategorized') AS category,
      SUM(ABS(t.amount)) AS total
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    WHERE t.date >= ?
      AND t.pending = 0
      AND t.amount < 0
      AND COALESCE(c.is_income, 0) = 0
      AND COALESCE(c.is_investment, 0) = 0
    GROUP BY COALESCE(pc.id, c.id, 'uncategorized')
    ORDER BY total DESC
    LIMIT 8
  `).all(thisMonthStart) as Array<{ category: string; total: number }>;

  // Budget context
  const budgets = db.prepare(`
    SELECT b.amount, c.name AS category_name,
      COALESCE(pc.name, c.name) AS parent_category
    FROM budgets b
    JOIN categories c ON c.id = b.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
    WHERE b.period = 'monthly'
  `).all() as Array<{ amount: number; category_name: string; parent_category: string }>;
  const budgetMap = new Map(budgets.map((b) => [b.parent_category || b.category_name, b.amount]));

  if (thisMonthSpending.length > 0) {
    lines.push('');
    lines.push(`### Top Spending - ${format(today, 'MMMM')}`);
    for (const row of thisMonthSpending) {
      const budget = budgetMap.get(row.category);
      const budgetStr = budget ? ` | budget: ${fmt(row.total)}/${fmt(budget)} (${Math.round((row.total / budget) * 100)}%)` : '';
      lines.push(`  ${row.category}: ${fmt(row.total)}${budgetStr}`);
    }
  }

  // ── Investment Portfolio ─────────────────────────────────────────────────
  const holdings = db.prepare(`
    SELECT
      s.ticker, s.name AS sec_name, s.type AS sec_type,
      h.quantity, h.institution_value, h.cost_basis
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    JOIN accounts a ON a.id = h.account_id
    WHERE a.is_hidden = 0
    ORDER BY h.institution_value DESC
    LIMIT 15
  `).all() as Array<{
    ticker: string | null; sec_name: string; sec_type: string;
    quantity: number; institution_value: number; cost_basis: number | null;
  }>;

  if (holdings.length > 0) {
    const totalPortfolio = holdings.reduce((s, h) => s + h.institution_value, 0);
    const totalCostBasis = holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
    const totalGain = totalCostBasis > 0 ? totalPortfolio - totalCostBasis : null;
    const totalReturn = totalCostBasis > 0 ? ((totalPortfolio - totalCostBasis) / totalCostBasis) * 100 : null;

    // Asset type allocation
    const byType = new Map<string, number>();
    for (const h of holdings) {
      byType.set(h.sec_type, (byType.get(h.sec_type) ?? 0) + h.institution_value);
    }

    lines.push('');
    lines.push(`### Investment Portfolio - ${fmt(totalPortfolio)}${totalReturn != null ? ` (${pct(totalReturn)} total return)` : ''}`);
    if (totalGain != null) lines.push(`  Unrealized gain/loss: ${fmt(totalGain)}`);

    lines.push('  Asset mix:');
    for (const [type, val] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${type}: ${fmt(val)} (${Math.round((val / totalPortfolio) * 100)}%)`);
    }

    lines.push('  Top holdings:');
    for (const h of holdings.slice(0, 10)) {
      const gain = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
      const ret = h.cost_basis != null && h.cost_basis > 0
        ? ((h.institution_value - h.cost_basis) / h.cost_basis) * 100
        : null;
      const gainStr = gain != null ? ` (${gain >= 0 ? '+' : ''}${fmt(gain)}, ${pct(ret)})` : '';
      lines.push(`    ${h.ticker ?? h.sec_name}: ${fmt(h.institution_value)}${gainStr}`);
    }
  }

  // ── Net Worth Trend (6 months) ───────────────────────────────────────────
  const nwHistory = db.prepare(`
    SELECT date, net_worth FROM net_worth_snapshots
    WHERE date >= ? ORDER BY date ASC
  `).all(sixMonthsAgo) as Array<{ date: string; net_worth: number }>;

  if (nwHistory.length >= 2) {
    lines.push('');
    lines.push('### Net Worth Trend (last 6 months)');
    for (const snap of nwHistory) {
      lines.push(`  ${snap.date}: ${fmt(snap.net_worth)}`);
    }
  }

  // ── Upcoming Bills ───────────────────────────────────────────────────────
  const upcoming = db.prepare(`
    SELECT merchant_name, average_amount, next_expected, frequency
    FROM recurring_patterns
    WHERE is_active = 1 AND next_expected >= date('now') AND next_expected <= date('now', '+14 days')
    ORDER BY next_expected ASC
  `).all() as Array<{ merchant_name: string; average_amount: number; next_expected: string; frequency: string }>;

  if (upcoming.length > 0) {
    lines.push('');
    lines.push('### Upcoming Bills (next 14 days)');
    for (const bill of upcoming) {
      lines.push(`  ${bill.next_expected}: ${bill.merchant_name} - ${fmt(bill.average_amount)} (${bill.frequency})`);
    }
  }

  // ── Recent Transactions ──────────────────────────────────────────────────
  const recent = db.prepare(`
    SELECT t.date, t.merchant_name, t.amount, c.name AS category, c.is_income
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.pending = 0
    ORDER BY t.date DESC, t.created_at DESC
    LIMIT 15
  `).all() as Array<{ date: string; merchant_name: string | null; amount: number; category: string | null; is_income: number }>;

  if (recent.length > 0) {
    lines.push('');
    lines.push('### Recent Transactions');
    for (const tx of recent) {
      const sign = tx.amount >= 0 ? '+' : '-';
      lines.push(`  ${tx.date}: ${tx.merchant_name ?? 'Unknown'} - ${sign}${fmt(Math.abs(tx.amount))} (${tx.category ?? 'Uncategorized'})`);
    }
  }

  return lines.join('\n');
}
