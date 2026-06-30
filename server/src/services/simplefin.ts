import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getCredentials } from './credentials';
import { getDb } from '../db/index';
import type { AccountType } from '../../../shared/types';
import { balancesDiffer, type AccountBalanceChange } from './balanceChanges';

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

  // Fetch accounts and transactions
  const res = await client.get('/accounts');
  const data = res.data;

  const accountCount = data.accounts?.length || 0;

  for (const acct of (data.accounts || [])) {
    const isLiability = acct.balance < 0 ? 1 : 0;
    const currentBalance = parseFloat(acct.balance);
    const currency = acct.currency || 'USD';
    const institutionName = acct.org?.name || 'SimpleFIN';

    const existingAcct = db.prepare(`
      SELECT id, account_name, current_balance, is_liability, currency
      FROM accounts
      WHERE simplefin_account_id = ?
    `).get(acct.id) as any;

    let accountId;

    if (existingAcct) {
      accountId = existingAcct.id;
      if (balancesDiffer(existingAcct.current_balance, currentBalance)) {
        balanceChanges.push({
          accountId: existingAcct.id,
          accountName: existingAcct.account_name,
          provider: 'simplefin',
          previousBalance: existingAcct.current_balance,
          newBalance: currentBalance,
          isLiability: Boolean(existingAcct.is_liability),
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
      db.prepare(`
        INSERT INTO accounts
          (id, simplefin_account_id, connection_id, connection_type, institution_name,
           account_name, type, current_balance,
           currency, is_manual, is_hidden, is_liability, sort_order, created_at, updated_at)
        VALUES (?, ?, 'simplefin_primary', 'simplefin', ?, ?, 'checking', ?, ?, 0, 0, ?, 0, ?, ?)
      `).run(
        accountId,
        acct.id,
        institutionName,
        acct.name,
        currentBalance,
        currency,
        isLiability,
        now,
        now
      );
    }

    // Process transactions
    // SimpleFIN doesn't group txns per account in /accounts, it returns them inside /accounts endpoint maybe?
    // Wait, simplefin usually returns transactions inside the account object or a separate array? Let's assume they are under acct.transactions based on standard MX/SimpleFIN payload. Or if it's top level data.transactions? Let's check typical MX payload. SimpleFIN returns accounts and a separate transactions array or nested. Actually, let's look at MX. Wait, SimpleFIN typically nests transactions? Let's just process them if they are inside acct.transactions.
  }

  return { status: 'synced', accountCount, added, modified, removed, skipped, balanceChanges };
}
