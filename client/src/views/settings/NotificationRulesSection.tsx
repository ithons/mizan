import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Account,
  Category,
  Goal,
  NotificationRule,
  NotificationRuleKind,
  NotificationRuleSpec,
} from '@shared/types';
import { NOTIFICATION_RULE_KINDS } from '@shared/types';
import { accountsApi, categoriesApi, flattenCategories, goalsApi, notificationsApi } from '../../lib/api';
import { useDesktopAlertsPreference } from '../../lib/desktopAlerts';
import { useAppStore } from '../../store';
import { InkButton, SectionLabel, TextButton } from '../../components/balance';

const KIND_LABEL: Record<NotificationRuleKind, string> = {
  budget_threshold: 'Budget used',
  large_transaction: 'Large charge',
  bill_due: 'Bill due',
  low_balance: 'Low balance',
  safe_to_spend_negative: 'Short over the forecast window',
  sync_failed: 'Sync failed',
  goal_milestone: 'Goal milestone',
  unusual_spending: 'Unusual spending',
  recurring_amount_changed: 'Recurring amount changed',
  income_late: 'Pay is late',
  account_shortfall: 'Account would go below zero',
  card_payment_missing: 'Card payment missing',
};

const DEFAULT_SPECS: { [K in NotificationRuleKind]: Extract<NotificationRuleSpec, { kind: K }> } = {
  budget_threshold: { kind: 'budget_threshold', params: { category_id: null, percent: 90 } },
  large_transaction: { kind: 'large_transaction', params: { min_amount: 500, account_id: null, lookback_days: 7 } },
  bill_due: { kind: 'bill_due', params: { days_ahead: 3 } },
  low_balance: { kind: 'low_balance', params: { account_id: null, threshold: 500 } },
  safe_to_spend_negative: { kind: 'safe_to_spend_negative', params: {} },
  sync_failed: { kind: 'sync_failed', params: { include_partial: true } },
  goal_milestone: { kind: 'goal_milestone', params: { goal_id: null, milestones: [50, 100] } },
  unusual_spending: { kind: 'unusual_spending', params: { category_id: null, ratio: 1.5, min_amount: 100 } },
  recurring_amount_changed: { kind: 'recurring_amount_changed', params: {} },
  income_late: { kind: 'income_late', params: { min_days_late: 2 } },
  account_shortfall: { kind: 'account_shortfall', params: { days_ahead: 14 } },
  card_payment_missing: { kind: 'card_payment_missing', params: { min_days_late: 3 } },
};

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

interface Lookups {
  categories: Category[];
  accounts: Account[];
  goals: Goal[];
}

function nameOf<T extends { id: string }>(rows: T[], id: string | null, pick: (row: T) => string, fallback: string): string {
  if (id === null) return fallback;
  const row = rows.find((r) => r.id === id);
  return row ? pick(row) : 'a record that no longer exists';
}

