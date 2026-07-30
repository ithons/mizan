import jwt from 'jsonwebtoken';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';
import { balancesDiffer, type AccountBalanceChange } from './balanceChanges';
import { toCents, toDollars } from './money';
import { isoToLocalDate } from './dates';
import { isBelowBackfillFloor } from './backfillFloor';

export interface CoinbaseSyncResult {
  accountCount: number;
  transactionCount: number;
  staleAccountCount: number;
  balanceChanges: AccountBalanceChange[];
}

interface CoinbaseConnectionRow {
  id: string;
}

// coinbase_user_id for the synthetic connection created when Coinbase is configured
// via .env (COINBASE_KEY_NAME/COINBASE_PRIVATE_KEY) rather than the connect route.
// The env path has no real Coinbase user id; this stable sentinel lets us anchor a
// single connection so crypto accounts are linked and surface in sync health.
const ENV_COINBASE_USER_ID = 'env';

// Guarantees exactly one active coinbase_connections row exists and returns its id.
// Preserves a real connect-route connection if one is already active; otherwise
// creates (or reactivates) the synthetic env connection.
function ensureCoinbaseConnection(db: Database.Database, now: string): string {
  const active = db.prepare(
    "SELECT id FROM coinbase_connections WHERE status = 'active'"
  ).get() as CoinbaseConnectionRow | undefined;
  if (active) return active.id;

  const row = db.prepare(`
    INSERT INTO coinbase_connections (id, coinbase_user_id, display_name, last_synced_at, status, created_at)
    VALUES (?, ?, 'Coinbase', NULL, 'active', ?)
    ON CONFLICT(coinbase_user_id) DO UPDATE SET status = 'active'
    RETURNING id
  `).get(uuidv4(), ENV_COINBASE_USER_ID, now) as CoinbaseConnectionRow;
  return row.id;
}

export class CoinbaseApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'CoinbaseApiError';
  }
}

// Resolves the securities row for a Coinbase ticker, creating it if this is the first time the
// ticker has been seen. Shared by the holdings upsert and both transaction write paths, so a
// trade and the position it produces always point at the same security id.
export function resolveCryptoSecurityId(db: Database.Database, ticker: string): string {
  const existing = db.prepare(
    "SELECT id FROM securities WHERE ticker = ? AND type = 'crypto' LIMIT 1"
  ).get(ticker) as { id: string } | undefined;
  if (existing) return existing.id;

  const securityId = uuidv4();
  db.prepare(`
    INSERT INTO securities (id, ticker, name, type, currency)
    VALUES (?, ?, ?, 'crypto', 'USD')
  `).run(securityId, ticker, ticker);
  return securityId;
}

// Mirrors upsertHoldingsFromSimplefin (simplefin.ts): each crypto_wallet account holds exactly
// one coin, so unlike SimpleFIN there's no array of positions, just one security per account.
// cost_basis stays NULL: Coinbase's brokerage API reports none, and nothing in this app derives
// one. See upsertCoinbaseTransaction for why this ledger cannot honestly produce it either.
export function upsertCoinbaseHolding(
  db: Database.Database,
  accountId: string,
  currency: string,
  quantity: number,
  price: number,
  value: number,
  now: string
): void {
  const securityId = resolveCryptoSecurityId(db, currency);

  // quantity + per-unit price stay REAL dollars; institution_value is a total -> cents.
  db.prepare(`
    INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis, currency, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'USD', ?)
    ON CONFLICT(account_id, security_id) DO UPDATE SET
      quantity = excluded.quantity,
      institution_price = excluded.institution_price,
      institution_value = excluded.institution_value,
      updated_at = excluded.updated_at
  `).run(uuidv4(), accountId, securityId, quantity, price, toCents(value), now);
}

// A Coinbase v2 (App API) transaction. amount/native_amount are SIGNED decimal strings:
// negative = debit (out), positive = credit (in). native_amount is the USD value.
export interface CoinbaseV2Transaction {
  id: string;
  type: string;
  status: string;
  amount: { amount: string; currency: string };
  native_amount: { amount: string; currency: string };
  created_at: string;
}

export interface ClassifiedLedgerTx {
  categoryId: string;
  signedCents: number; // integer cents, signed (money in positive, money out negative)
  merchant: string;
}

