import { v4 as uuidv4 } from 'uuid';
import { format, subMonths, startOfMonth, differenceInCalendarMonths } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';

// Upper bound on reverse-replay estimation: a 50-year backstop so a stray ancient
// transaction can't spin the loop for an absurd number of months. There is deliberately no
// MINIMUM. There used to be one (12 months, "keep the chart at least a year even with little
// data"), and it manufactured exactly the kind of number this app should never show: see
// estimateFloorMonth below.
const MAX_BACKFILL_MONTHS = 600;

/**
 * The earliest month reverse-replay can say anything real about.
 *
 * Estimation works by taking today's balance and undoing every transaction since. That only
 * carries information for as far back as the ledger actually reaches. Past that point the
 * arithmetic still runs and still produces a number, but the number is just today's balance
 * again: not an estimate of the past, an assertion that nothing ever changed.
 *
 * On real data that produced 20 consecutive months with byte-identical breakdowns, drawn on
 * the same chart line as measured snapshots with nothing to distinguish them.
 *
 * An account is exempt when it has no transactions at all (a manual cash account, say): its
 * balance is static as far as the ledger knows, so carrying it back adds no false movement.
 * An account sitting at zero today is exempt too, since there is no value to reconstruct.
 * Everything else has to have history reaching back to the month, or the month is unknowable
 * and we emit nothing for it.
 */
export function estimateFloorMonth(
  accounts: Array<{ id: string; current_balance: number }>,
  firstTransactionByAccount: Map<string, string>
): string | null {
  let floor: string | null = null;

  for (const account of accounts) {
    if (account.current_balance === 0) continue;
    const firstSeen = firstTransactionByAccount.get(account.id);
    if (!firstSeen) continue;
    if (!floor || firstSeen > floor) floor = firstSeen;
  }

  if (!floor) return null;
  return format(startOfMonth(new Date(`${floor}T00:00:00`)), 'yyyy-MM-dd');
}

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

  // 'closed' accounts are former deposit accounts (checking/savings) kept for net-worth history;
  // they're $0 today so this bucketing is a no-op live, but keeps them liquid in the breakdown.
  const liquidTypes = new Set(['checking', 'savings', 'cash', 'closed']);
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
  // actually produces net-worth points instead of stopping at a fixed wall.
  const earliestDate = transactions.length ? transactions[0].date : format(now, 'yyyy-MM-dd');
  const monthsOfHistory = differenceInCalendarMonths(now, startOfMonth(new Date(`${earliestDate}T00:00:00`)));
  const monthsBackLimit = Math.min(Math.max(monthsOfHistory, 0), MAX_BACKFILL_MONTHS);

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

  // transactions is ordered by date ASC, so the first row seen per account is its earliest.
  const firstTransactionByAccount = new Map<string, string>();
  for (const txn of transactions) {
    if (!firstTransactionByAccount.has(txn.account_id)) {
      firstTransactionByAccount.set(txn.account_id, txn.date);
    }
  }

  const coverageFloor = estimateFloorMonth(accounts, firstTransactionByAccount);
  // Nothing that holds value today has any ledger history: every "estimate" would be a copy
  // of today's balances wearing a past date.
  if (!coverageFloor) return;

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

  // 'closed' accounts reconstruct their history through the deposit (else) branch below and
  // bucket as liquid — they were checking/savings before closure.
  const liquidTypes = new Set(['checking', 'savings', 'cash', 'closed']);
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

    // Walking backwards, so the first month past the coverage floor ends the run.
    if (targetStr < coverageFloor) break;

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
        } else if (cat === 'cat_crypto_sell') {
          // A crypto SELL leg is the mirror of a buy leg — undo by ADDING back its magnitude.
          // This makes a Coinbase convert (a matched crypto_sell + crypto_buy of equal USD) net
          // to zero in the estimate, instead of the buy leg being counted as a phantom external
          // contribution. (A real crypto→cash sell is treated as an outflow, a fair approximation.
          // Fiat deposits/withdrawals into the wallet are left flat, so a buy funded by a separate
          // deposit isn't double-counted.)
          approxBalances[txn.account_id] += Math.abs(txn.amount);
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
