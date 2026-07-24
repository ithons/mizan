import { v4 as uuidv4 } from 'uuid';
import { format, subMonths, startOfMonth, differenceInCalendarMonths } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';

// How far back reverse-replay estimation may run. 12 is the historical floor (keep the
// chart at least a year even with little data); the upper bound is a 50-year backstop so
// a stray ancient transaction can't spin the loop for an absurd number of months.
const MIN_BACKFILL_MONTHS = 12;
const MAX_BACKFILL_MONTHS = 600;

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

  takeHoldingsSnapshot(db, today, now);
}

// Mirrors net_worth_snapshots' one-row-per-day pattern above, at the individual holding
// level, so a position's value over time can be charted (holdings itself is overwritten
// on every sync and only ever reflects the current state).
export function takeHoldingsSnapshot(db: Database.Database, today: string, now: string): void {
  const holdings = db.prepare(`
    SELECT account_id, security_id, quantity, institution_price, institution_value, cost_basis
    FROM holdings
  `).all() as Array<{
    account_id: string; security_id: string; quantity: number;
    institution_price: number; institution_value: number; cost_basis: number | null;
  }>;

  const upsert = db.prepare(`
    INSERT INTO holdings_history
      (id, account_id, security_id, date, quantity, institution_price, institution_value, cost_basis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, security_id, date) DO UPDATE SET
      quantity = excluded.quantity,
      institution_price = excluded.institution_price,
      institution_value = excluded.institution_value,
      cost_basis = excluded.cost_basis
  `);

  for (const h of holdings) {
    upsert.run(uuidv4(), h.account_id, h.security_id, today, h.quantity, h.institution_price, h.institution_value, h.cost_basis, now);
  }
}

export function backfillSnapshots(): void {
  const db = getDb();
  const now = new Date();

  // Load the full posted-transaction history — the backfill extends as far back as the
  // data goes (post one-time import this can be years), not a fixed window.
  const transactions = db.prepare(`
    SELECT id, account_id, date, amount, category_id
    FROM transactions
    WHERE pending = 0
    ORDER BY date ASC
  `).all() as Array<{
    id: string;
    account_id: string;
    date: string;
    amount: number;
    category_id: string | null;
  }>;

  // Reach back to the month of the oldest transaction (clamped), so imported history
  // actually produces net-worth points instead of stopping at a 12-month wall.
  const earliestDate = transactions.length ? transactions[0].date : format(now, 'yyyy-MM-dd');
  const monthsOfHistory = differenceInCalendarMonths(now, startOfMonth(new Date(`${earliestDate}T00:00:00`)));
  const monthsBackLimit = Math.min(Math.max(monthsOfHistory, MIN_BACKFILL_MONTHS), MAX_BACKFILL_MONTHS);

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

  // Accounts whose value is market-driven, not transaction-driven. Reversing individual
  // buys/sells/dividends off their current value is meaningless (a $100 buy doesn't change
  // account value, it converts cash to securities). Since transaction data can't
  // reconstruct market moves, we instead reverse only NEW external money entering the
  // account (the user's periodic auto-investing / crypto buys) and hold market value flat.
  // Result: past value ≈ "what you'd contributed by then" — a flagged estimate, not the
  // reverse-every-trade nonsense.
  const marketValueTypes = new Set(['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet']);

  // Walk backwards month by month across the full history.
  for (let monthsBack = 1; monthsBack <= monthsBackLimit; monthsBack++) {
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

    // Compute approximate balances at start of target month by reversing later transactions.
    const approxBalances: Record<string, number> = { ...balances };
    for (const txn of laterTransactions) {
      if (approxBalances[txn.account_id] === undefined) continue;
      const meta = accountMap[txn.account_id];
      // Transaction sign: negative = money out (expense), positive = money in (income).
      if (meta && marketValueTypes.has(meta.type)) {
        // Market-driven account: only external money moving in/out changes value in a way we
        // can reconstruct; internal buys-with-existing-cash, sells, and dividends leave the
        // estimate flat (market moves are unknowable from transactions).
        const cat = txn.category_id ?? '';
        if (cat === 'cat_inv_buy' || cat === 'cat_crypto_buy') {
          // Money spent to acquire assets (negative cash) RAISES value by its magnitude, so
          // pre-purchase value was lower — undo by subtracting the magnitude.
          approxBalances[txn.account_id] -= Math.abs(txn.amount);
        } else if (cat === 'cat_inv_transfer') {
          // Sign-aware external flow: a contribution (+) means value was lower before; a
          // withdrawal/correction (−) means it was higher. Undo by subtracting the amount.
          approxBalances[txn.account_id] -= txn.amount;
        }
      } else if (meta?.is_liability) {
        // Liability balances are stored as positive "amount owed" and move OPPOSITE the
        // sign — a purchase (negative amount) raises what's owed — so undo by adding.
        approxBalances[txn.account_id] += txn.amount;
      } else {
        // Asset balances move WITH the sign, so undo by subtracting the amount.
        approxBalances[txn.account_id] -= txn.amount;
      }
    }

    // Neither a market-driven account nor a liability can sensibly go negative in this
    // estimate. Market accounts overshoot when reversed contributions exceed today's value
    // (a market loss/withdrawal we can't see); liabilities overshoot when we have a card's
    // purchases but not its payments (e.g. a spend-only year-end summary), which would drive
    // "owed" hugely negative. Clamp both at zero — transaction-based reconstruction is
    // approximate, and this keeps it from producing nonsense (a phantom asset/liability).
    for (const id of Object.keys(approxBalances)) {
      const m = accountMap[id];
      if (m && (marketValueTypes.has(m.type) || m.is_liability) && approxBalances[id] < 0) {
        approxBalances[id] = 0;
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
