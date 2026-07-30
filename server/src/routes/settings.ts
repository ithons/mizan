import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index';
import { validate } from '../middleware/validate';
import {
  CoinbaseCredentialsSchema,
  CsvImportMappingSchema,
  DeleteDataSchema,
  BackupRestorePreviewSchema,
  BackupRestoreSchema,
  SetPreferenceSchema,
} from '../../../shared/schemas';
import {
  getCredentials,
  getEnvCredentials,
  updateCoinbaseCredentials,
} from '../services/credentials';
import { takeSnapshot } from '../services/snapshot';
import { detectRecurring } from '../services/recurring';
import { refreshTransactionIntegrity } from '../services/transactionIntegrity';
import {
  buildLocalBackup,
  buildLocalBackupRestorePreview,
  restoreLocalBackup,
  LocalBackupValidationError,
  LOCAL_RESTORE_TABLES,
  type LocalRestoreTableName,
} from '../services/localBackup';
import { buildCsvImportPreview, commitCsvImport } from '../services/csvImport';
import { listDataImportRuns, recordDataImportRun } from '../services/importRuns';
import { getPreference, setPreference } from '../services/preferences';
import {
  buildTransactionsCsv,
  transactionCsvFilename,
  type TransactionCsvFormat,
} from '../services/csvExport';
import type { z } from 'zod';

const router = Router();

/**
 * Tables a factory reset keeps. Only the category taxonomy: it is seeded by migrations, so
 * deleting it leaves an install with nowhere to file a transaction and no way back short of
 * rebuilding the database.
 */
const FACTORY_RESET_PRESERVED: ReadonlySet<LocalRestoreTableName> = new Set(['categories']);

function routeParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// GET /credentials
router.get('/credentials', (_req: Request, res: Response, next: NextFunction): void => {
  try {
    const creds = getCredentials();
    const envCreds = getEnvCredentials();
    res.json({
      data: {
        coinbase: !!creds.coinbase,
        coinbaseFromEnv: !!envCreds.coinbase,
        simplefin: !!creds.simplefin?.setupToken || !!creds.simplefin?.accessUrl,
      },
    });
  } catch (err) {
    next(err);
  }
});



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
    const body = req.query as {
      startDate?: string;
      endDate?: string;
      accountIds?: string | string[];
      format?: string;
    };
    const accountIds = body.accountIds
      ? Array.isArray(body.accountIds) ? body.accountIds : [body.accountIds]
      : undefined;
    const format: TransactionCsvFormat = body.format === 'monarch' ? 'monarch' : 'mizan';
    const exportedAt = new Date();
    const csv = buildTransactionsCsv(db, {
      startDate: body.startDate,
      endDate: body.endDate,
      accountIds,
      format,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${transactionCsvFilename(format, exportedAt)}"`
    );
    res.send(csv);
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

router.get('/preferences/:key', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const key = routeParam(req.params.key);
    if (!key) {
      res.status(400).json({ error: 'Invalid preference key' });
      return;
    }

    res.json({ data: getPreference(getDb(), key) });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/preferences/:key',
  validate(SetPreferenceSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const key = routeParam(req.params.key);
      if (!key) {
        res.status(400).json({ error: 'Invalid preference key' });
        return;
      }

      res.json({ data: setPreference(getDb(), key, req.body.value) });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/import-runs', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
    res.json({ data: listDataImportRuns(getDb(), Number.isFinite(limit) ? limit : 20) });
  } catch (err) {
    next(err);
  }
});

// POST /backup-json/preview
router.post(
  '/backup-json/preview',
  validate(BackupRestorePreviewSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json({ data: buildLocalBackupRestorePreview(getDb(), req.body.backup) });
    } catch (err) {
      next(err);
    }
  }
);

// POST /backup-json/restore
router.post(
  '/backup-json/restore',
  validate(BackupRestoreSchema),
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getDb();
      const result = restoreLocalBackup(db, req.body.backup);
      recordDataImportRun(db, {
        source: 'backup_restore',
        status: result.warnings.length > 0 ? 'partial' : 'succeeded',
        rows_seen: result.restored_rows,
        rows_imported: result.restored_rows,
        warnings_count: result.warnings.length,
        errors_count: 0,
        summary: `Restored ${result.restored_rows} row${result.restored_rows === 1 ? '' : 's'} from local backup.`,
      });
      res.json({ data: result });
    } catch (err) {
      if (err instanceof LocalBackupValidationError) {
        res.status(400).json({ error: err.message, details: err.errors });
        return;
      }
      next(err);
    }
  }
);

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
    const preview = buildCsvImportPreview(db, { rows, mapping });
    const result = commitCsvImport(db, { rows, mapping });

    if (result.balanceChanged) {
      takeSnapshot();
    }
    if (result.imported > 0) {
      detectRecurring();
      refreshTransactionIntegrity(db);
    }

    recordDataImportRun(db, {
      source: 'csv',
      status: result.imported === 0 && result.errors.length > 0
        ? 'failed'
        : result.errors.length > 0 || preview.invalid_count > 0
          ? 'partial'
          : 'succeeded',
      rows_seen: rows.length,
      rows_imported: result.imported,
      rows_invalid: preview.invalid_count,
      duplicate_candidates: preview.duplicate_candidate_count,
      transfer_candidates: preview.transfer_candidate_count,
      warnings_count: preview.warnings.length,
      errors_count: result.errors.length,
      summary: `Imported ${result.imported} of ${rows.length} CSV row${rows.length === 1 ? '' : 's'}.`,
    });

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

      // Full factory reset: clear every user-data table, the AI history/audit tables, and
      // app_preferences (the AI profile + settings). Driven off LOCAL_RESTORE_TABLES rather
      // than a hand-written list, because a hand-written list is exactly how the backup set
      // silently fell nine tables behind the schema. Reversed, that list is children before
      // parents, which is what the live connection's `foreign_keys = ON` requires.
      for (const table of [...LOCAL_RESTORE_TABLES].reverse()) {
        if (FACTORY_RESET_PRESERVED.has(table)) continue;
        db.prepare(`DELETE FROM "${table}"`).run();
      }

      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
