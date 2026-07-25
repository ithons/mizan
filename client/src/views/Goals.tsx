import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import type { Goal } from '@shared/types';
import { accountsApi, goalsApi, recurringApi } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { buildGoalForecastSummary, type GoalForecastInsight } from '../lib/goalForecast';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import { Screen, ScreenHeader, ProgressBar, InkButton, TextButton } from '../components/balance';

function goalNote(goal: Goal, insight?: GoalForecastInsight): string {
  const projectedMonthly = insight?.projected_monthly_contribution ?? 0;
  const parts: string[] = [];

  if (projectedMonthly > 0 && goal.remaining_amount > 0) {
    parts.push(`≈${formatWholeCurrency(projectedMonthly)} / month`);
  }

  if (goal.remaining_amount <= 0) {
    parts.push('complete');
  } else {
    // The target date is what the user ASKED for; the projection is what the contribution rate
    // actually buys. Showing the target as "full by <date>" claimed the goal would be funded by
    // then even when the forecast said otherwise — so the two are now labelled separately.
    if (goal.target_date) {
      parts.push(`target ${format(parseISO(goal.target_date), 'MMM yyyy')}`);
    }
    if (insight?.projected_completion_date) {
      parts.push(`projected ${format(parseISO(insight.projected_completion_date), 'MMM yyyy')}`);
    } else if (insight?.status === 'blocked') {
      parts.push('no projected date at this rate');
    } else if (!goal.target_date && goal.progress_amount <= 0) {
      parts.push('just started');
    }
  }

  return parts.join(' · ') || (goal.account_name ? `funded from ${goal.account_name}` : 'no target date');
}

