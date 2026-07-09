import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';
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
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CreditCard,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { accountsApi, coinbaseApi, transactionsApi, investmentsApi, syncApi } from '../../lib/api';
import { formatCurrency, formatDate, formatRelativeTime } from '../../lib/formatters';
import { ACCOUNT_TYPE_LABELS, CATEGORY_COLORS } from '../../lib/constants';
import { useAppStore } from '../../store';
import { Modal } from '../../components/Modal';
import { AmountBadge } from '../../components/AmountBadge';
import { CategoryBadge } from '../../components/CategoryBadge';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonList } from '../../components/SkeletonLoader';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { parseDecimalInput } from '../../lib/numberInput';
import type { Account, Holding, SyncHealth, SyncHealthConnection, SyncRun } from '@shared/types';

export function EditAccountModal({
  open,
  account,
  onClose,
}: {
  open: boolean;
  account: Account | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    account_name: '',
    institution_name: '',
    type: 'checking',
    current_balance: '',
    is_liability: false,
    color: CATEGORY_COLORS[0],
  });

  useEffect(() => {
    if (account) {
      setForm({
        account_name: account.account_name,
        institution_name: account.institution_name ?? '',
        type: account.type,
        current_balance: String(account.current_balance),
        is_liability: Boolean(account.is_liability),
        color: account.color ?? CATEGORY_COLORS[0],
      });
    }
  }, [account]);

  const mutation = useMutation({
    mutationFn: () => {
      // Balance is only editable for manual accounts
      let currentBalance = account?.current_balance ?? 0;
      if (account?.is_manual) {
        const parsed = parseDecimalInput(form.current_balance);
        if (parsed === null) {
          throw new Error('Enter a valid current balance');
        }
        currentBalance = parsed;
      }

      return accountsApi.update(account!.id, {
        account_name: form.account_name,
        institution_name: account?.is_manual ? form.institution_name : undefined,
        type: form.type as import('@shared/types').AccountType,
        is_liability: form.is_liability,
        current_balance: account?.is_manual ? currentBalance : undefined,
        color: form.color,
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Account updated' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (!account) return null;

  return (
    <Modal open={open} onClose={onClose} title="Edit Account">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-muted mb-1">Account Name</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-positive-5"
            value={form.account_name}
            onChange={(e) => setForm({ ...form, account_name: e.target.value })}
          />
        </div>
        {Boolean(account.is_manual) && (
          <div>
            <label className="block text-xs text-muted mb-1">Institution</label>
            <input
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-positive-5"
              value={form.institution_name}
              onChange={(e) => setForm({ ...form, institution_name: e.target.value })}
              placeholder="Chase"
            />
          </div>
        )}
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-xs text-muted mb-1">Account Type</label>
            <select
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-positive-5"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {Object.entries(ACCOUNT_TYPE_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_liability}
                onChange={(e) => setForm({ ...form, is_liability: e.target.checked })}
                className="rounded border-border text-positive focus:ring-positive-5"
              />
              <span className="text-sm text-text">Liability</span>
            </label>
          </div>
        </div>
        {Boolean(account.is_manual) && (
          <div>
            <label className="block text-xs text-muted mb-1">Current Balance</label>
            <input
              type="number"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-positive-5"
              value={form.current_balance}
              onChange={(e) => setForm({ ...form, current_balance: e.target.value })}
            />
          </div>
        )}
        <div>
          <label className="block text-xs text-muted mb-1">Color</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setForm({ ...form, color: c })}
                className="w-5 h-5 rounded-full transition-transform"
                style={{
                  backgroundColor: c,
                  outline: form.color === c ? '2px solid white' : 'none',
                  outlineOffset: '2px',
                  transform: form.color === c ? 'scale(1.15)' : 'scale(1)',
                }}
              />
            ))}
          </div>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            className="flex-1 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90 disabled:opacity-40"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Saving...' : 'Save Changes'}
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

// ─── Add Manual Account Modal ─────────────────────────────────────────────────

export function AddManualAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    account_name: '',
    institution_name: '',
    type: 'checking',
    current_balance: '',
    currency: 'USD',
    is_liability: false,
    color: CATEGORY_COLORS[0],
  });

  const mutation = useMutation({
    mutationFn: () => {
      const currentBalance = parseDecimalInput(form.current_balance);
      if (currentBalance === null) {
        throw new Error('Enter a valid current balance');
      }

      return accountsApi.createManual({
        ...form,
        current_balance: currentBalance,
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
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
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-positive-5"
            value={form.account_name}
            onChange={(e) => setForm({ ...form, account_name: e.target.value })}
            placeholder="My Savings"
          />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Institution (optional)</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-positive-5"
            value={form.institution_name}
            onChange={(e) => setForm({ ...form, institution_name: e.target.value })}
            placeholder="Chase"
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-xs text-muted mb-1">Account Type</label>
            <select
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-positive-5"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              {Object.entries(ACCOUNT_TYPE_LABELS).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_liability}
                onChange={(e) => setForm({ ...form, is_liability: e.target.checked })}
                className="rounded border-border text-positive focus:ring-positive-5"
              />
              <span className="text-sm text-text">Liability</span>
            </label>
          </div>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Current Balance</label>
          <input
            type="number"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-positive-5"
            value={form.current_balance}
            onChange={(e) => setForm({ ...form, current_balance: e.target.value })}
            placeholder="0.00"
          />
        </div>
        <div className="flex gap-3 pt-2">
          <button
            className="flex-1 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90 disabled:opacity-40"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Creating...' : 'Create Account'}
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

// ─── Main Accounts View ───────────────────────────────────────────────────────
