import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from 'plaid';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index';
import {
  getCredentials,
  savePlaidItemToken,
  removePlaidItemToken,
} from './credentials';
import type { Account, AccountType } from '../../../shared/types';

let _client: PlaidApi | null = null;

function getPlaidClient(): PlaidApi {
  if (_client) return _client;
  const creds = getCredentials();
  if (!creds.plaid) {
    throw new Error('Plaid credentials not configured');
  }

  const config = new Configuration({
    basePath: PlaidEnvironments[creds.plaid.environment],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': creds.plaid.clientId,
        'PLAID-SECRET': creds.plaid.secret,
      },
    },
  });

  _client = new PlaidApi(config);
  return _client;
}

// Reset the cached client when credentials change
export function resetPlaidClient(): void {
  _client = null;
}

function mapAccountType(
  plaidType: string,
  plaidSubtype: string | null | undefined
): AccountType {
  const type = plaidType.toLowerCase();
  const subtype = (plaidSubtype || '').toLowerCase();

  if (type === 'depository') {
    if (subtype === 'savings') return 'savings';
    return 'checking';
  }
  if (type === 'credit') return 'credit';
  if (type === 'loan') return 'other';
  if (type === 'investment') {
    if (subtype === 'ira') return 'ira_traditional';
    if (subtype === 'roth') return 'ira_roth';
    return 'brokerage';
  }
  return 'other';
}

export async function createLinkToken(redirectUri: string = 'http://localhost:3000'): Promise<string> {
  const plaid = getPlaidClient();
  const creds = getCredentials();

  const requestPayload = {
    user: { client_user_id: 'local-user' },
    client_name: 'Mizān',
    products: [Products.Transactions, Products.Investments],
    country_codes: [CountryCode.Us],
    language: 'en',
    redirect_uri: redirectUri,
  };

  console.log(
    '[plaid] createLinkToken environment=%s basePath=%s',
    creds.plaid?.environment,
    PlaidEnvironments[creds.plaid?.environment ?? 'sandbox']
  );
  console.log('[plaid] createLinkToken request:', JSON.stringify(requestPayload));

  const response = await plaid.linkTokenCreate(requestPayload);

  console.log('[plaid] link_token (first 20 chars):', response.data.link_token.substring(0, 20));
  console.log('[plaid] response request_id:', response.data.request_id);

  return response.data.link_token;
}

export async function exchangeToken(
  publicToken: string,
  metadata: Record<string, unknown>
): Promise<{ itemId: string; accounts: Account[] }> {
  const plaid = getPlaidClient();
  const db = getDb();

  // Exchange public token for access token
  const exchangeResponse = await plaid.itemPublicTokenExchange({
    public_token: publicToken,
  });

  const { access_token, item_id } = exchangeResponse.data;

  // Save access token securely
  savePlaidItemToken(item_id, access_token);

  const now = new Date().toISOString();
  const dbItemId = uuidv4();
  const institutionId = (metadata?.institution as Record<string, unknown>)?.institution_id as string | undefined;
  const institutionName =
    ((metadata?.institution as Record<string, unknown>)?.name as string) || 'Unknown Institution';

  // Create plaid_items record
  db.prepare(`
    INSERT INTO plaid_items (id, item_id, institution_id, institution_name, cursor, last_synced_at, products, status, created_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, 'active', ?)
  `).run(
    dbItemId,
    item_id,
    institutionId || null,
    institutionName,
    'transactions,investments',
    now
  );

  // Fetch accounts
  const accountsResponse = await plaid.accountsGet({ access_token });
  const plaidAccounts = accountsResponse.data.accounts;

  for (const acct of plaidAccounts) {
    const acctType = mapAccountType(acct.type, acct.subtype);
    const isLiability = acct.type === 'credit' || acct.type === 'loan' ? 1 : 0;
    const currentBalance = acct.balances.current ?? 0;
    const availableBalance = acct.balances.available ?? null;

    const existingAcct = db.prepare(
      'SELECT id FROM accounts WHERE plaid_account_id = ?'
    ).get(acct.account_id) as { id: string } | undefined;

    if (existingAcct) {
      db.prepare(`
        UPDATE accounts
        SET current_balance = ?, available_balance = ?, updated_at = ?
        WHERE id = ?
      `).run(currentBalance, availableBalance, now, existingAcct.id);
    } else {
      db.prepare(`
        INSERT INTO accounts
          (id, plaid_account_id, connection_id, connection_type, institution_name,
           account_name, type, subtype, mask, current_balance, available_balance,
           currency, is_manual, is_hidden, is_liability, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 'plaid', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)
      `).run(
        uuidv4(),
        acct.account_id,
        dbItemId,
        institutionName,
        acct.name,
        acctType,
        acct.subtype || null,
        acct.mask || null,
        currentBalance,
        availableBalance,
        acct.balances.iso_currency_code || 'USD',
        isLiability,
        now,
        now
      );
    }
  }

  // Queue immediate sync
  try {
    await syncItem(dbItemId);
  } catch (err) {
    console.error('[plaid] Initial sync failed:', (err as Error).message);
  }

  return { itemId: dbItemId, accounts: [] };
}

