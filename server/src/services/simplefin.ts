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

// We store liability balances as positive "amount owed" and negate what SimpleFIN reports (which
// normally sends credit balances as negatives).
//
// This guard only fires on the one shape a single number can actually diagnose: a positive provider
// balance, whose negation produces a credit position. The opposite failure (an institution sending
// a credit balance under the same fixed negative sign it uses for debt) is indistinguishable from
// ordinary debt from here, so it is not guessed at: correctLiabilitySigns() settles direction
// against the ledger once the pass's transactions have landed, and owns that reporting alone.
export function liabilityAdjustedCents(
  balanceMagnitude: number,
  isLiability: boolean,
  accountName: string,
  errors: string[]
): number {
  const cents = toCents(isLiability ? -balanceMagnitude : balanceMagnitude);

  if (isLiability && balanceMagnitude > 0) {
    const msg = `Account "${accountName}" is a liability but its balance is reported positive, so it is being stored as a credit balance. The sign may be wrong: verify this institution's balance convention.`;
    errors.push(msg);
    console.warn(`[simplefin] ${msg}`);
  }

  return cents;
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

// The slice of a SimpleFIN Bridge `/accounts` response this sync reads. Nothing deep-validates
// the payload, so `simplefinAccountsOrThrow` is the one trust boundary: fields the loop already
// copes with being absent are optional here, and the two amount fields stay `unknown` because
// parseFinancialAmount is what decides whether they are numbers.
interface SimplefinTransactionPayload {
  id: string;
  posted: number;
  amount: unknown;
  payee?: string | null;
  description?: string | null;
  pending?: boolean | null;
}

interface SimplefinAccountPayload {
  id: string;
  name: string;
  currency?: string | null;
  balance: unknown;
  org?: { name?: string | null } | null;
  transactions?: SimplefinTransactionPayload[] | null;
  holdings?: SimplefinHolding[] | null;
}

// A provider basis of 0 means "not reported", never "acquired for nothing". Stored as 0 it reads
// as a known basis and books the position's entire market value as unrealized gain: SPAXX, a
// Fidelity cash sweep that is worth exactly what was put into it, was reported as pure profit and
// carried the whole portfolio's return from 1.8% to 7.1%. Unknown has to stay NULL.
function knownCostBasis(value: number | null): number | null {
  return value != null && value > 0 ? value : null;
}

// Confirmed against a live SimpleFIN Bridge response (Fidelity brokerage/IRA accounts):
// `holdings[]` is populated with {id, created, currency, cost_basis, description,
// market_value, purchase_price, shares, symbol}. cost_basis/market_value are totals for
// the whole position, matching how holdings.cost_basis is already interpreted elsewhere
// (see investmentMetadata.ts, AccountDetail.tsx: institution_value - cost_basis).
export function upsertHoldingsFromSimplefin(db: Database.Database, accountId: string, holdings: SimplefinHolding[], now: string): void {
  // Positions the institution no longer reports have been sold. This pass used to only upsert,
  // never remove, so a fully-sold position kept its last market value in `holdings` forever and
  // inflated the portfolio total. coinbase.ts already zeroed its side; this brings the two
  // providers into line. Zeroed rather than deleted so holdings_history keeps its foreign key.
  const seenSecurityIds = new Set<string>();
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
    const derivedCostBasis = purchasePrice != null && purchasePrice > 0 && shares !== 0
      ? shares * purchasePrice
      : null;
    const costBasis = knownCostBasis(rawCostBasis) ?? knownCostBasis(derivedCostBasis);
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
    seenSecurityIds.add(securityId);
  }

  const held = db.prepare(
    'SELECT id, security_id FROM holdings WHERE account_id = ? AND institution_value != 0'
  ).all(accountId) as Array<{ id: string; security_id: string }>;
  const zeroHolding = db.prepare(
    'UPDATE holdings SET quantity = 0, institution_value = 0, updated_at = ? WHERE id = ?'
  );
  for (const row of held) {
    if (seenSecurityIds.has(row.security_id)) continue;
    zeroHolding.run(now, row.id);
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

/**
 * The response's `accounts` array, or a thrown error.
 *
 * HTTP 200 is not proof of a payload. The bridge answers a maintenance window with an HTML page,
 * and any body without an `accounts` array used to parse to accountCount 0, `errors` [], and an
 * empty seen-set. Nothing then failed: the stale-account pass read the empty seen-set as "every
 * account closed" and zeroed all nine balances, syncManager marked the connection active and the
 * run succeeded, and takeSnapshot() wrote the zeroes into net-worth history as a measured fact for
 * the day. An absent accounts array says nothing about what the accounts hold, so the stage has to
 * fail rather than succeed emptily.
 */
export function simplefinAccountsOrThrow(data: unknown): SimplefinAccountPayload[] {
  const accounts = (data as { accounts?: unknown } | null | undefined)?.accounts;
  if (!Array.isArray(accounts)) {
    throw new Error(
      'SimpleFIN answered 200 with no accounts array; refusing to read an unreadable response as zero accounts.'
    );
  }
  return accounts as SimplefinAccountPayload[];
}

export function providerErrorStrings(data: unknown): string[] {
  const raw = (data as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

// SimpleFIN puts advisories in the same `errors` array it uses for access failures. The bridge
// answers this app's own 730-day first-sync request with "Requested date range exceeds limit of 90
// days and was capped.", and reading any string in that array as an expired institution login told
// the owner to re-link the bank, which is the riskiest action the app offers. Only auth-shaped
// messages may claim reauth; everything else is still reported, just not as a login problem.
const REAUTH_ERROR_PATTERNS: RegExp[] = [
  /re-?auth/i,
  /re-?connect/i,
  /re-?link/i,
  /credential/i,
  /log ?in|sign ?in|password/i,
  /expired/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /access (has been |was )?(denied|revoked)/i,
  /mfa|multi-factor|two-factor|verification code/i,
];

export interface SimplefinErrorTriage {
  /** Messages that mean the institution connection itself needs a fresh login. */
  reauth: string[];
  /** Everything else the provider said: capped date ranges, per-account notices, our own data warnings. */
  advisories: string[];
}

export function triageSimplefinErrors(errors: string[]): SimplefinErrorTriage {
  const triage: SimplefinErrorTriage = { reauth: [], advisories: [] };
  for (const message of errors) {
    const target = REAUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message))
      ? triage.reauth
      : triage.advisories;
    target.push(message);
  }
  return triage;
}

/**
 * Zero out SimpleFIN accounts that the provider no longer returns.
 *
 * An account closed at the institution stops appearing in the response entirely, so absence is
 * the only signal we get, and leaving a stale balance would inflate net worth forever (this
 * mirrors coinbase.ts's stale-coin handling).
 *
 * But absence only means "closed" when the response is COMPLETE. SimpleFIN reports a failing
 * institution inside `errors` on an otherwise-200 response, and the affected institution's
 * accounts can be missing from `accounts` altogether. Zeroing then reads a reauth prompt as
 * "every account at this bank is now empty", and because runFullSync() calls takeSnapshot() in
 * the same pass, that lands in net-worth history as a MEASURED (is_estimated = 0) fact and
 * overwrites the day's prior value. The balances come back on the next good sync; the poisoned
 * snapshot does not.
 *
 * This is not a repair for an observed incident. The path has never been caught firing here.
 * It is a guard on a cheap mistake with a permanent consequence.
 */
export function zeroAccountsMissingFromResponse(
  db: Database.Database,
  seenAccountIds: Set<string>,
  now: string,
  providerErrors: string[]
): AccountBalanceChange[] {
  // Total absence is the "unknown" case, never the "closed" case. No institution's accounts all
  // vanish at once, but an unreadable 200 produces exactly this seen-set, and one such pass would
  // zero every balance and hand the zeroes to the same run's net-worth snapshot.
  if (seenAccountIds.size === 0) {
    console.warn(
      '[simplefin] Response carried no accounts at all; skipping the stale-account pass rather than reading total absence as total closure.'
    );
    return [];
  }

  if (providerErrors.length > 0) {
    console.warn(
      `[simplefin] Provider reported ${providerErrors.length} error(s); skipping the stale-account pass so a partial response cannot zero real balances.`
    );
    return [];
  }

  const staleAccounts = db.prepare(`
    SELECT id, simplefin_account_id, account_name, current_balance, is_liability, currency
    FROM accounts
    WHERE connection_type = 'simplefin' AND simplefin_account_id IS NOT NULL
  `).all() as Array<{ id: string; simplefin_account_id: string; account_name: string; current_balance: number; is_liability: number; currency: string }>;

  const changes: AccountBalanceChange[] = [];
  for (const account of staleAccounts) {
    if (seenAccountIds.has(account.simplefin_account_id)) continue;
    if (balancesDiffer(account.current_balance, 0)) {
      changes.push({
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

  return changes;
}

export interface SimplefinTransactionValues {
  providerId: string;
  date: string;
  /** Integer cents, already negative for spend. */
  amount: number;
  merchantName: string | null;
  originalName: string;
  pending: number;
}

export type SimplefinTransactionWrite = 'added' | 'modified' | 'unchanged';

interface ExistingTransactionRow {
  date: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  pending: number;
}

/**
 * Write one provider transaction, reporting whether it actually changed anything.
 *
 * Two things this deliberately no longer does.
 *
 * It does not rewrite `merchant_name` on a row that has already posted. The owner is allowed to
 * correct a merchant (UpdateTransactionSchema permits `merchant_name`), and the old unconditional
 * refresh reverted every such correction within the hour with nothing on screen to say so. No
 * provenance for a rename is stored anywhere, so the test is the row's own state instead: while a
 * transaction is pending the provider is still settling it and may legitimately sharpen the payee,
 * and once it has posted the payee does not change at the institution, so a divergence from that
 * point on is the owner's. `original_name` carries the provider's raw description either way, so
 * nothing is lost from the record.
 *
 * And it does not count a row it did not change. Every row in the payload used to be reported as
 * 'modified', so the sync panel claimed ~123 updated transactions every hour on a ledger that had
 * not moved. That panel is also where reauth prompts and partial failures appear, and noise there
 * is what teaches the owner to stop reading it.
 */
export function upsertSimplefinTransaction(
  db: Database.Database,
  accountId: string,
  values: SimplefinTransactionValues,
  now: string
): SimplefinTransactionWrite {
  const existing = db.prepare(`
    SELECT date, amount, merchant_name, original_name, pending
    FROM transactions
    WHERE simplefin_transaction_id = ?
  `).get(values.providerId) as ExistingTransactionRow | undefined;

  if (!existing) {
    db.prepare(`
      INSERT INTO transactions
        (id, simplefin_transaction_id, account_id, date, amount, merchant_name,
         original_name, pending, is_manual, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'simplefin', ?, ?)
    `).run(
      uuidv4(),
      values.providerId,
      accountId,
      values.date,
      values.amount,
      values.merchantName,
      values.originalName,
      values.pending,
      now,
      now
    );
    return 'added';
  }

  const stillSettling = existing.pending === 1 || values.pending === 1;
  const ownerOwnsMerchant = !stillSettling && (existing.merchant_name ?? '') !== '';
  const merchantName = ownerOwnsMerchant ? existing.merchant_name : values.merchantName;

  if (
    existing.date === values.date &&
    existing.amount === values.amount &&
    existing.merchant_name === merchantName &&
    existing.original_name === values.originalName &&
    existing.pending === values.pending
  ) {
    return 'unchanged';
  }

  db.prepare(`
    UPDATE transactions
    SET date = ?, amount = ?, merchant_name = ?, original_name = ?, pending = ?, updated_at = ?
    WHERE simplefin_transaction_id = ?
  `).run(
    values.date,
    values.amount,
    merchantName,
    values.originalName,
    values.pending,
    now,
    values.providerId
  );
  return 'modified';
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
  const accounts = simplefinAccountsOrThrow(res.data);

  const accountCount = accounts.length;
  const errors: string[] = providerErrorStrings(res.data);
  const seenAccountIds = new Set<string>();

  for (const acct of accounts) {
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
    for (const txn of (acct.transactions ?? [])) {
      // Normalize the posted epoch to a LOCAL calendar day: see services/dates.ts for why
      // (every "today"/"this month" boundary in the app is local, and a late-night purchase
      // should stay on the day it happened). This comment used to claim UTC, which was true
      // before commit 9ac0220 reversed the rule and left the comment behind.
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
      const write = upsertSimplefinTransaction(db, accountId, {
        providerId: txn.id,
        date,
        amount,
        merchantName: txn.payee || null,
        originalName: txn.description || '',
        // Not every institution reports this via SimpleFIN Bridge - defaults to posted (0)
        // when the field is absent from the payload, matching the column's schema default.
        pending: txn.pending === true ? 1 : 0,
      }, now);

      if (write === 'added') added++;
      else if (write === 'modified') modified++;
    }

    if (Array.isArray(acct.holdings) && acct.holdings.length > 0) {
      upsertHoldingsFromSimplefin(db, accountId, acct.holdings, now);
    }
  }

  balanceChanges.push(...zeroAccountsMissingFromResponse(db, seenAccountIds, now, errors));

  // Update simplefin_connections last_synced_at
  db.prepare(`
    UPDATE simplefin_connections
    SET last_synced_at = ?
    WHERE id = 'simplefin_primary'
  `).run(now);

  return { status: 'synced', accountCount, added, modified, removed, skipped, balanceChanges, errors };
}
