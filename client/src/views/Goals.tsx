import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  Calendar,
  CheckCircle2,
  Landmark,
  Link2,
  Pencil,
  Plus,
  Sparkles,
  Target,
} from 'lucide-react';
import type { Account, Goal, GoalType } from '@shared/types';
import { accountsApi, goalsApi } from '../lib/api';
import { advisorRouteState } from '../lib/advisorRouteState';
import { buildGoalAdvisorPrompt } from '../lib/advisorPrompts';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { formatCurrency, formatDate } from '../lib/formatters';
import { parseDecimalInput } from '../lib/numberInput';
import { Modal } from '../components/Modal';
import { EmptyState } from '../components/EmptyState';
import { PageLoader } from '../components/LoadingSpinner';
import { useAppStore } from '../store';

const COLORS = ['#32bfa3', '#6487f0', '#f6c177', '#ef6f8a', '#b48ead'];

interface GoalFormState {
  name: string;
  type: GoalType;
  target_amount: string;
  current_amount: string;
  starting_amount: string;
  account_id: string;
  target_date: string;
  color: string;
}

function initialForm(goal?: Goal): GoalFormState {
  return {
    name: goal?.name ?? '',
    type: goal?.type ?? 'savings',
    target_amount: goal ? String(goal.target_amount) : '',
    current_amount: goal ? String(goal.current_amount) : '',
    starting_amount: goal?.starting_amount != null ? String(goal.starting_amount) : '',
    account_id: goal?.account_id ?? '',
    target_date: goal?.target_date ?? '',
    color: goal?.color ?? COLORS[0],
  };
}

function goalIcon(type: GoalType) {
  return type === 'debt' ? Landmark : Target;
}

