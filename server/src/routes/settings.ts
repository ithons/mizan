import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { format, parse, isValid } from 'date-fns';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  PlaidCredentialsSchema,
  CoinbaseCredentialsSchema,
  CsvImportMappingSchema,
} from '../../../shared/schemas';
import {
  getCredentials,
  updatePlaidCredentials,
  updateCoinbaseCredentials,
} from '../services/credentials';
import type { PlaidCredentials } from '../services/credentials';
import { resetPlaidClient } from '../services/plaid';
import type { z } from 'zod';

const router = Router();

// GET /credentials
router.get('/credentials', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const creds = getCredentials();
    res.json({
      data: {
        plaid: !!creds.plaid,
        plaidEnvironment: creds.plaid?.environment ?? null,
        coinbase: !!creds.coinbase,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /credentials/plaid
router.post(
  '/credentials/plaid',
  validate(PlaidCredentialsSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      updatePlaidCredentials(req.body as PlaidCredentials);
      resetPlaidClient();
      console.log('[plaid] credentials updated, environment=%s', (req.body as PlaidCredentials).environment);
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

// POST /credentials/coinbase
router.post(
  '/credentials/coinbase',
  validate(CoinbaseCredentialsSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      updateCoinbaseCredentials(req.body as { keyName: string; privateKey: string });
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

// GET /export-csv
router.get('/export-csv', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const body = req.query as { startDate?: string; endDate?: string; accountIds?: string | string[] };
    const accountIds = body.accountIds
      ? Array.isArray(body.accountIds) ? body.accountIds : [body.accountIds]
      : undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (body.startDate) {
      conditions.push('t.date >= ?');
      params.push(body.startDate);
    }
    if (body.endDate) {
      conditions.push('t.date <= ?');
      params.push(body.endDate);
    }
    if (accountIds && accountIds.length > 0) {
      conditions.push(`t.account_id IN (${accountIds.map(() => '?').join(',')})`);
      params.push(...accountIds);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const transactions = db.prepare(`
      SELECT
        t.date,
        t.amount,
        t.merchant_name,
        t.original_name,
        t.notes,
        c.name AS category_name,
        a.account_name,
        a.institution_name
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      ${where}
      ORDER BY t.date DESC
    `).all(...params) as Array<Record<string, unknown>>;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mizan-transactions-${new Date().toISOString().split('T')[0]}.csv"`
    );

    const headers = ['date', 'amount', 'merchant_name', 'original_name', 'category_name', 'account_name', 'institution_name', 'notes'];
    res.write(headers.join(',') + '\n');

    for (const txn of transactions) {
      const row = headers.map(h => {
        const val = txn[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        // Escape CSV: wrap in quotes if contains comma, quote, or newline
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      });
      res.write(row.join(',') + '\n');
    }

    res.end();
  } catch (err) {
    next(err);
  }
});

// POST /import-csv
router.post('/import-csv', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const db = getDb();
    const body = req.body as {
      rows: Array<Record<string, string>>;
      mapping: z.infer<typeof CsvImportMappingSchema>;
    };

    const mappingResult = CsvImportMappingSchema.safeParse(body.mapping);
    if (!mappingResult.success) {
      res.status(400).json({ error: 'Invalid mapping', details: mappingResult.error.issues });
      return;
    }

    const mapping = mappingResult.data;
    const rows = body.rows || [];
    const now = new Date().toISOString();
    let imported = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        // Parse date
        let dateStr = row[mapping.date] || '';
        const dateFormat = mapping.dateFormat || 'yyyy-MM-dd';
        let parsedDate: Date;

        if (dateFormat === 'yyyy-MM-dd') {
          parsedDate = new Date(dateStr);
        } else {
          parsedDate = parse(dateStr, dateFormat, new Date());
        }

        if (!isValid(parsedDate)) {
          errors.push(`Row ${i + 1}: Invalid date "${dateStr}"`);
          continue;
        }

        dateStr = format(parsedDate, 'yyyy-MM-dd');

        // Parse amount
        let amount = parseFloat(row[mapping.amount] || '0');
        if (isNaN(amount)) {
          errors.push(`Row ${i + 1}: Invalid amount "${row[mapping.amount]}"`);
          continue;
        }
        if (mapping.amountNegate) {
          amount = -amount;
        }

        // Find account by name if provided
        let accountId: string | null = null;
        if (mapping.account && row[mapping.account]) {
          const acct = db.prepare(
            'SELECT id FROM accounts WHERE account_name = ? OR institution_name = ? LIMIT 1'
          ).get(row[mapping.account], row[mapping.account]) as { id: string } | undefined;
          accountId = acct?.id || null;
        }

        if (!accountId) {
          // Use first manual account or skip
          const fallback = db.prepare(
            "SELECT id FROM accounts WHERE is_manual = 1 LIMIT 1"
          ).get() as { id: string } | undefined;
          if (!fallback) {
            errors.push(`Row ${i + 1}: No account found`);
            continue;
          }
          accountId = fallback.id;
        }

        // Find category if provided
        let categoryId: string | null = null;
        if (mapping.category && row[mapping.category]) {
          const cat = db.prepare(
            'SELECT id FROM categories WHERE name = ? LIMIT 1'
          ).get(row[mapping.category]) as { id: string } | undefined;
          categoryId = cat?.id || null;
        }

        const merchantName = mapping.merchant ? (row[mapping.merchant] || null) : null;
        const originalName = merchantName || `Imported transaction`;
        const notes = mapping.notes ? (row[mapping.notes] || null) : null;

        db.prepare(`
          INSERT INTO transactions
            (id, account_id, date, amount, merchant_name, original_name,
             category_id, pending, notes, is_manual, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)
        `).run(
          uuidv4(),
          accountId,
          dateStr,
          amount,
          merchantName,
          originalName,
          categoryId,
          notes,
          now,
          now
        );

        imported++;
      } catch (rowErr) {
        errors.push(`Row ${i + 1}: ${(rowErr as Error).message}`);
      }
    }

    res.json({ data: { imported, errors } });
  } catch (err) {
    next(err);
  }
});

// DELETE /data — wipe all user data
router.delete(
  '/data',
  (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();

      // Delete all user data tables (in dependency order)
      db.exec(`
        DELETE FROM investment_transactions;
        DELETE FROM holdings;
        DELETE FROM securities;
        DELETE FROM merchant_rules;
        DELETE FROM recurring_patterns;
        DELETE FROM transactions;
        DELETE FROM budgets;
        DELETE FROM accounts;
        DELETE FROM net_worth_snapshots;
        DELETE FROM plaid_items;
        DELETE FROM coinbase_connections;
      `);

      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
