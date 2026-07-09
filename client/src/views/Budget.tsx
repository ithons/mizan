import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, Check, X, Trash2, WalletCards, Sparkles } from 'lucide-react';
import { format, subMonths, addMonths } from 'date-fns';
import { budgetsApi, recurringApi, categoriesApi, flattenCategories } from '../lib/api';
import { formatCurrency, formatDate, formatMonth, formatPercent } from '../lib/formatters';
import { FREQUENCY_LABELS } from '../lib/constants';
import { useAppStore } from '../store';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { advisorRouteState } from '../lib/advisorRouteState';
import {
  buildBudgetAdvisorPrompt,
  buildBudgetGroupAdvisorPrompt,
  buildRolloverLedgerAdvisorPrompt,
} from '../lib/advisorPrompts';
import {
  availableBudgetAmount,
  budgetProjectedPercent,
  budgetProjectedRemaining,
  budgetProjectedSpend,
} from '../lib/budgetMath';
import { Modal } from '../components/Modal';
import { CategoryBadge } from '../components/CategoryBadge';
import { EmptyState } from '../components/EmptyState';
import { PageLoader } from '../components/LoadingSpinner';
import type {
  Budget as BudgetModel,
  BudgetGroup,
  BudgetRolloverLedgerEntry,
  Category,
} from '@shared/types';

// ─── Budget Progress Bar ─────────────────────────────────────────────────────

