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

export function PlaidSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [showSecret, setShowSecret] = useState(false);
  const [form, setForm] = useState({ clientId: '', secret: '', environment: 'sandbox' });
  const [unlinkTarget, setUnlinkTarget] = useState<{ id: string; name: string } | null>(null);

  const { data: credStatus } = useQuery({
    queryKey: ['credential-status'],
    queryFn: settingsApi.getCredentials,
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['plaid-items'],
    queryFn: plaidApi.listItems,
  });

  const saveMutation = useMutation({
    mutationFn: () => settingsApi.savePlaidCredentials(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credential-status'] });
      addToast({ type: 'success', message: 'Plaid credentials saved' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) => plaidApi.deleteItem(itemId),
    onSuccess: () => {
      invalidateFinancialData(qc);
      setUnlinkTarget(null);
      addToast({ type: 'success', message: 'Institution removed' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: (itemId: string) => plaidApi.syncItem(itemId),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      if (!result.success) {
        addToast({ type: 'error', message: 'Institution needs reconnecting' });
        return;
      }
      addToast({ type: 'success', message: 'Institution sync complete' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      await settingsApi.savePlaidCredentials(form);
      await plaidApi.createLinkToken();
    },
    onSuccess: () => addToast({ type: 'success', message: 'Plaid connection successful' }),
    onError: () => addToast({ type: 'error', message: 'Plaid connection failed - check credentials' }),
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-sm font-medium text-text">Plaid Credentials</h3>
          {credStatus?.plaidEnvironment && (
            <span
              className={`text-xs px-2 py-0.5 rounded border font-mono ${
                credStatus.plaidEnvironment === 'sandbox'
                  ? 'text-amber border-amber/40 bg-amber/10'
                  : 'text-rose border-rose/40 bg-rose/10'
              }`}
            >
              {credStatus.plaidEnvironment}
            </span>
          )}
        </div>
        {credStatus?.plaidFromEnv ? (
          <div className="flex items-start gap-2 p-3 bg-green-10 border border-green/30 rounded max-w-md">
            <Info size={13} className="text-green mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted">
              Credentials loaded from <span className="font-mono text-text">.env</span>. To change them, edit that file and restart the server.
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-w-md">
            <div>
              <label className="block text-xs text-muted mb-1">Client ID</label>
              <input
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                placeholder="Plaid client ID"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Secret</label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono pr-10 focus:outline-none focus:ring-1 focus:ring-green-50"
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  placeholder="Plaid secret"
                />
                <button
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                  onClick={() => setShowSecret(!showSecret)}
                  type="button"
                >
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Environment</label>
              <div className="flex gap-2">
                {['sandbox', 'production'].map((env) => (
                  <button
                    key={env}
                    onClick={() => setForm({ ...form, environment: env })}
                    className={`px-3 py-1.5 text-xs rounded border transition-all ${
                      form.environment === env
                        ? 'bg-green-10 text-green border-green/40'
                        : 'text-muted border-border hover:text-text'
                    }`}
                  >
                    {env.charAt(0).toUpperCase() + env.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-2 p-3 bg-amber/10 border border-amber/30 rounded">
              <AlertTriangle size={13} className="text-amber mt-0.5 flex-shrink-0" />
              <div className="text-xs text-muted space-y-1">
                <p className="text-amber/90 font-medium">Required for OAuth banks (Chase, Wells Fargo, etc.)</p>
                <p>
                  In your Plaid Dashboard go to{' '}
                  <span className="font-mono text-text">Settings → API → Allowed redirect URIs</span>{' '}
                  and add:
                </p>
                <p className="font-mono text-text bg-background px-2 py-0.5 rounded inline-block">
                  {window.location.origin}
                </p>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                className="px-4 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? 'Saving...' : 'Save Credentials'}
              </button>
              <button
                className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Connected institutions */}
      <div>
        <h3 className="text-sm font-medium text-text mb-3">Connected Institutions</h3>
        {itemsLoading ? (
          <p className="text-xs text-muted">Loading...</p>
        ) : items.length > 0 ? (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between p-3 bg-background border border-border rounded">
                <div>
                  <p className="text-sm text-text">{item.institution_name}</p>
                  <p className="text-xs text-muted font-mono">
                    {item.last_synced_at ? `Synced ${formatRelativeTime(item.last_synced_at)}` : 'Never synced'}
                    {' · '}
                    <span style={{ color: item.status === 'active' ? '#32bfa3' : '#ef6f8a' }}>
                      {item.status}
                    </span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="text-xs text-muted border border-border rounded px-2 py-1 hover:text-text flex items-center gap-1"
                    onClick={() => syncMutation.mutate(item.id)}
                    disabled={syncMutation.isPending}
                  >
                    <RefreshCw size={11} /> Sync
                  </button>
                  <button
                    className="text-xs text-rose border border-rose/30 rounded px-2 py-1 hover:bg-rose/10 flex items-center gap-1"
                    onClick={() => setUnlinkTarget({ id: item.id, name: item.institution_name })}
                  >
                    <Unlink size={11} /> Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No institutions connected yet</p>
        )}
      </div>

      <ConfirmRemoveModal
        open={!!unlinkTarget}
        onClose={() => setUnlinkTarget(null)}
        title="Remove Institution"
        description={`This will remove ${unlinkTarget?.name ?? 'this institution'} and delete its access token. Existing accounts and transactions will be hidden, not deleted.`}
        confirmLabel="Remove Institution"
        onConfirm={() => unlinkTarget && deleteMutation.mutate(unlinkTarget.id)}
        isPending={deleteMutation.isPending}
      />
    </div>
  );
}

// ─── Coinbase Section ─────────────────────────────────────────────────────────
