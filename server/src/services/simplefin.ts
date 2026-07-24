import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { epochSecondsToLocalDate } from './dates';
import type Database from 'better-sqlite3';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';
import { balancesDiffer, type AccountBalanceChange } from './balanceChanges';
import { guessAccountTypeAndLiability } from './accountClassification';
import { isBelowBackfillFloor } from './backfillFloor';
import { toCents, toCentsOrNull, toDollars } from './money';

// We store liability balances as positive "amount owed" and negate what SimpleFIN reports
// (which normally sends credit balances as negatives). If an institution ever reports an
// owed balance as a positive number, negating it would store the wrong sign — flag it
// through the sync result instead of silently corrupting net worth.
export function liabilityAdjustedCents(
  balanceMagnitude: number,
  isLiability: boolean,
  accountName: string,
  errors: string[]
): number {
  if (isLiability && balanceMagnitude > 0) {
    const msg = `Account "${accountName}" is a liability but its balance is reported positive; the stored sign may be wrong — verify this institution's balance convention.`;
    errors.push(msg);
    console.warn(`[simplefin] ${msg}`);
  }
  return toCents(isLiability ? -balanceMagnitude : balanceMagnitude);
}

interface SimplefinHolding {
  symbol?: string | null;
  description?: string | null;
  shares?: string | number | null;
  market_value?: string | number | null;
  cost_basis?: string | number | null;
  purchase_price?: string | number | null;
  currency?: string | null;
}

// Confirmed against a live SimpleFIN Bridge response (Fidelity brokerage/IRA accounts):
// `holdings[]` is populated with {id, created, currency, cost_basis, description,
// market_value, purchase_price, shares, symbol}. cost_basis/market_value are totals for
// the whole position, matching how holdings.cost_basis is already interpreted elsewhere
// (see investmentMetadata.ts, AccountDetail.tsx: institution_value - cost_basis).
export function upsertHoldingsFromSimplefin(db: Database.Database, accountId: string, holdings: SimplefinHolding[], now: string): void {
  const findSecurityByTicker = db.prepare('SELECT id FROM securities WHERE ticker = ? LIMIT 1');
  const insertSecurity = db.prepare(`
    INSERT INTO securities (id, ticker, name, type, currency)
    VALUES (?, ?, ?, 'equity', ?)
  `);
  const upsertHolding = db.prepare(`
    INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis, currency, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, security_id) DO UPDATE SET
      quantity = excluded.quantity,
      institution_price = excluded.institution_price,
      institution_value = excluded.institution_value,
      cost_basis = excluded.cost_basis,
      currency = excluded.currency,
      updated_at = excluded.updated_at
  `);

  for (const holding of holdings) {
    const ticker = holding.symbol?.trim() || null;
    const name = holding.description?.trim() || ticker || 'Unknown security';
    const currency = holding.currency || 'USD';
    const shares = parseFloat(String(holding.shares ?? 0)) || 0;
    const marketValue = parseFloat(String(holding.market_value ?? 0)) || 0;
    const rawCostBasis = holding.cost_basis != null ? parseFloat(String(holding.cost_basis)) : null;
    const purchasePrice = holding.purchase_price != null ? parseFloat(String(holding.purchase_price)) : null;
    // SimpleFIN frequently returns cost_basis as 0/missing even when it does provide a
    // real per-share purchase_price (confirmed against a live Fidelity payload) - fall
    // back to shares * purchase_price rather than showing a false $0 cost basis.
    const costBasis = (!rawCostBasis) && purchasePrice != null && purchasePrice > 0 && shares !== 0
      ? shares * purchasePrice
      : rawCostBasis;
    const price = shares !== 0 ? marketValue / shares : 0;

    let securityId: string | undefined;
    if (ticker) {
      const existing = findSecurityByTicker.get(ticker) as { id: string } | undefined;
      securityId = existing?.id;
    }
    if (!securityId) {
      securityId = uuidv4();
      insertSecurity.run(securityId, ticker, name, currency);
    }

    // quantity + per-unit price stay REAL dollars; value + cost basis are totals -> cents.
    upsertHolding.run(uuidv4(), accountId, securityId, shares, price, toCents(marketValue), toCentsOrNull(costBasis), currency, now);
  }
}

const INCREMENTAL_LOOKBACK_DAYS = 30;
// On a connection's very first sync there's no local history yet, so request as much
// backlog as SimpleFIN Bridge will serve instead of the normal incremental window.
// Institutions still cap what they actually return regardless of what's requested.
const INITIAL_LOOKBACK_DAYS = 730;

