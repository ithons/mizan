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

export function CoinbaseSection() {
  const { addToast } = useAppStore();
  const qc = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const [form, setForm] = useState({ keyName: '', privateKey: '' });
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const { data: credStatus } = useQuery({
    queryKey: ['credential-status'],
    queryFn: settingsApi.getCredentials,
  });

  const connected = !!credStatus?.coinbase;

  const connectMutation = useMutation({
    mutationFn: () => coinbaseApi.connect(form),
    onSuccess: (data) => {
      const detail = data?.accountCount != null
        ? ` - ${data.accountCount} account(s) found`
        : '';
      addToast({ type: 'success', message: `Coinbase connected${detail}` });
      qc.invalidateQueries({ queryKey: ['credential-status'] });
      invalidateFinancialData(qc);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: coinbaseApi.sync,
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      const changes = result.transactionCount + result.staleAccountCount;
      const detail = changes > 0 ? `, ${changes} update(s)` : '';
      addToast({ type: 'success', message: `Coinbase sync complete${detail}` });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const disconnectMutation = useMutation({
    mutationFn: coinbaseApi.disconnect,
    onSuccess: () => {
      addToast({ type: 'info', message: 'Coinbase disconnected' });
      qc.invalidateQueries({ queryKey: ['credential-status'] });
      invalidateFinancialData(qc);
      setShowDisconnectConfirm(false);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <div className="space-y-4 max-w-md">
      {credStatus?.coinbaseFromEnv ? (
        <div className="flex items-start gap-2 p-3 bg-green-10 border border-green/30 rounded">
          <Info size={13} className="text-green mt-0.5 flex-shrink-0" />
          <p className="text-xs text-muted">
            Credentials loaded from <span className="font-mono text-text">.env</span>. To change them, edit that file and restart the server.
          </p>
        </div>
      ) : connected ? (
        <div className="flex items-center gap-3 p-3 bg-green-10 border border-green/30 rounded">
          <CheckCircle size={16} className="text-green flex-shrink-0" />
          <div>
            <p className="text-sm text-text">Coinbase connected</p>
            <p className="text-xs text-muted">API key stored in local credentials</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2 p-3 bg-blue/10 border border-blue/30 rounded">
            <Info size={14} className="text-blue mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted">
              Create an API key at{' '}
              <a href="https://portal.cdp.coinbase.com" target="_blank" rel="noopener noreferrer" className="text-blue hover:underline">
                portal.cdp.coinbase.com
              </a>{' '}
              → Advanced Trade API with read-only permissions.
            </p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Key Name</label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
              value={form.keyName}
              onChange={(e) => setForm({ ...form, keyName: e.target.value })}
              placeholder="organizations/xxx/apiKeys/yyy"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Private Key</label>
            <div className="relative">
              <textarea
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono resize-none focus:outline-none focus:ring-1 focus:ring-green-50"
                rows={4}
                value={form.privateKey}
                onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
                placeholder="-----BEGIN EC PRIVATE KEY-----&#10;..."
                style={{ filter: showKey ? 'none' : 'blur(4px)' }}
              />
              <button
                className="absolute right-2 top-2 text-muted hover:text-text"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        </>
      )}

      {credStatus?.coinbaseFromEnv || connected ? (
        <div className="flex gap-2">
          <button
            className="px-4 py-2 text-sm border border-border rounded text-text hover:bg-black/5 flex items-center gap-1.5"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw size={13} /> Sync Now
          </button>
          {!credStatus?.coinbaseFromEnv && (
            <button
              className="px-4 py-2 text-sm border border-rose/30 rounded text-rose hover:bg-rose/10 flex items-center gap-1.5"
              onClick={() => setShowDisconnectConfirm(true)}
              disabled={disconnectMutation.isPending}
            >
              <Unlink size={13} /> Disconnect
            </button>
          )}
        </div>
      ) : (
        <button
          className="px-4 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90"
          onClick={() => connectMutation.mutate()}
          disabled={connectMutation.isPending || !form.keyName || !form.privateKey}
        >
          {connectMutation.isPending ? 'Connecting...' : 'Connect Coinbase'}
        </button>
      )}

      <ConfirmRemoveModal
        open={showDisconnectConfirm}
        onClose={() => setShowDisconnectConfirm(false)}
        title="Disconnect Coinbase"
        description="This will remove your Coinbase API credentials. Existing Coinbase accounts and transactions will be hidden, not deleted."
        confirmLabel="Disconnect Coinbase"
        onConfirm={() => disconnectMutation.mutate()}
        isPending={disconnectMutation.isPending}
      />
    </div>
  );
}

// ─── Categories Section ───────────────────────────────────────────────────────