function BudgetRow({
  budget,
  month,
  onEdit,
  onDelete,
  onAsk,
  onLedger,
  onRemoveFromGroup,
}: {
  budget: BudgetModel;
  month: string;
  onEdit: (categoryId: string, amount: number) => void;
  onDelete: (id: string) => void;
  onAsk: (budget: BudgetModel, month: string) => void;
  onLedger?: (budget: BudgetModel) => void;
  onRemoveFromGroup?: (budget: BudgetModel) => void;
}) {
  const spent = budget.spent ?? 0;
  const rolloverBalance = budget.rollover ? budget.rollover_balance : 0;
  const availableAmount = availableBudgetAmount(budget);
  const projectedSpend = budgetProjectedSpend(budget);
  const expectedRecurring = budget.expected_recurring ?? 0;
  const projectedPct = budgetProjectedPercent(budget);
  const actualPct = availableAmount > 0 ? (spent / availableAmount) * 100 : 0;
  const barColor = projectedPct >= 100 ? '#b5654a' : projectedPct >= 80 ? '#ce8642' : '#c9963a';
  const remaining = availableAmount - spent;
  const projectedRemaining = budgetProjectedRemaining(budget);

  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(String(budget.amount));
  const commitEdit = () => {
    const amount = parseDecimalInput(editVal);
    if (amount === null || amount <= 0) return;
    onEdit(budget.category_id, amount);
    setEditing(false);
  };

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
          {rolloverBalance !== 0 && (
            <span className="text-xs text-muted font-mono">
              ({rolloverBalance > 0 ? '+' : ''}{formatCurrency(rolloverBalance)} rollover)
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">{formatPercent(projectedPct)}</span>
          <button
            className="text-muted hover:text-info transition-colors"
            onClick={() => onAsk(budget, month)}
            title="Ask advisor"
          >
            <Sparkles size={12} />
          </button>
          {Boolean(budget.rollover) && onLedger && (
            <button
              className="font-mono text-xs text-muted hover:text-text"
              onClick={() => onLedger(budget)}
            >
              Ledger
            </button>
          )}
          {onRemoveFromGroup && (
            <button
              className="font-mono text-xs text-muted hover:text-text"
              onClick={() => onRemoveFromGroup(budget)}
            >
              Ungroup
            </button>
          )}
          {editing ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                type="number"
                className="bg-background border border-border rounded px-2 py-0.5 text-xs text-text font-mono w-20 focus:outline-none"
                value={editVal}
                onChange={(e) => setEditVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <button onClick={commitEdit}>
                <Check size={12} className="text-positive" />
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
              {formatCurrency(projectedSpend)} / {formatCurrency(availableAmount)}
            </button>
          )}
          <button
            className="text-muted hover:text-negative transition-colors"
            onClick={() => onDelete(budget.id)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="h-2 bg-border rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all relative"
          style={{ width: `${Math.min(projectedPct, 100)}%`, backgroundColor: barColor }}
        />
      </div>
      {expectedRecurring > 0 && actualPct < projectedPct && (
        <div className="h-2 -mt-2 pointer-events-none">
          <div
            className="h-full bg-white/20 rounded-full"
            style={{ width: `${Math.min(actualPct, 100)}%` }}
          />
        </div>
      )}
      <div className="flex justify-between mt-1 gap-3">
        <span className="text-xs text-muted">
          {remaining >= 0 ? (
            <span className="text-positive">{formatCurrency(remaining)} remaining</span>
          ) : (
            <span className="text-negative">{formatCurrency(Math.abs(remaining))} over budget</span>
          )}
        </span>
        <span className="text-xs text-muted text-right">
          {expectedRecurring > 0 ? (
            <>
              {formatCurrency(expectedRecurring)} expected,{' '}
              <span style={{ color: projectedRemaining >= 0 ? '#c9963a' : '#b5654a' }}>
                {projectedRemaining >= 0
                  ? `${formatCurrency(projectedRemaining)} projected left`
                  : `${formatCurrency(Math.abs(projectedRemaining))} projected over`}
              </span>
            </>
          ) : (
            <span>No recurring forecast</span>
          )}
        </span>
      </div>
    </div>
  );
}

function BudgetGroupSection({
  group,
  budgets,
  availableBudgets,
  month,
  onEdit,
  onDeleteBudget,
  onAsk,
  onLedger,
  onRename,
  onDeleteGroup,
  onSetMembers,
  onAskGroup,
}: {
  group: BudgetGroup;
  budgets: BudgetModel[];
  availableBudgets: BudgetModel[];
  month: string;
  onEdit: (categoryId: string, amount: number) => void;
  onDeleteBudget: (id: string) => void;
  onAsk: (budget: BudgetModel, month: string) => void;
  onLedger: (budget: BudgetModel) => void;
  onRename: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onSetMembers: (id: string, categoryIds: string[]) => void;
  onAskGroup: (group: BudgetGroup, month: string) => void;
}) {
  const [name, setName] = useState(group.name);
  const memberIds = group.members.map((member) => member.category_id);
  const projectedRemaining = group.totals.projected_remaining;

  useEffect(() => {
    setName(group.name);
  }, [group.name]);

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== group.name) onRename(group.id, trimmed);
    else setName(group.name);
  };

  return (
    <div className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-4 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: group.color ?? '#c9963a' }}
          />
          <input
            className="bg-transparent text-sm font-medium text-text focus:outline-none focus:ring-1 focus:ring-positive-5 rounded px-1 py-0.5"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitName();
              if (event.key === 'Escape') setName(group.name);
            }}
          />
          <span className="text-xs text-muted font-mono">{group.totals.budget_count} budgets</span>
          <button
            className="text-muted hover:text-info transition-colors"
            onClick={() => onAskGroup(group, month)}
            title="Ask advisor"
          >
            <Sparkles size={12} />
          </button>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="font-mono text-muted">{formatCurrency(group.totals.projected_spend)} projected</span>
          <span
            className="font-mono"
            style={{ color: projectedRemaining >= 0 ? '#c9963a' : '#b5654a' }}
          >
            {formatCurrency(projectedRemaining)} left
          </span>
          <button
            className="text-muted hover:text-negative"
            onClick={() => onDeleteGroup(group.id)}
          >
            Delete
          </button>
        </div>
      </div>

      {availableBudgets.length > 0 && (
        <select
          className="mb-2 bg-background border border-border rounded px-2 py-1 text-xs text-text focus:outline-none"
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            onSetMembers(group.id, [...memberIds, event.target.value]);
          }}
        >
          <option value="">Add category budget</option>
          {availableBudgets.map((budget) => (
            <option key={budget.id} value={budget.category_id}>
              {budget.category_name ?? budget.category_id}
            </option>
          ))}
        </select>
      )}

      {budgets.length > 0 ? (
        budgets.map((budget) => (
          <BudgetRow
            key={budget.id}
            budget={budget}
            month={month}
            onEdit={onEdit}
            onDelete={onDeleteBudget}
            onAsk={onAsk}
            onLedger={onLedger}
            onRemoveFromGroup={(item) =>
              onSetMembers(group.id, memberIds.filter((categoryId) => categoryId !== item.category_id))
            }
          />
        ))
      ) : (
        <p className="text-xs text-muted py-3">No category budgets in this group yet.</p>
      )}
    </div>
  );
}

