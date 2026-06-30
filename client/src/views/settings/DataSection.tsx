import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Edit2,
  X,
  Check,
  AlertTriangle,
  Download,
  Link2,
  Unlink,
  RefreshCw,
  Info,
  Wallet,
  Tag,
  Database,
  CheckCircle,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  settingsApi,
  plaidApi,
  coinbaseApi,
  categoriesApi,
  rulesApi,
  syncApi,
  flattenCategories,
} from '../../lib/api';
import { formatCurrency, formatRelativeTime } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { Modal } from '../../components/Modal';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import { PageLoader } from '../../components/LoadingSpinner';
import type {
  Category,
  CsvImportPreview,
  LocalBackupRestorePreview,
  MerchantRule,
  MerchantRuleSuggestion,
  SyncRun,
} from '@shared/types';

const CATEGORY_PRESET_COLORS = [
  '#32bfa3', '#6487f0', '#ef6f8a', '#e2a53f', '#9b8dee',
  '#ee8d5b', '#70c4e0', '#e070b8', '#70e07a', '#a0a0b8',
  '#c4a86e', '#6e8ec4',
];

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

const DEFAULT_CSV_MAPPING = {
  date: 'date',
  amount: 'amount',
  merchant: 'merchant_name',
  category: 'category_name',
  account: 'account_name',
  notes: 'notes',
  dateFormat: 'yyyy-MM-dd',
  amountNegate: false,
};

