import jwt from 'jsonwebtoken';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';

const BROKERAGE_BASE = 'https://api.coinbase.com/api/v3/brokerage';

function buildJwt(method: string, path: string): string {
  const creds = getCredentials();
  if (!creds.coinbase) {
    throw new Error('Coinbase credentials not configured');
  }

  const { keyName, privateKey } = creds.coinbase;
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    sub: keyName,
    iss: 'coinbase-cloud',
    nbf: now,
    exp: now + 120,
    aud: ['retail_rest_api_proxy'],
    uri: `${method.toUpperCase()} api.coinbase.com${path}`,
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

export async function syncCoinbase(): Promise<number> {
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

  while (hasNext) {
    const params = new URLSearchParams({ limit: '250' });
    if (cursor) params.set('cursor', cursor);

    const data = await signedRequest<AccountsPage>(
      'GET',
      `/api/v3/brokerage/accounts?${params.toString()}`
    );

    for (const account of data.accounts || []) {
      const balanceValue = parseFloat(account.available_balance?.value || '0');
      if (balanceValue <= 0) continue;

      const currency = account.available_balance?.currency || account.currency;
      let spotPrice = 1;

      if (currency !== 'USD') {
        try {
          const spotResponse = await axios.get<{ data: { amount: string } }>(
            `https://api.coinbase.com/v2/prices/${currency}-USD/spot`
          );
          spotPrice = parseFloat(spotResponse.data.data.amount);
        } catch {
          spotPrice = 0;
        }
      }

      const currentBalance = balanceValue * spotPrice;

      const existing = db.prepare(
        'SELECT id FROM accounts WHERE coinbase_account_id = ?'
      ).get(account.uuid) as { id: string } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE accounts
          SET native_currency = ?, native_balance = ?, current_balance = ?,
              updated_at = ?
          WHERE id = ?
        `).run(currency, balanceValue, currentBalance, now, existing.id);
      } else {
        db.prepare(`
          INSERT INTO accounts
            (id, coinbase_account_id, connection_type, institution_name,
             account_name, type, current_balance, native_currency, native_balance,
             currency, is_manual, is_hidden, is_liability, sort_order, created_at, updated_at)
          VALUES (?, ?, 'coinbase', 'Coinbase', ?, 'crypto_wallet', ?, ?, ?, 'USD', 0, 0, 0, 0, ?, ?)
        `).run(
          uuidv4(),
          account.uuid,
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

  // Update coinbase_connections.last_synced_at
  db.prepare(
    "UPDATE coinbase_connections SET last_synced_at = ? WHERE status = 'active'"
  ).run(now);

  return syncedCount;
}

export async function syncTradeHistory(connectionId: string): Promise<void> {
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

  // Look up coinbase_connection to get the user's account id
  const connection = db.prepare(
    'SELECT id FROM coinbase_connections WHERE id = ?'
  ).get(connectionId) as { id: string } | undefined;

  if (!connection) return;

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

      // Find matching account by product currency
      const currency = order.product_id.split('-')[0];
      const acct = db.prepare(
        'SELECT id FROM accounts WHERE coinbase_account_id IS NOT NULL AND native_currency = ?'
      ).get(currency) as { id: string } | undefined;

      if (!acct) continue;

      const side = order.side.toUpperCase();
      const amount = parseFloat(order.total_value_after_fees || '0');
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
    }

    hasNext = data.has_next || false;
    cursor = data.cursor;
    if (!hasNext) break;
  }
}
