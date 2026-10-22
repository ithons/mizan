import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index';
import { liabilitiesInDoubt } from './liabilitySign';
import { bucketOf } from '../../../shared/accountTypes';


/**
 * A card whose direction the sign check cannot settle is left out of the sheet and counted as
 * uncovered: its stored sign is the provider's, which for these cards carries no information, and
 * a measured row is never re-examined.
 */
export function takeSnapshot(): void {
  const db = getDb();

  const visible = db.prepare(`
    SELECT id, current_balance, is_liability, type
    FROM accounts
    WHERE is_hidden = 0
  `).all() as Array<{ id: string; current_balance: number; is_liability: number; type: string }>;
  const inDoubt = liabilitiesInDoubt(db);
  const accounts = visible.filter((account) => !(account.is_liability && inDoubt.has(account.id)));

  let total_assets = 0;
  let total_liabilities = 0;
  let liquid_assets = 0;
  let investment_assets = 0;
  let crypto_assets = 0;
  const breakdown: Record<string, number> = {};

  for (const account of accounts) {
    breakdown[account.id] = account.current_balance;
    if (account.is_liability) {
      total_liabilities += account.current_balance;
    } else {
      total_assets += account.current_balance;
      const bucket = bucketOf(account.type);
      if (bucket === 'liquid') liquid_assets += account.current_balance;
      else if (bucket === 'invested') investment_assets += account.current_balance;
      else if (bucket === 'crypto') crypto_assets += account.current_balance;
    }
  }

  const net_worth = total_assets - total_liabilities;
  const today = format(new Date(), 'yyyy-MM-dd');
  const now = new Date().toISOString();

  const existing = db.prepare(
    'SELECT id FROM net_worth_snapshots WHERE date = ?'
  ).get(today) as { id: string } | undefined;

  const coveredAccounts = accounts.length;
  const totalAccounts = visible.length;


  if (existing) {
    db.prepare(`
      UPDATE net_worth_snapshots
      SET total_assets = ?, total_liabilities = ?, net_worth = ?, breakdown = ?,
          liquid_assets = ?, investment_assets = ?, crypto_assets = ?,
          covered_accounts = ?, total_accounts = ?, taken_at = ?
      WHERE id = ?
    `).run(total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets,
           coveredAccounts, totalAccounts, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO net_worth_snapshots
        (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
         liquid_assets, investment_assets, crypto_assets, covered_accounts, total_accounts,
         created_at, taken_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), today, total_assets, total_liabilities, net_worth, JSON.stringify(breakdown),
           liquid_assets, investment_assets, crypto_assets, coveredAccounts, totalAccounts, now, now);
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
