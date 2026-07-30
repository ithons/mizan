import { v4 as uuidv4 } from 'uuid';
import { format, subMonths, startOfMonth, differenceInCalendarMonths } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';

// Upper bound on reverse-replay estimation: a 50-year backstop so a stray ancient
// transaction can't spin the loop for an absurd number of months. There is deliberately no
// MINIMUM. There used to be one (12 months, "keep the chart at least a year even with little
// data"), and it manufactured exactly the kind of number this app should never show: see
// accountFloorMonths and monthIsInformative below.
const MAX_BACKFILL_MONTHS = 600;

/**
 * The earliest month reverse-replay can say anything real about, one floor per account.
 *
 * Estimation works by taking today's balance and undoing every transaction since. That only
 * carries information for as far back as the ledger actually reaches. Past that point the
 * arithmetic still runs and still produces a number, but the number is just today's balance
 * again: not an estimate of the past, an assertion that nothing ever changed.
 *
 * On real data that produced 20 consecutive months with byte-identical breakdowns, drawn on
 * the same chart line as measured snapshots with nothing to distinguish them.
 *
 * This used to collapse into ONE floor for the whole portfolio, the LATEST of these dates, and
 * `backfillSnapshots` ended the backward walk there. A single recently-opened account therefore
 * erased every other account's history: Chase Freedom Flex opened 2026-03-10 holding $283.81 and
 * capped a 35-month ledger at five estimated months, discarding almost all of the 2,198
 * transactions imported specifically to have long history. A floor is a claim about ONE account's
 * history, so it belongs to that account. A month below an account's own floor now leaves that
 * account out instead of ending the walk for everyone.
 *
 * An account is exempt and gets no floor at all when it has no transactions (a manual cash
 * account, say): its balance is static as far as the ledger knows, so carrying it back adds no
 * false movement. An account sitting at zero today is exempt too, since there is no value to
 * reconstruct. Everything else has to have history reaching back to a month, or it is omitted
 * from that month and the month records the omission in `covered_accounts`.
 */
export function accountFloorMonths(
  accounts: Array<{ id: string; current_balance: number }>,
  firstTransactionByAccount: Map<string, string>
): Map<string, string> {
  const floors = new Map<string, string>();

  for (const account of accounts) {
    if (account.current_balance === 0) continue;
    const firstSeen = firstTransactionByAccount.get(account.id);
    if (!firstSeen) continue;
    floors.set(account.id, format(startOfMonth(new Date(`${firstSeen}T00:00:00`)), 'yyyy-MM-dd'));
  }

  return floors;
}

/**
 * The oldest month any single account can speak to, which is where the backward walk stops.
 *
 * Null means nothing holding value today has any ledger history, so every month would be a copy
 * of today's balances wearing a past date and the honest output is no rows at all.
 */
export function earliestCoveredMonth(floors: Map<string, string>): string | null {
  let earliest: string | null = null;
  for (const month of floors.values()) {
    if (!earliest || month < earliest) earliest = month;
  }
  return earliest;
}

/**
 * Whether a reconstructed month is worth emitting at all.
 *
 * Coverage says which accounts a month can include. It does not say whether including them taught
 * anyone anything, and that gap reintroduced the failure the floor was built to end. On the live
 * ledger, per-account floors reached back to 2023-09 and then drew ten consecutive months at
 * exactly $380.00: the covered set there is a manual cash account with no transactions (static by
 * definition), three closed accounts at $0, and a credit card whose 1,671 purchases sum to
 * -$31,156.60 against a $5.82 balance today, so reverse-replay drives "owed" far negative and the
 * clamp pins it at zero every single month. Five accounts covered, one number, none of it
 * observed. A flat line is a claim, and 5-of-14 coverage in a column does not stop a reader
 * believing it.
 *
 * A month earns a point when at least one account it covers actually moved the reconstruction:
 *
 *   - the account is in the covered set, so its own ledger reaches the month;
 *   - the ledger records activity dated inside that month, which is precisely what separates this
 *     month's estimate from the following month's, since the walk differs by those rows alone;
 *   - the account is not sitting on the clamp, because a clamped balance is the arithmetic
 *     refusing to answer, not an answer.
 *
 * A static exempt account can never satisfy this: it has no transactions to date inside any month.
 * That is the correct outcome. Carrying it flat is a reasonable way to include a balance in a month
 * that other evidence justifies, and no justification at all for a month of its own.
 */
