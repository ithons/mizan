import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addMonths, format, parseISO, subMonths } from 'date-fns';
import type { Budget as BudgetType, Category } from '@shared/types';
import { budgetsApi, categoriesApi, flattenCategories } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { availableBudgetAmount, budgetActualSpend } from '../lib/budgetMath';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { Screen, ScreenHeader, SectionLabel, ProgressBar, healthTone, InkButton, TextButton } from '../components/balance';

function BudgetModal({
  open,
  onClose,
  categories,
  budgets,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  budgets: BudgetType[];
  editing: BudgetType | null;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [rollover, setRollover] = useState(false);

  useEffect(() => {
    if (editing) {
      setCategoryId(editing.category_id);
      setAmount(String(editing.amount));
      setRollover(editing.rollover);
    } else {
      setCategoryId('');
      setAmount('');
      setRollover(false);
    }
  }, [editing, open]);

  const budgetedIds = new Set(budgets.map((b) => b.category_id));
  const options = flattenCategories(categories).filter(
    (c) => !c.is_income && (editing ? c.id === editing.category_id || !budgetedIds.has(c.id) : !budgetedIds.has(c.id))
  );

  const save = useMutation({
    mutationFn: () => {
      const parsed = parseDecimalInput(amount);
      if (!categoryId) throw new Error('Pick a category');
      if (parsed === null || parsed < 0) throw new Error('Enter a valid amount');
      return budgetsApi.upsert(categoryId, { amount: parsed, rollover });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: editing ? 'Budget updated' : 'Budget added' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const remove = useMutation({
    mutationFn: () => budgetsApi.delete(editing!.id),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Budget removed' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${editing.category_name ?? 'budget'}` : 'Add category budget'}>
      <div className="space-y-4">
        <div>
          <label className="mz-label">Category</label>
          <select className="mz-field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={Boolean(editing)}>
            <option value="">Pick a category…</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parent_id ? `· ${c.name}` : c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mz-label">Monthly amount</label>
          <input type="number" className="mz-field tabular-nums" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={rollover}
            onChange={(e) => setRollover(e.target.checked)}
            className="rounded border-line-3 text-sage focus:ring-0"
          />
          <span className="text-sm text-ink">Roll unspent money into next month</span>
        </label>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add budget'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
          {editing && (
            <TextButton onClick={() => remove.mutate()} disabled={remove.isPending} className="ml-auto hover:!text-clay">
              Remove
            </TextButton>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function Budget() {
  const [month, setMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<BudgetType | null>(null);

  const { data: budgets } = useQuery({ queryKey: ['budgets', month], queryFn: () => budgetsApi.getMonth(month) });
  const { data: groups } = useQuery({ queryKey: ['budgets', 'groups', month], queryFn: () => budgetsApi.groups(month) });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });

  const allBudgets = budgets ?? [];
  const totalBudgeted = allBudgets.reduce((s, b) => s + availableBudgetAmount(b), 0);
  const totalSpent = allBudgets.reduce((s, b) => s + budgetActualSpend(b), 0);
  const remaining = totalBudgeted - totalSpent;

  const stepMonth = (dir: 1 | -1) => {
    const next = dir === 1 ? addMonths(parseISO(`${month}-01`), 1) : subMonths(parseISO(`${month}-01`), 1);
    setMonth(format(next, 'yyyy-MM'));
  };

  const grouped = useMemo(() => {
    const byId = new Map(allBudgets.map((b) => [b.category_id, b]));
    const used = new Set<string>();
    const sections = (groups ?? [])
      .map((g) => {
        const rows = g.members
          .map((m) => byId.get(m.category_id))
          .filter((b): b is BudgetType => Boolean(b));
        rows.forEach((b) => used.add(b.category_id));
        return { name: g.name, rows };
      })
      .filter((s) => s.rows.length > 0);
    const rest = allBudgets.filter((b) => !used.has(b.category_id));
    if (rest.length > 0) sections.push({ name: sections.length > 0 ? 'Other' : 'Categories', rows: rest });
    return sections;
  }, [allBudgets, groups]);

  const groupSummary = (rows: BudgetType[]) => {
    const budgeted = rows.reduce((s, b) => s + availableBudgetAmount(b), 0);
    const spent = rows.reduce((s, b) => s + budgetActualSpend(b), 0);
    return `${formatWholeCurrency(spent)} of ${formatWholeCurrency(budgeted)}${spent > budgeted ? ' · over' : ''}`;
  };

  return (
    <Screen>
      <ScreenHeader
        title="Budget"
        sub={
          allBudgets.length > 0 ? (
            <>
              {format(parseISO(`${month}-01`), 'MMMM')} · budgeted <span className="tabular-nums">{formatWholeCurrency(totalBudgeted)}</span> ·
              spent <span className="tabular-nums">{formatWholeCurrency(totalSpent)}</span> ·{' '}
              <span className={remaining >= 0 ? 'text-sage-deep' : 'text-clay'}>
                {formatWholeCurrency(Math.abs(remaining))} {remaining >= 0 ? 'left' : 'over'}
              </span>
            </>
          ) : (
            'No budgets set for this month'
          )
        }
        actions={
          <>
            <div className="flex items-baseline gap-4 text-sm">
              <button type="button" onClick={() => stepMonth(-1)} className="text-muted transition-colors hover:text-ink">
                ‹
              </button>
              <span className="text-ink">{format(parseISO(`${month}-01`), 'MMMM yyyy')}</span>
              <button type="button" onClick={() => stepMonth(1)} className="text-muted transition-colors hover:text-ink">
                ›
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setShowModal(true);
              }}
              className="text-[13.5px] text-ink transition-opacity hover:opacity-75"
            >
              + Category
            </button>
          </>
        }
        className="mb-7"
      />

      <div className="flex-1">
        {grouped.map((section) => (
          <div key={section.name} className="mb-7">
            <SectionLabel summary={groupSummary(section.rows)} className="mb-3">
              {section.name}
            </SectionLabel>
            {section.rows.map((b) => {
              const available = availableBudgetAmount(b);
              const spent = budgetActualSpend(b);
              return (
                <div
                  key={b.id}
                  className="cursor-pointer rounded-lg px-1 py-3 transition-colors hover:bg-rail"
                  onClick={() => {
                    setEditing(b);
                    setShowModal(true);
                  }}
                >
                  <div className="mb-2 flex justify-between">
                    <span className="text-[15px] text-ink">{b.category_name}</span>
                    <span className="text-[13.5px] tabular-nums text-muted">
                      {formatWholeCurrency(spent)} <span className="text-dot">/ {formatWholeCurrency(available)}</span>
                    </span>
                  </div>
                  <ProgressBar fraction={available > 0 ? spent / available : spent > 0 ? 1 : 0} tone={healthTone(spent, available)} />
                </div>
              );
            })}
          </div>
        ))}
        {allBudgets.length === 0 && (
          <div className="py-8 text-[14px] text-muted">
            Budgets track spending against a monthly amount per category.{' '}
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setShowModal(true);
              }}
              className="text-ink underline underline-offset-2"
            >
              Add your first category.
            </button>
          </div>
        )}
      </div>

      <BudgetModal open={showModal} onClose={() => setShowModal(false)} categories={categories ?? []} budgets={allBudgets} editing={editing} />
    </Screen>
  );
}
