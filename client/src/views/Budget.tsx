import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addMonths, format, parseISO, subMonths } from 'date-fns';
import type { Budget as BudgetType, BudgetGroup, Category } from '@shared/types';
import { budgetsApi, categoriesApi, flattenCategories } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { availableBudgetAmount, budgetActualSpend, buildBudgetRowMeta } from '../lib/budgetMath';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import {
  Screen, ScreenHeader, SectionLabel, Card, Figure, ProgressBar, healthTone, InkButton,
  TextButton, CategoryPicker,
} from '../components/balance';

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
          <CategoryPicker
            variant="field" value={categoryId} categories={categories} onChange={setCategoryId}
            placeholder="Pick a category…" disabled={Boolean(editing)}
            filter={(c) => !c.is_income && (editing ? c.id === editing.category_id || !budgetedIds.has(c.id) : !budgetedIds.has(c.id))}
          />
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
          <span className="text-body-lg text-ink">Roll unspent money into next month</span>
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

function GroupModal({
  open,
  onClose,
  categories,
  groups,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  groups: BudgetGroup[];
  editing: BudgetGroup | null;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setName(editing?.name ?? '');
    setSelected(new Set(editing ? editing.members.map((m) => m.category_id) : []));
  }, [editing, open]);

  const spendable = flattenCategories(categories).filter((c) => !c.is_income);
  // Which other group each category currently sits in (a category can belong to only one group).
  const otherGroupOf = new Map<string, string>();
  for (const g of groups) {
    if (editing && g.id === editing.id) continue;
    for (const m of g.members) otherGroupOf.set(m.category_id, g.name);
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Name the group');
      const ids = [...selected];
      if (editing) {
        if (trimmed !== editing.name) await budgetsApi.updateGroup(editing.id, { name: trimmed });
        await budgetsApi.setGroupMembers(editing.id, ids);
      } else {
        const created = await budgetsApi.createGroup({ name: trimmed });
        if (ids.length > 0) await budgetsApi.setGroupMembers(created.id, ids);
      }
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: editing ? 'Group updated' : 'Group created' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const remove = useMutation({
    mutationFn: () => budgetsApi.deleteGroup(editing!.id),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Group deleted' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${editing.name}` : 'New budget group'}>
      <div className="space-y-4">
        <div>
          <label className="mz-label">Group name</label>
          <input className="mz-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Essentials" autoFocus />
        </div>
        <div>
          <label className="mz-label">Categories</label>
          <div className="max-h-[280px] overflow-y-auto rounded-lg border border-line-2">
            {spendable.length === 0 && <div className="px-3 py-3 text-body text-muted-2">No spending categories yet.</div>}
            {spendable.map((c, i) => {
              const other = otherGroupOf.get(c.id);
              return (
                <label
                  key={c.id}
                  className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-well ${
                    i < spendable.length - 1 ? 'border-b border-line' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="rounded border-line-3 text-sage focus:ring-0"
                  />
                  <span className="flex-1 text-body-lg text-ink">
                    {c.parent_id ? `· ${c.name}` : c.name}
                  </span>
                  {other && !selected.has(c.id) && <span className="text-note text-muted-2">in {other}</span>}
                </label>
              );
            })}
          </div>
          <p className="mt-1.5 text-note text-muted-2">A category can belong to one group. Adding it here moves it out of its current group.</p>
        </div>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create group'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
          {editing && (
            <TextButton onClick={() => remove.mutate()} disabled={remove.isPending} className="ml-auto hover:!text-clay">
              Delete group
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
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<BudgetGroup | null>(null);

  const budgetsQ = useQuery({ queryKey: ['budgets', month], queryFn: () => budgetsApi.getMonth(month) });
  const budgets = budgetsQ.data;
  const groupsQ = useQuery({ queryKey: ['budgets', 'groups', month], queryFn: () => budgetsApi.groups(month) });
  const groups = groupsQ.data;
  const categoriesQ = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const categories = categoriesQ.data;

  // A failed request used to render as an empty section, indistinguishable from no data.
  const failableQueries = [
    { query: budgetsQ, label: 'budgets' },
    { query: groupsQ, label: 'budget groups' },
    { query: categoriesQ, label: 'categories' },
  ];

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
    // Real groups always render (even when empty this month) so they can be managed.
    const sections: Array<{ group: BudgetGroup | null; name: string; rows: BudgetType[] }> = (groups ?? []).map((g) => {
      const rows = g.members
        .map((m) => byId.get(m.category_id))
        .filter((b): b is BudgetType => Boolean(b));
      rows.forEach((b) => used.add(b.category_id));
      return { group: g, name: g.name, rows };
    });
    const rest = allBudgets.filter((b) => !used.has(b.category_id));
    if (rest.length > 0) sections.push({ group: null, name: sections.length > 0 ? 'Other' : 'Categories', rows: rest });
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
        sub={allBudgets.length > 0 ? format(parseISO(`${month}-01`), 'MMMM yyyy') : 'No budgets set for this month'}
        actions={
          <>
            <div className="flex items-baseline gap-4 text-body-lg">
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
                setEditingGroup(null);
                setGroupModalOpen(true);
              }}
              className="text-body text-muted transition-colors hover:text-ink"
            >
              + New group
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setShowModal(true);
              }}
              className="text-body text-ink transition-opacity hover:opacity-75"
            >
              + Category
            </button>
          </>
        }
        className="mb-6"
      />
      <QueryErrorBanner items={failableQueries} className="mb-5" />

      {/* What is left is the subject; budgeted and spent are the two terms behind it. It was a
          fragment of the sub-line, set at 13.5px, indistinguishable from the words around it.
          Its sign is a state rather than a direction, so the word carries it and the numeral is
          always a magnitude: "over" and "left" are different situations, not one with a minus. */}
      {allBudgets.length > 0 && (
        <div className="mb-8 flex-shrink-0 space-y-3 lg:space-y-4">
          <Card padding="lg" elevation={2}>
            <Figure
              scale="subject"
              label={remaining >= 0 ? 'Left to spend' : 'Over budget'}
              value={remaining}
              states={{
                positive: 'still unspent this month',
                negative: 'spent past the budgets you set',
                zero: 'exactly on budget',
              }}
            >
              {formatWholeCurrency(Math.abs(remaining))}
            </Figure>
          </Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:gap-4">
            <Card padding="lg">
              <Figure scale="lead" label="Budgeted">{formatWholeCurrency(totalBudgeted)}</Figure>
            </Card>
            <Card padding="lg">
              <Figure scale="lead" label="Spent">{formatWholeCurrency(totalSpent)}</Figure>
            </Card>
          </div>
        </div>
      )}

      <div className="flex-1">
        {grouped.map((section) => (
          <div key={section.group?.id ?? section.name} className="group mb-6">
            <SectionLabel summary={groupSummary(section.rows)} className="mb-3">
              <span className="inline-flex items-baseline gap-2">
                {section.name}
                {section.group && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingGroup(section.group);
                      setGroupModalOpen(true);
                    }}
                    className="text-rule normal-case tracking-normal text-muted-2 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                  >
                    edit
                  </button>
                )}
              </span>
            </SectionLabel>
            {section.rows.length === 0 && (
              <div className="px-1 py-2 text-body text-muted-2">No budgeted categories in this group yet.</div>
            )}
            {section.rows.map((b) => {
              const available = availableBudgetAmount(b);
              const spent = budgetActualSpend(b);
              const meta = buildBudgetRowMeta(b);
              return (
                <div
                  key={b.id}
                  className="cursor-pointer rounded-lg px-1 py-3 transition-colors hover:bg-well"
                  onClick={() => {
                    setEditing(b);
                    setShowModal(true);
                  }}
                >
                  <div className="mb-2 flex justify-between">
                    <span className="text-body-lg text-ink">{b.category_name}</span>
                    <span className="text-body tabular-nums text-muted">
                      {formatWholeCurrency(spent)} <span className="text-dot">/ {formatWholeCurrency(available)}</span>
                    </span>
                  </div>
                  <ProgressBar fraction={available > 0 ? spent / available : spent > 0 ? 1 : 0} tone={healthTone(spent, available)} />
                  {(meta.carriedOver !== null || meta.projection) && (
                    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-note text-muted-2">
                      {meta.carriedOver !== null && (
                        <span>
                          {meta.carriedOver > 0 ? 'incl. ' : 'after '}
                          {formatWholeCurrency(Math.abs(meta.carriedOver))}
                          {meta.carriedOver > 0 ? ' carried over' : ' carried overspend'}
                        </span>
                      )}
                      {meta.projection && (
                        <span className={meta.projection.over ? 'text-clay' : undefined}>
                          projected {formatWholeCurrency(meta.projection.spend)} ·{' '}
                          {formatWholeCurrency(meta.projection.remaining)}{' '}
                          {meta.projection.over ? 'over' : 'left'}
                          {meta.projection.confidence !== 'confirmed' && ` (${meta.projection.confidence})`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {allBudgets.length === 0 && (
          <div className="py-8 text-body-lg text-muted">
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
      <GroupModal
        open={groupModalOpen}
        onClose={() => setGroupModalOpen(false)}
        categories={categories ?? []}
        groups={groups ?? []}
        editing={editingGroup}
      />
    </Screen>
  );
}