// Maps a v2 transaction to a ledger entry, or null to skip it. buy/sell/advanced_trade_fill are
// intentionally skipped here, they're imported from the v3 brokerage-orders endpoint
// (syncTradeHistory) and would double-count. Only completed transactions are imported.
//
// Sign convention matches syncTradeHistory: a SELL/receive/deposit is money IN (positive); a
// BUY/send/withdrawal is money OUT (negative). For send/receive/fiat, native_amount is already
// signed that way. For a convert leg ('trade'), native_amount is signed by cash direction of the
// coin (coin out = negative), which is the OPPOSITE of the money sign we want, so it's negated.
export function classifyCoinbaseLedgerTx(txn: CoinbaseV2Transaction): ClassifiedLedgerTx | null {
  if (txn.status !== 'completed') return null;
  const nativeUsd = Number.parseFloat(txn.native_amount?.amount ?? '');
  if (!Number.isFinite(nativeUsd)) return null;
  const coin = txn.amount?.currency ?? '';
  const coinAmount = Number.parseFloat(txn.amount?.amount ?? '0');

  switch (txn.type) {
    case 'trade': {
      // A convert has two legs (one per coin sub-account): coin out = a sell, coin in = a buy.
      const isSell = coinAmount < 0;
      return {
        categoryId: isSell ? 'cat_crypto_sell' : 'cat_crypto_buy',
        signedCents: toCents(-nativeUsd),
        merchant: `Convert ${isSell ? 'sold' : 'bought'} ${coin}`.trim(),
      };
    }
    case 'send':
      // 'send' covers external crypto transfers in both directions; the sign picks which.
      return {
        categoryId: nativeUsd < 0 ? 'cat_xfer_out' : 'cat_xfer_in',
        signedCents: toCents(nativeUsd),
        merchant: `${nativeUsd < 0 ? 'Send' : 'Receive'} ${coin}`.trim(),
      };
    case 'receive':
      return { categoryId: 'cat_xfer_in', signedCents: toCents(nativeUsd), merchant: `Receive ${coin}`.trim() };
    case 'fiat_deposit':
      return { categoryId: 'cat_xfer_in', signedCents: toCents(nativeUsd), merchant: 'Coinbase deposit' };
    case 'fiat_withdrawal':
      return { categoryId: 'cat_xfer_out', signedCents: toCents(nativeUsd), merchant: 'Coinbase withdrawal' };
    default:
      // buy / sell / advanced_trade_fill (v3 covers these) and everything else (staking moves,
      // rewards, interest, incentives, internal transfers) are skipped. Coinbase pays rewards
      // automatically, so those units reach holdings.quantity with no ledger row behind them:
      // this is the gap that makes any lot replay over these rows wrong, not just incomplete.
      return null;
  }
}

export interface LedgerUnits {
  ticker: string;
  quantity: number; // signed units of `ticker`: positive arrived, negative left
}

// A FILLED v3 brokerage order. Hoisted out of syncTradeHistory so coinbaseOrderUnits can be
// exercised against the real shape instead of a restatement of it.
export interface CoinbaseFilledOrder {
  order_id: string;
  product_id: string;
  side: string;
  status: string;
  filled_size: string;
  average_filled_price: string;
  created_time: string;
  total_fees: string;
  total_value_after_fees: string;
}

/**
 * Why both capture sites below record units that nothing currently reads.
 *
 * The only use for a unit count is cost basis, and this ledger cannot produce an honest one.
 * Coinbase's API gives us trades, converts, sends, receives and fiat moves; it does not give us
 * the disposal history a lot replay needs. Rewards, interest and incentives arrive as types
 * classifyCoinbaseLedgerTx skips, so those units reach a holding with no row behind them. Worse, a
 * coin sent to self-custody and received back is indistinguishable from an acquisition at the
 * receive-day price, and the owner's own history is full of exactly that. A replay over these rows
 * lands on a number that is wrong rather than missing, and a wrong basis renders as unrealized
 * gain with nothing on screen to say it was invented. Absent is the safe state; NULL reads as
 * "unknown" everywhere.
 *
 * The complete history exists only in the owner's data/coinbase/*.csv exports, and no importer
 * reads them. Until one does and writes units of its own, any basis computed from this ledger is a
 * fabrication, so nothing derives one.
 *
 * The units are still captured, because Coinbase hands them over on every row and they are
 * unrecoverable once a row is written without them. That is the whole reason this runs ahead of
 * any consumer.
 */