function monthIsInformative(
  activeAccountIds: Set<string> | undefined,
  coveredBalances: Record<string, number>,
  clampedAccountIds: Set<string>
): boolean {
  if (!activeAccountIds) return false;
  for (const accountId of activeAccountIds) {
    if (coveredBalances[accountId] === undefined) continue;
    if (clampedAccountIds.has(accountId)) continue;
    return true;
  }
  return false;
}

/**
 * Remove estimated snapshots that today's data would refuse to create.
 *
 * The floor moves, because it is a function of today's balances: paying a card to zero makes that
 * card exempt and drops the floor, opening an account or spending on a dormant one raises it.
 * Estimated months were only ever written when absent and never re-examined, so a row written
 * under an older floor survived forever. Migration 040 deleted exactly this class of row by hand
 * and `scripts/backfill/rebuild.ts` recreated five of them two days later, including one at
 * 2026-02-01 that the very code which wrote it would have refused to write the following day. A
 * repair that is not also a guard decays, so the invariant runs on every backfill instead of
 * living in another one-off migration.
 *
 * This handles months the walk never visits. A month inside the walk that no longer earns a point
 * is cleared where that is decided, in the loop.
 *
 * Only `is_estimated = 1` rows are eligible. A measured snapshot records real balances at a point
 * in time and is never deleted or rewritten here.
 */
