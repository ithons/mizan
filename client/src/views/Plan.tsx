import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addMonths, format, parseISO, subMonths } from 'date-fns';
import type {
  Budget as BudgetType,
  BudgetRolloverLedgerEntry,
  Category,
  Goal,
  SafeToSpend,
} from '@shared/types';
import { accountsApi, budgetsApi, categoriesApi, goalsApi, insightsApi, recurringApi } from '../lib/api';
import { formatCurrency, formatWholeCurrency } from '../lib/formatters';
import { availableBudgetAmount, budgetActualSpend, buildBudgetRowMeta } from '../lib/budgetMath';
import { buildGoalForecastSummary, type GoalForecastInsight } from '../lib/goalForecast';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { parseDecimalInput } from '../lib/numberInput';
import { useAppStore } from '../store';
import { Modal } from '../components/Modal';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import {
  Screen, ScreenHeader, SectionLabel, Card, Figure, ProgressBar, healthTone, SignedBar,
  signedBarScale, type SignedBarScale, InkButton, TextButton, CategoryPicker,
} from '../components/balance';
import { carryoverBudgetPhrase, claimLines, uncountedHeadroom } from './plan/readings';

/**
 * `/plan`: every claim already made on the money, at both horizons.
 *
 * Budgets and goals were two screens, and splitting them made the owner do the arithmetic of
 * "what have I already promised" in their head. That arithmetic already exists, on the server,
 * in `computeSafeToSpend`: liquid minus cards minus bills minus budgets minus goals. A budget
 * claims money for one month and a goal claims it toward a target, so they are two line items in
 * one subtraction rather than two subjects. The sheet below IS that subtraction, and the two
 * sections under it are the two lines that have detail worth expanding.
 *
 * A consequence worth stating: the sheet never renders empty. On the owner's ledger it has one
 * budget and one goal, and the first three lines come from the accounts, so an owner with neither
 * still gets a full sheet with two invitations on it instead of a blank screen with two buttons.
 */

/** The claim sheet always reads the CURRENT month; the budget list can be stepped backward. */
function currentMonthKey(): string {
  return format(new Date(), 'yyyy-MM');
}

/**
 * The sheet's own two companions, and why both are allowed to be absent.
 *
 * `sheetQ` resolves first on an ordinary cold load, so the sheet has to render against companions
 * that have not arrived. `undefined`/`null` mean "not known yet" and every sentence that depends on
 * one is withheld until it is; see `claimLines` in ./plan/readings.
 *
 * `budgets` is the OPEN month's list, never the month stepper's. The sheet is always today's
 * because `GET /api/insights/safe-to-spend` builds its budgets from `new Date()`.
 *
 * Exported so a test can hand it two different budget lists against one sheet and see what changes.
 * It takes no hooks and holds no state; the only thing it can be wrong about is what it was given.
 */
