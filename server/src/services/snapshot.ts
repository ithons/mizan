import { v4 as uuidv4 } from 'uuid';
import { format, subMonths, parseISO, startOfMonth } from 'date-fns';
import { getDb } from '../db/index';

export function takeSnapshot(): void {
  const db = getDb();

  const accounts = db.prepare(`
    SELECT id, current_balance, is_liability
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{ id: string; current_balance: number; is_liability: number }>;

  let total_assets = 0;
  let total_liabilities = 0;
  const breakdown: Record<string, number> = {};

  for (const account of accounts) {
    breakdown[account.id] = account.current_balance;
    if (account.is_liability) {
      total_liabilities += account.current_balance;
    } else {
      total_assets += account.current_balance;
    }
  }

  const net_worth = total_assets - total_liabilities;
  const today = format(new Date(), 'yyyy-MM-dd');
  const now = new Date().toISOString();

  const existing = db.prepare(
    'SELECT id FROM net_worth_snapshots WHERE date = ?'
  ).get(today) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE net_worth_snapshots
      SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?
      WHERE id = ?
    `).run(total_assets, total_liabilities, net_worth, JSON.stringify(breakdown), existing.id);
  } else {
    db.prepare(`
      INSERT INTO net_worth_snapshots (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(uuidv4(), today, total_assets, total_liabilities, net_worth, JSON.stringify(breakdown), now);
  }
}

export function backfillSnapshots(): void {
  const db = getDb();
  const now = new Date();

  // Load all transactions from last 13 months
  const transactions = db.prepare(`
    SELECT id, account_id, date, amount
    FROM transactions
    WHERE date >= ? AND pending = 0
    ORDER BY date ASC
  `).all(format(subMonths(now, 13), 'yyyy-MM-dd')) as Array<{
    id: string;
    account_id: string;
    date: string;
    amount: number;
  }>;

  // Current balances as the starting point (today's balances)
  const accounts = db.prepare(`
    SELECT id, current_balance, is_liability, is_hidden
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{ id: string; current_balance: number; is_liability: number; is_hidden: number }>;

  const balances: Record<string, number> = {};
  for (const account of accounts) {
    balances[account.id] = account.current_balance;
  }

  const accountMap: Record<string, { is_liability: number }> = {};
  for (const account of accounts) {
    accountMap[account.id] = { is_liability: account.is_liability };
  }

  // Walk backwards month by month for 12 months
  for (let monthsBack = 1; monthsBack <= 12; monthsBack++) {
    const targetDate = startOfMonth(subMonths(now, monthsBack));
    const targetStr = format(targetDate, 'yyyy-MM-dd');

    // Check if snapshot already exists for this month
    const existing = db.prepare(
      'SELECT id FROM net_worth_snapshots WHERE date = ?'
    ).get(targetStr) as { id: string } | undefined;

    if (existing) continue;

    // Find all transactions that occurred after this target date up to the next month
    // to replay backwards: subtract amounts that happened after target date
    const laterTransactions = transactions.filter(t => t.date > targetStr);

    // Compute approximate balances at start of target month by reversing later transactions
    const approxBalances: Record<string, number> = { ...balances };
    for (const txn of laterTransactions) {
      if (approxBalances[txn.account_id] !== undefined) {
        // Reverse the transaction: transactions reduce/increase balance
        // In Plaid convention: negative amount = money going out (expense), positive = income
        approxBalances[txn.account_id] -= txn.amount;
      }
    }

    let total_assets = 0;
    let total_liabilities = 0;
    const breakdown: Record<string, number> = {};

    for (const accountId of Object.keys(approxBalances)) {
      const balance = approxBalances[accountId];
      breakdown[accountId] = balance;
      const account = accountMap[accountId];
      if (!account) continue;
      if (account.is_liability) {
        total_liabilities += balance;
      } else {
        total_assets += balance;
      }
    }

    const net_worth = total_assets - total_liabilities;

    db.prepare(`
      INSERT INTO net_worth_snapshots (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      uuidv4(),
      targetStr,
      total_assets,
      total_liabilities,
      net_worth,
      JSON.stringify(breakdown),
      new Date().toISOString()
    );
  }
}