function purgeUnjustifiedEstimates(db: Database.Database, earliestMonth: string | null): number {
  if (!earliestMonth) {
    return db.prepare('DELETE FROM net_worth_snapshots WHERE is_estimated = 1').run().changes;
  }
  return db
    .prepare('DELETE FROM net_worth_snapshots WHERE is_estimated = 1 AND date < ?')
    .run(earliestMonth).changes;
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

  // A measurement covers every account it lists, by construction: it observed all of them. The
  // columns are still written so the series carries one meaning end to end and a consumer never
  // has to read NULL as "probably complete".
  const coveredAccounts = accounts.length;

  if (existing) {
    db.prepare(`
      UPDATE net_worth_snapshots
      SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?,
          liquid_assets = ?, investment_assets = ?, crypto_assets = ?,
          covered_accounts = ?, total_accounts = ?
      WHERE id = ?
    `).run(total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets,
           coveredAccounts, coveredAccounts, existing.id);
  } else {
    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, covered_accounts, total_accounts,
         created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), today, total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets, coveredAccounts, coveredAccounts, now);
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
  // Which accounts the ledger has anything to say about in a given `yyyy-MM`. Reversing a month
  // moves the estimate by exactly the rows dated inside it, so this is the evidence that makes one
  // month's point different from the next one's.
  const activeAccountsByMonth = new Map<string, Set<string>>();
  for (const txn of transactions) {
    if (!firstTransactionByAccount.has(txn.account_id)) {
      firstTransactionByAccount.set(txn.account_id, txn.date);
    }
    const month = txn.date.slice(0, 7);
    const active = activeAccountsByMonth.get(month);
    if (active) {
      active.add(txn.account_id);
    } else {
      activeAccountsByMonth.set(month, new Set([txn.account_id]));
    }
  }

  const floors = accountFloorMonths(accounts, firstTransactionByAccount);
  const earliestMonth = earliestCoveredMonth(floors);

  // Runs before the early return and before any writing, because a raised floor is exactly when
  // stale rows go stale: the months this run will no longer produce are the ones nothing would
  // ever have deleted.
  purgeUnjustifiedEstimates(db, earliestMonth);

  // Nothing that holds value today has any ledger history: every "estimate" would be a copy
  // of today's balances wearing a past date.
  if (!earliestMonth) return;

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

    // Walking backwards, so the month before the oldest account floor ends the run. Every month
    // above it has at least one account it can reconstruct.
    if (targetStr < earliestMonth) break;

    // A month that already holds a MEASURED snapshot is left untouched: it records balances
    // actually observed that day, and an estimate must never overwrite an observation.
    //
    // An existing ESTIMATE is recomputed instead of skipped, which is the other half of the
    // staleness bug. `if (existing) continue` treated a derivation as a record. An estimate is a
    // pure function of today's balances and the ledger, and both change on every sync, so a row
    // written weeks ago describes balances nobody holds any more and drifts out of agreement with
    // the measured segment it joins: 2026-06-01 estimated $4,049.84 against $1,068.29 measured
    // four weeks later. Recomputing keeps the two halves of one line consistent. The cost is that
    // a guess can move under the owner, which is the honest behaviour for a guess.
    const existing = db.prepare(
      'SELECT id, is_estimated FROM net_worth_snapshots WHERE date = ?'
    ).get(targetStr) as { id: string; is_estimated: number } | undefined;

    if (existing && existing.is_estimated === 0) continue;

    // Find all transactions that occurred after this target date up to the next month
    // to replay backwards: subtract amounts that happened after target date
    const laterTransactions = transactions.filter(t => t.date > targetStr);

    // Seed only the accounts this month can account for. An account whose own history starts later
    // is omitted rather than carried back at today's balance, because carrying it back would put
    // a card that did not exist yet onto the balance sheet.
    const approxBalances: Record<string, number> = {};
    for (const account of accounts) {
      const floor = floors.get(account.id);
      if (floor !== undefined && floor > targetStr) continue;
      approxBalances[account.id] = account.current_balance;
    }
    const coveredAccounts = Object.keys(approxBalances).length;

    // Compute approximate balances at start of target month by reversing later transactions.
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
    // A clamped balance is also the reconstruction admitting it has no answer, so the ids are kept
    // and a month that rests entirely on them is not emitted at all.
    const clampedAccounts = new Set<string>();
    for (const id of Object.keys(approxBalances)) {
      const m = accountMap[id];
      if (m && (marketValueTypes.has(m.type) || m.is_liability) && approxBalances[id] < 0) {
        approxBalances[id] = 0;
        clampedAccounts.add(id);
      }
    }

    // Nothing the covered accounts recorded this month survived into the estimate, so the row
    // would restate its neighbour under an older date. Any stale estimate here is removed for the
    // same reason it would not be written: the current data does not support it.
    if (!monthIsInformative(activeAccountsByMonth.get(targetStr.slice(0, 7)), approxBalances, clampedAccounts)) {
      if (existing) {
        db.prepare('DELETE FROM net_worth_snapshots WHERE id = ?').run(existing.id);
      }
      continue;
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
    // created_at is refreshed on a recompute on purpose: for a derived row it answers "when was
    // this derived", and the value it replaced described balances that no longer exist.
    const derivedAt = new Date().toISOString();

    if (existing) {
      db.prepare(`
        UPDATE net_worth_snapshots
        SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?,
            liquid_assets = ?, investment_assets = ?, crypto_assets = ?,
            covered_accounts = ?, total_accounts = ?, created_at = ?
        WHERE id = ?
      `).run(
        total_assets,
        total_liabilities,
        net_worth,
        JSON.stringify(breakdown),
        liquid_assets,
        investment_assets,
        crypto_assets,
        coveredAccounts,
        accounts.length,
        derivedAt,
        existing.id
      );
      continue;
    }

    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, covered_accounts, total_accounts,
         created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
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
      coveredAccounts,
      accounts.length,
      derivedAt
    );
  }
}