export async function syncItem(dbItemId: string): Promise<void> {
  const db = getDb();
  const plaid = getPlaidClient();
  const creds = getCredentials();

  const item = db.prepare(
    'SELECT * FROM plaid_items WHERE id = ?'
  ).get(dbItemId) as {
    id: string;
    item_id: string;
    cursor: string | null;
    status: string;
  } | undefined;

  if (!item) throw new Error(`Plaid item not found: ${dbItemId}`);

  const accessToken = creds.plaidItems?.[item.item_id]?.accessToken;
  if (!accessToken) throw new Error(`No access token for item: ${item.item_id}`);

  let cursor = item.cursor || undefined;
  let hasMore = true;

  while (hasMore) {
    let syncResponse;
    try {
      syncResponse = await plaid.transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
      });
    } catch (err: unknown) {
      const plaidErr = err as { response?: { data?: { error_code?: string } } };
      if (plaidErr?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED') {
        db.prepare(
          "UPDATE plaid_items SET status = 'reauth_required' WHERE id = ?"
        ).run(dbItemId);
        return;
      }
      throw err;
    }

    const { added, modified, removed, next_cursor, has_more } =
      syncResponse.data;
    cursor = next_cursor;
    hasMore = has_more;

    const now = new Date().toISOString();

    // Process added transactions
    for (const txn of added) {
      const acct = db.prepare(
        'SELECT id FROM accounts WHERE plaid_account_id = ?'
      ).get(txn.account_id) as { id: string } | undefined;

      if (!acct) continue;

      const existing = db.prepare(
        'SELECT id FROM transactions WHERE plaid_transaction_id = ?'
      ).get(txn.transaction_id) as { id: string } | undefined;

      if (!existing) {
        const txnId = uuidv4();
        db.prepare(`
          INSERT INTO transactions
            (id, plaid_transaction_id, account_id, date, amount, merchant_name,
             original_name, category_id, pending, is_manual, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)
        `).run(
          txnId,
          txn.transaction_id,
          acct.id,
          txn.date,
          txn.amount,
          txn.merchant_name || null,
          txn.name,
          txn.pending ? 1 : 0,
          now,
          now
        );
        autoCategorize(txnId, txn.merchant_name || txn.name);
      }
    }

    // Process modified transactions
    for (const txn of modified) {
      const acct = db.prepare(
        'SELECT id FROM accounts WHERE plaid_account_id = ?'
      ).get(txn.account_id) as { id: string } | undefined;

      if (!acct) continue;

      db.prepare(`
        UPDATE transactions
        SET date = ?, amount = ?, merchant_name = ?, original_name = ?,
            pending = ?, updated_at = ?
        WHERE plaid_transaction_id = ?
      `).run(
        txn.date,
        txn.amount,
        txn.merchant_name || null,
        txn.name,
        txn.pending ? 1 : 0,
        now,
        txn.transaction_id
      );
    }

    // Process removed transactions
    for (const txn of removed) {
      db.prepare(
        'DELETE FROM transactions WHERE plaid_transaction_id = ?'
      ).run(txn.transaction_id);
    }

    // Update cursor
    db.prepare(
      'UPDATE plaid_items SET cursor = ? WHERE id = ?'
    ).run(cursor, dbItemId);
  }

  // Sync investments
  try {
    await syncInvestments(dbItemId);
  } catch (err) {
    console.error('[plaid] Investment sync failed:', (err as Error).message);
  }

  // Update last_synced_at
  db.prepare(
    "UPDATE plaid_items SET last_synced_at = ?, status = 'active' WHERE id = ?"
  ).run(new Date().toISOString(), dbItemId);
}