// The unit half of a v2 ledger entry, which classifyCoinbaseLedgerTx deliberately leaves alone so
// its money-only contract stays testable in isolation. `amount` is the coin leg and is already
// signed by unit direction for every type we import (a convert's coin-out leg, a send, a receive,
// and a fiat move all report units the way the account saw them), so no per-type branching.
// Returns null when Coinbase reported no usable units, which stores the row with NULL units:
// unknown, never zero.
export function coinbaseLedgerUnits(txn: CoinbaseV2Transaction): LedgerUnits | null {
  const ticker = txn.amount?.currency?.trim() ?? '';
  if (!ticker) return null;
  const quantity = Number.parseFloat(txn.amount?.amount ?? '');
  if (!Number.isFinite(quantity)) return null;
  return { ticker, quantity };
}

// filled_size is the coin count and is unsigned, so the side supplies the direction: a buy adds
// units, a sell removes them, which is the opposite of the money sign. Units degrade to null
// rather than throwing, because the money amount is load-bearing (there is no row without it)
// while the units are allowed to be unknown.
export function coinbaseOrderUnits(order: CoinbaseFilledOrder, side: 'BUY' | 'SELL'): LedgerUnits | null {
  const ticker = order.product_id?.split('-')[0]?.trim() ?? '';
  if (!ticker) return null;
  const filledSize = Number.parseFloat(order.filled_size ?? '');
  if (!Number.isFinite(filledSize)) return null;
  return { ticker, quantity: side === 'BUY' ? filledSize : -filledSize };
}

export interface CoinbaseTransactionWrite {
  coinbaseTransactionId: string;
  accountId: string;
  date: string;
  amountCents: number;
  originalName: string;
  categoryId: string;
  units: LedgerUnits | null;
  now: string;
}

export type CoinbaseTransactionWriteResult = 'inserted' | 'units_backfilled' | 'unchanged';

// The single write path for a Coinbase-sourced transaction, shared by the v3 order import and the
// v2 ledger import so units can never be recorded by one and dropped by the other.
//
// The backfill branch exists because dedup is on coinbase_transaction_id: every row written before
// migration 046 carries NULL units, and a plain "already imported, skip" would mean those rows
// never acquire them, no matter how many syncs run. Units are only ever written into a gap, never
// over a stored value, so this cannot fight a later correction (the CSV import described above,
// when it exists).
export function upsertCoinbaseTransaction(
  db: Database.Database,
  write: CoinbaseTransactionWrite
): CoinbaseTransactionWriteResult {
  const existing = db.prepare(
    'SELECT id, quantity FROM transactions WHERE coinbase_transaction_id = ?'
  ).get(write.coinbaseTransactionId) as { id: string; quantity: number | null } | undefined;

  if (existing) {
    if (existing.quantity !== null || !write.units) return 'unchanged';
    db.prepare(
      'UPDATE transactions SET quantity = ?, security_id = ?, updated_at = ? WHERE id = ?'
    ).run(
      write.units.quantity,
      resolveCryptoSecurityId(db, write.units.ticker),
      write.now,
      existing.id
    );
    return 'units_backfilled';
  }

  db.prepare(`
    INSERT INTO transactions
      (id, coinbase_transaction_id, account_id, date, amount, merchant_name,
       original_name, category_id, quantity, security_id, pending, is_manual, source_type,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Coinbase', ?, ?, ?, ?, 0, 0, 'coinbase', ?, ?)
  `).run(
    uuidv4(),
    write.coinbaseTransactionId,
    write.accountId,
    write.date,
    write.amountCents,
    write.originalName,
    write.categoryId,
    write.units ? write.units.quantity : null,
    write.units ? resolveCryptoSecurityId(db, write.units.ticker) : null,
    write.now,
    write.now
  );
  return 'inserted';
}