function GoalCard({
  goal,
  onEdit,
  onArchive,
  onAsk,
}: {
  goal: Goal;
  onEdit: () => void;
  onArchive: () => void;
  onAsk: () => void;
}) {
  const Icon = goalIcon(goal.type);
  const complete = goal.progress_percent >= 100;

  return (
    <div className="border border-border bg-surface rounded p-4 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${goal.color ?? COLORS[0]}20`, color: goal.color ?? COLORS[0] }}
        >
          {complete ? <CheckCircle2 size={18} /> : <Icon size={18} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-text truncate">{goal.name}</h2>
            <span className="text-[10px] uppercase tracking-wide text-muted border border-border rounded px-1.5 py-0.5">
              {goal.type}
            </span>
          </div>
          {goal.account_name && (
            <div className="flex items-center gap-1.5 text-xs text-muted mt-1">
              <Link2 size={11} />
              <span className="truncate">{goal.institution_name ? `${goal.institution_name} · ` : ''}{goal.account_name}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="w-7 h-7 flex items-center justify-center rounded text-muted hover:text-green hover:bg-black/5"
            onClick={onAsk}
            title="Ask advisor"
          >
            <Sparkles size={14} />
          </button>
          <button
            className="w-7 h-7 flex items-center justify-center rounded text-muted hover:text-text hover:bg-black/5"
            onClick={onEdit}
            title="Edit goal"
          >
            <Pencil size={14} />
          </button>
          <button
            className="w-7 h-7 flex items-center justify-center rounded text-muted hover:text-text hover:bg-black/5"
            onClick={onArchive}
            title="Archive goal"
          >
            <Archive size={14} />
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <p className="text-xs text-muted">Progress</p>
            <p className="font-mono text-lg text-text">{formatCurrency(goal.progress_amount)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted">Target</p>
            <p className="font-mono text-sm text-muted">{formatCurrency(goal.target_amount)}</p>
          </div>
        </div>
        <div className="h-2 bg-background border border-border rounded overflow-hidden">
          <div
            className="h-full"
            style={{
              width: `${goal.progress_percent}%`,
              backgroundColor: goal.color ?? COLORS[0],
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-2 mt-2 text-xs">
          <span className="font-mono text-muted">{goal.progress_percent.toFixed(1)}%</span>
          <span className={complete ? 'text-green' : 'text-muted'}>
            {complete ? 'Complete' : `${formatCurrency(goal.remaining_amount)} left`}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-muted border-t border-border pt-3">
        {goal.target_date ? (
          <span className="flex items-center gap-1.5">
            <Calendar size={12} />
            {formatDate(goal.target_date)}
          </span>
        ) : (
          <span>No target date</span>
        )}
        {goal.account_balance != null && (
          <span className="font-mono">{formatCurrency(goal.account_balance)}</span>
        )}
      </div>
    </div>
  );
}

function GoalModal({
  open,
  goal,
  accounts,
  onClose,
  onSubmit,
  onInvalid,
}: {
  open: boolean;
  goal?: Goal;
  accounts: Account[];
  onClose: () => void;
  onSubmit: (body: Partial<Goal>) => void;
  onInvalid: (message: string) => void;
}) {
  const [form, setForm] = useState<GoalFormState>(() => initialForm(goal));
  const linkedAccount = accounts.find((account) => account.id === form.account_id);
  const manual = !form.account_id;

  useEffect(() => {
    if (open) setForm(initialForm(goal));
  }, [goal, open]);

  const submit = () => {
    const targetAmount = parseDecimalInput(form.target_amount);
    const currentAmount = parseDecimalInput(form.current_amount || '0');
    const startingAmount = form.starting_amount ? parseDecimalInput(form.starting_amount) : null;

    if (!form.name.trim()) {
      onInvalid('Name is required');
      return;
    }
    if (targetAmount === null || targetAmount <= 0) {
      onInvalid('Enter a valid target amount');
      return;
    }
    if (manual && (currentAmount === null || currentAmount < 0)) {
      onInvalid('Enter a valid current amount');
      return;
    }
    if (form.type === 'debt' && startingAmount !== null && startingAmount < 0) {
      onInvalid('Enter a valid starting balance');
      return;
    }

    onSubmit({
      name: form.name.trim(),
      type: form.type,
      target_amount: targetAmount,
      current_amount: manual ? currentAmount ?? 0 : 0,
      starting_amount: form.type === 'debt' ? startingAmount : null,
      account_id: form.account_id || null,
      target_date: form.target_date || null,
      color: form.color,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={goal ? 'Edit Goal' : 'New Goal'}>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-muted mb-1">Name</label>
          <input
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Emergency fund"
          />
        </div>

        <div>
          <label className="block text-xs text-muted mb-1">Type</label>
          <div className="grid grid-cols-2 gap-2">
            {(['savings', 'debt'] as GoalType[]).map((type) => {
              const Icon = goalIcon(type);
              const active = form.type === type;
              return (
                <button
                  key={type}
                  className={`flex items-center justify-center gap-2 border rounded px-3 py-2 text-sm capitalize ${
                    active
                      ? 'border-green-50 bg-green-10 text-green'
                      : 'border-border text-muted hover:text-text'
                  }`}
                  onClick={() => setForm({ ...form, type })}
                >
                  <Icon size={14} />
                  {type}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted mb-1">Target Amount</label>
            <input
              type="number"
              step="0.01"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
              value={form.target_amount}
              onChange={(e) => setForm({ ...form, target_amount: e.target.value })}
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Target Date</label>
            <input
              type="date"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
              value={form.target_date}
              onChange={(e) => setForm({ ...form, target_date: e.target.value })}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-muted mb-1">Linked Account</label>
          <select
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
            value={form.account_id}
            onChange={(e) => {
              const account = accounts.find((candidate) => candidate.id === e.target.value);
              setForm({
                ...form,
                account_id: e.target.value,
                type: account?.is_liability ? 'debt' : form.type,
                starting_amount: account?.is_liability ? String(account.current_balance) : form.starting_amount,
              });
            }}
          >
            <option value="">Manual progress</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.institution_name ? `${account.institution_name} · ` : ''}{account.account_name}
              </option>
            ))}
          </select>
        </div>

        {manual && (
          <div>
            <label className="block text-xs text-muted mb-1">Current Amount</label>
            <input
              type="number"
              step="0.01"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
              value={form.current_amount}
              onChange={(e) => setForm({ ...form, current_amount: e.target.value })}
              placeholder="0.00"
            />
          </div>
        )}

        {form.type === 'debt' && (
          <div>
            <label className="block text-xs text-muted mb-1">Starting Balance</label>
            <input
              type="number"
              step="0.01"
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-text font-mono focus:outline-none focus:ring-1 focus:ring-green-50"
              value={form.starting_amount}
              onChange={(e) => setForm({ ...form, starting_amount: e.target.value })}
              placeholder={linkedAccount ? String(linkedAccount.current_balance) : '0.00'}
            />
          </div>
        )}

        <div>
          <label className="block text-xs text-muted mb-2">Color</label>
          <div className="flex gap-2">
            {COLORS.map((color) => (
              <button
                key={color}
                className={`w-7 h-7 rounded border ${form.color === color ? 'border-text' : 'border-border'}`}
                style={{ backgroundColor: color }}
                onClick={() => setForm({ ...form, color })}
                title={color}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            className="px-4 py-2 text-xs text-muted border border-border rounded hover:text-text"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="flex items-center gap-1.5 px-4 py-2 text-xs bg-text text-surface font-medium rounded hover:opacity-90"
            onClick={submit}
          >
            <Target size={13} />
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Goals() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [open, setOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | undefined>();

  const { data: goals = [], isLoading } = useQuery({
    queryKey: ['goals'],
    queryFn: goalsApi.list,
  });

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const totals = useMemo(() => {
    const target = goals.reduce((sum, goal) => sum + goal.target_amount, 0);
    const progress = goals.reduce((sum, goal) => sum + goal.progress_amount, 0);
    return {
      target,
      progress,
      percent: target > 0 ? Math.min((progress / target) * 100, 100) : 0,
    };
  }, [goals]);

  const createMutation = useMutation({
    mutationFn: (body: Partial<Goal>) => goalsApi.create(body),
    onSuccess: () => {
      invalidateFinancialData(qc);
      setOpen(false);
      addToast({ type: 'success', message: 'Goal saved' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Goal> }) => goalsApi.update(id, body),
    onSuccess: () => {
      invalidateFinancialData(qc);
      setOpen(false);
      setEditingGoal(undefined);
      addToast({ type: 'success', message: 'Goal updated' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => goalsApi.update(id, { is_archived: true }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Goal archived' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const handleSubmit = (body: Partial<Goal>) => {
    if (editingGoal) {
      updateMutation.mutate({ id: editingGoal.id, body });
    } else {
      createMutation.mutate(body);
    }
  };

  const openNewGoal = () => {
    setEditingGoal(undefined);
    setOpen(true);
  };

  const openEditGoal = (goal: Goal) => {
    setEditingGoal(goal);
    setOpen(true);
  };

  const askAdvisorAboutGoal = (goal: Goal) => {
    navigate('/advisor', {
      state: advisorRouteState(buildGoalAdvisorPrompt(goal)),
    });
  };

  if (isLoading) return <PageLoader />;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Goals</h1>
          <p className="text-xs text-muted mt-1 font-mono">
            {formatCurrency(totals.progress)} / {formatCurrency(totals.target)}
          </p>
        </div>
        <button
          className="flex items-center gap-1.5 text-xs bg-text text-surface font-medium rounded px-3 py-1.5 hover:opacity-90"
          onClick={openNewGoal}
        >
          <Plus size={13} />
          New Goal
        </button>
      </div>

      {goals.length > 0 && (
        <div className="border border-border bg-surface rounded p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <p className="text-xs text-muted">Total Progress</p>
              <p className="font-mono text-2xl text-text">{totals.percent.toFixed(1)}%</p>
            </div>
            <p className="text-xs text-muted">{goals.length} active</p>
          </div>
          <div className="h-2 bg-background border border-border rounded overflow-hidden">
            <div className="h-full bg-green" style={{ width: `${totals.percent}%` }} />
          </div>
        </div>
      )}

      {goals.length === 0 ? (
        <div className="border border-border bg-surface rounded">
          <EmptyState
            icon={Target}
            title="No active goals"
            action={openNewGoal}
            actionLabel="New Goal"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              onEdit={() => openEditGoal(goal)}
              onArchive={() => archiveMutation.mutate(goal.id)}
              onAsk={() => askAdvisorAboutGoal(goal)}
            />
          ))}
        </div>
      )}

      <GoalModal
        open={open}
        goal={editingGoal}
        accounts={accounts}
        onClose={() => {
          setOpen(false);
          setEditingGoal(undefined);
        }}
        onSubmit={handleSubmit}
        onInvalid={(message) => addToast({ type: 'error', message })}
      />
    </div>
  );
}
