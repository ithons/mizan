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

// Mirrors upsertHoldingsFromSimplefin (simplefin.ts): each crypto_wallet account holds exactly
// one coin, so unlike SimpleFIN there's no array of positions, just one security per account.
// cost_basis is left null for v1 - the Coinbase brokerage accounts API doesn't return it, and
// mining it from trade history is a separate feature, not part of this fix.
export function upsertCoinbaseHolding(
  db: Database.Database,
  accountId: string,
  currency: string,
  quantity: number,
  price: number,
  value: number,
  now: string
): void {
  const existing = db.prepare(
    "SELECT id FROM securities WHERE ticker = ? AND type = 'crypto' LIMIT 1"
  ).get(currency) as { id: string } | undefined;

  const securityId = existing?.id ?? uuidv4();
  if (!existing) {
    db.prepare(`
      INSERT INTO securities (id, ticker, name, type, currency)
      VALUES (?, ?, ?, 'crypto', 'USD')
    `).run(securityId, currency, currency);
  }

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
  // A real connect-route connection that pre-exists this sync keeps its historical
  // behavior of importing trade history; a synthetic env connection stays
  // balances-only (crypto trade history is not pulled into the ledger by default).
  const preExistingConnection = db.prepare(
    "SELECT id FROM coinbase_connections WHERE status = 'active'"
  ).get() as CoinbaseConnectionRow | undefined;
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

  const transactionCount = preExistingConnection
    ? await syncTradeHistory(preExistingConnection.id)
    : 0;

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

  interface FilledOrder {
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

  interface OrdersResponse {
    orders: FilledOrder[];
    has_next: boolean;
    cursor: string;
  }

  let cursor: string | undefined;
  let hasNext = true;
  let insertedCount = 0;

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
      const existing = db.prepare(
        'SELECT id FROM transactions WHERE coinbase_transaction_id = ?'
      ).get(order.order_id) as { id: string } | undefined;

      if (existing) continue;

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

      const categoryId = side === 'BUY' ? 'cat_crypto_buy' : 'cat_crypto_sell';

      db.prepare(`
        INSERT INTO transactions
          (id, coinbase_transaction_id, account_id, date, amount, merchant_name,
           original_name, category_id, pending, is_manual, source_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'Coinbase', ?, ?, 0, 0, 'coinbase', ?, ?)
      `).run(
        uuidv4(),
        order.order_id,
        acct.id,
        date,
        toCents(signedAmount),
        `${side === 'BUY' ? 'Buy' : 'Sell'} ${currency}`,
        categoryId,
        now,
        now
      );
      insertedCount++;
    }

    hasNext = data.has_next || false;
    cursor = data.cursor;
    if (!hasNext) break;
  }

  return insertedCount;
}
