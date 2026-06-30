import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  PlaidCredentialsSchema,
  CoinbaseCredentialsSchema,
  CsvImportMappingSchema,
  DeleteDataSchema,
} from '../../../shared/schemas';
import {
  getCredentials,
  getEnvCredentials,
  updatePlaidCredentials,
  updateCoinbaseCredentials,
} from '../services/credentials';
import type { PlaidCredentials } from '../services/credentials';
import { resetPlaidClient } from '../services/plaid';
import { takeSnapshot } from '../services/snapshot';
import { detectRecurring } from '../services/recurring';
import { refreshTransactionIntegrity } from '../services/transactionIntegrity';
import { buildLocalBackup } from '../services/localBackup';
import { buildCsvImportPreview, commitCsvImport } from '../services/csvImport';
import type { z } from 'zod';

const router = Router();

// GET /credentials
router.get('/credentials', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const creds = getCredentials();
    const envCreds = getEnvCredentials();
    res.json({
      data: {
        plaid: !!creds.plaid,
        plaidEnvironment: creds.plaid?.environment ?? null,
        plaidFromEnv: !!envCreds.plaid,
        coinbase: !!creds.coinbase,
        coinbaseFromEnv: !!envCreds.coinbase,
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

// GET /backup-json
router.get('/backup-json', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const exportedAt = new Date();
    const backup = buildLocalBackup(getDb(), exportedAt);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mizan-backup-${exportedAt.toISOString().split('T')[0]}.json"`
    );
    res.json(backup);
  } catch (err) {
    next(err);
  }
});

// POST /import-csv/preview
router.post('/import-csv/preview', (req: Request, res: Response, next: NextFunction): void => {
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

    res.json({
      data: buildCsvImportPreview(db, {
        rows: body.rows || [],
        mapping: mappingResult.data,
      }),
    });
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
    const result = commitCsvImport(db, { rows, mapping });

    if (result.balanceChanged) {
      takeSnapshot();
    }
    if (result.imported > 0) {
      detectRecurring();
      refreshTransactionIntegrity(db);
    }

    res.json({ data: { imported: result.imported, errors: result.errors } });
  } catch (err) {
    next(err);
  }
});

// DELETE /data - wipe all user data
router.delete(
  '/data',
  validate(DeleteDataSchema),
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
        DELETE FROM goals;
        DELETE FROM transactions;
        DELETE FROM budgets;
        DELETE FROM accounts;
        DELETE FROM net_worth_snapshots;
        DELETE FROM plaid_items;
        DELETE FROM coinbase_connections;
        DELETE FROM sync_changes;
        DELETE FROM sync_run_items;
        DELETE FROM sync_runs;
      `);

      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