export interface SimplefinSyncResult {
  status: string;
  accountCount: number;
  added: number;
  modified: number;
  removed: number;
  skipped: number;
  balanceChanges: AccountBalanceChange[];
  errors: string[];
}

// A malformed balance/amount must never be persisted: parseFloat would yield NaN
// (stored as NULL in a REAL column) and silently corrupt net worth. Callers catch
// this and either skip the account (preserving its prior balance) or the transaction.
function parseFinancialAmount(raw: unknown, label: string): number {
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n)) {
    throw new Error(`SimpleFIN returned a non-numeric ${label}: ${JSON.stringify(raw)}`);
  }
  return n;
}

export async function syncSimplefin(): Promise<SimplefinSyncResult> {
  const creds = getCredentials();
  if (!creds.simplefin?.accessUrl) {
    throw new Error('Missing SimpleFIN access URL');
  }

  const accessUrl = creds.simplefin.accessUrl;

  const client = axios.create({
    baseURL: accessUrl,
  });

  const db = getDb();
  let added = 0, modified = 0, removed = 0, skipped = 0;
  const balanceChanges: AccountBalanceChange[] = [];
  const now = new Date().toISOString();

  const connection = db.prepare(
    "SELECT last_synced_at FROM simplefin_connections WHERE id = 'simplefin_primary'"
  ).get() as { last_synced_at: string | null } | undefined;
  // last_synced_at IS NULL means either a brand-new connection or an explicit
  // user-requested "force full resync" (routes/simplefin.ts POST /resync nulls it).
  const isFirstSync = !connection?.last_synced_at;
  const lookbackDays = isFirstSync ? INITIAL_LOOKBACK_DAYS : INCREMENTAL_LOOKBACK_DAYS;

  const startDate = Math.floor(Date.now() / 1000) - (lookbackDays * 86400);
  const res = await client.get(`/accounts?start-date=${startDate}`);
  const data = res.data;

  const accountCount = data.accounts?.length || 0;
  const errors: string[] = Array.isArray(data.errors) ? data.errors : [];
  const seenAccountIds = new Set<string>();

  for (const acct of (data.accounts || [])) {
    seenAccountIds.add(acct.id);
    const currency = acct.currency || 'USD';
    const institutionName = acct.org?.name || 'SimpleFIN';

    // Balances are stored and reported as USD everywhere. A non-USD account would be
    // mislabeled/unconverted, so surface it rather than silently treating it as dollars.
    if (currency !== 'USD') {
      const msg = `Account "${acct.name}" is in ${currency}, but Mizān treats balances as USD — its value may be misstated.`;
      errors.push(msg);
      console.warn(`[simplefin] ${msg}`);
    }

    let balanceMagnitude: number;
    try {
      balanceMagnitude = parseFinancialAmount(acct.balance, `account "${acct.name}" balance`);
    } catch (err) {
      // Preserve the account's last-known balance rather than overwrite it with a
      // corrupt value; surface the problem through the sync result.
      errors.push((err as Error).message);
      console.warn(`[simplefin] Skipping account ${acct.id}: ${(err as Error).message}`);
      continue;
    }

    const existingAcct = db.prepare(`
      SELECT id, account_name, current_balance, is_liability, currency, backfill_floor_date, name_source
      FROM accounts
      WHERE simplefin_account_id = ?
    `).get(acct.id) as any;

    // Manual history owns everything below this date; skip anything the provider
    // serves below it so a deep resync can never duplicate the imported backfill.
    const backfillFloor: string | null = existingAcct?.backfill_floor_date ?? null;

    let accountId: string;
    let isLiability: boolean;
    let currentBalance: number;

    if (existingAcct) {
      accountId = existingAcct.id;
      isLiability = Boolean(existingAcct.is_liability);
      currentBalance = liabilityAdjustedCents(balanceMagnitude, isLiability, acct.name, errors);

      // existingAcct.current_balance and currentBalance are both cents here; the
      // display-facing change struct is kept in dollars.
      if (balancesDiffer(existingAcct.current_balance, currentBalance)) {
        balanceChanges.push({
          accountId: existingAcct.id,
          accountName: existingAcct.account_name,
          provider: 'simplefin',
          previousBalance: toDollars(existingAcct.current_balance),
          newBalance: toDollars(currentBalance),
          isLiability,
          currency: existingAcct.currency ?? currency,
        });
      }

      // Preserve a user's manual rename: only refresh account_name from the provider when the
      // name hasn't been overridden (name_source != 'manual'). Mirrors the type_source guard.
      const keepName = existingAcct.name_source === 'manual';
      db.prepare(`
        UPDATE accounts
        SET connection_id = 'simplefin_primary',
            institution_name = ?,
            ${keepName ? '' : 'account_name = ?,'}
            current_balance = ?,
            currency = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        institutionName,
        ...(keepName ? [] : [acct.name]),
        currentBalance,
        currency,
        now,
        existingAcct.id
      );
    } else {
      accountId = uuidv4();
      const guessed = guessAccountTypeAndLiability(acct.name, institutionName);
      isLiability = guessed.isLiability;
      currentBalance = liabilityAdjustedCents(balanceMagnitude, isLiability, acct.name, errors);

      db.prepare(`
        INSERT INTO accounts
          (id, simplefin_account_id, connection_id, connection_type, institution_name,
           account_name, type, current_balance,
           currency, is_manual, is_hidden, is_liability, sort_order, created_at, updated_at)
        VALUES (?, ?, 'simplefin_primary', 'simplefin', ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)
      `).run(
        accountId,
        acct.id,
        institutionName,
        acct.name,
        guessed.type,
        currentBalance,
        currency,
        isLiability ? 1 : 0,
        now,
        now
      );
    }

    // Process transactions
    for (const txn of (acct.transactions || [])) {
      const existingTxn = db.prepare('SELECT id FROM transactions WHERE simplefin_transaction_id = ?').get(txn.id);

      // Normalize the posted epoch to a UTC calendar day so it doesn't drift with the
      // server's timezone and matches how Coinbase timestamps are handled.
      const date = epochSecondsToLocalDate(txn.posted);

      if (isBelowBackfillFloor(date, backfillFloor)) {
        skipped++;
        continue;
      }

      let amount: number; // cents, already negative for expenses
      try {
        amount = toCents(parseFinancialAmount(txn.amount, `transaction ${txn.id} amount`));
      } catch (err) {
        errors.push((err as Error).message);
        console.warn(`[simplefin] Skipping transaction ${txn.id}: ${(err as Error).message}`);
        skipped++;
        continue;
      }
      const merchantName = txn.payee || null;
      const originalName = txn.description || '';
      // Not every institution reports this via SimpleFIN Bridge - defaults to posted (0)
      // when the field is absent from the payload, matching the column's schema default.
      const pending = txn.pending === true ? 1 : 0;

      if (existingTxn) {
        db.prepare(`
          UPDATE transactions
          SET date = ?, amount = ?, merchant_name = ?, original_name = ?, pending = ?, updated_at = ?
          WHERE simplefin_transaction_id = ?
        `).run(date, amount, merchantName, originalName, pending, now, txn.id);
        modified++;
      } else {
        db.prepare(`
          INSERT INTO transactions
            (id, simplefin_transaction_id, account_id, date, amount, merchant_name,
             original_name, pending, is_manual, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'simplefin', ?, ?)
        `).run(
          uuidv4(),
          txn.id,
          accountId,
          date,
          amount,
          merchantName,
          originalName,
          pending,
          now,
          now
        );
        added++;
      }
    }

    if (Array.isArray(acct.holdings) && acct.holdings.length > 0) {
      upsertHoldingsFromSimplefin(db, accountId, acct.holdings, now);
    }
  }

  // Accounts closed/removed at the institution no longer appear in the response at all;
  // zero them out (mirrors coinbase.ts's stale-account handling) instead of leaving a
  // stale nonzero balance in net worth forever.
  const staleAccounts = db.prepare(`
    SELECT id, simplefin_account_id, account_name, current_balance, is_liability, currency
    FROM accounts
    WHERE connection_type = 'simplefin' AND simplefin_account_id IS NOT NULL
  `).all() as Array<{ id: string; simplefin_account_id: string; account_name: string; current_balance: number; is_liability: number; currency: string }>;

  for (const account of staleAccounts) {
    if (seenAccountIds.has(account.simplefin_account_id)) continue;
    if (balancesDiffer(account.current_balance, 0)) {
      balanceChanges.push({
        accountId: account.id,
        accountName: account.account_name,
        provider: 'simplefin',
        previousBalance: toDollars(account.current_balance),
        newBalance: 0,
        isLiability: Boolean(account.is_liability),
        currency: account.currency ?? 'USD',
      });
    }
    db.prepare(`
      UPDATE accounts SET current_balance = 0, updated_at = ? WHERE id = ?
    `).run(now, account.id);
  }

  // Update simplefin_connections last_synced_at
  db.prepare(`
    UPDATE simplefin_connections
    SET last_synced_at = ?
    WHERE id = 'simplefin_primary'
  `).run(now);

  return { status: 'synced', accountCount, added, modified, removed, skipped, balanceChanges, errors };
}