export function DataSection() {
  const { addToast } = useAppStore();
  const qc = useQueryClient();
  const [showDangerModal, setShowDangerModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [csvText, setCsvText] = useState('');
  const [csvMapping, setCsvMapping] = useState(DEFAULT_CSV_MAPPING);
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
        <h3 className="text-sm font-medium text-text mb-3">Data Management</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="border border-border bg-background rounded p-3 space-y-3 md:col-span-2">
            <div>
              <p className="text-sm text-text">CSV Import Preview</p>
              <p className="text-xs text-muted mt-1">Preview normalized rows, invalid rows, duplicate warnings, and manual-account balance impact before importing.</p>
            </div>

            <textarea
              className="w-full min-h-28 bg-surface border border-border rounded px-3 py-2 text-xs text-text font-mono resize-y focus:outline-none focus:ring-1 focus:ring-green-50"
              value={csvText}
              onChange={(event) => {
                setCsvText(event.target.value);
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
                  <span className="text-[11px] text-muted">{label}</span>
                  <input
                    className="w-full bg-surface border border-border rounded px-2 py-1.5 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
                    value={String(csvMapping[key as keyof typeof csvMapping] ?? '')}
                    onChange={(event) => {
                      setCsvMapping((mapping) => ({ ...mapping, [key]: event.target.value }));
                      setCsvPreview(null);
                    }}
                  />
                </label>
              ))}
              <label className="flex items-center gap-2 pt-5 text-xs text-muted">
                <input
                  type="checkbox"
                  className="accent-green"
                  checked={csvMapping.amountNegate}
                  onChange={(event) => {
                    setCsvMapping((mapping) => ({ ...mapping, amountNegate: event.target.checked }));
                    setCsvPreview(null);
                  }}
                />
                Flip amount signs
              </label>
            </div>

            {csvParseError && (
              <p className="text-xs text-rose">{csvParseError}</p>
            )}

            {csvPreview && (
              <div className="border border-border rounded p-3 bg-surface space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                  <div>
                    <p className="text-muted mb-0.5">Valid</p>
                    <p className="font-mono text-green">{csvPreview.valid_count}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Invalid</p>
                    <p className="font-mono text-rose">{csvPreview.invalid_count}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Duplicates</p>
                    <p className="font-mono text-amber">{csvPreview.duplicate_candidate_count}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Balance impact</p>
                    <p className="font-mono text-text">{formatCurrency(csvPreview.balance_delta, { showSign: true })}</p>
                  </div>
                  <div>
                    <p className="text-muted mb-0.5">Warnings</p>
                    <p className="font-mono text-blue">{csvPreview.warnings.length}</p>
                  </div>
                </div>

                {(csvPreview.errors.length > 0 || csvPreview.warnings.length > 0) && (
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {[...csvPreview.errors, ...csvPreview.warnings].slice(0, 8).map((issue) => (
                      <p key={`${issue.row_number}:${issue.message}`} className={`text-xs ${issue.severity === 'error' ? 'text-rose' : 'text-muted'}`}>
                        Row {issue.row_number}: {issue.message}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text disabled:opacity-40"
                onClick={() => previewCsvMutation.mutate()}
                disabled={previewCsvMutation.isPending || csvText.trim().length === 0}
              >
                Preview Import
              </button>
              <button
                className="flex items-center gap-2 px-4 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90 disabled:opacity-40"
                onClick={() => importCsvMutation.mutate()}
                disabled={importCsvMutation.isPending || !csvPreview || csvPreview.valid_count === 0}
              >
                Import Valid Rows
              </button>
            </div>
          </div>

          <div className="border border-border bg-background rounded p-3 space-y-3">
            <div>
              <p className="text-sm text-text">Transactions CSV</p>
              <p className="text-xs text-muted mt-1">Download transactions for spreadsheets, external analysis, or a Monarch-friendly import file.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
                onClick={handleCsvExport}
              >
                <Download size={14} /> Export CSV
              </button>
              <button
                className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
                onClick={handleMonarchCsvExport}
              >
                <Download size={14} /> Export Monarch CSV
              </button>
            </div>
          </div>

          <div className="border border-border bg-background rounded p-3 space-y-3 md:col-span-2">
            <div>
              <p className="text-sm text-text">Full Local Backup</p>
              <p className="text-xs text-muted mt-1">
                Download or restore accounts, transactions, categories, budgets, goals, investments, snapshots, and sync history. Provider credentials are not included.
              </p>
            </div>
            <button
              className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
              onClick={handleBackupExport}
            >
              <Download size={14} /> Export Backup
            </button>

            <div className="border-t border-border pt-3 space-y-3">
              <div>
                <p className="text-sm text-text">Restore Backup</p>
                <p className="text-xs text-muted mt-1">
                  Preview first. Restore replaces local data tables, keeps encrypted credentials, and preserves the current migration state.
                </p>
              </div>

              <textarea
                className="w-full min-h-28 bg-surface border border-border rounded px-3 py-2 text-xs text-text font-mono resize-y focus:outline-none focus:ring-1 focus:ring-green-50"
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
                <p className="text-xs text-rose">{backupParseError}</p>
              )}

              {backupPreview && (
                <div className="border border-border rounded p-3 bg-surface space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                    <div>
                      <p className="text-muted mb-0.5">Status</p>
                      <p className={backupPreview.valid ? 'font-mono text-green' : 'font-mono text-rose'}>
                        {backupPreview.valid ? 'Ready' : 'Blocked'}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Exported</p>
                      <p className="font-mono text-text">
                        {backupPreview.exported_at ? formatRelativeTime(backupPreview.exported_at) : '-'}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Rows</p>
                      <p className="font-mono text-text">{backupPreview.restorable_rows}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Tables</p>
                      <p className="font-mono text-text">
                        {backupPreview.restorable_table_count}/{backupPreview.table_count}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Issues</p>
                      <p className="font-mono text-text">
                        {backupPreview.errors.length + backupPreview.warnings.length}
                      </p>
                    </div>
                  </div>

                  {(backupPreview.errors.length > 0 || backupPreview.warnings.length > 0) && (
                    <div className="max-h-28 overflow-y-auto space-y-1">
                      {[...backupPreview.errors, ...backupPreview.warnings].slice(0, 8).map((issue, index) => (
                        <p
                          key={`${index}:${issue}`}
                          className={`text-xs ${backupPreview.errors.includes(issue) ? 'text-rose' : 'text-muted'}`}
                        >
                          {issue}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="max-h-36 overflow-y-auto divide-y divide-border rounded border border-border">
                    {backupPreview.tables
                      .filter((table) => table.restorable || table.backup_rows > 0)
                      .slice(0, 12)
                      .map((table) => (
                        <div key={table.table} className="grid grid-cols-[1fr_auto_auto] gap-3 px-2 py-1.5 text-xs">
                          <span className="text-text truncate">{table.table}</span>
                          <span className="font-mono text-muted">{table.backup_rows} backup</span>
                          <span className="font-mono text-muted">{table.current_rows} current</span>
                        </div>
                      ))}
                  </div>

                  {backupPreview.valid && (
                    <label className="block space-y-1">
                      <span className="text-xs text-muted">
                        Type <span className="font-mono text-rose">restore</span> to replace local data tables
                      </span>
                      <input
                        className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-rose/50"
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
                  className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text disabled:opacity-40"
                  onClick={() => previewBackupMutation.mutate()}
                  disabled={previewBackupMutation.isPending || backupText.trim().length === 0}
                >
                  Preview Backup
                </button>
                <button
                  className="flex items-center gap-2 px-4 py-2 text-sm border border-rose/40 text-rose rounded hover:bg-rose/10 disabled:opacity-40"
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

      <SyncActivityPanel runs={syncRuns} showDetail />

      <div className="border border-rose/30 rounded p-4 space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={14} className="text-rose" />
          <h3 className="text-sm font-medium text-rose">Danger Zone</h3>
        </div>
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div>
            <p className="text-sm text-text">Clear All Data</p>
            <p className="text-xs text-muted">Permanently delete accounts, transactions, budgets, goals, rules, snapshots, and sync history. Encrypted credentials stay on disk.</p>
          </div>
          <button
            className="px-3 py-1.5 text-xs border border-rose/40 text-rose rounded hover:bg-rose/10"
            onClick={() => setShowDangerModal(true)}
          >
            Delete All Data
          </button>
        </div>
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm text-text">Disconnect All Plaid Items</p>
            <p className="text-xs text-muted">Remove all connected bank accounts.</p>
          </div>
          <button
            className="px-3 py-1.5 text-xs border border-rose/40 text-rose rounded hover:bg-rose/10"
            onClick={async () => {
              try {
                const items = await plaidApi.listItems();
                await Promise.all(items.map((i) => plaidApi.deleteItem(i.id)));
                invalidateFinancialData(qc);
                addToast({ type: 'success', message: 'All Plaid items disconnected' });
              } catch (err: unknown) {
                addToast({ type: 'error', message: err instanceof Error ? err.message : 'Disconnect failed' });
              }
            }}
          >
            Disconnect All
          </button>
        </div>
      </div>

      <Modal
        open={showDangerModal}
        onClose={() => setShowDangerModal(false)}
        title="Delete All Data"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 bg-rose/10 border border-rose/30 rounded">
            <AlertTriangle size={14} className="text-rose mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted">
              This permanently deletes local finance data from the database. Encrypted provider credentials are not deleted, so disconnect providers separately if needed.
            </p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">
              Type <span className="font-mono text-rose">delete</span> to confirm
            </label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-rose/50"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="delete"
            />
          </div>
          <div className="flex gap-3">
            <button
              className="flex-1 py-2 text-sm bg-rose text-white font-medium rounded hover:opacity-90 disabled:opacity-40"
              disabled={deleteConfirm !== 'delete' || deleteAllMutation.isPending}
              onClick={() => deleteAllMutation.mutate()}
            >
              {deleteAllMutation.isPending ? 'Deleting...' : 'Delete Everything'}
            </button>
            <button
              className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
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