export function ClaimSheet({
  sheet,
  budgets,
  goalCount,
}: {
  sheet: SafeToSpend;
  budgets: BudgetType[] | undefined;
  goalCount: number | null;
}) {
  const lines = claimLines(sheet, budgets ? budgets.length : null, goalCount);
  const headroom = budgets ? uncountedHeadroom(budgets) : 0;
  let running = 0;

  return (
    <Card padding="lg" elevation={2} className="mb-9">
      <Figure
        scale="subject"
        label={sheet.free >= 0 ? 'Free to spend' : 'Short this month'}
        value={sheet.free}
        states={{
          positive: 'left after every claim already made',
          negative: 'more is claimed than the pool holds',
          zero: 'claimed to the cent',
        }}
        className="mb-7"
      >
        {formatCurrency(Math.abs(sheet.free))}
      </Figure>

      <SectionLabel className="mb-2.5">What claims it</SectionLabel>

      {/* The running column is the signature of this screen and the reason the two horizons sit
          on one surface: each line takes its bite in front of you and the last line is the figure
          above. Set in the serif so the remainder reads in the same voice as the subject, while
          the amount taken stays in the sans, which is the operation rather than the money. */}
      <dl className="text-body-lg">
        {lines.map((line, index) => {
          running += line.delta;
          const opening = index === 0;
          return (
            <div key={line.key} className="border-b border-line py-2.5 last:border-b-0">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="min-w-0 text-ink">{line.label}</dt>
                <dd className="flex flex-shrink-0 items-baseline gap-5 tabular-nums">
                  <span className="text-muted">
                    {opening ? formatCurrency(line.delta) : formatCurrency(line.delta, { showSign: true })}
                  </span>
                  <span className="w-[7.5rem] text-right font-serif text-ink">{formatCurrency(running)}</span>
                </dd>
              </div>
              {line.note && <p className="mt-1 max-w-[46ch] text-note text-muted-2">{line.note}</p>}
              {line.key === 'budgets' && headroom > 0 && (
                <p className="mt-1 max-w-[46ch] text-note text-muted-2">
                  {formatCurrency(headroom)} of headroom is left out. Refunds have netted a category
                  below zero, which raises what is left of its budget without raising what you set
                  aside, and only what you set aside is a claim.
                </p>
              )}
            </div>
          );
        })}
      </dl>

      {/* Single rule above the result, double rule under it: the sheet says where it ends the way
          a statement does, so nothing below can be mistaken for another term of the sum. */}
      <div className="mt-1 border-t border-line-3 pt-2.5">
        <div className="flex items-baseline justify-between gap-4 border-b-[3px] border-double border-line-3 pb-2.5">
          <span className="text-body-lg text-ink">{sheet.free >= 0 ? 'Free to spend' : 'Short this month'}</span>
          <span
            className={`font-serif text-figure tabular-nums ${sheet.free >= 0 ? 'text-sage-deep' : 'text-clay'}`}
          >
            {formatCurrency(sheet.free)}
          </span>
        </div>
      </div>
    </Card>
  );
}

/**
 * One month of a rollover budget, as the ledger recorded it. Reading this writes nothing.
 *
 * The strip is `bg-well`, and `well` is the one ground on this screen the money numerals were never
 * measured against: the recorded budget amount was set in `muted-2` on it, and nothing had checked
 * the pair. On the current tokens `muted-2` on `well` is 5.41:1 light and 6.42:1 dark, so that
 * particular pair is no longer a failure and is not recorded as one. What survives the palette is
 * the ground: `well` still returns the lowest ratio of the four this screen uses, in both themes,
 * and three tones are still under AA on it, being `faint` (3.46 light / 4.29 dark), `sage`
 * (3.79 / 4.02) and `gold` on light only (4.19). Every ink in here clears 4.5:1 on `well`
 * in both themes, checked from the shipped tokens by tests/plan.test.ts rather than asserted here.
 * Hierarchy is carried by the ladder ink-soft -> muted with the carried-on figure in ink, which is
 * what the strip is actually for.
 */
