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
import { formatRelativeTime } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { Modal } from '../../components/Modal';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import { PageLoader } from '../../components/LoadingSpinner';
import type { Category, MerchantRule, MerchantRuleSuggestion, SyncRun } from '@shared/types';

const CATEGORY_PRESET_COLORS = [
  '#32bfa3', '#6487f0', '#ef6f8a', '#e2a53f', '#9b8dee',
  '#ee8d5b', '#70c4e0', '#e070b8', '#70e07a', '#a0a0b8',
  '#c4a86e', '#6e8ec4',
];

export function DataSection() {
  const { addToast } = useAppStore();
  const qc = useQueryClient();
  const [showDangerModal, setShowDangerModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

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

  const handleCsvExport = async () => {
    try {
      await settingsApi.exportCsv();
      addToast({ type: 'success', message: 'CSV export complete' });
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
          <div className="border border-border bg-background rounded p-3 space-y-3">
            <div>
              <p className="text-sm text-text">Transactions CSV</p>
              <p className="text-xs text-muted mt-1">Download transactions for spreadsheets and external analysis.</p>
            </div>
            <button
              className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
              onClick={handleCsvExport}
            >
              <Download size={14} /> Export CSV
            </button>
          </div>

          <div className="border border-border bg-background rounded p-3 space-y-3">
            <div>
              <p className="text-sm text-text">Full Local Backup</p>
              <p className="text-xs text-muted mt-1">
                Download accounts, transactions, categories, budgets, goals, investments, snapshots, and sync history. Provider credentials are not included.
              </p>
            </div>
            <button
              className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
              onClick={handleBackupExport}
            >
              <Download size={14} /> Export Backup
            </button>
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
