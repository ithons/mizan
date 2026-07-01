import axios from 'axios';
import { format } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';
import type { AccountType } from '../../../shared/types';
import { balancesDiffer, type AccountBalanceChange } from './balanceChanges';

function guessAccountTypeAndLiability(name: string, orgName: string): { type: AccountType; isLiability: boolean } {
  const combined = `${name} ${orgName}`.toLowerCase();
  
  if (combined.includes('credit') || combined.includes('card')) {
    return { type: 'credit', isLiability: true };
  }
  if (combined.includes('loan') || combined.includes('mortgage')) {
    return { type: 'other', isLiability: true };
  }
  if (combined.includes('savings')) {
    return { type: 'savings', isLiability: false };
  }
  if (combined.includes('brokerage') || combined.includes('investment')) {
    return { type: 'brokerage', isLiability: false };
  }
  if (combined.includes('ira') || combined.includes('roth') || combined.includes('401k')) {
    return { type: 'ira_traditional', isLiability: false };
  }
  
  return { type: 'checking', isLiability: false };
}

export async function syncSimplefin() {
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

  // Fetch accounts and transactions (request past 30 days or so, SimpleFIN uses start-date epoch)
  const startDate = Math.floor(Date.now() / 1000) - (30 * 86400);
  const res = await client.get(`/accounts?start-date=${startDate}`);
  const data = res.data;

  const accountCount = data.accounts?.length || 0;

  for (const acct of (data.accounts || [])) {
    const currency = acct.currency || 'USD';
    const institutionName = acct.org?.name || 'SimpleFIN';

    const existingAcct = db.prepare(`
      SELECT id, account_name, current_balance, is_liability, currency
      FROM accounts
      WHERE simplefin_account_id = ?
    `).get(acct.id) as any;

    let accountId: string;
    let isLiability: boolean;
    let currentBalance: number;

    if (existingAcct) {
      accountId = existingAcct.id;
      isLiability = Boolean(existingAcct.is_liability);
      currentBalance = isLiability ? -parseFloat(acct.balance) : parseFloat(acct.balance);

      if (balancesDiffer(existingAcct.current_balance, currentBalance)) {
        balanceChanges.push({
          accountId: existingAcct.id,
          accountName: existingAcct.account_name,
          provider: 'simplefin',
          previousBalance: existingAcct.current_balance,
          newBalance: currentBalance,
          isLiability,
          currency: existingAcct.currency ?? currency,
        });
      }

      db.prepare(`
        UPDATE accounts
        SET connection_id = 'simplefin_primary',
            institution_name = ?,
            account_name = ?,
            current_balance = ?,
            currency = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        institutionName,
        acct.name,
        currentBalance,
        currency,
        now,
        existingAcct.id
      );
    } else {
      accountId = uuidv4();
      const guessed = guessAccountTypeAndLiability(acct.name, institutionName);
      isLiability = guessed.isLiability;
      currentBalance = isLiability ? -parseFloat(acct.balance) : parseFloat(acct.balance);

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

      // Convert epoch seconds to YYYY-MM-DD in the local timezone
      const date = format(new Date(txn.posted * 1000), 'yyyy-MM-dd');
      const amount = parseFloat(txn.amount); // already negative for expenses
      const merchantName = txn.payee || null;
      const originalName = txn.description || '';

      if (existingTxn) {
        db.prepare(`
          UPDATE transactions
          SET date = ?, amount = ?, merchant_name = ?, original_name = ?, updated_at = ?
          WHERE simplefin_transaction_id = ?
        `).run(date, amount, merchantName, originalName, now, txn.id);
        modified++;
      } else {
        db.prepare(`
          INSERT INTO transactions
            (id, simplefin_transaction_id, account_id, date, amount, merchant_name,
             original_name, is_manual, source_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'simplefin', ?, ?)
        `).run(
          uuidv4(),
          txn.id,
          accountId,
          date,
          amount,
          merchantName,
          originalName,
          now,
          now
        );
        added++;
      }
    }
  }

  // Update simplefin_connections last_synced_at
  db.prepare(`
    UPDATE simplefin_connections
    SET last_synced_at = ?
    WHERE access_url = ?
  `).run(now, accessUrl);

  return { status: 'synced', accountCount, added, modified, removed, skipped, balanceChanges };
}