function describeRule(spec: NotificationRuleSpec, lookups: Lookups): string {
  const category = (id: string | null, all: string) => nameOf(lookups.categories, id, (c) => c.name, all);
  const account = (id: string | null, all: string) => nameOf(lookups.accounts, id, (a) => a.account_name, all);
  switch (spec.kind) {
    case 'budget_threshold':
      return `When ${category(spec.params.category_id, 'any budget')} has used ${spec.params.percent}% of this month's budget.`;
    case 'large_transaction':
      return `When a charge of ${USD.format(spec.params.min_amount)} or more posts on ${account(spec.params.account_id, 'any account')}, looking back ${spec.params.lookback_days} days.`;
    case 'bill_due':
      return `When a scheduled bill is due within ${spec.params.days_ahead} day${spec.params.days_ahead === 1 ? '' : 's'}.`;
    case 'low_balance':
      return `When ${account(spec.params.account_id, 'checking, savings and cash together')} fall${spec.params.account_id ? 's' : ''} below ${USD.format(spec.params.threshold)}. At most once a month.`;
    case 'safe_to_spend_negative':
      return 'When what is free to spend over the next 30 days goes below zero. At most once a month.';
    case 'sync_failed':
      return spec.params.include_partial
        ? 'When a sync fails or finishes with issues. Once per run of failures.'
        : 'When a sync fails outright. Once per run of failures.';
    case 'goal_milestone':
      return `When ${nameOf(lookups.goals, spec.params.goal_id, (g) => g.name, 'any goal')} reaches ${spec.params.milestones.join('%, ')}%.`;
    case 'unusual_spending':
      return `When ${category(spec.params.category_id, 'a top-level category')} runs at ${spec.params.ratio}x its usual month-to-date pace and at least ${USD.format(spec.params.min_amount)} over it.`;
    case 'recurring_amount_changed':
      return 'When a recurring bill or deposit moves to a new amount.';
    case 'income_late':
      return `When expected pay is later than it usually runs, and at least ${spec.params.min_days_late} day${spec.params.min_days_late === 1 ? '' : 's'} late.`;
    case 'card_payment_missing':
      return `When a card's usual payment is at least ${spec.params.min_days_late} day${spec.params.min_days_late === 1 ? '' : 's'} late, later than it usually runs, and nothing has paid the card since.`;
    case 'account_shortfall':
      return `When scheduled bills, transfers and card payments would take a checking, savings or cash account below zero within ${spec.params.days_ahead} day${spec.params.days_ahead === 1 ? '' : 's'}.`;
  }
}

const inputClass = 'mt-1 block w-full rounded-lg border border-line-2 bg-paper px-2.5 py-1.5 text-body text-ink';

function NumberField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="block text-note text-muted">
      {label}
      <input type="number" step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.valueAsNumber)} className={inputClass} />
    </label>
  );
}

