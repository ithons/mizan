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
} from '../lib/api';
import { formatRelativeTime } from '../lib/formatters';
import { useAppStore } from '../store';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { Modal } from '../components/Modal';
import { ConfirmRemoveModal } from '../components/ConfirmRemoveModal';
import { SyncActivityPanel } from '../components/SyncActivityPanel';
import { PageLoader } from '../components/LoadingSpinner';
import type { Category, MerchantRule, MerchantRuleSuggestion, SyncRun } from '@shared/types';

const CATEGORY_PRESET_COLORS = [
  '#32bfa3', '#6487f0', '#ef6f8a', '#e2a53f', '#9b8dee',
  '#ee8d5b', '#70c4e0', '#e070b8', '#70e07a', '#a0a0b8',
  '#c4a86e', '#6e8ec4',
];

function invalidateCategoryData(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['categories'] });
  invalidateFinancialData(queryClient);
}

// ─── Plaid Section ────────────────────────────────────────────────────────────

function PlaidSection() {
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
                  ? 'text-[#e2a53f] border-[#e2a53f]/40 bg-[#e2a53f]/10'
                  : 'text-[#ef6f8a] border-[#ef6f8a]/40 bg-[#ef6f8a]/10'
              }`}
            >
              {credStatus.plaidEnvironment}
            </span>
          )}
        </div>
        {credStatus?.plaidFromEnv ? (
          <div className="flex items-start gap-2 p-3 bg-[#32bfa3]/10 border border-[#32bfa3]/30 rounded max-w-md">
            <Info size={13} className="text-[#32bfa3] mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted">
              Credentials loaded from <span className="font-mono text-text">.env</span>. To change them, edit that file and restart the server.
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-w-md">
            <div>
              <label className="block text-xs text-muted mb-1">Client ID</label>
              <input
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
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
                  className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono pr-10 focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
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
                        ? 'bg-[#32bfa3]/10 text-[#32bfa3] border-[#32bfa3]/40'
                        : 'text-muted border-border hover:text-text'
                    }`}
                  >
                    {env.charAt(0).toUpperCase() + env.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-2 p-3 bg-[#e2a53f]/10 border border-[#e2a53f]/30 rounded">
              <AlertTriangle size={13} className="text-[#e2a53f] mt-0.5 flex-shrink-0" />
              <div className="text-xs text-muted space-y-1">
                <p className="text-[#e2a53f]/90 font-medium">Required for OAuth banks (Chase, Wells Fargo, etc.)</p>
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
                className="px-4 py-2 text-sm bg-[#32bfa3] text-[#273238] font-medium rounded hover:opacity-90"
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
                    className="text-xs text-[#ef6f8a] border border-[#ef6f8a]/30 rounded px-2 py-1 hover:bg-[#ef6f8a]/10 flex items-center gap-1"
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

function CoinbaseSection() {
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
        <div className="flex items-start gap-2 p-3 bg-[#32bfa3]/10 border border-[#32bfa3]/30 rounded">
          <Info size={13} className="text-[#32bfa3] mt-0.5 flex-shrink-0" />
          <p className="text-xs text-muted">
            Credentials loaded from <span className="font-mono text-text">.env</span>. To change them, edit that file and restart the server.
          </p>
        </div>
      ) : connected ? (
        <div className="flex items-center gap-3 p-3 bg-[#32bfa3]/10 border border-[#32bfa3]/30 rounded">
          <CheckCircle size={16} className="text-[#32bfa3] flex-shrink-0" />
          <div>
            <p className="text-sm text-text">Coinbase connected</p>
            <p className="text-xs text-muted">API key stored in local credentials</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2 p-3 bg-[#6487f0]/10 border border-[#6487f0]/30 rounded">
            <Info size={14} className="text-[#6487f0] mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted">
              Create an API key at{' '}
              <a href="https://portal.cdp.coinbase.com" target="_blank" rel="noopener noreferrer" className="text-[#6487f0] hover:underline">
                portal.cdp.coinbase.com
              </a>{' '}
              → Advanced Trade API with read-only permissions.
            </p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Key Name</label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
              value={form.keyName}
              onChange={(e) => setForm({ ...form, keyName: e.target.value })}
              placeholder="organizations/xxx/apiKeys/yyy"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Private Key</label>
            <div className="relative">
              <textarea
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono resize-none focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
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
            className="px-4 py-2 text-sm border border-border rounded text-text hover:bg-white/5 flex items-center gap-1.5"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw size={13} /> Sync Now
          </button>
          {!credStatus?.coinbaseFromEnv && (
            <button
              className="px-4 py-2 text-sm border border-[#ef6f8a]/30 rounded text-[#ef6f8a] hover:bg-[#ef6f8a]/10 flex items-center gap-1.5"
              onClick={() => setShowDisconnectConfirm(true)}
              disabled={disconnectMutation.isPending}
            >
              <Unlink size={13} /> Disconnect
            </button>
          )}
        </div>
      ) : (
        <button
          className="px-4 py-2 text-sm bg-[#32bfa3] text-[#273238] font-medium rounded hover:opacity-90"
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

function CategoryRow({
  category,
  onEdit,
  onDelete,
  onAddChild,
  depth,
}: {
  category: Category;
  onEdit: (id: string, name: string, color: string, icon: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  depth: number;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(category.name);
  const [editColor, setEditColor] = useState(category.color || CATEGORY_PRESET_COLORS[0]);
  const [editIcon, setEditIcon] = useState(category.icon || '');

  const handleSave = () => {
    onEdit(category.id, editName, editColor, editIcon);
    setEditing(false);
  };

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 hover:bg-white/3 group rounded px-2"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: category.color || '#6b6b7a' }} />
        {category.icon && !editing && <span className="text-sm">{category.icon}</span>}
        {editing ? (
          <div className="flex flex-col gap-2 flex-1 py-1">
            <div className="flex items-center gap-1">
              <input
                autoFocus
                className="bg-background border border-border rounded px-2 py-0.5 text-xs text-text flex-1 focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <input
                className="w-8 bg-background border border-border rounded px-1 py-0.5 text-xs text-center text-text focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
                value={editIcon}
                onChange={(e) => setEditIcon(e.target.value)}
                maxLength={2}
                placeholder="🏠"
                title="Category icon (emoji)"
              />
              <button onClick={handleSave}>
                <Check size={12} className="text-[#32bfa3]" />
              </button>
              <button onClick={() => setEditing(false)}>
                <X size={12} className="text-muted" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {CATEGORY_PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setEditColor(color)}
                  className="w-4 h-4 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: color,
                    outline: editColor === color ? `2px solid white` : '2px solid transparent',
                    outlineOffset: '1px',
                  }}
                  title={color}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            <span className="text-sm text-text flex-1">{category.name}</span>
            {category.is_income && <span className="text-xs text-[#32bfa3] bg-[#32bfa3]/10 px-1.5 py-0.5 rounded">income</span>}
            {category.is_system && <span className="text-xs text-muted bg-border/50 px-1.5 py-0.5 rounded">system</span>}
          </>
        )}
        {!editing && (
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {depth === 0 && (
              <button
                className="p-1 text-muted hover:text-[#32bfa3]"
                title="Add subcategory"
                onClick={() => onAddChild(category.id)}
              >
                <Plus size={12} />
              </button>
            )}
            {!category.is_system && (
              <>
                <button
                  className="p-1 text-muted hover:text-text"
                  onClick={() => {
                    setEditName(category.name);
                    setEditColor(category.color || CATEGORY_PRESET_COLORS[0]);
                    setEditIcon(category.icon || '');
                    setEditing(true);
                  }}
                >
                  <Edit2 size={12} />
                </button>
                <button className="p-1 text-muted hover:text-[#ef6f8a]" onClick={() => onDelete(category.id)}>
                  <Trash2 size={12} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {category.children?.map((child) => (
        <CategoryRow
          key={child.id}
          category={child}
          onEdit={onEdit}
          onDelete={onDelete}
          onAddChild={onAddChild}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function CategoriesSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [addParentId, setAddParentId] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addColor, setAddColor] = useState(CATEGORY_PRESET_COLORS[0]);
  const [addIcon, setAddIcon] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });

  const editMutation = useMutation({
    mutationFn: ({ id, name, color, icon }: { id: string; name: string; color: string; icon: string }) =>
      categoriesApi.update(id, { name, color, icon }),
    onSuccess: () => invalidateCategoryData(qc),
  });

  const deleteMutation = useMutation({
    mutationFn: categoriesApi.delete,
    onSuccess: () => invalidateCategoryData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const addMutation = useMutation({
    mutationFn: () =>
      categoriesApi.create({
        name: addName,
        color: addColor,
        icon: addIcon || undefined,
        parent_id: addParentId ?? undefined,
        is_income: false,
        is_system: false,
        is_investment: false,
        sort_order: 0,
      }),
    onSuccess: () => {
      invalidateCategoryData(qc);
      setAddName('');
      setAddColor(CATEGORY_PRESET_COLORS[0]);
      setAddIcon('');
      setShowAddModal(false);
      addToast({ type: 'success', message: 'Category created' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const rootCategories = categories.filter((c) => !c.parent_id);

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text">Categories</h3>
        <button
          className="flex items-center gap-1 text-xs text-[#32bfa3] hover:opacity-80"
          onClick={() => { setAddParentId(null); setShowAddModal(true); }}
        >
          <Plus size={13} /> Add Category
        </button>
      </div>
      <div className="bg-background border border-border rounded py-2">
        {rootCategories.map((cat) => (
          <CategoryRow
            key={cat.id}
            category={cat}
            onEdit={(id, name, color, icon) => editMutation.mutate({ id, name, color, icon })}
            onDelete={(id) => deleteMutation.mutate(id)}
            onAddChild={(parentId) => { setAddParentId(parentId); setShowAddModal(true); }}
            depth={0}
          />
        ))}
        {categories.length === 0 && (
          <p className="text-xs text-muted text-center py-6">No categories yet</p>
        )}
      </div>

      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={addParentId ? 'Add Subcategory' : 'Add Category'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">Name</label>
            <div className="flex gap-2">
              <input
                autoFocus
                className="flex-1 bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addMutation.mutate()}
                placeholder="Category name"
              />
              <input
                className="w-10 bg-background border border-border rounded px-2 py-2 text-sm text-center text-text focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
                value={addIcon}
                onChange={(e) => setAddIcon(e.target.value)}
                maxLength={2}
                placeholder="🏠"
                title="Icon (emoji)"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted mb-2">Color</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setAddColor(color)}
                  className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                  style={{
                    backgroundColor: color,
                    outline: addColor === color ? '2px solid white' : '2px solid transparent',
                    outlineOffset: '1px',
                  }}
                  title={color}
                />
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <button
              className="flex-1 py-2 text-sm bg-[#32bfa3] text-[#273238] font-medium rounded hover:opacity-90"
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !addName}
            >
              {addMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button
              className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
              onClick={() => setShowAddModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── Rules Section ────────────────────────────────────────────────────────────

function RulesSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
  });

  const { data: suggestions = [] } = useQuery({
    queryKey: ['rules', 'suggestions'],
    queryFn: rulesApi.suggestions,
  });

  const { data: categoriesTree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const categories = flattenCategories(categoriesTree);

  const selectedCategory = categories.find((category) => category.id === categoryId);

  const createMutation = useMutation({
    mutationFn: () => rulesApi.create({
      pattern,
      category_id: categoryId,
      apply_existing: true,
    }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      setPattern('');
      setCategoryId('');
      addToast({
        type: 'success',
        message: result.applied > 0
          ? `Rule saved and applied to ${result.applied} transactions`
          : 'Rule saved',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const suggestionMutation = useMutation({
    mutationFn: (suggestion: MerchantRuleSuggestion) => rulesApi.create({
      pattern: suggestion.pattern,
      category_id: suggestion.category_id,
      apply_existing: true,
    }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      addToast({
        type: 'success',
        message: result.applied > 0
          ? `Rule saved and applied to ${result.applied} transactions`
          : 'Rule saved',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: rulesApi.delete,
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Rule deleted' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const applyMutation = useMutation({
    mutationFn: () => rulesApi.apply({ only_uncategorized: true }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      addToast({
        type: 'success',
        message: result.updated > 0
          ? `Applied rules to ${result.updated} transactions`
          : 'No uncategorized matches found',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const saveRule = () => {
    if (!pattern.trim()) {
      addToast({ type: 'error', message: 'Pattern is required' });
      return;
    }
    if (!categoryId) {
      addToast({ type: 'error', message: 'Choose a category' });
      return;
    }
    createMutation.mutate();
  };

  if (rulesLoading) return <PageLoader />;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2">
        <input
          className="bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveRule()}
          placeholder="Merchant contains..."
        />
        <select
          className="bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#32bfa3]/50"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>
        <button
          className="flex items-center gap-1.5 px-3 py-2 text-xs bg-[#32bfa3] text-[#273238] font-medium rounded hover:opacity-90 disabled:opacity-40"
          onClick={saveRule}
          disabled={createMutation.isPending}
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      {selectedCategory && (
        <p className="text-xs text-muted">
          New matches will be categorized as <span className="text-text">{selectedCategory.name}</span>.
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="border border-[#e2a53f]/30 bg-[#e2a53f]/10 rounded">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e2a53f]/20">
            <Sparkles size={13} className="text-[#e2a53f]" />
            <p className="text-xs font-medium text-text">Suggested rules</p>
          </div>
          <div className="divide-y divide-[#e2a53f]/15">
            {suggestions.map((suggestion) => (
              <div key={`${suggestion.pattern}:${suggestion.category_id}`} className="flex items-center gap-3 px-3 py-3">
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: suggestion.category_color ?? '#6b6b7a' }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text truncate">{suggestion.pattern}</p>
                  <p className="text-xs text-muted">
                    {suggestion.categorized_count} categorized as {suggestion.category_name}
                    {' '}
                    - {suggestion.uncategorized_count} uncategorized
                    {' '}
                    - {Math.round(suggestion.confidence * 100)}% confidence
                  </p>
                </div>
                <button
                  className="flex items-center gap-1.5 text-xs text-[#273238] bg-[#e2a53f] rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
                  onClick={() => suggestionMutation.mutate(suggestion)}
                  disabled={suggestionMutation.isPending}
                >
                  <Check size={12} />
                  Accept
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">{rules.length} rules</p>
        <button
          className="flex items-center gap-1.5 text-xs text-muted border border-border rounded px-3 py-1.5 hover:text-text disabled:opacity-40"
          onClick={() => applyMutation.mutate()}
          disabled={applyMutation.isPending || rules.length === 0}
        >
          <Check size={13} />
          Apply Rules
        </button>
      </div>

      <div className="bg-background border border-border rounded divide-y divide-border">
        {rules.map((rule: MerchantRule) => (
          <div key={rule.id} className="flex items-center gap-3 px-3 py-3">
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: rule.category_color ?? '#6b6b7a' }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text truncate">{rule.pattern}</p>
              <p className="text-xs text-muted">
                {rule.category_name ?? 'Unknown category'}
                {rule.match_count !== undefined && ` · ${rule.match_count} matches`}
              </p>
            </div>
            <button
              className="p-1 text-muted hover:text-[#ef6f8a]"
              onClick={() => deleteMutation.mutate(rule.id)}
              title="Delete rule"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {rules.length === 0 && (
          <p className="text-xs text-muted text-center py-6">No rules yet</p>
        )}
      </div>
    </div>
  );
}

// ─── Data Section ─────────────────────────────────────────────────────────────

function DataSection() {
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

  const handleExport = async () => {
    try {
      await settingsApi.exportCsv();
      addToast({ type: 'success', message: 'Export complete' });
    } catch (err: unknown) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Export failed' });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-text mb-3">Data Management</h3>
        <div className="flex gap-3">
          <button
            className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={handleExport}
          >
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      <SyncActivityPanel runs={syncRuns} showDetail />

      <div className="border border-[#ef6f8a]/30 rounded p-4 space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={14} className="text-[#ef6f8a]" />
          <h3 className="text-sm font-medium text-[#ef6f8a]">Danger Zone</h3>
        </div>
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div>
            <p className="text-sm text-text">Clear All Data</p>
            <p className="text-xs text-muted">Permanently delete accounts, transactions, budgets, goals, rules, snapshots, and sync history. Encrypted credentials stay on disk.</p>
          </div>
          <button
            className="px-3 py-1.5 text-xs border border-[#ef6f8a]/40 text-[#ef6f8a] rounded hover:bg-[#ef6f8a]/10"
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
            className="px-3 py-1.5 text-xs border border-[#ef6f8a]/40 text-[#ef6f8a] rounded hover:bg-[#ef6f8a]/10"
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
          <div className="flex items-start gap-2 p-3 bg-[#ef6f8a]/10 border border-[#ef6f8a]/30 rounded">
            <AlertTriangle size={14} className="text-[#ef6f8a] mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted">
              This permanently deletes local finance data from the database. Encrypted provider credentials are not deleted, so disconnect providers separately if needed.
            </p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">
              Type <span className="font-mono text-[#ef6f8a]">delete</span> to confirm
            </label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#ef6f8a]/50"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="delete"
            />
          </div>
          <div className="flex gap-3">
            <button
              className="flex-1 py-2 text-sm bg-[#ef6f8a] text-white font-medium rounded hover:opacity-90 disabled:opacity-40"
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

function AboutSection() {
  return (
    <div className="space-y-3 max-w-md">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted mb-0.5">Version</p>
          <p className="text-text font-mono">0.1.0</p>
        </div>
        <div>
          <p className="text-xs text-muted mb-0.5">License</p>
          <p className="text-text">MIT</p>
        </div>
      </div>
      <p className="text-xs text-muted pt-2">
        Mizān is a self-hosted personal finance app. Your data never leaves your machine.
      </p>
    </div>
  );
}

// ─── Main Settings View ───────────────────────────────────────────────────────

type SettingsSection = 'plaid' | 'coinbase' | 'categories' | 'rules' | 'data' | 'about';

const sectionItems: { key: SettingsSection; label: string; icon: LucideIcon }[] = [
  { key: 'plaid', label: 'Plaid', icon: Link2 },
  { key: 'coinbase', label: 'Coinbase', icon: Wallet },
  { key: 'categories', label: 'Categories', icon: Tag },
  { key: 'rules', label: 'Rules', icon: CheckCircle },
  { key: 'data', label: 'Data', icon: Database },
  { key: 'about', label: 'About', icon: Info },
];

function settingsSection(value: string | null): SettingsSection {
  return sectionItems.some((section) => section.key === value)
    ? value as SettingsSection
    : 'plaid';
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeSection, setActiveSection] = useState<SettingsSection>(() =>
    settingsSection(searchParams.get('section'))
  );

  useEffect(() => {
    setActiveSection(settingsSection(searchParams.get('section')));
  }, [searchParams]);

  const selectSection = (section: SettingsSection) => {
    setActiveSection(section);
    setSearchParams({ section }, { replace: true });
  };

  return (
    <div className="p-6 flex gap-6">
      {/* Section nav */}
      <div className="w-44 flex-shrink-0">
        <h1 className="text-xl font-semibold text-text mb-4">Settings</h1>
        <nav className="space-y-0.5">
          {sectionItems.map((s) => {
            const Icon = s.icon;
            const active = activeSection === s.key;
            return (
              <button
                key={s.key}
                onClick={() => selectSection(s.key)}
                className={`w-full text-left px-3 py-2 text-sm rounded transition-colors flex items-center gap-2.5 ${
                  active
                    ? 'bg-[#eaf7f3] text-text'
                    : 'text-muted hover:text-text'
                }`}
              >
                <Icon size={14} className={active ? 'text-[#32bfa3]' : 'text-muted'} />
                {s.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 max-w-2xl">
        <div className="bg-surface border border-border rounded p-6">
          <h2 className="text-base font-semibold text-text mb-6">
            {sectionItems.find((s) => s.key === activeSection)?.label}
          </h2>
          {activeSection === 'plaid' && <PlaidSection />}
          {activeSection === 'coinbase' && <CoinbaseSection />}
          {activeSection === 'categories' && <CategoriesSection />}
          {activeSection === 'rules' && <RulesSection />}
          {activeSection === 'data' && <DataSection />}
          {activeSection === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