function RolloverLedgerModal({
  budget,
  month,
  onClose,
  onAskRow,
}: {
  budget: BudgetModel | null;
  month: string;
  onClose: () => void;
  onAskRow: (row: BudgetRolloverLedgerEntry) => void;
}) {
  const { data: ledger = [] } = useQuery({
    queryKey: ['budgets', 'rollover-ledger', budget?.id, month],
    queryFn: () => budgetsApi.rolloverLedger({ budgetId: budget?.id, month, months: 12 }),
    enabled: Boolean(budget),
  });

  return (
    <Modal open={Boolean(budget)} onClose={onClose} title="Rollover Ledger">
      <div className="space-y-3">
        <p className="text-sm text-text">{budget?.category_name ?? 'Budget'}</p>
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-background/40">
              <tr>
                {['Month', 'Starting', 'Budget', 'Spent', 'Ending'].map((label) => (
                  <th key={label} className="text-left px-3 py-2 text-muted font-medium">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ledger.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-mono text-text">{row.month}</td>
                  <td className="px-3 py-2 font-mono text-muted">{formatCurrency(row.starting_rollover)}</td>
                  <td className="px-3 py-2 font-mono text-muted">{formatCurrency(row.budget_amount)}</td>
                  <td className="px-3 py-2 font-mono text-negative">{formatCurrency(row.actual_spend)}</td>
                  <td className="px-3 py-2 font-mono text-text">
                    <div className="flex items-center justify-between gap-2">
                      <span>{formatCurrency(row.ending_rollover)}</span>
                      <button
                        className="text-muted hover:text-info transition-colors"
                        onClick={() => onAskRow(row)}
                        title="Ask advisor"
                      >
                        <Sparkles size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {ledger.length === 0 && (
            <p className="text-xs text-muted text-center py-6">No rollover ledger rows for this budget.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Add Budget Modal ─────────────────────────────────────────────────────────

function AddBudgetModal({
  open,
  onClose,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState({
    category_id: categories[0]?.id ?? '',
    amount: '',
    rollover: false,
  });

  useEffect(() => {
    if (!open) return;
    const defaultCategory = categories.find((c) => !c.is_income)?.id ?? categories[0]?.id ?? '';
    setForm({
      category_id: defaultCategory,
      amount: '',
      rollover: false,
    });
  }, [categories, open]);

  const mutation = useMutation({
    mutationFn: () => {
      const amount = parseDecimalInput(form.amount);
      if (amount === null || amount <= 0) {
        throw new Error('Enter a valid budget amount');
      }

      return budgetsApi.upsert(form.category_id, {
        amount,
        rollover: form.rollover,
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
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
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-positive-5"
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
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-positive-5"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="0.00"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="rollover"
            className="accent-positive"
            checked={form.rollover}
            onChange={(e) => setForm({ ...form, rollover: e.target.checked })}
          />
          <label htmlFor="rollover" className="text-sm text-muted">Enable rollover</label>
        </div>
        <div className="flex gap-3 pt-1">
          <button
            className="flex-1 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Saving...' : 'Save Budget'}
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

  const { data: categoriesTree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const categories = flattenCategories(categoriesTree);

  const confirmMutation = useMutation({
    mutationFn: recurringApi.confirm,
    onSuccess: () => invalidateFinancialData(qc),
  });

  const dismissMutation = useMutation({
    mutationFn: recurringApi.dismiss,
    onSuccess: () => invalidateFinancialData(qc),
  });

  const updateCatMutation = useMutation({
    mutationFn: ({ id, category_id }: { id: string; category_id: string }) =>
      recurringApi.update(id, { category_id }),
    onSuccess: () => invalidateFinancialData(qc),
  });

  const confirmed = recurring.filter((r) => r.is_confirmed && r.is_active);
  const annualTotal = confirmed.reduce((sum, r) => {
    const multiplier = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, annual: 1 }[r.frequency] ?? 12;
    return sum + r.average_amount * multiplier;
  }, 0);

  return (
    <div className="space-y-6">
      {/* Annual total */}
      <div className="bg-surface shadow-sm border border-border rounded p-4 flex items-center justify-between">
        <span className="text-sm text-muted">Total Confirmed Annual Spend</span>
        <span className="font-mono text-xl text-negative">{formatCurrency(annualTotal)}</span>
      </div>

      {/* Recurring table */}
      <div className="bg-surface shadow-sm border border-border rounded overflow-hidden">
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
                <tr key={r.id} className="border-b border-border hover:bg-black/5">
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
                  <td className="px-4 py-2 font-mono text-negative">{formatCurrency(annual)}</td>
                  <td className="px-4 py-2">
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: status === 'confirmed' ? 'rgba(78,203,163,0.15)' : status === 'dismissed' ? 'rgba(107,107,122,0.15)' : 'rgba(212,164,76,0.15)',
                        color: status === 'confirmed' ? '#c9963a' : status === 'dismissed' ? '#7a6c5d' : '#ce8642',
                      }}
                    >
                      {status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      {!r.is_confirmed && r.is_active && (
                        <button
                          className="text-xs text-positive hover:opacity-80"
                          onClick={() => confirmMutation.mutate(r.id)}
                        >
                          Confirm
                        </button>
                      )}
                      {Boolean(r.is_active) && (
                        <button
                          className="text-xs text-muted hover:text-negative"
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
      <div className="bg-surface shadow-sm border border-border rounded overflow-hidden">
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
              <span className="font-mono text-sm text-negative">{formatCurrency(r.average_amount)}</span>
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
  const navigate = useNavigate();
  const now = new Date();
  const [tab, setTab] = useState<'monthly' | 'recurring'>('monthly');
  const [currentMonth, setCurrentMonth] = useState(format(now, 'yyyy-MM'));
  const [showAddModal, setShowAddModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [ledgerBudget, setLedgerBudget] = useState<BudgetModel | null>(null);
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const { data: budgets = [], isLoading } = useQuery({
    queryKey: ['budgets', currentMonth],
    queryFn: () => budgetsApi.getMonth(currentMonth),
  });

  const { data: groups = [] } = useQuery({
    queryKey: ['budgets', 'groups', currentMonth],
    queryFn: () => budgetsApi.groups(currentMonth),
  });

  const { data: categoriesTree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const categories = flattenCategories(categoriesTree);

  const monthDate = new Date(`${currentMonth}-01`);

  const editMutation = useMutation({
    mutationFn: ({ categoryId, amount }: { categoryId: string; amount: number }) =>
      budgetsApi.upsert(categoryId, { amount }),
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: budgetsApi.delete,
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const createGroupMutation = useMutation({
    mutationFn: () => budgetsApi.createGroup({ name: newGroupName }),
    onSuccess: () => {
      setNewGroupName('');
      invalidateFinancialData(qc);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const renameGroupMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      budgetsApi.updateGroup(id, { name }),
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteGroupMutation = useMutation({
    mutationFn: budgetsApi.deleteGroup,
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const groupMembersMutation = useMutation({
    mutationFn: ({ id, categoryIds }: { id: string; categoryIds: string[] }) =>
      budgetsApi.setGroupMembers(id, categoryIds),
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  // Summary stats
  const budgeted = budgets.reduce((sum, b) => sum + availableBudgetAmount(b), 0);
  const spent = budgets.reduce((sum, b) => sum + (b.spent ?? 0), 0);
  const expectedRecurring = budgets.reduce((sum, b) => sum + (b.expected_recurring ?? 0), 0);
  const projectedSpend = budgets.reduce((sum, b) => sum + budgetProjectedSpend(b), 0);
  const remaining = budgeted - spent;
  const projectedRemaining = budgeted - projectedSpend;

  // Unbudgeted: categories with spending but no budget
  const budgetedCatIds = new Set(budgets.map((b) => b.category_id));
  const groupedCategoryIds = new Set(groups.flatMap((group) =>
    group.members.map((member) => member.category_id)
  ));
  const groupedBudgets = new Map(groups.map((group) => [
    group.id,
    budgets.filter((budget) => group.members.some((member) => member.category_id === budget.category_id)),
  ]));
  const ungroupedBudgets = budgets.filter((budget) => !groupedCategoryIds.has(budget.category_id));
  const askAdvisorAboutBudget = (budget: BudgetModel, month: string) => {
    navigate('/advisor', {
      state: advisorRouteState(buildBudgetAdvisorPrompt(budget, month)),
    });
  };
  const askAdvisorAboutBudgetGroup = (group: BudgetGroup, month: string) => {
    navigate('/advisor', {
      state: advisorRouteState(buildBudgetGroupAdvisorPrompt(group, month)),
    });
  };
  const askAdvisorAboutRolloverLedger = (row: BudgetRolloverLedgerEntry) => {
    navigate('/advisor', {
      state: advisorRouteState(buildRolloverLedgerAdvisorPrompt(row)),
    });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Budget</h1>
        <div className="flex gap-1 bg-surface shadow-sm border border-border rounded p-0.5">
          <button
            className={`px-3 py-1.5 text-xs rounded ${tab === 'monthly' ? 'bg-positive-10 text-positive' : 'text-muted hover:text-text'}`}
            onClick={() => setTab('monthly')}
          >
            Monthly
          </button>
          <button
            className={`px-3 py-1.5 text-xs rounded ${tab === 'recurring' ? 'bg-positive-10 text-positive' : 'text-muted hover:text-text'}`}
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
            <span className="font-mono text-sm text-text px-3 py-1 bg-surface shadow-sm border border-border rounded min-w-[120px] text-center">
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
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-surface shadow-sm border border-border rounded p-4">
              <p className="text-xs text-muted mb-1">Budgeted</p>
              <p className="font-mono text-lg text-text">{formatCurrency(budgeted)}</p>
            </div>
            <div className="bg-surface shadow-sm border border-border rounded p-4">
              <p className="text-xs text-muted mb-1">Spent</p>
              <p className="font-mono text-lg text-negative">{formatCurrency(spent)}</p>
            </div>
            <div className="bg-surface shadow-sm border border-border rounded p-4">
              <p className="text-xs text-muted mb-1">Remaining</p>
              <p
                className="font-mono text-lg"
                style={{ color: remaining >= 0 ? '#c9963a' : '#b5654a' }}
              >
                {formatCurrency(remaining)}
              </p>
            </div>
            <div className="bg-surface shadow-sm border border-border rounded p-4">
              <p className="text-xs text-muted mb-1">Projected</p>
              <p
                className="font-mono text-lg"
                style={{ color: projectedRemaining >= 0 ? '#c9963a' : '#b5654a' }}
              >
                {formatCurrency(projectedSpend)}
              </p>
              {expectedRecurring > 0 && (
                <p className="text-xs text-muted mt-1">
                  {formatCurrency(expectedRecurring)} expected
                </p>
              )}
            </div>
          </div>

          {/* Budget list */}
          <div className="bg-surface shadow-sm border border-border rounded p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium text-text">Budgets</h2>
              <button
                className="flex items-center gap-1 text-xs text-positive hover:opacity-80"
                onClick={() => setShowAddModal(true)}
              >
                <Plus size={13} /> Add Budget
              </button>
            </div>

            <div className="flex items-center gap-2 mb-4">
              <input
                className="bg-background border border-border rounded px-3 py-1.5 text-xs text-text focus:outline-none focus:ring-1 focus:ring-positive-5 min-w-[220px]"
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && newGroupName.trim()) createGroupMutation.mutate();
                }}
                placeholder="New budget group"
              />
              <button
                className="flex items-center gap-1.5 text-xs border border-border rounded px-2.5 py-1.5 text-muted hover:text-text disabled:opacity-40"
                onClick={() => createGroupMutation.mutate()}
                disabled={!newGroupName.trim() || createGroupMutation.isPending}
              >
                <Plus size={12} />
                Add Group
              </button>
            </div>

            {isLoading ? (
              <div className="py-8 text-center text-muted text-sm">Loading...</div>
            ) : budgets.length > 0 ? (
              <div className="space-y-5">
                {groups.map((group) => (
                  <BudgetGroupSection
                    key={group.id}
                    group={group}
                    budgets={groupedBudgets.get(group.id) ?? []}
                    availableBudgets={ungroupedBudgets}
                    month={currentMonth}
                    onEdit={(categoryId, amount) => editMutation.mutate({ categoryId, amount })}
                    onDeleteBudget={(id) => deleteMutation.mutate(id)}
                    onAsk={askAdvisorAboutBudget}
                    onLedger={setLedgerBudget}
                    onRename={(id, name) => renameGroupMutation.mutate({ id, name })}
                    onDeleteGroup={(id) => deleteGroupMutation.mutate(id)}
                    onSetMembers={(id, categoryIds) => groupMembersMutation.mutate({ id, categoryIds })}
                    onAskGroup={askAdvisorAboutBudgetGroup}
                  />
                ))}

                {ungroupedBudgets.length > 0 && (
                  <div className="border-t border-border pt-4 first:border-t-0 first:pt-0">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-sm font-medium text-text">Ungrouped</h3>
                      <span className="text-xs text-muted font-mono">{ungroupedBudgets.length} budgets</span>
                    </div>
                    {ungroupedBudgets.map((budget) => (
                      <BudgetRow
                        key={budget.id}
                        budget={budget}
                        month={currentMonth}
                        onEdit={(categoryId, amount) => editMutation.mutate({ categoryId, amount })}
                        onDelete={(id) => deleteMutation.mutate(id)}
                        onAsk={askAdvisorAboutBudget}
                        onLedger={setLedgerBudget}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <EmptyState
                icon={WalletCards}
                title={`No budgets set for ${formatMonth(currentMonth)}`}
                description="Create category limits, then compare them against projected recurring activity."
                action={() => setShowAddModal(true)}
                actionLabel="Add Budget"
                secondaryAction={() => setTab('recurring')}
                secondaryActionLabel="Review Recurring"
              />
            )}
          </div>
        </>
      )}

      {tab === 'recurring' && <RecurringTab />}

      <AddBudgetModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        categories={categories}
      />
      <RolloverLedgerModal
        budget={ledgerBudget}
        month={currentMonth}
        onClose={() => setLedgerBudget(null)}
        onAskRow={askAdvisorAboutRolloverLedger}
      />
    </div>
  );
}