function CarryoverStrip({ rows }: { rows: BudgetRolloverLedgerEntry[] }) {
  const openMonth = currentMonthKey();

  return (
    <div className="mt-3 rounded-lg border border-faint bg-well px-3 py-2.5">
      <div className="mb-1.5 text-micro font-semibold uppercase tracking-[0.16em] text-muted">Carryover</div>
      <dl className="text-note">
        {rows.map((row) => (
          <div key={row.id} className="flex items-baseline justify-between gap-3 py-0.5">
            <dt className="text-ink-soft">
              {format(parseISO(`${row.month}-01`), 'MMM yyyy')}
              <span className="ml-1.5 text-muted">
                {carryoverBudgetPhrase(row.month, openMonth, formatWholeCurrency(row.budget_amount))}
              </span>
            </dt>
            <dd className="flex-shrink-0 tabular-nums text-ink">
              {formatCurrency(row.ending_rollover)} carried on
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 text-note text-muted">
        Spend is re-derived every time, so a late or recategorized row still lands in the month it
        belongs to.
      </p>
    </div>
  );
}

function BudgetLine({
  budget,
  scale,
  onEdit,
}: {
  budget: BudgetType;
  /** The whole list's scale. Never this row's own; see the bar below. */
  scale: SignedBarScale;
  onEdit: () => void;
}) {
  const available = availableBudgetAmount(budget);
  const spent = budgetActualSpend(budget);
  const meta = buildBudgetRowMeta(budget);
  const returned = spent < 0;
  const remaining = available - spent;

  const ledgerQ = useQuery({
    queryKey: ['budgets', 'rollover-ledger', budget.id],
    queryFn: () => budgetsApi.rolloverLedger({ budgetId: budget.id, months: 6 }),
    enabled: budget.rollover,
  });

  return (
    <div className="border-b border-line-2 py-4 last:border-b-0">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 truncate text-body-lg text-ink transition-colors hover:text-sage-deep"
        >
          {budget.category_name ?? 'Uncategorized'}
        </button>
        <span className="flex-shrink-0 text-body tabular-nums text-muted">
          {formatCurrency(spent)} <span className="text-muted-2">of {formatCurrency(available)}</span>
        </span>
      </div>

      {/* Hazard 1: a category's spend can be negative, and the two directions are different
          states rather than one with a minus. A fraction of a ceiling is what ProgressBar draws
          and it clamps at zero, which renders a category that gave $1,028.63 back identically to
          one that spent nothing. So a returned month gets the diverging bar instead, which draws
          from a printed zero and can point the other way.

          The extent is the LIST's, from `signedBarScale`, which is the contract that primitive
          documents. It used to be `Math.max(available, Math.abs(spent))`, computed per row off the
          row's own value, so the ratio was exactly 1 the instant a category returned more than its
          ceiling: Shopping at -$1,203.63 against $500, a -$600 month and a -$5,000 month all drew
          the same full bar. That is the mirror of the clamp this branch exists to fix. The scale
          spans every row's spend, not only the returned ones, because the denominator has to be
          the largest movement of money in the list or it moves as the list is filtered. */}
      {returned ? (
        <SignedBar value={spent} {...scale} height={8} />
      ) : (
        <ProgressBar
          fraction={available > 0 ? spent / available : spent > 0 ? 1 : 0}
          tone={healthTone(spent, available)}
          height={8}
        />
      )}

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-note">
        {returned ? (
          <span className="text-sage-deep">
            Refunds beat purchases by {formatCurrency(-spent)} this month, so none of this budget is
            consumed.
          </span>
        ) : (
          <span className={remaining < 0 ? 'text-clay' : 'text-muted'}>
            {formatCurrency(Math.abs(remaining))} {remaining < 0 ? 'over' : 'left'}
            {available > 0 && ` · ${Math.round((spent / available) * 100)}% used`}
          </span>
        )}
        {meta.carriedOver !== null && (
          <span className="text-muted-2">
            {meta.carriedOver > 0 ? 'includes ' : 'after '}
            {formatCurrency(Math.abs(meta.carriedOver))}
            {meta.carriedOver > 0 ? ' carried in' : ' carried overspend'}
          </span>
        )}
        {meta.projection && (
          <span className={meta.projection.over ? 'text-clay' : 'text-muted-2'}>
            projected {formatCurrency(meta.projection.spend)}, {formatCurrency(meta.projection.remaining)}{' '}
            {meta.projection.over ? 'over' : 'left'}
            {meta.projection.confidence !== 'confirmed' && ` (${meta.projection.confidence})`}
          </span>
        )}
      </div>

      {budget.rollover && ledgerQ.data && ledgerQ.data.length > 0 && <CarryoverStrip rows={ledgerQ.data} />}
    </div>
  );
}

/**
 * What a goal says beyond its own two numbers.
 *
 * The target date is what the owner ASKED for and the projection is what the contribution rate
 * actually buys, so they are labelled separately: rendering the target as "full by <date>" claimed
 * the goal would be funded by then even when the forecast said otherwise.
 */
function goalNote(goal: Goal, insight?: GoalForecastInsight): string {
  const projectedMonthly = insight?.projected_monthly_contribution ?? 0;
  const parts: string[] = [];

  if (projectedMonthly > 0 && goal.remaining_amount > 0) {
    parts.push(`about ${formatWholeCurrency(projectedMonthly)} a month`);
  }

  if (goal.remaining_amount <= 0) {
    parts.push('complete');
  } else {
    if (goal.target_date) parts.push(`target ${format(parseISO(goal.target_date), 'MMM yyyy')}`);
    if (insight?.projected_completion_date) {
      parts.push(`projected ${format(parseISO(insight.projected_completion_date), 'MMM yyyy')}`);
    } else if (insight?.status === 'blocked') {
      parts.push('no projected date at this rate');
    } else if (!goal.target_date && goal.progress_amount <= 0) {
      parts.push('just started');
    }
  }

  if (parts.length === 0) {
    return goal.account_name ? `funded from ${goal.account_name}` : 'no target date set';
  }
  return goal.account_name ? `${parts.join(' · ')} · from ${goal.account_name}` : parts.join(' · ');
}

function GoalLine({
  goal,
  insight,
  onEdit,
}: {
  goal: Goal;
  insight?: GoalForecastInsight;
  onEdit: () => void;
}) {
  const fraction = goal.target_amount > 0 ? goal.progress_amount / goal.target_amount : 0;
  const pct = Math.round(Math.min(100, Math.max(0, fraction * 100)));

  return (
    <div className="border-b border-line-2 py-4 last:border-b-0">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 truncate text-body-lg text-ink transition-colors hover:text-sage-deep"
        >
          {goal.name}
        </button>
        <span className="flex-shrink-0 text-body tabular-nums text-muted">
          {formatCurrency(goal.progress_amount)}{' '}
          <span className="text-muted-2">of {formatCurrency(goal.target_amount)}</span>
        </span>
      </div>
      <ProgressBar fraction={fraction} tone="sage" height={8} />
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-note">
        <span className="tabular-nums text-muted">{pct}% funded</span>
        <span className="text-muted-2">{goalNote(goal, insight)}</span>
      </div>
    </div>
  );
}

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
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${editing.category_name ?? 'budget'}` : 'Add a monthly budget'}>
      <div className="space-y-4">
        <div>
          <label htmlFor="plan-category" className="mz-label">Category</label>
          <CategoryPicker id="plan-category"
            variant="field" value={categoryId} categories={categories} onChange={setCategoryId}
            placeholder="Pick a category…" disabled={Boolean(editing)}
            filter={(c) => !c.is_income && (editing ? c.id === editing.category_id || !budgetedIds.has(c.id) : !budgetedIds.has(c.id))}
          />
        </div>
        <div>
          <label htmlFor="plan-monthly-amount" className="mz-label">Monthly amount</label>
          <input id="plan-monthly-amount" type="number" className="mz-field tabular-nums" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={rollover}
            onChange={(e) => setRollover(e.target.checked)}
            className="rounded border-line-3 text-sage focus:ring-0"
          />
          <span className="text-body-lg text-ink">Carry what is left into next month</span>
        </label>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add budget'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
          {editing && (
            <TextButton onClick={() => remove.mutate()} disabled={remove.isPending} className="ml-auto hover:!text-clay">Remove</TextButton>
          )}
        </div>
      </div>
    </Modal>
  );
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
          <label htmlFor="plan-name" className="mz-label">Name</label>
          <input id="plan-name" className="mz-field" placeholder="Emergency fund" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="plan-target-amount" className="mz-label">Target amount</label>
            <input id="plan-target-amount"
              type="number"
              className="mz-field tabular-nums"
              placeholder="10,000"
              value={form.target_amount}
              onChange={(e) => setForm({ ...form, target_amount: e.target.value })}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="plan-saved-so-far" className="mz-label">Saved so far</label>
            <input id="plan-saved-so-far"
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
            <label htmlFor="plan-target-date" className="mz-label">Target date</label>
            <input id="plan-target-date" type="date" className="mz-field" value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} />
          </div>
          <div className="flex-1">
            <label htmlFor="plan-linked-account" className="mz-label">Linked account</label>
            <select id="plan-linked-account" className="mz-field" value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
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
            <TextButton onClick={() => archive.mutate()} disabled={archive.isPending} className="ml-auto">Archive</TextButton>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function Plan() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [month, setMonth] = useState(currentMonthKey);
  const [budgetModal, setBudgetModal] = useState<{ open: boolean; editing: BudgetType | null }>({
    open: false,
    editing: null,
  });
  const [goalModal, setGoalModal] = useState<{ open: boolean; editing: Goal | null }>({
    open: false,
    editing: null,
  });
  const [showArchived, setShowArchived] = useState(false);

  const openMonth = currentMonthKey();
  const viewingPastMonth = month !== openMonth;

  const sheetQ = useQuery({ queryKey: ['insights', 'safe-to-spend'], queryFn: () => insightsApi.safeToSpend() });
  const budgetsQ = useQuery({ queryKey: ['budgets', month], queryFn: () => budgetsApi.getMonth(month) });
  // The sheet's own month, which the stepper cannot move: `/api/insights/safe-to-spend` builds its
  // budgets from `new Date()`, so anything the sheet says about budgets has to be read from the
  // same month or the paragraph and the figures beside it are about different months. While the
  // stepper sits on the open month this shares `budgetsQ`'s key and costs no second request.
  const openMonthBudgetsQ = useQuery({
    queryKey: ['budgets', openMonth],
    queryFn: () => budgetsApi.getMonth(openMonth),
  });
  const categoriesQ = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const goalsQ = useQuery({ queryKey: ['goals', 'all'], queryFn: () => goalsApi.list({ includeArchived: true }) });
  const forecastQ = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });

  // A failed request used to render as an empty section, indistinguishable from no data.
  const failableQueries = [
    { query: sheetQ, label: 'the claim sheet' },
    { query: budgetsQ, label: 'budgets' },
    // Listed only when it is a different request. On the open month it IS budgetsQ, and naming the
    // same failure twice would read as two broken sections.
    ...(viewingPastMonth ? [{ query: openMonthBudgetsQ, label: "this month's budgets" }] : []),
    { query: categoriesQ, label: 'categories' },
    { query: goalsQ, label: 'goals' },
    { query: forecastQ, label: 'the recurring forecast' },
  ];

  const budgets = budgetsQ.data ?? [];
  const goals = goalsQ.data ?? [];
  const active = useMemo(() => goals.filter((g) => !g.is_archived), [goals]);
  const archived = useMemo(() => goals.filter((g) => g.is_archived), [goals]);

  const forecastSummary = useMemo(
    () => buildGoalForecastSummary({ goals: active, forecast: forecastQ.data ?? undefined }),
    [active, forecastQ.data]
  );
  const insightByGoal = useMemo(
    () => new Map(forecastSummary.insights.map((i) => [i.goal_id, i])),
    [forecastSummary]
  );
  const spendScale = useMemo(() => signedBarScale(budgets.map(budgetActualSpend)), [budgets]);

  const restore = useMutation({
    mutationFn: (goal: Goal) => goalsApi.update(goal.id, { is_archived: false }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Goal restored' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const stepMonth = (dir: 1 | -1) => {
    const base = parseISO(`${month}-01`);
    setMonth(format(dir === 1 ? addMonths(base, 1) : subMonths(base, 1), 'yyyy-MM'));
  };

  return (
    <Screen>
      <ScreenHeader
        title="Plan"
        sub="Every claim already made on your money, at both horizons"
        className="mb-7"
      />
      <QueryErrorBanner items={failableQueries} className="mb-5" />

      {sheetQ.data && (
        <ClaimSheet
          sheet={sheetQ.data}
          budgets={openMonthBudgetsQ.data}
          goalCount={goalsQ.data ? active.length : null}
        />
      )}

      <section className="mb-9">
        <SectionLabel
          className="mb-1"
          summary={
            <span className="flex items-baseline gap-4">
              <span className="flex items-baseline gap-3">
                <button type="button" onClick={() => stepMonth(-1)} aria-label="Previous month" className="text-muted transition-colors hover:text-ink">‹</button>
                <span className="text-ink">{format(parseISO(`${month}-01`), 'MMMM yyyy')}</span>
                <button type="button" onClick={() => stepMonth(1)} aria-label="Next month" className="text-muted transition-colors hover:text-ink">›</button>
              </span>
              <TextButton onClick={() => setBudgetModal({ open: true, editing: null })}>Add budget</TextButton>
            </span>
          }
        >
          Claimed this month
        </SectionLabel>

        {/* The sheet above is always today's. Say so rather than letting a stepped-back month look
            like it changed the subtraction, which it does not. */}
        {viewingPastMonth && (
          <p className="mb-3 text-note text-muted-2">
            The sheet above stays on {format(parseISO(`${openMonth}-01`), 'MMMM yyyy')}. Stepping the
            month changes this list only.
          </p>
        )}

        {budgets.length > 0 ? (
          <div className="mt-2">
            {budgets.map((budget) => (
              <BudgetLine
                key={budget.id}
                budget={budget}
                scale={spendScale}
                onEdit={() => setBudgetModal({ open: true, editing: budget })}
              />
            ))}
          </div>
        ) : (
          <p className="mt-3 max-w-[52ch] text-body-lg text-muted">
            A budget claims an amount for one category, one month at a time, and shows up on the
            sheet above the moment you set it.{' '}
            <button
              type="button"
              onClick={() => setBudgetModal({ open: true, editing: null })}
              className="text-ink underline underline-offset-2"
            >
              Set the first one.
            </button>
          </p>
        )}
      </section>

      <section className="flex-1">
        <SectionLabel
          className="mb-1"
          summary={<TextButton onClick={() => setGoalModal({ open: true, editing: null })}>Add goal</TextButton>}
        >
          Claimed toward a target
        </SectionLabel>

        {active.length > 0 ? (
          <div className="mt-2">
            {active.map((goal) => (
              <GoalLine
                key={goal.id}
                goal={goal}
                insight={insightByGoal.get(goal.id)}
                onEdit={() => setGoalModal({ open: true, editing: goal })}
              />
            ))}
          </div>
        ) : (
          <p className="mt-3 max-w-[52ch] text-body-lg text-muted">
            A goal claims money with a name on it and keeps claiming until the target is met.{' '}
            <button
              type="button"
              onClick={() => setGoalModal({ open: true, editing: null })}
              className="text-ink underline underline-offset-2"
            >
              Name the first one.
            </button>
          </p>
        )}

        {archived.length > 0 && (
          <div className="mt-6">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="text-note text-muted-2 transition-colors hover:text-muted"
            >
              {showArchived ? 'Hide archived' : `Archived · ${archived.length}`}
            </button>
            {showArchived && (
              <div className="mz-rise-fast mt-3">
                {archived.map((goal) => (
                  <div
                    key={goal.id}
                    className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-body-lg text-muted">{goal.name}</span>
                    <span className="ml-auto flex-shrink-0 text-body tabular-nums text-muted-2">
                      {formatCurrency(goal.progress_amount)} of {formatCurrency(goal.target_amount)}
                    </span>
                    <button
                      type="button"
                      onClick={() => restore.mutate(goal)}
                      disabled={restore.isPending}
                      className="flex-shrink-0 text-body text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <BudgetModal
        open={budgetModal.open}
        onClose={() => setBudgetModal({ open: false, editing: null })}
        categories={categoriesQ.data ?? []}
        budgets={budgets}
        editing={budgetModal.editing}
      />
      <GoalModal
        open={goalModal.open}
        onClose={() => setGoalModal({ open: false, editing: null })}
        editing={goalModal.editing}
      />
    </Screen>
  );
}