function parseCoinbaseNumber(value: string | undefined, label: string): number {
  const parsed = Number.parseFloat(value ?? '0');
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Coinbase ${label}: ${value ?? 'missing'}`);
  }
  return parsed;
}

async function getUsdSpotPrice(currency: string): Promise<number> {
  if (currency === 'USD') return 1;

  try {
    const spotResponse = await axios.get<{ data: { amount: string } }>(
      `https://api.coinbase.com/v2/prices/${currency}-USD/spot`
    );
    const spotPrice = parseCoinbaseNumber(spotResponse.data.data.amount, `${currency}-USD spot price`);
    if (spotPrice <= 0) {
      throw new Error(`Coinbase returned non-positive ${currency}-USD spot price`);
    }
    return spotPrice;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown price error';
    throw new Error(`Unable to price ${currency} in USD: ${message}`);
  }
}

function buildJwt(method: string, path: string): string {
  const creds = getCredentials();
  if (!creds.coinbase) {
    throw new Error('Coinbase credentials not configured');
  }

  const { keyName } = creds.coinbase;

  // Normalize private key: trim whitespace and convert escaped newlines
  const privateKey = creds.coinbase.privateKey.trim().replace(/\\n/g, '\n');

  // Validate PEM format before attempting to sign
  if (!privateKey.includes('-----BEGIN EC PRIVATE KEY-----')) {
    console.error('[coinbase] Invalid private key format - expected EC PRIVATE KEY');
    throw new Error(
      'Invalid private key format: expected -----BEGIN EC PRIVATE KEY-----. ' +
      'Make sure you are pasting the full PEM key from the Coinbase portal.'
    );
  }

  const now = Math.floor(Date.now() / 1000);

  // Strip query string from the URI claim - Coinbase validates against path only
  const pathWithoutQuery = path.split('?')[0];

  const payload = {
    sub: keyName,
    iss: 'coinbase-cloud',
    nbf: now,
    exp: now + 120,
    aud: ['retail_rest_api_proxy'],
    uri: `${method.toUpperCase()} api.coinbase.com${pathWithoutQuery}`,
  };

  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: keyName },
  } as jwt.SignOptions);
}

async function signedRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = buildJwt(method, path);

  try {
    const response = await axios({
      method,
      url: `https://api.coinbase.com${path}`,
      data: body,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data as T;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status?: number; data?: unknown } };
    if (axiosErr.response) {
      console.error('[coinbase] API error %d:', axiosErr.response.status, JSON.stringify(axiosErr.response.data));
      const errBody = axiosErr.response.data as { message?: string; error?: string; error_details?: string; preview?: { error_details?: string } } | undefined;
      const detail =
        errBody?.error_details ||
        errBody?.preview?.error_details ||
        errBody?.message ||
        errBody?.error ||
        `HTTP ${axiosErr.response.status}`;
      throw new CoinbaseApiError(`Coinbase API error (${axiosErr.response.status}): ${detail}`, axiosErr.response.status);
    }
    throw err;
  }
}

export async function testConnection(): Promise<{ userId: string; displayName: string }> {
  interface AccountsResponse {
    accounts: Array<{ uuid: string; name: string }>;
  }

  const data = await signedRequest<AccountsResponse>(
    'GET',
    '/api/v3/brokerage/accounts?limit=1'
  );

  const firstAccount = data.accounts?.[0];
  return {
    userId: firstAccount?.uuid || 'coinbase-user',
    displayName: firstAccount?.name || 'Coinbase User',
  };
}

