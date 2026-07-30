import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Download, Database, Sparkles } from 'lucide-react';
import { settingsApi, syncApi } from '../../lib/api';
import { formatCurrency, formatRelativeTime } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { advisorRouteState } from '../../lib/advisorRouteState';
import { buildImportRunAdvisorPrompt } from '../../lib/advisorPrompts';
import {
  detectCsvImportMapping,
  MIZAN_CSV_MAPPING,
  MONARCH_CSV_MAPPING,
} from '../../lib/csvImportMapping';
import { Modal } from '../../components/Modal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import type {
  CsvImportPreview,
  DataImportRun,
  LocalBackupRestorePreview,
  SyncRun,
} from '@shared/types';

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseCsvText(text: string): { rows: Array<Record<string, string>>; headers: string[]; error?: string } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], headers: [], error: 'Paste a header row and at least one transaction row.' };
  }

  const headers = parseCsvLine(lines[0]);
  if (headers.length === 0 || headers.some((header) => header.length === 0)) {
    return { rows: [], headers: [], error: 'CSV headers cannot be blank.' };
  }

  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });

  return { rows, headers };
}

function parseBackupJsonText(text: string): unknown {
  if (text.trim().length === 0) {
    throw new Error('Paste a Mizan backup JSON file first.');
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new Error('Backup JSON is not valid JSON.');
  }
}

function parseCsvHeaders(text: string): string[] {
  const headerLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  return headerLine ? parseCsvLine(headerLine) : [];
}

function importRunStatusClass(status: DataImportRun['status']): string {
  if (status === 'succeeded') return 'text-sage-deep';
  if (status === 'partial') return 'text-gold';
  return 'text-clay';
}

function importRunSourceLabel(source: DataImportRun['source']): string {
  return source === 'csv' ? 'CSV import' : 'Backup restore';
}