function PickField({ label, value, options, onChange }: {
  label: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="block text-note text-muted">
      {label}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={inputClass}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function ParamsEditor({ spec, onChange, lookups }: {
  spec: NotificationRuleSpec;
  onChange: (spec: NotificationRuleSpec) => void;
  lookups: Lookups;
}) {
  const categoryOptions = (all: string) => [{ value: '', label: all }, ...lookups.categories.map((c) => ({ value: c.id, label: c.name }))];
  const assetAccounts = lookups.accounts.filter((a) => !a.is_liability && a.type !== 'closed');
  switch (spec.kind) {
    case 'budget_threshold':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <PickField label="Budget" value={spec.params.category_id} options={categoryOptions('Any budget')} onChange={(v) => onChange({ ...spec, params: { ...spec.params, category_id: v } })} />
          <NumberField label="Percent used" value={spec.params.percent} onChange={(v) => onChange({ ...spec, params: { ...spec.params, percent: v } })} />
        </div>
      );
    case 'large_transaction':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="At least (dollars)" step={0.01} value={spec.params.min_amount} onChange={(v) => onChange({ ...spec, params: { ...spec.params, min_amount: v } })} />
          <PickField label="Account" value={spec.params.account_id} options={[{ value: '', label: 'Any account' }, ...lookups.accounts.map((a) => ({ value: a.id, label: a.account_name }))]} onChange={(v) => onChange({ ...spec, params: { ...spec.params, account_id: v } })} />
          <NumberField label="Look back (days)" value={spec.params.lookback_days} onChange={(v) => onChange({ ...spec, params: { ...spec.params, lookback_days: v } })} />
        </div>
      );
    case 'bill_due':
      return <NumberField label="Days ahead" value={spec.params.days_ahead} onChange={(v) => onChange({ ...spec, params: { days_ahead: v } })} />;
    case 'low_balance':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <PickField label="Account" value={spec.params.account_id} options={[{ value: '', label: 'Checking, savings and cash together' }, ...assetAccounts.map((a) => ({ value: a.id, label: a.account_name }))]} onChange={(v) => onChange({ ...spec, params: { ...spec.params, account_id: v } })} />
          <NumberField label="Below (dollars)" step={0.01} value={spec.params.threshold} onChange={(v) => onChange({ ...spec, params: { ...spec.params, threshold: v } })} />
        </div>
      );
    case 'sync_failed':
      return (
        <label className="flex items-center gap-2 text-note text-muted">
          <input type="checkbox" className="rounded border-line-3 text-sage focus:ring-0" checked={spec.params.include_partial} onChange={(e) => onChange({ ...spec, params: { include_partial: e.target.checked } })} />
          Include runs that finished with issues
        </label>
      );
    case 'goal_milestone':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <PickField label="Goal" value={spec.params.goal_id} options={[{ value: '', label: 'Any goal' }, ...lookups.goals.map((g) => ({ value: g.id, label: g.name }))]} onChange={(v) => onChange({ ...spec, params: { ...spec.params, goal_id: v } })} />
          <label className="block text-note text-muted">
            Milestones (percent, comma separated)
            <input
              type="text"
              defaultValue={spec.params.milestones.join(', ')}
              onChange={(e) => onChange({ ...spec, params: { ...spec.params, milestones: e.target.value.split(',').map((s) => Number(s.trim())).filter(isMilestone) } })}
              className={inputClass}
            />
          </label>
        </div>
      );
    case 'unusual_spending':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <PickField label="Category" value={spec.params.category_id} options={categoryOptions('Every top-level category')} onChange={(v) => onChange({ ...spec, params: { ...spec.params, category_id: v } })} />
          <NumberField label="Times usual" step={0.1} value={spec.params.ratio} onChange={(v) => onChange({ ...spec, params: { ...spec.params, ratio: v } })} />
          <NumberField label="And over by (dollars)" step={0.01} value={spec.params.min_amount} onChange={(v) => onChange({ ...spec, params: { ...spec.params, min_amount: v } })} />
        </div>
      );
    case 'safe_to_spend_negative':
    case 'recurring_amount_changed':
      return <p className="text-note text-muted-2">Nothing to set.</p>;
    case 'income_late':
      return <NumberField label="At least this many days late" value={spec.params.min_days_late} onChange={(v) => onChange({ ...spec, params: { min_days_late: v } })} />;
    case 'card_payment_missing':
      return <NumberField label="At least this many days late" value={spec.params.min_days_late} onChange={(v) => onChange({ ...spec, params: { min_days_late: v } })} />;
    case 'account_shortfall':
      return <NumberField label="Days ahead to look" value={spec.params.days_ahead} onChange={(v) => onChange({ ...spec, params: { days_ahead: v } })} />;
  }
}