export async function syncCoinbase(): Promise<CoinbaseSyncResult> {
  const db = getDb();
  const now = new Date().toISOString();

  interface CoinbaseAccount {
    uuid: string;
    name: string;
    currency: string;
    available_balance: {
      value: string;
      currency: string;
    };
    type: string;
  }

  interface AccountsPage {
    accounts: CoinbaseAccount[];
    has_next: boolean;
    cursor: string;
    size: number;
  }

  let cursor: string | undefined;
  let hasNext = true;
  let coinCount = 0;
  const balanceChanges: AccountBalanceChange[] = [];
  const seenCurrencies = new Set<string>();
  const activeConnectionId = ensureCoinbaseConnection(db, now);

  // One consolidated Coinbase account holds every coin as a holding (the Fidelity model),
  // rather than one account per coin. Resolve or create it up front; the per-coin balances
  // become holdings and the account balance is their sum (computed below).
  const existingAcct = db.prepare(
    "SELECT id, account_name, current_balance FROM accounts WHERE connection_type = 'coinbase' AND type = 'crypto_wallet' LIMIT 1"
  ).get() as { id: string; account_name: string; current_balance: number } | undefined;
  const accountId = existingAcct?.id ?? uuidv4();
  if (!existingAcct) {
    db.prepare(`
      INSERT INTO accounts
        (id, coinbase_account_id, connection_id, connection_type, institution_name,
         account_name, type, current_balance, currency, is_manual, is_hidden, is_liability, sort_order, created_at, updated_at)
      VALUES (?, NULL, ?, 'coinbase', 'Coinbase', 'Coinbase', 'crypto_wallet', 0, 'USD', 0, 0, 0, 0, ?, ?)
    `).run(accountId, activeConnectionId, now, now);
  } else {
    // Keep the account anchored to the active connection. account_name is left untouched:
    // Coinbase never renames (a user rename, or the consolidation migration's name, persists).
    db.prepare(
      'UPDATE accounts SET connection_id = COALESCE(?, connection_id), updated_at = ? WHERE id = ?'
    ).run(activeConnectionId, now, accountId);
  }

  while (hasNext) {
    const params = new URLSearchParams({ limit: '250' });
    if (cursor) params.set('cursor', cursor);

    const data = await signedRequest<AccountsPage>(
      'GET',
      `/api/v3/brokerage/accounts?${params.toString()}`
    );

    for (const account of data.accounts || []) {
      const currency = account.available_balance?.currency || account.currency;
      const balanceValue = parseCoinbaseNumber(
        account.available_balance?.value,
        `${currency} available balance`
      );

      // A coin at zero balance is dropped from the account by the zero-out pass below.
      if (balanceValue <= 0) continue;

      // Price each holding independently: a single unpriceable/delisted coin must not abort
      // the whole run. Mark it seen so its last-known holding is kept (not zeroed), and skip.
      let spotPrice: number;
      try {
        spotPrice = await getUsdSpotPrice(currency);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown pricing error';
        console.warn(`[coinbase] Skipping ${currency}: ${message}`);
        seenCurrencies.add(currency);
        continue;
      }

      const value = balanceValue * spotPrice; // dollars
      upsertCoinbaseHolding(db, accountId, currency, balanceValue, spotPrice, value, now);
      seenCurrencies.add(currency);
      coinCount++;
    }

    hasNext = data.has_next || false;
    cursor = data.cursor;
    if (!hasNext) break;
  }

  // Zero out coins fully sold since the last sync so they drop out of the account total.
  const held = db.prepare(
    'SELECT h.id AS holding_id, s.ticker FROM holdings h JOIN securities s ON s.id = h.security_id WHERE h.account_id = ?'
  ).all(accountId) as Array<{ holding_id: string; ticker: string | null }>;
  let zeroedCount = 0;
  for (const row of held) {
    if (row.ticker && seenCurrencies.has(row.ticker)) continue;
    db.prepare(
      'UPDATE holdings SET quantity = 0, institution_value = 0, updated_at = ? WHERE id = ?'
    ).run(now, row.holding_id);
    zeroedCount++;
  }

  // The account balance is the sum of its holdings (authoritative, already in cents).
  const totalCents = (db.prepare(
    'SELECT COALESCE(SUM(institution_value), 0) AS total FROM holdings WHERE account_id = ?'
  ).get(accountId) as { total: number }).total;

  const previousCents = existingAcct?.current_balance ?? 0;
  if (balancesDiffer(previousCents, totalCents)) {
    balanceChanges.push({
      accountId,
      accountName: existingAcct?.account_name ?? 'Coinbase',
      provider: 'coinbase',
      previousBalance: toDollars(previousCents),
      newBalance: toDollars(totalCents),
      isLiability: false,
      currency: 'USD',
    });
  }
  db.prepare('UPDATE accounts SET current_balance = ?, updated_at = ? WHERE id = ?').run(totalCents, now, accountId);
  console.log(`[coinbase] Consolidated account: ${coinCount} coin${coinCount === 1 ? '' : 's'} held, ${zeroedCount} zeroed, ${toDollars(totalCents).toFixed(2)} total`);

  // Import the full crypto ledger for the active connection: v3 brokerage orders (buy/sell) plus
  // the v2 ledger (converts/sends/receives/fiat). Both dedup on coinbase_transaction_id and honor
  // the backfill floor, so running every sync is idempotent, and doing it unconditionally fixes a
  // prior bug where the .env connection only imported history from the *second* sync onward
  // (the gate keyed off "pre-existing active connection", which is order-dependent).
  let transactionCount = await syncTradeHistory(activeConnectionId);

  // The v2 ledger is best-effort: a failure here must not fail an otherwise-successful sync.
  try {
    transactionCount += await syncCoinbaseLedger();
  } catch (err) {
    console.warn(`[coinbase] Ledger sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  db.prepare(
    "UPDATE coinbase_connections SET last_synced_at = ? WHERE status = 'active'"
  ).run(now);

  return {
    // One consolidated account; coinCount is how many coins it holds this run.
    accountCount: 1,
    transactionCount,
    staleAccountCount: zeroedCount,
    balanceChanges,
  };
}

export async function syncTradeHistory(connectionId: string): Promise<number> {
  const db = getDb();
  const now = new Date().toISOString();

  interface OrdersResponse {
    orders: CoinbaseFilledOrder[];
    has_next: boolean;
    cursor: string;
  }

  let cursor: string | undefined;
  let hasNext = true;
  let insertedCount = 0;
  let backfilledCount = 0;

  const connection = db.prepare(
    'SELECT id FROM coinbase_connections WHERE id = ?'
  ).get(connectionId) as { id: string } | undefined;

  if (!connection) {
    console.warn('[coinbase] Trade history skipped: connection not found');
    return 0;
  }

  // All coins now live in one consolidated account; every trade routes to it.
  const acct = db.prepare(
    "SELECT id, backfill_floor_date FROM accounts WHERE connection_type = 'coinbase' AND type = 'crypto_wallet' LIMIT 1"
  ).get() as { id: string; backfill_floor_date: string | null } | undefined;

  if (!acct) {
    console.warn('[coinbase] Trade history skipped: no Coinbase account');
    return 0;
  }

  while (hasNext) {
    const params = new URLSearchParams({
      order_status: 'FILLED',
      limit: '250',
    });
    if (cursor) params.set('cursor', cursor);

    const data = await signedRequest<OrdersResponse>(
      'GET',
      `/api/v3/brokerage/orders/historical/batch?${params.toString()}`
    );

    for (const order of data.orders || []) {
      const currency = order.product_id.split('-')[0];

      const side = order.side.toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') {
        throw new Error(`Unsupported Coinbase order side: ${order.side}`);
      }

      const amount = parseCoinbaseNumber(
        order.total_value_after_fees,
        `order ${order.order_id} total value`
      );
      const signedAmount = side === 'BUY' ? -amount : amount;

      const date = order.created_time
        ? isoToLocalDate(order.created_time)
        : now.split('T')[0];

      // Manual history owns everything below this account's floor; never let a deep
      // pull re-insert a crypto trade the imported backfill already covers.
      if (isBelowBackfillFloor(date, acct.backfill_floor_date)) continue;

      const result = upsertCoinbaseTransaction(db, {
        coinbaseTransactionId: order.order_id,
        accountId: acct.id,
        date,
        amountCents: toCents(signedAmount),
        originalName: `${side === 'BUY' ? 'Buy' : 'Sell'} ${currency}`,
        categoryId: side === 'BUY' ? 'cat_crypto_buy' : 'cat_crypto_sell',
        units: coinbaseOrderUnits(order, side),
        now,
      });
      if (result === 'inserted') insertedCount++;
      if (result === 'units_backfilled') backfilledCount++;
    }

    hasNext = data.has_next || false;
    cursor = data.cursor;
    if (!hasNext) break;
  }

  if (backfilledCount > 0) {
    console.log(`[coinbase] Filled units on ${backfilledCount} previously unit-less trade${backfilledCount === 1 ? '' : 's'}`);
  }

  return insertedCount;
}

// Imports the non-trade crypto activity that the v3 brokerage-orders endpoint doesn't expose:
// converts, sends, receives, and fiat deposits/withdrawals, from the v2 App API. Everything routes
// to the single consolidated Coinbase account. Deduped on coinbase_transaction_id, floor-guarded,
// completed-only. Independent of syncTradeHistory (different id space, disjoint types), so it's
// called guarded, a v2 failure must not fail the whole sync.
export async function syncCoinbaseLedger(): Promise<number> {
  const db = getDb();
  const now = new Date().toISOString();

  const acct = db.prepare(
    "SELECT id, backfill_floor_date FROM accounts WHERE connection_type = 'coinbase' AND type = 'crypto_wallet' LIMIT 1"
  ).get() as { id: string; backfill_floor_date: string | null } | undefined;
  if (!acct) {
    console.warn('[coinbase] Ledger sync skipped: no Coinbase account');
    return 0;
  }

  interface V2Account { id: string }
  interface V2Page<T> { data: T[]; pagination?: { next_uri: string | null } }

  // "Nothing left to learn from this row" is stronger than "this row exists": a row imported
  // before migration 046 exists but carries no units, and stopping on it would strand those rows
  // unit-less forever. Once the units are filled the walk goes back to stopping at the first
  // fully-known page, so this costs one deep pass, not one per sync.
  const settledStmt = db.prepare(
    'SELECT quantity FROM transactions WHERE coinbase_transaction_id = ?'
  );
  const isSettled = (id: string): boolean => {
    const row = settledStmt.get(id) as { quantity: number | null } | undefined;
    return row !== undefined && row.quantity !== null;
  };

  // Page through a v2 list endpoint following pagination.next_uri (already includes the query).
  //
  // `stopWhen` bounds the walk. Without it this re-paged the ENTIRE ledger, every account and
  // every transaction ever, on every sync, to insert the handful that were new: the one place
  // where sync cost tracked total history instead of the size of the delta. v2 returns
  // transactions newest-first, so a page containing nothing new means everything past it is
  // older and already imported.
  async function fetchAll<T>(firstPath: string, stopWhen?: (page: T[]) => boolean): Promise<T[]> {
    const out: T[] = [];
    let path: string | null = firstPath;
    while (path) {
      const page: V2Page<T> = await signedRequest<V2Page<T>>('GET', path);
      const rows = page.data || [];
      out.push(...rows);
      if (stopWhen && rows.length > 0 && stopWhen(rows)) break;
      path = page.pagination?.next_uri ?? null;
    }
    return out;
  }

  // Only safe to short-circuit once something has been imported: on a first sync there is no
  // watermark to stop at and the full history genuinely has to be walked.
  const alreadyImported = (db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE coinbase_transaction_id IS NOT NULL AND source_type = 'coinbase'"
  ).get() as { n: number }).n > 0;

  let inserted = 0;
  let backfilled = 0;
  const accounts = await fetchAll<V2Account>('/v2/accounts?limit=100');
  for (const cbAccount of accounts) {
    const txns = await fetchAll<CoinbaseV2Transaction>(
      `/v2/accounts/${cbAccount.id}/transactions?limit=100`,
      alreadyImported
        ? (page) => page.every((t) => Boolean(t.id) && isSettled(t.id))
        : undefined
    );
    for (const txn of txns) {
      if (!txn.id) continue;

      const classified = classifyCoinbaseLedgerTx(txn);
      if (!classified) continue;

      const date = txn.created_at ? isoToLocalDate(txn.created_at) : now.split('T')[0];
      // Imported backfill owns dates below the floor; never let a deep pull re-insert them.
      if (isBelowBackfillFloor(date, acct.backfill_floor_date)) continue;

      const result = upsertCoinbaseTransaction(db, {
        coinbaseTransactionId: txn.id,
        accountId: acct.id,
        date,
        amountCents: classified.signedCents,
        originalName: classified.merchant,
        categoryId: classified.categoryId,
        units: coinbaseLedgerUnits(txn),
        now,
      });
      if (result === 'inserted') inserted++;
      if (result === 'units_backfilled') backfilled++;
    }
  }

  if (backfilled > 0) {
    console.log(`[coinbase] Filled units on ${backfilled} previously unit-less ledger row${backfilled === 1 ? '' : 's'}`);
  }

  return inserted;
}
