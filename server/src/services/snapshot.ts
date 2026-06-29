import { v4 as uuidv4 } from 'uuid';
import { format, subMonths, parseISO, startOfMonth } from 'date-fns';
import { getDb } from '../db/index';

export function takeSnapshot(): void {
  const db = getDb();

  const accounts = db.prepare(`
    SELECT id, current_balance, is_liability, type
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{ id: string; current_balance: number; is_liability: number; type: string }>;

  let total_assets = 0;
  let total_liabilities = 0;
  let liquid_assets = 0;
  let investment_assets = 0;
  let crypto_assets = 0;
  const breakdown: Record<string, number> = {};

  const liquidTypes = new Set(['checking', 'savings', 'cash']);
  const investmentTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth']);

  for (const account of accounts) {
    breakdown[account.id] = account.current_balance;
    if (account.is_liability) {
      total_liabilities += account.current_balance;
    } else {
      total_assets += account.current_balance;
      if (liquidTypes.has(account.type)) {
        liquid_assets += account.current_balance;
      } else if (investmentTypes.has(account.type)) {
        investment_assets += account.current_balance;
      } else if (account.type === 'crypto_wallet') {
        crypto_assets += account.current_balance;
      }
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
      SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?,
          liquid_assets = ?, investment_assets = ?, crypto_assets = ?
      WHERE id = ?
    `).run(total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets, existing.id);
  } else {
    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(uuidv4(), today, total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets, now);
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
    SELECT id, current_balance, is_liability, is_hidden, type
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{
    id: string;
    current_balance: number;
    is_liability: number;
    is_hidden: number;
    type: string;
  }>;

  const balances: Record<string, number> = {};
  for (const account of accounts) {
    balances[account.id] = account.current_balance;
  }

  const accountMap: Record<string, { is_liability: number; type: string }> = {};
  for (const account of accounts) {
    accountMap[account.id] = {
      is_liability: account.is_liability,
      type: account.type,
    };
  }

  const liquidTypes = new Set(['checking', 'savings', 'cash']);
  const investmentTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth']);

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
    let liquid_assets = 0;
    let investment_assets = 0;
    let crypto_assets = 0;
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
        if (liquidTypes.has(account.type)) {
          liquid_assets += balance;
        } else if (investmentTypes.has(account.type)) {
          investment_assets += balance;
        } else if (account.type === 'crypto_wallet') {
          crypto_assets += balance;
        }
      }
    }

    const net_worth = total_assets - total_liabilities;

    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      targetStr,
      total_assets,
      total_liabilities,
      net_worth,
      JSON.stringify(breakdown),
      liquid_assets,
      investment_assets,
      crypto_assets,
      new Date().toISOString()
    );
  }
}
