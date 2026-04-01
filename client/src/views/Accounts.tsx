import React, { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  RefreshCw,
  Eye,
  EyeOff,
  Trash2,
  Edit2,
  MoreHorizontal,
  Link,
  Unlink,
} from 'lucide-react';
import { accountsApi, plaidApi, transactionsApi, investmentsApi } from '../lib/api';
import { formatCurrency, formatDate } from '../lib/formatters';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_GROUPS } from '../lib/constants';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { AmountBadge } from '../components/AmountBadge';
import { CategoryBadge } from '../components/CategoryBadge';
import { PageLoader } from '../components/LoadingSpinner';
import type { Account } from '@shared/types';

declare global {
  interface Window {
    Plaid: any;
  }
}

function AccountTypeBadge({ type }: { type: string }) {
  return (
    <span className="text-xs text-muted bg-border/50 px-1.5 py-0.5 rounded">
      {ACCOUNT_TYPE_LABELS[type] ?? type}
    </span>
  );
}

function AccountRow({
  account,
  selected,
  onSelect,
  onHide,
  onDelete,
  onSync,
}: {
  account: Account;
  selected: boolean;
  onSelect: () => void;
  onHide: () => void;
  onDelete: () => void;
  onSync: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/3 group relative ${selected ? 'bg-white/5' : ''}`}
      onClick={onSelect}
    >
      {/* Color dot */}
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: account.color || '#6b6b7a' }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text truncate">{account.account_name}</p>
        <p className="text-xs text-muted font-mono">
          {account.mask ? `••${account.mask}` : account.currency}
        </p>
      </div>
      <AccountTypeBadge type={account.type} />
      <span
        className="font-mono text-sm flex-shrink-0"
        style={{ color: account.is_liability ? '#e07070' : '#4ecba3' }}
      >
        {formatCurrency(account.current_balance)}
      </span>

      {/* Kebab menu */}
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <button
          className="opacity-0 group-hover:opacity-100 p-1 text-muted hover:text-text transition-all"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-6 bg-surface border border-border rounded shadow-lg z-20 w-44 py-1">
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted hover:text-text hover:bg-white/5"
              onClick={() => { onHide(); setMenuOpen(false); }}
            >
              {account.is_hidden ? <Eye size={12} /> : <EyeOff size={12} />}
              {account.is_hidden ? 'Show' : 'Hide'} Account
            </button>
            {account.connection_type === 'plaid' && (
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted hover:text-text hover:bg-white/5"
                onClick={() => { onSync(); setMenuOpen(false); }}
              >
                <RefreshCw size={12} />
                Sync Now
              </button>
            )}
            {account.is_manual && (
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[#e07070] hover:bg-white/5"
                onClick={() => { onDelete(); setMenuOpen(false); }}
              >
                <Trash2 size={12} />
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountGroup({
  label,
  accounts,
  selectedId,
  onSelect,
  onHide,
  onDelete,
  onSync,
}: {
  label: string;
  accounts: Account[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onDelete: (id: string) => void;
  onSync: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const total = accounts.reduce((sum, a) => sum + (a.is_liability ? -a.current_balance : a.current_balance), 0);

  if (accounts.length === 0) return null;

  return (
    <div className="mb-2">
      <button
        className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-muted hover:text-text"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="font-medium uppercase tracking-wider">{label}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono" style={{ color: total >= 0 ? '#4ecba3' : '#e07070' }}>
            {formatCurrency(total)}
          </span>
          {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </div>
      </button>
      {!collapsed && accounts.map((acc) => (
        <AccountRow
          key={acc.id}
          account={acc}
          selected={selectedId === acc.id}
          onSelect={() => onSelect(acc.id)}
          onHide={() => onHide(acc.id)}
          onDelete={() => onDelete(acc.id)}
          onSync={() => onSync(acc.id)}
        />
      ))}
    </div>
  );
}

// ─── Account Detail ──────────────────────────────────────────────────────────

function AccountDetail({ account }: { account: Account }) {
  const [tab, setTab] = useState<'transactions' | 'holdings' | 'inv-transactions'>('transactions');
  const isInvestment = ['brokerage', 'ira_traditional', 'ira_roth'].includes(account.type);
  const isCrypto = account.type === 'crypto_wallet';

  const { data: txs } = useQuery({
    queryKey: ['transactions', 'account', account.id],
    queryFn: () => transactionsApi.list({ accountId: [account.id], limit: 50, page: 1 }),
    enabled: tab === 'transactions',
  });

  const { data: holdings } = useQuery({
    queryKey: ['holdings', account.id],
    queryFn: () => investmentsApi.holdingsByAccount(account.id),
    enabled: isInvestment && tab === 'holdings',
  });

  const { data: invTxs } = useQuery({
    queryKey: ['inv-transactions', account.id],
    queryFn: () => investmentsApi.transactions({ accountId: account.id }),
    enabled: isInvestment && tab === 'inv-transactions',
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3 mb-1">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: account.color || '#6b6b7a' }}
          />
          <h2 className="text-base font-semibold text-text">{account.account_name}</h2>
          <AccountTypeBadge type={account.type} />
          {(account.type === 'ira_traditional' || account.type === 'ira_roth') && (
            <span className="text-xs bg-[#5b8dee]/20 text-[#5b8dee] px-2 py-0.5 rounded">
              Tax-Advantaged
            </span>
          )}
        </div>
        <p className="font-mono text-2xl" style={{ color: account.is_liability ? '#e07070' : '#4ecba3' }}>
          {formatCurrency(account.current_balance)}
        </p>
        {account.institution_name && (
          <p className="text-xs text-muted mt-0.5">{account.institution_name}</p>
        )}
      </div>

      {/* Tabs */}
      {isInvestment && (
        <div className="flex gap-1 px-6 py-2 border-b border-border">
          {(['holdings', 'transactions', 'inv-transactions'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs rounded ${tab === t ? 'bg-[#4ecba3]/10 text-[#4ecba3]' : 'text-muted hover:text-text'}`}
            >
              {t === 'inv-transactions' ? 'Investment Txs' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Holdings */}
        {tab === 'holdings' && isInvestment && (
          <div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  {['Ticker', 'Name', 'Qty', 'Price', 'Value', 'Cost Basis', 'P&L'].map((h) => (
                    <th key={h} className="text-left px-4 py-2 text-muted font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(holdings ?? []).map((h) => {
                  const unrealized = h.cost_basis != null ? h.institution_value - h.cost_basis : null;
                  return (
                    <tr key={h.id} className="border-b border-border hover:bg-white/2">
                      <td className="px-4 py-2 font-mono text-[#5b8dee] font-medium">{h.ticker ?? '—'}</td>
                      <td className="px-4 py-2 text-text">{h.security_name}</td>
                      <td className="px-4 py-2 font-mono text-muted">{h.quantity.toFixed(4)}</td>
                      <td className="px-4 py-2 font-mono text-muted">{formatCurrency(h.institution_price)}</td>
                      <td className="px-4 py-2 font-mono text-text">{formatCurrency(h.institution_value)}</td>
                      <td className="px-4 py-2 font-mono text-muted">{h.cost_basis != null ? formatCurrency(h.cost_basis) : '—'}</td>
                      <td className="px-4 py-2 font-mono" style={{ color: unrealized != null ? (unrealized >= 0 ? '#4ecba3' : '#e07070') : '#6b6b7a' }}>
                        {unrealized != null ? `${unrealized >= 0 ? '+' : ''}${formatCurrency(unrealized)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Investment Transactions */}
        {tab === 'inv-transactions' && isInvestment && (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                {['Date', 'Type', 'Security', 'Qty', 'Price', 'Amount'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-muted font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(invTxs ?? []).map((tx) => (
                <tr key={tx.id} className="border-b border-border hover:bg-white/2">
                  <td className="px-4 py-2 font-mono text-muted">{formatDate(tx.date)}</td>
                  <td className="px-4 py-2 text-text capitalize">{tx.type}</td>
                  <td className="px-4 py-2 font-mono text-[#5b8dee]">{tx.ticker ?? tx.name}</td>
                  <td className="px-4 py-2 font-mono text-muted">{tx.quantity?.toFixed(4) ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-muted">{tx.price != null ? formatCurrency(tx.price) : '—'}</td>
                  <td className="px-4 py-2"><AmountBadge amount={tx.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Regular Transactions */}
        {tab === 'transactions' && (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                {['Date', 'Merchant', 'Category', 'Amount'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-muted font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(txs?.data ?? []).map((tx) => (
                <tr key={tx.id} className="border-b border-border hover:bg-white/2">
                  <td className="px-4 py-2 font-mono text-muted">{formatDate(tx.date)}</td>
                  <td className="px-4 py-2 text-text">{tx.merchant_name || tx.original_name}</td>
                  <td className="px-4 py-2">
                    {tx.category_name ? (
                      <CategoryBadge name={tx.category_name} color={tx.category_color} />
                    ) : (
                      <span className="text-muted">Uncategorized</span>
                    )}
                  </td>
                  <td className="px-4 py-2"><AmountBadge amount={tx.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Crypto */}
        {isCrypto && (
          <div className="p-6 space-y-4">
            <div className="flex gap-6">
              <div>
                <p className="text-xs text-muted mb-1">Native Balance</p>
                <p className="font-mono text-lg text-text">
                  {account.native_balance?.toFixed(8) ?? '—'} {account.native_currency ?? ''}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted mb-1">USD Value</p>
                <p className="font-mono text-lg text-[#4ecba3]">{formatCurrency(account.current_balance)}</p>
              </div>
            </div>
            {account.updated_at && (
              <p className="text-xs text-muted">Last synced: {formatDate(account.updated_at)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Add Manual Account Modal ────────────────────────────────────────────────

function AddManualAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    account_name: '',
    institution_name: '',
    type: 'checking',
    current_balance: '',
    currency: 'USD',
  });

  const mutation = useMutation({
    mutationFn: () =>
      accountsApi.createManual({
        ...form,
        current_balance: parseFloat(form.current_balance) || 0,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      addToast({ type: 'success', message: 'Account created' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add Manual Account">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-muted mb-1">Account Name</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.account_name}
            onChange={(e) => setForm({ ...form, account_name: e.target.value })}
            placeholder="My Savings"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Institution (optional)</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.institution_name}
            onChange={(e) => setForm({ ...form, institution_name: e.target.value })}
            placeholder="Chase"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Account Type</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            {Object.entries(ACCOUNT_TYPE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Current Balance</label>
          <input
            type="number"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.current_balance}
            onChange={(e) => setForm({ ...form, current_balance: e.target.value })}
            placeholder="0.00"
          />
        </div>
        <div className="flex gap-3 pt-2">
          <button
            className="flex-1 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Creating…' : 'Create Account'}
          </button>
          <button
            className="px-4 py-2 text-sm border border-border rounded text-muted hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main Accounts View ──────────────────────────────────────────────────────

export function Accounts() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showManualModal, setShowManualModal] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const hideMutation = useMutation({
    mutationFn: (id: string) => {
      const acc = accounts.find((a) => a.id === id);
      return accountsApi.update(id, { is_hidden: !acc?.is_hidden });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: accountsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setSelectedId(null);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const acc = accounts.find((a) => a.id === accountId);
      if (acc?.connection_id) await plaidApi.syncItem(acc.connection_id);
    },
    onSuccess: () => {
      addToast({ type: 'success', message: 'Sync started' });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const connectPlaid = async () => {
    setAddMenuOpen(false);
    try {
      const { link_token } = await plaidApi.createLinkToken();
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (publicToken: string, metadata: unknown) => {
          await plaidApi.exchangeToken(publicToken, metadata);
          qc.invalidateQueries({ queryKey: ['accounts'] });
          addToast({ type: 'success', message: 'Bank connected successfully' });
        },
        onExit: () => {},
      });
      handler.open();
    } catch (err: any) {
      addToast({ type: 'error', message: err.message || 'Failed to open Plaid' });
    }
  };

  if (isLoading) return <PageLoader />;

  const selectedAccount = accounts.find((a) => a.id === selectedId);

  // Group accounts
  const groupedAccounts: Record<string, Account[]> = {};
  Object.keys(ACCOUNT_TYPE_GROUPS).forEach((group) => {
    const types = ACCOUNT_TYPE_GROUPS[group];
    const accs = accounts.filter(
      (a) => !a.is_hidden && types.includes(a.type)
    );
    if (accs.length) groupedAccounts[group] = accs;
  });
  // Manual accounts not matching any standard type
  const otherAccounts = accounts.filter(
    (a) => !a.is_hidden && a.is_manual && a.type === 'other'
  );
  if (otherAccounts.length) groupedAccounts['Manual'] = otherAccounts;

  return (
    <div className="flex h-full">
      {/* Left Panel */}
      <div className="w-72 border-r border-border bg-surface flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-sm font-medium text-text">Accounts</span>
          <div className="relative">
            <button
              className="flex items-center gap-1 text-xs text-[#4ecba3] hover:opacity-80"
              onClick={() => setAddMenuOpen(!addMenuOpen)}
            >
              <Plus size={14} /> Add
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-6 bg-surface border border-border rounded shadow-lg z-20 w-52 py-1">
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-white/5"
                  onClick={connectPlaid}
                >
                  <Link size={12} className="text-[#4ecba3]" />
                  Connect Bank or Card
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-white/5"
                  onClick={() => { setAddMenuOpen(false); window.location.href = '/settings'; }}
                >
                  <Link size={12} className="text-[#5b8dee]" />
                  Connect Coinbase
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text hover:bg-white/5"
                  onClick={() => { setAddMenuOpen(false); setShowManualModal(true); }}
                >
                  <Plus size={12} className="text-muted" />
                  Add Manual Account
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {Object.entries(groupedAccounts).map(([group, accs]) => (
            <AccountGroup
              key={group}
              label={group}
              accounts={accs}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onHide={(id) => hideMutation.mutate(id)}
              onDelete={(id) => deleteMutation.mutate(id)}
              onSync={(id) => syncMutation.mutate(id)}
            />
          ))}
          {accounts.length === 0 && (
            <div className="py-12 text-center text-muted text-sm px-4">
              <p className="mb-2">No accounts yet</p>
              <p className="text-xs">Click "Add" to connect your accounts</p>
            </div>
          )}
        </div>
      </div>

      {/* Right Panel */}
      <div className="flex-1 overflow-y-auto bg-background">
        {selectedAccount ? (
          <AccountDetail account={selectedAccount} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted">
            <CreditCardIcon size={48} className="mb-4 opacity-20" />
            <p className="text-sm">Select an account to view details</p>
          </div>
        )}
      </div>

      <AddManualAccountModal
        open={showManualModal}
        onClose={() => setShowManualModal(false)}
      />
    </div>
  );
}

function CreditCardIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}