export async function syncInvestments(dbItemId: string): Promise<void> {
  const db = getDb();
  const plaid = getPlaidClient();
  const creds = getCredentials();

  const item = db.prepare(
    'SELECT item_id FROM plaid_items WHERE id = ?'
  ).get(dbItemId) as { item_id: string } | undefined;

  if (!item) return;

  const accessToken = creds.plaidItems?.[item.item_id]?.accessToken;
  if (!accessToken) return;

  const now = new Date().toISOString();

  try {
    // Sync holdings
    const holdingsResponse = await plaid.investmentsHoldingsGet({
      access_token: accessToken,
    });

    const { holdings, securities, accounts } = holdingsResponse.data;

    // Upsert securities
    for (const sec of securities) {
      const secType = (() => {
        const t = (sec.type || '').toLowerCase();
        if (t === 'equity') return 'equity';
        if (t === 'etf') return 'etf';
        if (t === 'mutual fund') return 'mutual_fund';
        if (t === 'cryptocurrency') return 'crypto';
        if (t === 'cash') return 'cash';
        return 'other';
      })();

      const existing = db.prepare(
        'SELECT id FROM securities WHERE plaid_security_id = ?'
      ).get(sec.security_id) as { id: string } | undefined;

      if (!existing) {
        db.prepare(`
          INSERT INTO securities (id, plaid_security_id, ticker, name, type, currency)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          sec.security_id,
          sec.ticker_symbol || null,
          sec.name || sec.ticker_symbol || 'Unknown',
          secType,
          sec.iso_currency_code || 'USD'
        );
      }
    }

    // Compute account balance from holdings per account
    const acctHoldingValues: Record<string, number> = {};

    // Upsert holdings
    for (const holding of holdings) {
      const acct = db.prepare(
        'SELECT id FROM accounts WHERE plaid_account_id = ?'
      ).get(holding.account_id) as { id: string } | undefined;

      if (!acct) continue;

      const sec = db.prepare(
        'SELECT id FROM securities WHERE plaid_security_id = ?'
      ).get(holding.security_id) as { id: string } | undefined;

      if (!sec) continue;

      acctHoldingValues[acct.id] =
        (acctHoldingValues[acct.id] || 0) + (holding.institution_value || 0);

      const existing = db.prepare(
        'SELECT id FROM holdings WHERE account_id = ? AND security_id = ?'
      ).get(acct.id, sec.id) as { id: string } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE holdings
          SET quantity = ?, institution_price = ?, institution_value = ?,
              cost_basis = ?, currency = ?, updated_at = ?
          WHERE id = ?
        `).run(
          holding.quantity,
          holding.institution_price,
          holding.institution_value,
          holding.cost_basis ?? null,
          holding.iso_currency_code || 'USD',
          now,
          existing.id
        );
      } else {
        db.prepare(`
          INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis, currency, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          acct.id,
          sec.id,
          holding.quantity,
          holding.institution_price,
          holding.institution_value,
          holding.cost_basis ?? null,
          holding.iso_currency_code || 'USD',
          now
        );
      }
    }

    // Update account balances from holdings
    for (const [acctId, totalValue] of Object.entries(acctHoldingValues)) {
      db.prepare(
        'UPDATE accounts SET current_balance = ?, updated_at = ? WHERE id = ?'
      ).run(totalValue, now, acctId);
    }

    // Sync investment transactions
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];

    const investTxnResponse = await plaid.investmentsTransactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
    });

    for (const itxn of investTxnResponse.data.investment_transactions) {
      const acct = db.prepare(
        'SELECT id FROM accounts WHERE plaid_account_id = ?'
      ).get(itxn.account_id) as { id: string } | undefined;

      if (!acct) continue;

      const sec = itxn.security_id
        ? (db.prepare('SELECT id FROM securities WHERE plaid_security_id = ?').get(
            itxn.security_id
          ) as { id: string } | undefined)
        : undefined;

      const txnType = (() => {
        const t = (itxn.type || '').toLowerCase();
        if (t === 'buy') return 'buy';
        if (t === 'sell') return 'sell';
        if (t === 'dividend') return 'dividend';
        if (t === 'transfer') return 'transfer';
        if (t === 'fee') return 'fee';
        return 'other';
      })();

      const existing = db.prepare(
        'SELECT id FROM investment_transactions WHERE plaid_investment_transaction_id = ?'
      ).get(itxn.investment_transaction_id) as { id: string } | undefined;

      if (!existing) {
        db.prepare(`
          INSERT INTO investment_transactions
            (id, plaid_investment_transaction_id, account_id, date, type, security_id,
             quantity, price, amount, fees, name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          itxn.investment_transaction_id,
          acct.id,
          itxn.date,
          txnType,
          sec?.id ?? null,
          itxn.quantity ?? null,
          itxn.price ?? null,
          itxn.amount,
          itxn.fees ?? null,
          itxn.name,
          now
        );
      }
    }
  } catch (err: unknown) {
    const plaidErr = err as { response?: { data?: { error_code?: string } } };
    if (plaidErr?.response?.data?.error_code === 'PRODUCTS_NOT_SUPPORTED') {
      // Account doesn't support investments, skip
      return;
    }
    throw err;
  }
}

export async function syncAllItems(): Promise<void> {
  const db = getDb();

  const items = db.prepare(
    "SELECT id FROM plaid_items WHERE status != 'removed'"
  ).all() as Array<{ id: string }>;

  for (const item of items) {
    try {
      await syncItem(item.id);
    } catch (err) {
      console.error(`[plaid] Failed to sync item ${item.id}:`, (err as Error).message);
    }
  }
}

export async function createUpdateToken(dbItemId: string, redirectUri: string = 'http://localhost:3000'): Promise<string> {
  const db = getDb();
  const plaid = getPlaidClient();
  const creds = getCredentials();

  const item = db.prepare(
    'SELECT item_id FROM plaid_items WHERE id = ?'
  ).get(dbItemId) as { item_id: string } | undefined;

  if (!item) throw new Error(`Plaid item not found: ${dbItemId}`);

  const accessToken = creds.plaidItems?.[item.item_id]?.accessToken;
  if (!accessToken) throw new Error(`No access token for item: ${item.item_id}`);

  const response = await plaid.linkTokenCreate({
    user: { client_user_id: 'local-user' },
    client_name: 'Mizān',
    access_token: accessToken,
    country_codes: [CountryCode.Us],
    language: 'en',
    redirect_uri: redirectUri,
  });

  return response.data.link_token;
}

export function autoCategorize(transactionId: string, merchantName: string): void {
  const db = getDb();

  const rules = db.prepare(
    'SELECT pattern, category_id FROM merchant_rules ORDER BY created_at DESC'
  ).all() as Array<{ pattern: string; category_id: string }>;

  const lowerMerchant = merchantName.toLowerCase();

  for (const rule of rules) {
    if (lowerMerchant.includes(rule.pattern.toLowerCase())) {
      db.prepare(
        'UPDATE transactions SET category_id = ? WHERE id = ?'
      ).run(rule.category_id, transactionId);
      return;
    }
  }
}
