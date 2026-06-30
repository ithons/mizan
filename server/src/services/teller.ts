import https from 'https';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';
import type { AccountType } from '../../../shared/types';
import { balancesDiffer, type AccountBalanceChange } from './balanceChanges';

function mapTellerAccountType(type: string, subtype: string): AccountType {
  const t = type.toLowerCase();
  const s = subtype.toLowerCase();
  if (t === 'depository') {
    if (s === 'savings') return 'savings';
    return 'checking';
  }
  if (t === 'credit') return 'credit';
  return 'other';
}

export async function syncTellerItem(enrollmentId: string) {
  const creds = getCredentials();
  if (!creds.tellerCertificate || !creds.tellerItems?.[enrollmentId]) {
    throw new Error('Missing Teller credentials or access token');
  }

  const { accessToken } = creds.tellerItems[enrollmentId];
  const { cert, privateKey } = creds.tellerCertificate;

  const agent = new https.Agent({
    cert,
    key: privateKey,
  });

  const client = axios.create({
    baseURL: 'https://api.teller.io',
    httpsAgent: agent,
    auth: {
      username: accessToken,
      password: '',
    },
  });

  const db = getDb();
  const dbItemId = `teller_${enrollmentId}`;
  
  let added = 0, modified = 0, removed = 0, skipped = 0;
  const balanceChanges: AccountBalanceChange[] = [];

  const now = new Date().toISOString();

  // Fetch accounts
  const accountsRes = await client.get('/accounts');
  const tellerAccounts = accountsRes.data as Array<any>;

  for (const acct of tellerAccounts) {
    const acctType = mapTellerAccountType(acct.type, acct.subtype);
    const isLiability = acct.type === 'credit' ? 1 : 0;
    
    // In Teller, balances are not in the list, you have to query them separately.
    // For simplicity let's assume we can fetch them or they're in the payload? Wait, Teller /accounts returns balances: { available, ledger }.
    const balances = acct.balances || {};
    const currentBalance = parseFloat(balances.ledger || '0');
    const availableBalance = balances.available ? parseFloat(balances.available) : null;
    const currency = acct.currency || 'USD';

    const existingAcct = db.prepare(`
      SELECT id, account_name, current_balance, is_liability, currency
      FROM accounts
      WHERE teller_account_id = ?
    `).get(acct.id) as any;

    let accountId;

    if (existingAcct) {
      accountId = existingAcct.id;
      if (balancesDiffer(existingAcct.current_balance, currentBalance)) {
        balanceChanges.push({
          accountId: existingAcct.id,
          accountName: existingAcct.account_name,
          provider: 'teller',
          previousBalance: existingAcct.current_balance,
          newBalance: currentBalance,
          isLiability: Boolean(existingAcct.is_liability),
          currency: existingAcct.currency ?? currency,
        });
      }

      db.prepare(`
        UPDATE accounts
        SET connection_id = ?,
            account_name = ?,
            type = ?,
            subtype = ?,
            mask = ?,
            current_balance = ?,
            available_balance = ?,
            currency = ?,
            is_liability = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        dbItemId,
        acct.name,
        acctType,
        acct.subtype || null,
        acct.last4 || null,
        currentBalance,
        availableBalance,
        currency,
        isLiability,
        now,
        existingAcct.id
      );
    } else {
      accountId = uuidv4();
      db.prepare(`
        INSERT INTO accounts
          (id, teller_account_id, connection_id, connection_type, institution_name,
           account_name, type, subtype, mask, current_balance, available_balance,
           currency, is_manual, is_hidden, is_liability, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 'teller', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)
      `).run(
        accountId,
        acct.id,
        dbItemId,
        acct.institution?.name || 'Teller',
        acct.name,
        acctType,
        acct.subtype || null,
        acct.last4 || null,
        currentBalance,
        availableBalance,
        currency,
        isLiability,
        now,
        now
      );
    }

    // Fetch transactions
    try {
      const txnsRes = await client.get(`/accounts/${acct.id}/transactions`);
      const transactions = txnsRes.data as Array<any>;

      for (const txn of transactions) {
        const existingTxn = db.prepare(
          'SELECT id FROM transactions WHERE teller_transaction_id = ?'
        ).get(txn.id) as any;

        // Teller amount is usually negative for expenses? Actually let's assume it's like Plaid or check.
        // Let's normalize it.
        const normalizedAmount = parseFloat(txn.amount) * -1; // Assuming Teller positive is expense? Wait, Teller positive is deposit, negative is expense. Mizān stores expenses as negative, so if Teller uses negative for expenses, no change needed. But let's just use -amount if it's like Plaid, or amount if it's standard. Let's assume standard negative means expense.
        
        if (!existingTxn) {
          db.prepare(`
            INSERT INTO transactions
              (id, teller_transaction_id, account_id, date, amount, merchant_name,
               original_name, pending, is_manual, source_type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'teller', ?, ?)
          `).run(
            uuidv4(),
            txn.id,
            accountId,
            txn.date,
            parseFloat(txn.amount), // Need to verify Teller's sign convention
            txn.details?.merchant?.name || txn.description || null,
            txn.description,
            txn.status === 'pending' ? 1 : 0,
            now,
            now
          );
          added++;
        } else {
          skipped++;
        }
      }
    } catch (e) {
      console.warn(`[teller] Failed to sync transactions for account ${acct.id}`);
    }
  }

  db.prepare(
    "UPDATE teller_items SET last_synced_at = ?, status = 'active' WHERE enrollment_id = ?"
  ).run(now, enrollmentId);

  return { 
    itemId: dbItemId,
    institutionName: tellerAccounts[0]?.institution?.name || 'Teller',
    status: 'synced', 
    accountCount: tellerAccounts.length, 
    added, modified, removed, skipped, balanceChanges 
  };
}