function GoalModal({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: Goal | null }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const [form, setForm] = useState({
    name: '',
    target_amount: '',
    current_amount: '',
    target_date: '',
    account_id: '',
  });

  useEffect(() => {
    setForm({
      name: editing?.name ?? '',
      target_amount: editing ? String(editing.target_amount) : '',
      current_amount: editing ? String(editing.current_amount) : '',
      target_date: editing?.target_date ?? '',
      account_id: editing?.account_id ?? '',
    });
  }, [editing, open]);

  const save = useMutation({
    mutationFn: () => {
      const target = parseDecimalInput(form.target_amount);
      if (!form.name.trim()) throw new Error('Give the goal a name');
      if (target === null || target <= 0) throw new Error('Enter a valid target amount');
      const current = form.current_amount ? parseDecimalInput(form.current_amount) : 0;
      const body = {
        name: form.name.trim(),
        type: 'savings' as const,
        target_amount: target,
        current_amount: current ?? 0,
        target_date: form.target_date || null,
        account_id: form.account_id || null,
      };
      return editing ? goalsApi.update(editing.id, body) : goalsApi.create(body);
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: editing ? 'Goal updated' : 'Goal created' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const archive = useMutation({
    mutationFn: () => goalsApi.update(editing!.id, { is_archived: true }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Goal archived' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${editing.name}` : 'New goal'}>
      <div className="space-y-4">
        <div>
          <label className="mz-label">Name</label>
          <input className="mz-field" placeholder="Emergency fund" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Target amount</label>
            <input
              type="number"
              className="mz-field tabular-nums"
              placeholder="10,000"
              value={form.target_amount}
              onChange={(e) => setForm({ ...form, target_amount: e.target.value })}
            />
          </div>
          <div className="flex-1">
            <label className="mz-label">Saved so far</label>
            <input
              type="number"
              className="mz-field tabular-nums"
              placeholder="0.00"
              value={form.current_amount}
              onChange={(e) => setForm({ ...form, current_amount: e.target.value })}
            />
          </div>
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Target date</label>
            <input type="date" className="mz-field" value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} />
          </div>
          <div className="flex-1">
            <label className="mz-label">Linked account</label>
            <select className="mz-field" value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
              <option value="">None</option>
              {(accounts ?? [])
                .filter((a) => !a.is_hidden)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.account_name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create goal'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
          {editing && (
            <TextButton onClick={() => archive.mutate()} disabled={archive.isPending} className="ml-auto">
              Archive
            </TextButton>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function Goals() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const goalsQ = useQuery({ queryKey: ['goals', 'all'], queryFn: () => goalsApi.list({ includeArchived: true }) });
  const goals = goalsQ.data;
  const forecastQ = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const forecast = forecastQ.data;

  // A failed request used to render as an empty section, indistinguishable from no data.
  const failableQueries = [
    { query: goalsQ, label: 'goals' },
    { query: forecastQ, label: 'recurring forecast' },
  ];

  const restore = useMutation({
    mutationFn: (goal: Goal) => goalsApi.update(goal.id, { is_archived: false }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Goal restored' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const active = useMemo(() => (goals ?? []).filter((g) => !g.is_archived), [goals]);
  const archived = useMemo(() => (goals ?? []).filter((g) => g.is_archived), [goals]);
  const totalSaved = active.reduce((s, g) => s + g.progress_amount, 0);
  const totalTarget = active.reduce((s, g) => s + g.target_amount, 0);

  const forecastSummary = useMemo(
    () => buildGoalForecastSummary({ goals: active, forecast: forecast ?? undefined }),
    [active, forecast]
  );
  const insightByGoal = new Map(forecastSummary.insights.map((i) => [i.goal_id, i]));

  return (
    <Screen>
      <ScreenHeader
        title="Goals"
        sub={
          active.length > 0 ? (
            <>
              {active.length} goal{active.length === 1 ? '' : 's'} ·{' '}
              <span className="tabular-nums">{formatWholeCurrency(totalSaved)}</span> saved of{' '}
              <span className="tabular-nums">{formatWholeCurrency(totalTarget)}</span>
            </>
          ) : (
            'Put money aside with a name on it'
          )
        }
        actions={
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setShowModal(true);
            }}
            className="text-[13.5px] text-ink transition-opacity hover:opacity-75"
          >
            + New goal
          </button>
        }
        className="mb-8"
      />
      <QueryErrorBanner items={failableQueries} className="mb-5" />

      <div className="grid flex-1 content-start gap-x-12 gap-y-5 md:grid-cols-2">
        {active.map((g) => {
          const fraction = g.target_amount > 0 ? g.progress_amount / g.target_amount : 0;
          const pct = Math.round(Math.min(100, Math.max(0, fraction * 100)));
          const insight = insightByGoal.get(g.id);
          return (
            <div
              key={g.id}
              className="cursor-pointer border-b border-line-2 pb-[22px] pt-1.5"
              onClick={() => {
                setEditing(g);
                setShowModal(true);
              }}
            >
              <div className="mb-3.5 flex items-baseline justify-between">
                <div>
                  <div className="text-[16.5px] text-ink">{g.name}</div>
                  <div className="mt-1 text-xs text-muted-2">{goalNote(g, insight)}</div>
                </div>
                <span className="text-[13px] text-sage">{pct}%</span>
              </div>
              <ProgressBar fraction={fraction} tone="sage" height={8} className="mb-3" />
              <div className="flex items-baseline justify-between">
                <span className="font-serif text-[21px] tabular-nums text-ink">{formatWholeCurrency(g.progress_amount)}</span>
                <span className="text-[13px] tabular-nums text-muted">of {formatWholeCurrency(g.target_amount)}</span>
              </div>
            </div>
          );
        })}
        {active.length === 0 && (
          <div className="py-8 text-[14px] text-muted">
            No goals yet.{' '}
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setShowModal(true);
              }}
              className="text-ink underline underline-offset-2"
            >
              Create the first one.
            </button>
          </div>
        )}
      </div>

      {archived.length > 0 && (
        <div className="mt-10 flex-shrink-0 pb-2">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-[12.5px] text-muted-2 transition-colors hover:text-muted"
          >
            {showArchived ? 'Hide archived' : `Archived · ${archived.length}`}
          </button>
          {showArchived && (
            <div className="mz-rise-fast mt-3">
              {archived.map((g, i) => (
                <div
                  key={g.id}
                  className={`flex items-baseline justify-between gap-4 py-2.5 ${i < archived.length - 1 ? 'border-b border-line' : ''}`}
                >
                  <span className="min-w-0 truncate text-[14px] text-muted">{g.name}</span>
                  <span className="ml-auto flex-shrink-0 text-[13px] tabular-nums text-muted-2">
                    {formatWholeCurrency(g.progress_amount)} of {formatWholeCurrency(g.target_amount)}
                  </span>
                  <button
                    type="button"
                    onClick={() => restore.mutate(g)}
                    disabled={restore.isPending}
                    className="flex-shrink-0 text-[13px] text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <GoalModal open={showModal} onClose={() => setShowModal(false)} editing={editing} />
    </Screen>
  );
}
