import jwt from 'jsonwebtoken';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';

export interface CoinbaseSyncResult {
  accountCount: number;
  transactionCount: number;
  staleAccountCount: number;
}

interface CoinbaseConnectionRow {
  id: string;
}

interface CoinbaseAccountRow {
  id: string;
  coinbase_account_id: string;
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
      throw new Error(`Coinbase API error (${axiosErr.response.status}): ${detail}`);
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
  let syncedCount = 0;
  const seenAccountIds = new Set<string>();
  const activeConnection = db.prepare(
    "SELECT id FROM coinbase_connections WHERE status = 'active'"
  ).get() as CoinbaseConnectionRow | undefined;
  const activeConnectionId = activeConnection?.id ?? null;

  while (hasNext) {
    const params = new URLSearchParams({ limit: '250' });
    if (cursor) params.set('cursor', cursor);

    const data = await signedRequest<AccountsPage>(
      'GET',
      `/api/v3/brokerage/accounts?${params.toString()}`
    );

    for (const account of data.accounts || []) {
      seenAccountIds.add(account.uuid);

      const currency = account.available_balance?.currency || account.currency;
      const balanceValue = parseCoinbaseNumber(
        account.available_balance?.value,
        `${currency} available balance`
      );
      const existing = db.prepare(
        'SELECT id FROM accounts WHERE coinbase_account_id = ?'
      ).get(account.uuid) as { id: string } | undefined;

      if (balanceValue <= 0 && !existing) continue;

      const spotPrice = balanceValue === 0 ? 0 : await getUsdSpotPrice(currency);
      const currentBalance = balanceValue * spotPrice;

      if (existing) {
        db.prepare(`
          UPDATE accounts
          SET connection_id = COALESCE(?, connection_id),
              native_currency = ?, native_balance = ?, current_balance = ?,
              updated_at = ?
          WHERE id = ?
        `).run(activeConnectionId, currency, balanceValue, currentBalance, now, existing.id);
      } else {
        db.prepare(`
          INSERT INTO accounts
            (id, coinbase_account_id, connection_id, connection_type, institution_name,
             account_name, type, current_balance, native_currency, native_balance,
             currency, is_manual, is_hidden, is_liability, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, 'coinbase', 'Coinbase', ?, 'crypto_wallet', ?, ?, ?, 'USD', 0, 0, 0, 0, ?, ?)
        `).run(
          uuidv4(),
          account.uuid,
          activeConnectionId,
          account.name || currency,
          currentBalance,
          currency,
          balanceValue,
          now,
          now
        );
      }

      syncedCount++;
    }

    hasNext = data.has_next || false;
    cursor = data.cursor;
    if (!hasNext) break;
  }

  const staleAccounts = db.prepare(`
    SELECT id, coinbase_account_id
    FROM accounts
    WHERE connection_type = 'coinbase'
      AND coinbase_account_id IS NOT NULL
  `).all() as CoinbaseAccountRow[];

  let staleAccountCount = 0;
  for (const account of staleAccounts) {
    if (seenAccountIds.has(account.coinbase_account_id)) continue;

    db.prepare(`
      UPDATE accounts
      SET current_balance = 0, native_balance = 0, updated_at = ?
      WHERE id = ?
    `).run(now, account.id);
    staleAccountCount++;
  }

  const transactionCount = activeConnection
    ? await syncTradeHistory(activeConnection.id)
    : 0;

  db.prepare(
    "UPDATE coinbase_connections SET last_synced_at = ? WHERE status = 'active'"
  ).run(now);

  return {
    accountCount: syncedCount,
    transactionCount,
    staleAccountCount,
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
      const acct = db.prepare(
        'SELECT id FROM accounts WHERE coinbase_account_id IS NOT NULL AND native_currency = ?'
      ).get(currency) as { id: string } | undefined;

      if (!acct) continue;

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
        ? new Date(order.created_time).toISOString().split('T')[0]
        : now.split('T')[0];

      const categoryId = side === 'BUY' ? 'cat_crypto_buy' : 'cat_crypto_sell';

      db.prepare(`
        INSERT INTO transactions
          (id, coinbase_transaction_id, account_id, date, amount, merchant_name,
           original_name, category_id, pending, is_manual, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'Coinbase', ?, ?, 0, 0, ?, ?)
      `).run(
        uuidv4(),
        order.order_id,
        acct.id,
        date,
        signedAmount,
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
