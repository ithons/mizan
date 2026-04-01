import React, { useState, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
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
  Upload,
  Link,
  Unlink,
  RefreshCw,
  Info,
} from 'lucide-react';
import { settingsApi, plaidApi, coinbaseApi, categoriesApi } from '../lib/api';
import { formatDate, formatRelativeTime } from '../lib/formatters';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { PageLoader } from '../components/LoadingSpinner';
import type { Category } from '@shared/types';

// ─── Plaid Section ────────────────────────────────────────────────────────────

function PlaidSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [showSecret, setShowSecret] = useState(false);
  const [form, setForm] = useState({ clientId: '', secret: '', environment: 'sandbox' });

  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['plaid-items'],
    queryFn: plaidApi.listItems,
  });

  const saveMutation = useMutation({
    mutationFn: () => settingsApi.savePlaidCredentials(form),
    onSuccess: () => addToast({ type: 'success', message: 'Plaid credentials saved' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) => plaidApi.deleteItem(itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid-items'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      addToast({ type: 'success', message: 'Institution unlinked' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: (itemId: string) => plaidApi.syncItem(itemId),
    onSuccess: () => addToast({ type: 'info', message: 'Sync started' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      await settingsApi.savePlaidCredentials(form);
      await plaidApi.createLinkToken();
    },
    onSuccess: () => addToast({ type: 'success', message: 'Plaid connection successful' }),
    onError: () => addToast({ type: 'error', message: 'Plaid connection failed — check credentials' }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-text mb-4">Plaid Credentials</h3>
        <div className="space-y-3 max-w-md">
          <div>
            <label className="block text-xs text-muted mb-1">Client ID</label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
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
                className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono pr-10 focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
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
                      ? 'bg-[#4ecba3]/10 text-[#4ecba3] border-[#4ecba3]/40'
                      : 'text-muted border-border hover:text-text'
                  }`}
                >
                  {env.charAt(0).toUpperCase() + env.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              className="px-4 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Saving…' : 'Save Credentials'}
            </button>
            <button
              className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending ? 'Testing…' : 'Test Connection'}
            </button>
          </div>
        </div>
      </div>

      {/* Connected institutions */}
      <div>
        <h3 className="text-sm font-medium text-text mb-3">Connected Institutions</h3>
        {itemsLoading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : items.length > 0 ? (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between p-3 bg-background border border-border rounded">
                <div>
                  <p className="text-sm text-text">{item.institution_name}</p>
                  <p className="text-xs text-muted font-mono">
                    {item.last_synced_at ? `Synced ${formatRelativeTime(item.last_synced_at)}` : 'Never synced'}
                    {' · '}
                    <span style={{ color: item.status === 'active' ? '#4ecba3' : '#e07070' }}>
                      {item.status}
                    </span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="text-xs text-muted border border-border rounded px-2 py-1 hover:text-text flex items-center gap-1"
                    onClick={() => syncMutation.mutate(item.item_id)}
                    disabled={syncMutation.isPending}
                  >
                    <RefreshCw size={11} /> Sync
                  </button>
                  <button
                    className="text-xs text-[#e07070] border border-[#e07070]/30 rounded px-2 py-1 hover:bg-[#e07070]/10 flex items-center gap-1"
                    onClick={() => deleteMutation.mutate(item.item_id)}
                  >
                    <Unlink size={11} /> Unlink
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">No institutions connected yet</p>
        )}
      </div>
    </div>
  );
}

// ─── Coinbase Section ─────────────────────────────────────────────────────────

function CoinbaseSection() {
  const { addToast } = useAppStore();
  const qc = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const [form, setForm] = useState({ keyName: '', privateKey: '' });
  const [connected, setConnected] = useState(false);

  const connectMutation = useMutation({
    mutationFn: () => coinbaseApi.connect(form),
    onSuccess: () => {
      addToast({ type: 'success', message: 'Coinbase connected' });
      setConnected(true);
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: coinbaseApi.sync,
    onSuccess: () => addToast({ type: 'success', message: 'Coinbase sync started' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const disconnectMutation = useMutation({
    mutationFn: coinbaseApi.disconnect,
    onSuccess: () => {
      addToast({ type: 'info', message: 'Coinbase disconnected' });
      setConnected(false);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <div className="space-y-4 max-w-md">
      <div className="flex items-start gap-2 p-3 bg-[#5b8dee]/10 border border-[#5b8dee]/30 rounded">
        <Info size={14} className="text-[#5b8dee] mt-0.5 flex-shrink-0" />
        <p className="text-xs text-muted">
          Create an API key at{' '}
          <a href="https://portal.cdp.coinbase.com" target="_blank" rel="noopener noreferrer" className="text-[#5b8dee] hover:underline">
            portal.cdp.coinbase.com
          </a>{' '}
          → Advanced Trade API with read-only permissions.
        </p>
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Key Name</label>
        <input
          className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
          value={form.keyName}
          onChange={(e) => setForm({ ...form, keyName: e.target.value })}
          placeholder="organizations/xxx/apiKeys/yyy"
        />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Private Key</label>
        <div className="relative">
          <textarea
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono resize-none focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
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
      {connected ? (
        <div className="flex gap-2">
          <button
            className="px-4 py-2 text-sm border border-border rounded text-text hover:bg-white/5 flex items-center gap-1.5"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw size={13} /> Sync Now
          </button>
          <button
            className="px-4 py-2 text-sm border border-[#e07070]/30 rounded text-[#e07070] hover:bg-[#e07070]/10 flex items-center gap-1.5"
            onClick={() => disconnectMutation.mutate()}
          >
            <Unlink size={13} /> Disconnect
          </button>
        </div>
      ) : (
        <button
          className="px-4 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
          onClick={() => connectMutation.mutate()}
          disabled={connectMutation.isPending || !form.keyName || !form.privateKey}
        >
          {connectMutation.isPending ? 'Connecting…' : 'Connect Coinbase'}
        </button>
      )}
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
  onEdit: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (parentId: string) => void;
  depth: number;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(category.name);

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 hover:bg-white/3 group rounded px-2"
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: category.color || '#6b6b7a' }} />
        {category.icon && <span className="text-sm">{category.icon}</span>}
        {editing ? (
          <div className="flex items-center gap-1 flex-1">
            <input
              autoFocus
              className="bg-background border border-border rounded px-2 py-0.5 text-xs text-text flex-1 focus:outline-none"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onEdit(category.id, editName); setEditing(false); }
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <button onClick={() => { onEdit(category.id, editName); setEditing(false); }}>
              <Check size={12} className="text-[#4ecba3]" />
            </button>
            <button onClick={() => setEditing(false)}>
              <X size={12} className="text-muted" />
            </button>
          </div>
        ) : (
          <>
            <span className="text-sm text-text flex-1">{category.name}</span>
            {category.is_income && <span className="text-xs text-[#4ecba3] bg-[#4ecba3]/10 px-1.5 py-0.5 rounded">income</span>}
            {category.is_system && <span className="text-xs text-muted bg-border/50 px-1.5 py-0.5 rounded">system</span>}
          </>
        )}
        {!editing && (
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {depth === 0 && (
              <button
                className="p-1 text-muted hover:text-[#4ecba3]"
                title="Add subcategory"
                onClick={() => onAddChild(category.id)}
              >
                <Plus size={12} />
              </button>
            )}
            {!category.is_system && (
              <>
                <button className="p-1 text-muted hover:text-text" onClick={() => setEditing(true)}>
                  <Edit2 size={12} />
                </button>
                <button className="p-1 text-muted hover:text-[#e07070]" onClick={() => onDelete(category.id)}>
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
  const [showAddModal, setShowAddModal] = useState(false);

  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });

  const editMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      categoriesApi.update(id, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: categoriesApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['categories'] }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const addMutation = useMutation({
    mutationFn: () =>
      categoriesApi.create({
        name: addName,
        parent_id: addParentId ?? undefined,
        is_income: false,
        is_system: false,
        is_investment: false,
        sort_order: 0,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      setAddName('');
      setShowAddModal(false);
      addToast({ type: 'success', message: 'Category created' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  // Build tree
  const topLevel = categories.filter((c) => !c.parent_id);
  const withChildren = topLevel.map((c) => ({
    ...c,
    children: categories.filter((child) => child.parent_id === c.id),
  }));

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text">Categories</h3>
        <button
          className="flex items-center gap-1 text-xs text-[#4ecba3] hover:opacity-80"
          onClick={() => { setAddParentId(null); setShowAddModal(true); }}
        >
          <Plus size={13} /> Add Category
        </button>
      </div>
      <div className="bg-background border border-border rounded py-2">
        {withChildren.map((cat) => (
          <CategoryRow
            key={cat.id}
            category={cat as Category}
            onEdit={(id, name) => editMutation.mutate({ id, name })}
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
            <input
              autoFocus
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addMutation.mutate()}
              placeholder="Category name"
            />
          </div>
          <div className="flex gap-3">
            <button
              className="flex-1 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !addName}
            >
              {addMutation.isPending ? 'Creating…' : 'Create'}
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

// ─── Data Section ─────────────────────────────────────────────────────────────

function DataSection() {
  const { addToast } = useAppStore();
  const qc = useQueryClient();
  const [showDangerModal, setShowDangerModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

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
    } catch (err: any) {
      addToast({ type: 'error', message: err.message });
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await settingsApi.importCsv(fd);
      qc.invalidateQueries({ queryKey: ['transactions'] });
      addToast({ type: 'success', message: 'Import complete' });
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Import failed' });
    }
    e.target.value = '';
  };

  return (
    <div className="space-y-6">
      {/* Export/Import */}
      <div>
        <h3 className="text-sm font-medium text-text mb-3">Data Management</h3>
        <div className="flex gap-3">
          <button
            className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={handleExport}
          >
            <Download size={14} /> Export CSV
          </button>
          <button
            className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={14} /> Import CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={handleImport}
          />
        </div>
      </div>

      {/* Danger Zone */}
      <div className="border border-[#e07070]/30 rounded p-4 space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={14} className="text-[#e07070]" />
          <h3 className="text-sm font-medium text-[#e07070]">Danger Zone</h3>
        </div>
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div>
            <p className="text-sm text-text">Clear All Data</p>
            <p className="text-xs text-muted">Permanently delete all transactions, accounts, and settings.</p>
          </div>
          <button
            className="px-3 py-1.5 text-xs border border-[#e07070]/40 text-[#e07070] rounded hover:bg-[#e07070]/10"
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
            className="px-3 py-1.5 text-xs border border-[#e07070]/40 text-[#e07070] rounded hover:bg-[#e07070]/10"
            onClick={async () => {
              try {
                const items = await plaidApi.listItems();
                await Promise.all(items.map((i) => plaidApi.deleteItem(i.item_id)));
                qc.invalidateQueries({ queryKey: ['accounts'] });
                addToast({ type: 'success', message: 'All Plaid items disconnected' });
              } catch (err: any) {
                addToast({ type: 'error', message: err.message });
              }
            }}
          >
            Disconnect All
          </button>
        </div>
      </div>

      {/* Confirm delete modal */}
      <Modal
        open={showDangerModal}
        onClose={() => setShowDangerModal(false)}
        title="Delete All Data"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 bg-[#e07070]/10 border border-[#e07070]/30 rounded">
            <AlertTriangle size={14} className="text-[#e07070] mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted">
              This will permanently delete all your data including transactions, accounts, budgets, and settings. This action cannot be undone.
            </p>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">
              Type <span className="font-mono text-[#e07070]">delete</span> to confirm
            </label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#e07070]/50"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="delete"
            />
          </div>
          <div className="flex gap-3">
            <button
              className="flex-1 py-2 text-sm bg-[#e07070] text-white font-medium rounded hover:opacity-90 disabled:opacity-40"
              disabled={deleteConfirm !== 'delete' || deleteAllMutation.isPending}
              onClick={() => deleteAllMutation.mutate()}
            >
              {deleteAllMutation.isPending ? 'Deleting…' : 'Delete Everything'}
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
      <div>
        <p className="text-xs text-muted mb-0.5">GitHub</p>
        <a
          href="#"
          className="text-sm text-[#5b8dee] hover:underline"
        >
          github.com/your-username/mizan
        </a>
      </div>
      <p className="text-xs text-muted pt-2">
        Mizān is a self-hosted personal finance app. Your data never leaves your machine.
      </p>
    </div>
  );
}

// ─── Main Settings View ───────────────────────────────────────────────────────

type SettingsSection = 'plaid' | 'coinbase' | 'categories' | 'data' | 'about';

const sectionItems: { key: SettingsSection; label: string }[] = [
  { key: 'plaid', label: 'Plaid' },
  { key: 'coinbase', label: 'Coinbase' },
  { key: 'categories', label: 'Categories' },
  { key: 'data', label: 'Data' },
  { key: 'about', label: 'About' },
];

export function Settings() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('plaid');

  return (
    <div className="p-6 flex gap-6">
      {/* Section nav */}
      <div className="w-40 flex-shrink-0">
        <h1 className="text-xl font-semibold text-text mb-4">Settings</h1>
        <nav className="space-y-1">
          {sectionItems.map((s) => (
            <button
              key={s.key}
              onClick={() => setActiveSection(s.key)}
              className={`w-full text-left px-3 py-2 text-sm rounded transition-colors ${
                activeSection === s.key
                  ? 'bg-[#1e1e22] text-text'
                  : 'text-muted hover:text-text'
              }`}
            >
              {s.label}
            </button>
          ))}
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
          {activeSection === 'data' && <DataSection />}
          {activeSection === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