function isMilestone(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function RuleEditor({ initial, lookups, onSave, onCancel, saving }: {
  initial: NotificationRuleSpec;
  lookups: Lookups;
  onSave: (spec: NotificationRuleSpec) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [spec, setSpec] = useState<NotificationRuleSpec>(initial);
  return (
    <div className="mt-2 rounded-lg border border-line bg-well p-3">
      <ParamsEditor spec={spec} onChange={setSpec} lookups={lookups} />
      <div className="mt-3 flex gap-3">
        <InkButton onClick={() => onSave(spec)} disabled={saving}>{saving ? 'Saving…' : 'Save'}</InkButton>
        <TextButton onClick={onCancel}>Cancel</TextButton>
      </div>
    </div>
  );
}

function DesktopAlertsRow() {
  const { state, enable, disable } = useDesktopAlertsPreference();
  const sub: Record<typeof state, string> = {
    unsupported: 'This browser cannot show desktop alerts.',
    blocked: 'Blocked in this browser’s site settings. Allow notifications there to turn this on.',
    off: 'Off. Turning it on asks this browser for permission once.',
    on: 'On in this browser, for notifications that arrive while the app is open.',
  };
  return (
    <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
      <div>
        <div className="text-body text-ink">Desktop alerts</div>
        <div className="mt-0.5 text-note text-muted-2">{sub[state]}</div>
      </div>
      {state === 'on' && <TextButton onClick={disable}>Turn off</TextButton>}
      {state === 'off' && <TextButton variant="primary" onClick={() => void enable()}>Turn on</TextButton>}
    </div>
  );
}

export function NotificationRulesSection() {
  const queryClient = useQueryClient();
  const { addToast } = useAppStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<NotificationRuleKind | null>(null);

  const rulesQ = useQuery({ queryKey: ['notifications', 'rules'], queryFn: notificationsApi.rules });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: goals } = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });
  const lookups: Lookups = { categories: flattenCategories(categories ?? []), accounts: accounts ?? [], goals: goals ?? [] };

  const done = () => void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const onError = (err: Error) => addToast({ type: 'error', message: err.message });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { enabled?: boolean; params?: NotificationRuleSpec['params'] } }) =>
      notificationsApi.updateRule(id, body),
    onSuccess: () => { setEditing(null); done(); },
    onError,
  });
  const create = useMutation({
    mutationFn: notificationsApi.createRule,
    onSuccess: () => { setAdding(null); done(); },
    onError,
  });
  const remove = useMutation({ mutationFn: notificationsApi.deleteRule, onSuccess: done, onError });

  const rules: NotificationRule[] = rulesQ.data ?? [];

  return (
    <div>
      <SectionLabel className="mb-1.5">Notification rules</SectionLabel>
      <p className="mb-3 text-note leading-relaxed text-muted-2">
        Rules run after every sync. Each condition notifies once in its period, and the inbox is under the rail.
      </p>
      {rulesQ.isPending && <p className="text-note text-muted">Reading rules…</p>}
      {rulesQ.isError && <p className="text-note text-ink">Could not load rules: {rulesQ.error.message}</p>}
      <ul>
        {rules.map((rule) => (
          <li key={rule.id} className="border-b border-line py-3">
            <div className="flex items-start justify-between gap-4">
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-1 rounded border-line-3 text-sage focus:ring-0"
                  checked={rule.enabled}
                  onChange={(e) => update.mutate({ id: rule.id, body: { enabled: e.target.checked } })}
                />
                <span>
                  <span className={`block text-body ${rule.enabled ? 'text-ink' : 'text-muted'}`}>
                    {KIND_LABEL[rule.kind]}
                    {rule.created_by === 'advisor' && <span className="ml-2 text-note text-muted-2">added by the advisor</span>}
                  </span>
                  <span className="mt-0.5 block text-note text-muted-2">{describeRule(rule, lookups)}</span>
                </span>
              </label>
              <div className="flex flex-shrink-0 gap-3">
                <TextButton className="text-note" onClick={() => setEditing(editing === rule.id ? null : rule.id)}>Edit</TextButton>
                <TextButton className="text-note" onClick={() => remove.mutate(rule.id)}>Delete</TextButton>
              </div>
            </div>
            {editing === rule.id && (
              <RuleEditor
                initial={{ kind: rule.kind, params: rule.params } as NotificationRuleSpec}
                lookups={lookups}
                saving={update.isPending}
                onCancel={() => setEditing(null)}
                onSave={(spec) => update.mutate({ id: rule.id, body: { params: spec.params } })}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <label className="block max-w-xs text-note text-muted">
          Add a rule
          <select
            value={adding ?? ''}
            onChange={(e) => setAdding((e.target.value || null) as NotificationRuleKind | null)}
            className={inputClass}
          >
            <option value="">Choose a kind…</option>
            {NOTIFICATION_RULE_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
          </select>
        </label>
        {adding && (
          <RuleEditor
            key={adding}
            initial={DEFAULT_SPECS[adding]}
            lookups={lookups}
            saving={create.isPending}
            onCancel={() => setAdding(null)}
            onSave={(spec) => create.mutate(spec)}
          />
        )}
      </div>
      <DesktopAlertsRow />
    </div>
  );
}