export function DataSection() {
  const { addToast } = useAppStore();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showDangerModal, setShowDangerModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [csvText, setCsvText] = useState('');
  const [csvMapping, setCsvMapping] = useState(MIZAN_CSV_MAPPING);
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null);
  const [csvParseError, setCsvParseError] = useState<string | null>(null);
  const [backupText, setBackupText] = useState('');
  const [backupPreview, setBackupPreview] = useState<LocalBackupRestorePreview | null>(null);
  const [backupParseError, setBackupParseError] = useState<string | null>(null);
  const [backupConfirm, setBackupConfirm] = useState('');

  const { data: syncRuns } = useQuery<SyncRun[]>({
    queryKey: ['sync', 'history', 'settings'],
    queryFn: () => syncApi.history(10),
  });

  const { data: importRuns = [] } = useQuery<DataImportRun[]>({
    queryKey: ['settings', 'import-runs'],
    queryFn: () => settingsApi.importRuns(10),
  });

  const deleteAllMutation = useMutation({
    mutationFn: settingsApi.deleteAllData,
    onSuccess: () => {
      addToast({ type: 'success', message: 'All data deleted' });
      qc.invalidateQueries();
      setShowDangerModal(false);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const previewCsvMutation = useMutation({
    mutationFn: () => {
      const parsed = parseCsvText(csvText);
      if (parsed.error) {
        setCsvParseError(parsed.error);
        throw new Error(parsed.error);
      }
      setCsvParseError(null);
      return settingsApi.previewCsvImport({ rows: parsed.rows, mapping: csvMapping });
    },
    onSuccess: (preview) => {
      setCsvPreview(preview);
      addToast({ type: 'success', message: 'CSV preview ready' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const importCsvMutation = useMutation({
    mutationFn: () => {
      const parsed = parseCsvText(csvText);
      if (parsed.error) {
        setCsvParseError(parsed.error);
        throw new Error(parsed.error);
      }
      setCsvParseError(null);
      return settingsApi.importCsv({ rows: parsed.rows, mapping: csvMapping });
    },
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      void qc.invalidateQueries({ queryKey: ['settings', 'import-runs'] });
      setCsvPreview(null);
      addToast({
        type: result.errors.length > 0 ? 'info' : 'success',
        message: `Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'}`,
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const previewBackupMutation = useMutation({
    mutationFn: () => {
      const backup = parseBackupJsonText(backupText);
      setBackupParseError(null);
      return settingsApi.previewBackupRestore({ backup });
    },
    onSuccess: (preview) => {
      setBackupPreview(preview);
      addToast({
        type: preview.valid ? 'success' : 'error',
        message: preview.valid ? 'Backup preview ready' : 'Backup preview has errors',
      });
    },
    onError: (err: Error) => {
      setBackupParseError(err.message);
      addToast({ type: 'error', message: err.message });
    },
  });

  const restoreBackupMutation = useMutation({
    mutationFn: () => {
      if (backupConfirm !== 'restore') {
        throw new Error('Type restore to confirm backup restore.');
      }
      const backup = parseBackupJsonText(backupText);
      setBackupParseError(null);
      return settingsApi.restoreBackup({ backup, confirm: 'restore' });
    },
    onSuccess: (result) => {
      qc.invalidateQueries();
      void qc.invalidateQueries({ queryKey: ['settings', 'import-runs'] });
      setBackupPreview(null);
      setBackupConfirm('');
      addToast({
        type: result.warnings.length > 0 ? 'info' : 'success',
        message: `Restored ${result.restored_rows} row${result.restored_rows === 1 ? '' : 's'} from backup`,
      });
    },
    onError: (err: Error) => {
      setBackupParseError(err.message);
      addToast({ type: 'error', message: err.message });
    },
  });

  const handleCsvExport = async () => {
    try {
      await settingsApi.exportCsv();
      addToast({ type: 'success', message: 'CSV export complete' });
    } catch (err: unknown) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Export failed' });
    }
  };

  const handleMonarchCsvExport = async () => {
    try {
      await settingsApi.exportCsv('monarch');
      addToast({ type: 'success', message: 'Monarch CSV export complete' });
    } catch (err: unknown) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Export failed' });
    }
  };

  const handleBackupExport = async () => {
    try {
      await settingsApi.exportBackupJson();
      addToast({ type: 'success', message: 'Backup export complete' });
    } catch (err: unknown) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Backup export failed' });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-body-lg font-medium text-ink mb-3">Data Management</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-line-2 bg-card shadow-e1-alt p-4 space-y-3 md:col-span-2">
            <div>
              <p className="text-body-lg text-ink">CSV Import Preview</p>
              <p className="text-note text-muted mt-1">Preview normalized rows, invalid rows, duplicate and transfer warnings, and manual-account balance impact before importing.</p>
            </div>

            <textarea
              className="mz-field min-h-28 resize-y font-mono !text-note"
              value={csvText}
              onChange={(event) => {
                const nextText = event.target.value;
                const headers = parseCsvHeaders(nextText);
                setCsvText(nextText);
                if (headers.length > 0) {
                  setCsvMapping(detectCsvImportMapping(headers));
                }
                setCsvPreview(null);
                setCsvParseError(null);
              }}
              placeholder="date,amount,merchant_name,category_name,account_name,notes"
            />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                ['date', 'Date column'],
                ['amount', 'Amount column'],
                ['merchant', 'Merchant column'],
                ['category', 'Category column'],
                ['account', 'Account column'],
                ['notes', 'Notes column'],
                ['dateFormat', 'Date format'],
              ].map(([key, label]) => (
                <label key={key} className="space-y-1">
                  <span className="text-micro text-muted">{label}</span>
                  <input
                    className="mz-field !px-2 !py-1.5 font-mono !text-note"
                    value={String(csvMapping[key as keyof typeof csvMapping] ?? '')}
                    onChange={(event) => {
                      setCsvMapping((mapping) => ({ ...mapping, [key]: event.target.value }));
                      setCsvPreview(null);
                    }}
                  />
                </label>
              ))}
              <label className="flex items-center gap-2 pt-5 text-note text-muted">
                <input
                  type="checkbox"
                  className="accent-sage"
                  checked={csvMapping.amountNegate}
                  onChange={(event) => {
                    setCsvMapping((mapping) => ({ ...mapping, amountNegate: event.target.checked }));
                    setCsvPreview(null);
                  }}
                />
                Flip amount signs
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-pill-border bg-pill-bg px-3 py-1.5 text-note text-muted transition-colors hover:text-ink"
                onClick={() => {
                  setCsvMapping(MIZAN_CSV_MAPPING);
                  setCsvPreview(null);
                }}
              >
                Mizan preset
              </button>
              <button
                className="rounded-md border border-pill-border bg-pill-bg px-3 py-1.5 text-note text-muted transition-colors hover:text-ink"
                onClick={() => {
                  setCsvMapping(MONARCH_CSV_MAPPING);
                  setCsvPreview(null);
                }}
              >
                Monarch preset
              </button>
              <button
                className="rounded-md border border-pill-border bg-pill-bg px-3 py-1.5 text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
                onClick={() => {
                  setCsvMapping(detectCsvImportMapping(parseCsvHeaders(csvText)));
                  setCsvPreview(null);
                }}
                disabled={csvText.trim().length === 0}
              >
                Auto detect
              </button>
            </div>

            {csvParseError && (
              <p className="text-note text-clay">{csvParseError}</p>
            )}

            {csvPreview && (
              <div className="rounded-lg border border-line-2 bg-rail p-3 space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-note">
                  <div>
                    <p className="text-muted mb-0.5">Valid</p>
                    <p className="font-mono text-sage-deep">{csvPreview.valid_count}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Invalid</p>
                    <p className="font-mono text-clay">{csvPreview.invalid_count}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Duplicates</p>
                    <p className="font-mono text-gold">{csvPreview.duplicate_candidate_count}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Transfers</p>
                    <p className="font-mono text-muted">{csvPreview.transfer_candidate_count}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Balance impact</p>
                    <p className="font-mono text-ink">{formatCurrency(csvPreview.balance_delta, { showSign: true })}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Warnings</p>
                    <p className="font-mono text-muted">{csvPreview.warnings.length}</p>
                  </div>
                </div>

                {(csvPreview.errors.length > 0 || csvPreview.warnings.length > 0) && (
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {[...csvPreview.errors, ...csvPreview.warnings].slice(0, 8).map((issue) => (
                      <p key={`${issue.row_number}:${issue.message}`} className={`text-note ${issue.severity === 'error' ? 'text-clay' : 'text-muted'}`}>
                        Row {issue.row_number}: {issue.message}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                className="flex items-center gap-2 rounded-lg border border-pill-border bg-pill-bg px-4 py-2 text-body-lg text-muted transition-colors hover:text-ink disabled:opacity-40"
                onClick={() => previewCsvMutation.mutate()}
                disabled={previewCsvMutation.isPending || csvText.trim().length === 0}
              >
                Preview Import
              </button>
              <button
                className="flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-body-lg font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
                onClick={() => importCsvMutation.mutate()}
                disabled={importCsvMutation.isPending || !csvPreview || csvPreview.valid_count === 0}
              >
                Import Valid Rows
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-line-2 bg-card shadow-e1-alt p-4 space-y-3">
            <div>
              <p className="text-body-lg text-ink">Transactions CSV</p>
              <p className="text-note text-muted mt-1">Download transactions for spreadsheets, external analysis, or a Monarch-friendly import file.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="flex items-center gap-2 rounded-lg border border-pill-border bg-pill-bg px-4 py-2 text-body-lg text-muted transition-colors hover:text-ink"
                onClick={handleCsvExport}
              >
                <Download size={14} /> Export CSV
              </button>
              <button
                className="flex items-center gap-2 rounded-lg border border-pill-border bg-pill-bg px-4 py-2 text-body-lg text-muted transition-colors hover:text-ink"
                onClick={handleMonarchCsvExport}
              >
                <Download size={14} /> Export Monarch CSV
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-line-2 bg-card shadow-e1-alt p-4 space-y-3 md:col-span-2">
            <div>
              <p className="text-body-lg text-ink">Full Local Backup</p>
              <p className="text-note text-muted mt-1">
                Download or restore accounts, transactions, categories, budgets, goals, investments, snapshots, and sync history. Provider credentials are not included.
              </p>
            </div>
            <button
              className="flex items-center gap-2 rounded-lg border border-pill-border bg-pill-bg px-4 py-2 text-body-lg text-muted transition-colors hover:text-ink"
              onClick={handleBackupExport}
            >
              <Download size={14} /> Export Backup
            </button>

            <div className="border-t border-line-2 pt-3 space-y-3">
              <div>
                <p className="text-body-lg text-ink">Restore Backup</p>
                <p className="text-note text-muted mt-1">
                  Preview first. Restore replaces local data tables, keeps encrypted credentials, and preserves the current migration state.
                </p>
              </div>

              <textarea
                className="mz-field min-h-28 resize-y font-mono !text-note"
                value={backupText}
                onChange={(event) => {
                  setBackupText(event.target.value);
                  setBackupPreview(null);
                  setBackupParseError(null);
                  setBackupConfirm('');
                }}
                placeholder='{"app":"mizan","version":1,"exported_at":"...","tables":{...}}'
              />

              {backupParseError && (
                <p className="text-note text-clay">{backupParseError}</p>
              )}

              {backupPreview && (
                <div className="rounded-lg border border-line-2 bg-rail p-3 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-note">
                    <div>
                      <p className="text-muted mb-0.5">Status</p>
                      <p className={backupPreview.valid ? 'font-mono text-sage-deep' : 'font-mono text-clay'}>
                        {backupPreview.valid ? 'Ready' : 'Blocked'}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Exported</p>
                      <p className="font-mono text-ink">
                        {backupPreview.exported_at ? formatRelativeTime(backupPreview.exported_at) : '-'}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Rows</p>
                      <p className="font-mono text-ink">{backupPreview.restorable_rows}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Tables</p>
                      <p className="font-mono text-ink">
                        {backupPreview.restorable_table_count}/{backupPreview.table_count}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Issues</p>
                      <p className="font-mono text-ink">
                        {backupPreview.errors.length + backupPreview.warnings.length}
                      </p>
                    </div>
                  </div>

                  {(backupPreview.errors.length > 0 || backupPreview.warnings.length > 0) && (
                    <div className="max-h-28 overflow-y-auto space-y-1">
                      {[...backupPreview.errors, ...backupPreview.warnings].slice(0, 8).map((issue, index) => (
                        <p
                          key={`${index}:${issue}`}
                          className={`text-note ${backupPreview.errors.includes(issue) ? 'text-clay' : 'text-muted'}`}
                        >
                          {issue}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="max-h-36 overflow-y-auto divide-y divide-line rounded-lg border border-line-2">
                    {backupPreview.tables
                      .filter((table) => table.restorable || table.backup_rows > 0)
                      .slice(0, 12)
                      .map((table) => (
                        <div key={table.table} className="grid grid-cols-[1fr_auto_auto] gap-3 px-2 py-1.5 text-note">
                          <span className="text-ink truncate">{table.table}</span>
                          <span className="font-mono text-muted">{table.backup_rows} backup</span>
                          <span className="font-mono text-muted">{table.current_rows} current</span>
                        </div>
                      ))}
                  </div>

                  {backupPreview.valid && (
                    <label className="block space-y-1">
                      <span className="text-note text-muted">
                        Type <span className="font-mono text-clay">restore</span> to replace local data tables
                      </span>
                      <input
                        className="mz-field font-mono !text-body"
                        value={backupConfirm}
                        onChange={(event) => setBackupConfirm(event.target.value)}
                        placeholder="restore"
                      />
                    </label>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  className="flex items-center gap-2 rounded-lg border border-pill-border bg-pill-bg px-4 py-2 text-body-lg text-muted transition-colors hover:text-ink disabled:opacity-40"
                  onClick={() => previewBackupMutation.mutate()}
                  disabled={previewBackupMutation.isPending || backupText.trim().length === 0}
                >
                  Preview Backup
                </button>
                <button
                  className="flex items-center gap-2 rounded-lg border border-pill-border px-4 py-2 text-body-lg text-clay transition-colors hover:bg-well disabled:opacity-40"
                  onClick={() => restoreBackupMutation.mutate()}
                  disabled={
                    restoreBackupMutation.isPending ||
                    !backupPreview?.valid ||
                    backupConfirm !== 'restore'
                  }
                >
                  Restore Backup
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line-2 bg-card shadow-e1-alt p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-body-lg text-ink">Import Audit</p>
            <p className="text-note text-muted mt-1">Recent CSV imports and backup restores recorded locally.</p>
          </div>
          <Database size={16} className="text-muted" />
        </div>

        {importRuns.length === 0 ? (
          <p className="text-note text-muted">No import or restore runs recorded yet.</p>
        ) : (
          <div className="divide-y divide-line rounded-lg border border-line-2 bg-rail">
            {importRuns.map((run) => (
              <div key={run.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 text-note items-center">
                <div className="min-w-0">
                  <p className="text-ink truncate">{importRunSourceLabel(run.source)}</p>
                  <p className="text-muted truncate">{run.summary}</p>
                </div>
                <div className="text-right font-mono text-muted">
                  <p>{run.rows_imported}/{run.rows_seen}</p>
                  <p>{formatRelativeTime(run.created_at)}</p>
                </div>
                <div className="text-right">
                  <p className={`font-mono ${importRunStatusClass(run.status)}`}>{run.status}</p>
                  <p className="font-mono text-muted">
                    {run.warnings_count}w {run.errors_count}e
                  </p>
                </div>
                <button
                  className="text-muted hover:text-ink transition-colors"
                  onClick={() => navigate('/advisor', {
                    state: advisorRouteState(buildImportRunAdvisorPrompt(run)),
                  })}
                  title="Ask advisor"
                >
                  <Sparkles size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <SyncActivityPanel runs={syncRuns} showDetail />

      <div className="rounded-xl border border-line-2 p-4 space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={14} className="text-clay" />
          <h3 className="text-body-lg font-medium text-clay">Danger Zone</h3>
        </div>
        <div className="flex items-center justify-between py-2 border-b border-line">
          <div>
            <p className="text-body-lg text-ink">Clear All Data</p>
            <p className="text-note text-muted">Permanently delete accounts, transactions, budgets, goals, rules, snapshots, and sync history. Encrypted credentials stay on disk.</p>
          </div>
          <button
            className="rounded-md border border-pill-border px-3 py-1.5 text-note text-clay transition-colors hover:bg-well"
            onClick={() => setShowDangerModal(true)}
          >
            Delete All Data
          </button>
        </div>

      </div>

      <Modal
        open={showDangerModal}
        onClose={() => setShowDangerModal(false)}
        title="Delete All Data"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-pill-border bg-rail p-3">
            <AlertTriangle size={14} className="text-clay mt-0.5 flex-shrink-0" />
            <p className="text-note text-muted">
              This permanently deletes local finance data from the database. Encrypted provider credentials are not deleted, so disconnect providers separately if needed.
            </p>
          </div>
          <div>
            <label className="mz-label">
              Type <span className="font-mono text-clay">delete</span> to confirm
            </label>
            <input
              className="mz-field font-mono !text-body"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="delete"
            />
          </div>
          <div className="flex gap-3">
            <button
              className="flex-1 rounded-lg bg-clay py-2 text-body-lg font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={deleteConfirm !== 'delete' || deleteAllMutation.isPending}
              onClick={() => deleteAllMutation.mutate()}
            >
              {deleteAllMutation.isPending ? 'Deleting...' : 'Delete Everything'}
            </button>
            <button
              className="rounded-lg border border-pill-border px-4 py-2 text-body-lg text-muted transition-colors hover:text-ink"
              onClick={() => setShowDangerModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── About Section ────────────────────────────────────────────────────────────
