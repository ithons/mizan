import React, { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, Check, X, Trash2 } from 'lucide-react';
import { format, subMonths, addMonths } from 'date-fns';
import { budgetsApi, recurringApi, categoriesApi } from '../lib/api';
import { formatCurrency, formatDate, formatMonth, formatPercent } from '../lib/formatters';
import { FREQUENCY_LABELS } from '../lib/constants';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { CategoryBadge } from '../components/CategoryBadge';
import { PageLoader } from '../components/LoadingSpinner';

// ─── Budget Progress Bar ─────────────────────────────────────────────────────

function BudgetRow({
  budget,
  onEdit,
  onDelete,
}: {
  budget: any;
  onEdit: (id: string, amount: number) => void;
  onDelete: (id: string) => void;
}) {
  const spent = budget.spent ?? 0;
  const pct = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;
  const barColor = pct >= 100 ? '#e07070' : pct >= 80 ? '#d4a44c' : '#4ecba3';
  const remaining = budget.amount - spent;

  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(String(budget.amount));

  return (
    <div className="py-3 border-b border-border last:border-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <CategoryBadge
            name={budget.category_name ?? 'Unknown'}
            color={budget.category_color}
            icon={budget.category_icon}
            size="md"
          />
          {budget.rollover && budget.rollover_balance !== 0 && (
            <span className="text-xs text-muted font-mono">
              (+{formatCurrency(budget.rollover_balance)} rollover)
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">{formatPercent(pct)}</span>
          {editing ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                type="number"
                className="bg-background border border-border rounded px-2 py-0.5 text-xs text-text font-mono w-20 focus:outline-none"
                value={editVal}
                onChange={(e) => setEditVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { onEdit(budget.id, parseFloat(editVal) || 0); setEditing(false); }
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <button onClick={() => { onEdit(budget.id, parseFloat(editVal) || 0); setEditing(false); }}>
                <Check size={12} className="text-[#4ecba3]" />
              </button>
              <button onClick={() => setEditing(false)}>
                <X size={12} className="text-muted" />
              </button>
            </div>
          ) : (
            <button
              className="font-mono text-xs text-muted hover:text-text"
              onClick={() => { setEditing(true); setEditVal(String(budget.amount)); }}
            >
              {formatCurrency(spent)} / {formatCurrency(budget.amount)}
            </button>
          )}
          <button
            className="text-muted hover:text-[#e07070] transition-colors"
            onClick={() => onDelete(budget.id)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="h-2 bg-border rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: barColor }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-xs text-muted">
          {remaining >= 0 ? (
            <span className="text-[#4ecba3]">{formatCurrency(remaining)} remaining</span>
          ) : (
            <span className="text-[#e07070]">{formatCurrency(Math.abs(remaining))} over budget</span>
          )}
        </span>
      </div>
    </div>
  );
}

// ─── Add Budget Modal ─────────────────────────────────────────────────────────

function AddBudgetModal({
  open,
  onClose,
  month,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  month: string;
  categories: any[];
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    category_id: categories[0]?.id ?? '',
    amount: '',
    period: month,
    rollover: false,
  });

  const mutation = useMutation({
    mutationFn: () =>
      budgetsApi.upsert({
        ...form,
        amount: parseFloat(form.amount) || 0,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['budgets'] });
      addToast({ type: 'success', message: 'Budget saved' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add Budget">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-muted mb-1">Category</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.category_id}
            onChange={(e) => setForm({ ...form, category_id: e.target.value })}
          >
            {categories.filter((c) => !c.is_income).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Budget Amount</label>
          <input
            type="number"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-[#4ecba3]/50"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="0.00"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="rollover"
            className="accent-[#4ecba3]"
            checked={form.rollover}
            onChange={(e) => setForm({ ...form, rollover: e.target.checked })}
          />
          <label htmlFor="rollover" className="text-sm text-muted">Enable rollover</label>
        </div>
        <div className="flex gap-3 pt-1">
          <button
            className="flex-1 py-2 text-sm bg-[#4ecba3] text-[#0f0f11] font-medium rounded hover:opacity-90"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : 'Save Budget'}
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

// ─── Recurring Tab ────────────────────────────────────────────────────────────

function RecurringTab() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const { data: recurring = [] } = useQuery({
    queryKey: ['recurring'],
    queryFn: recurringApi.list,
  });

  const { data: upcoming = [] } = useQuery({
    queryKey: ['recurring', 'upcoming', 30],
    queryFn: () => recurringApi.upcoming(30),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });

  const confirmMutation = useMutation({
    mutationFn: recurringApi.confirm,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });

  const dismissMutation = useMutation({
    mutationFn: recurringApi.dismiss,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });

  const updateCatMutation = useMutation({
    mutationFn: ({ id, category_id }: { id: string; category_id: string }) =>
      recurringApi.update(id, { category_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });

  const confirmed = recurring.filter((r) => r.is_confirmed && r.is_active);
  const annualTotal = confirmed.reduce((sum, r) => {
    const multiplier = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, annual: 1 }[r.frequency] ?? 12;
    return sum + r.average_amount * multiplier;
  }, 0);

  return (
    <div className="space-y-6">
      {/* Annual total */}
      <div className="bg-surface border border-border rounded p-4 flex items-center justify-between">
        <span className="text-sm text-muted">Total Confirmed Annual Spend</span>
        <span className="font-mono text-xl text-[#e07070]">{formatCurrency(annualTotal)}</span>
      </div>

      {/* Recurring table */}
      <div className="bg-surface border border-border rounded overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-text">All Recurring</h3>
        </div>
        <table className="w-full text-xs">
          <thead className="border-b border-border">
            <tr>
              {['Merchant', 'Category', 'Frequency', 'Avg Amount', 'Next Expected', 'Annual Cost', 'Status', ''].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-muted font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recurring.map((r) => {
              const multiplier = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, annual: 1 }[r.frequency] ?? 12;
              const annual = r.average_amount * multiplier;
              const status = !r.is_active ? 'dismissed' : r.is_confirmed ? 'confirmed' : 'unconfirmed';

              return (
                <tr key={r.id} className="border-b border-border hover:bg-white/2">
                  <td className="px-4 py-2 text-text font-medium">{r.merchant_name}</td>
                  <td className="px-4 py-2">
                    <select
                      className="bg-transparent text-xs text-text focus:outline-none"
                      value={r.category_id ?? ''}
                      onChange={(e) => updateCatMutation.mutate({ id: r.id, category_id: e.target.value })}
                    >
                      <option value="">Uncategorized</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-muted">{FREQUENCY_LABELS[r.frequency]}</td>
                  <td className="px-4 py-2 font-mono text-text">{formatCurrency(r.average_amount)}</td>
                  <td className="px-4 py-2 font-mono text-muted">{formatDate(r.next_expected)}</td>
                  <td className="px-4 py-2 font-mono text-[#e07070]">{formatCurrency(annual)}</td>
                  <td className="px-4 py-2">
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: status === 'confirmed' ? 'rgba(78,203,163,0.15)' : status === 'dismissed' ? 'rgba(107,107,122,0.15)' : 'rgba(212,164,76,0.15)',
                        color: status === 'confirmed' ? '#4ecba3' : status === 'dismissed' ? '#6b6b7a' : '#d4a44c',
                      }}
                    >
                      {status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      {!r.is_confirmed && r.is_active && (
                        <button
                          className="text-xs text-[#4ecba3] hover:opacity-80"
                          onClick={() => confirmMutation.mutate(r.id)}
                        >
                          Confirm
                        </button>
                      )}
                      {r.is_active && (
                        <button
                          className="text-xs text-muted hover:text-[#e07070]"
                          onClick={() => dismissMutation.mutate(r.id)}
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {recurring.length === 0 && (
          <div className="py-10 text-center text-muted text-sm">No recurring transactions detected</div>
        )}
      </div>

      {/* Upcoming 30 days */}
      <div className="bg-surface border border-border rounded overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-text">Upcoming (Next 30 Days)</h3>
        </div>
        <div className="divide-y divide-border">
          {upcoming.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
              <div>
                <p className="text-sm text-text">{r.merchant_name}</p>
                <p className="text-xs text-muted font-mono">{formatDate(r.next_expected)}</p>
              </div>
              <span className="font-mono text-sm text-[#e07070]">{formatCurrency(r.average_amount)}</span>
            </div>
          ))}
          {upcoming.length === 0 && (
            <div className="py-8 text-center text-muted text-sm">Nothing upcoming in the next 30 days</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Budget View ─────────────────────────────────────────────────────────

export function Budget() {
  const now = new Date();
  const [tab, setTab] = useState<'monthly' | 'recurring'>('monthly');
  const [currentMonth, setCurrentMonth] = useState(format(now, 'yyyy-MM'));
  const [showAddModal, setShowAddModal] = useState(false);
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const { data: budgets = [], isLoading } = useQuery({
    queryKey: ['budgets', currentMonth],
    queryFn: () => budgetsApi.getMonth(currentMonth),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });

  const monthDate = new Date(`${currentMonth}-01`);

  const editMutation = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: number }) =>
      budgetsApi.upsert({ id, amount }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['budgets'] }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: budgetsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['budgets'] }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  // Summary stats
  const budgeted = budgets.reduce((sum, b) => sum + b.amount, 0);
  const spent = budgets.reduce((sum, b) => sum + (b.spent ?? 0), 0);
  const remaining = budgeted - spent;

  // Unbudgeted: categories with spending but no budget
  const budgetedCatIds = new Set(budgets.map((b) => b.category_id));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Budget</h1>
        <div className="flex gap-1 bg-surface border border-border rounded p-0.5">
          <button
            className={`px-3 py-1.5 text-xs rounded ${tab === 'monthly' ? 'bg-[#4ecba3]/10 text-[#4ecba3]' : 'text-muted hover:text-text'}`}
            onClick={() => setTab('monthly')}
          >
            Monthly
          </button>
          <button
            className={`px-3 py-1.5 text-xs rounded ${tab === 'recurring' ? 'bg-[#4ecba3]/10 text-[#4ecba3]' : 'text-muted hover:text-text'}`}
            onClick={() => setTab('recurring')}
          >
            Recurring
          </button>
        </div>
      </div>

      {tab === 'monthly' && (
        <>
          {/* Month selector */}
          <div className="flex items-center gap-2">
            <button
              className="p-1.5 text-muted hover:text-text border border-border rounded"
              onClick={() => setCurrentMonth(format(subMonths(monthDate, 1), 'yyyy-MM'))}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="font-mono text-sm text-text px-3 py-1 bg-surface border border-border rounded min-w-[120px] text-center">
              {formatMonth(currentMonth)}
            </span>
            <button
              className="p-1.5 text-muted hover:text-text border border-border rounded"
              onClick={() => setCurrentMonth(format(addMonths(monthDate, 1), 'yyyy-MM'))}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Summary bar */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-surface border border-border rounded p-4">
              <p className="text-xs text-muted mb-1">Budgeted</p>
              <p className="font-mono text-lg text-text">{formatCurrency(budgeted)}</p>
            </div>
            <div className="bg-surface border border-border rounded p-4">
              <p className="text-xs text-muted mb-1">Spent</p>
              <p className="font-mono text-lg text-[#e07070]">{formatCurrency(spent)}</p>
            </div>
            <div className="bg-surface border border-border rounded p-4">
              <p className="text-xs text-muted mb-1">Remaining</p>
              <p
                className="font-mono text-lg"
                style={{ color: remaining >= 0 ? '#4ecba3' : '#e07070' }}
              >
                {formatCurrency(remaining)}
              </p>
            </div>
          </div>

          {/* Budget list */}
          <div className="bg-surface border border-border rounded p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium text-text">Budgets</h2>
              <button
                className="flex items-center gap-1 text-xs text-[#4ecba3] hover:opacity-80"
                onClick={() => setShowAddModal(true)}
              >
                <Plus size={13} /> Add Budget
              </button>
            </div>

            {isLoading ? (
              <div className="py-8 text-center text-muted text-sm">Loading…</div>
            ) : budgets.length > 0 ? (
              budgets.map((budget) => (
                <BudgetRow
                  key={budget.id}
                  budget={budget}
                  onEdit={(id, amount) => editMutation.mutate({ id, amount })}
                  onDelete={(id) => deleteMutation.mutate(id)}
                />
              ))
            ) : (
              <div className="py-12 text-center text-muted text-sm">
                <p className="mb-2">No budgets set for {formatMonth(currentMonth)}</p>
                <button
                  className="text-[#4ecba3] text-xs hover:opacity-80"
                  onClick={() => setShowAddModal(true)}
                >
                  + Add your first budget
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'recurring' && <RecurringTab />}

      <AddBudgetModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        month={currentMonth}
        categories={categories}
      />
    </div>
  );
}
