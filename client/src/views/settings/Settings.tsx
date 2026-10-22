import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type {
  AdvisorAutonomyEntry,
  AdvisorDraftActionKind,
  AdvisorProviderStatus,
  AdvisorSettings,
  AiProviderId,
} from '@shared/types';
import {
  accountsApi,
  aiApi,
  categoriesApi,
  flattenCategories,
  rulesApi,
  settingsApi,
  simplefinApi,
  type AiActionUndoResult,
} from '../../lib/api';
import { SkeletonRows } from '../../components/SkeletonLoader';
import { formatCompactRelative } from '../../lib/formatters';
import { useThemePreference, type ThemePreference } from '../../lib/theme';
import { useAppStore } from '../../store';
import { Screen, SectionLabel, Select } from '../../components/balance';
import { SimplefinSection } from './SimplefinSection';
import { CoinbaseSection } from './CoinbaseSection';
import { CategoriesSection } from './CategoriesSection';
import { RulesSection } from './RulesSection';
import { NotificationRulesSection } from './NotificationRulesSection';
import { DataSection } from './DataSection';
import { AdvisorMemorySection } from './AdvisorMemorySection';
import { AUTONOMY_QUERY } from '../../components/AiActions';
export {
  ACTIONS_PER_PAGE,
  AiActionRow,
  hiddenActionsNote,
  undoActionToast,
} from '../../components/AiActions';

type PanelId =
  | 'advisor_context'
  | 'simplefin'
  | 'coinbase'
  | 'import'
  | 'categories'
  | 'notifications'
  | 'advisor_profile'
  | 'advisor_memory'
  | 'advisor_model'
  | 'ai_declined'
  | null;

function SettingsRow({
  title,
  sub,
  trailing,
  onClick,
  last = false,
}: {
  title: string;
  sub?: string;
  trailing: ReactNode;
  onClick?: () => void;
  last?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center justify-between rounded-lg px-3 py-3.5 transition-colors ${
        onClick ? 'cursor-pointer hover:bg-well' : ''
      } ${last ? '' : 'border-b border-line'}`}
    >
      <div>
        <div className="text-body-lg text-ink">{title}</div>
        {sub && <div className="mt-0.5 text-note text-muted-2">{sub}</div>}
      </div>
      <div className="flex-shrink-0 pl-4 text-body">{trailing}</div>
    </div>
  );
}

function ExpandedPanel({ children }: { children: ReactNode }) {
  return <div className="mb-2 mt-1 rounded-xl border border-line-2 bg-card shadow-e1 p-5">{children}</div>;
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

function ThemeToggle() {
  const [theme, setTheme] = useThemePreference();
  return (
    <div role="radiogroup" aria-label="Appearance" className="flex gap-1.5">
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={theme === option.value}
          onClick={() => setTheme(option.value)}
          className={`rounded-md border px-2.5 py-1 text-note transition-colors ${
            theme === option.value ? 'border-sage bg-sage/10 text-ink' : 'border-line-2 text-muted hover:bg-well'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}


/**
 * How the owner says each kind.
 *
 * The wording is the only part written here. Which side of the boundary a kind falls on comes from
 * the server's table, and the `Record` over the whole union means a new kind cannot compile until
 * it has been worded, the same way `DRAFT_KIND_AUTONOMY` means it cannot compile until it has been
 * argued.
 */
const AUTONOMY_PHRASE: Record<AdvisorDraftActionKind, string> = {
  categorize_transaction:
    'categorizing transactions, including ones a rule or the heuristic already filed',
  create_merchant_rule: 'writing merchant rules',
  retire_merchant_rule: 'retiring rules it wrote itself that file no transaction',
  update_budget: 'changing a budget',
  update_goal_target: 'changing a goal target',
  set_manual_cost_basis: 'setting a cost basis',
  confirm_recurring: 'confirming a bill',
  set_sector_metadata: 'setting a security sector',
  create_recurring_adjustment: 'skipping or repricing a bill',
  delete_budget: 'removing a budget',
  create_goal: 'creating a goal',
  dismiss_recurring: 'dismissing a recurring item',
  link_reimbursement: 'linking money paid back to the purchase it covers',
  update_account: 'renaming, hiding or setting the balance of an account',
  set_notification_rule: 'setting what you are notified about',
  delete_notification_rule: 'removing a notification rule',
  expect_lump: 'expecting an irregular deposit',
};

/**
 * The owner's half of `describeAutonomyForPrompt` (server/src/services/draftAutonomy.ts): the same
 * table, the same split, generated the same way.
 *
 * The sentence this replaces was typed by hand and had gone false twice over: a third kind became
 * autonomous, and categorization widened past untouched rows. A model that is told the boundary
 * from the table while the owner is told it from memory is the exact asymmetry this closes.
 *
 * Null for an empty table, so a caller that has not loaded it yet says so rather than printing a
 * boundary with nothing on either side of it.
 */
export function describeAutonomyForOwner(entries: readonly AdvisorAutonomyEntry[]): string | null {
  if (entries.length === 0) return null;
  // A kind with no wording is named rather than dropped: silence would understate the boundary.
  const say = (entry: AdvisorAutonomyEntry): string => AUTONOMY_PHRASE[entry.kind] ?? entry.kind;
  const applies = entries.filter((e) => e.autonomy === 'autonomous').map(say);
  const queues = entries.filter((e) => e.autonomy === 'proposal_only').map(say);
  if (applies.length === 0) return `Nothing without you. Waits for you: ${queues.join('; ')}.`;
  if (queues.length === 0) return `On its own: ${applies.join('; ')}. Nothing waits for you.`;
  return `On its own: ${applies.join('; ')}. Waits for you: ${queues.join('; ')}.`;
}

export type DeclinedProposalItem = Awaited<ReturnType<typeof aiApi.listDeclined>>[number];

/**
 * What one dismissed suggestion was about, in the owner's words rather than the model's.
 *
 * Pure and exported so the copy can be asserted. Every branch says only what the row carries: a
 * proposal whose category has since been deleted reads as that, and is not quietly rendered as a
 * proposal about nothing, because `category_id` set with `category_name` null is a different fact
 * from `category_id` null.
 */
export function declinedProposalDetail(item: DeclinedProposalItem): string {
  const category = item.category_id === null
    ? null
    : item.category_name ?? 'a category that has since been deleted';

  switch (item.kind) {
    case 'categorize_transaction':
      return category === null
        ? 'Filing one transaction'
        : `Filing one transaction as ${category}`;
    case 'create_merchant_rule':
      return category === null
        ? `A rule for "${item.pattern ?? 'a merchant'}"`
        : `A rule filing "${item.pattern ?? 'a merchant'}" as ${category}`;
    case 'retire_merchant_rule':
      return item.pattern === null
        ? 'Retiring one of its own rules'
        : `Retiring its own rule for "${item.pattern}"`;
    default:
      return item.kind.replace(/_/g, ' ');
  }
}

/**
 * What restoring one actually did, said only as far as the server checked it.
 *
 * Three outcomes, not two: the draft row can be reopened and drawable, reopened and still filtered
 * out for some other reason, or long since deleted by a later worker pass. Collapsing them into
 * "it's back" would promise a card the owner may never see.
 */
export function restoreDeclinedToast(result: {
  draft_reopened: boolean;
  queued: boolean;
}): { type: 'success' | 'info'; message: string } {
  if (result.queued) {
    return { type: 'success', message: 'Restored. The suggestion is back in your review queue.' };
  }
  if (result.draft_reopened) {
    return {
      type: 'info',
      message: 'Cleared. The suggestion was put back but something else about it has changed since, so it is not in the queue.',
    };
  }
  return {
    type: 'info',
    message: 'Cleared. The original suggestion is gone, so the AI may raise it again on a later sync.',
  };
}

export function DeclinedProposalRow({
  item,
  restorePending,
  onRestore,
}: {
  item: DeclinedProposalItem;
  restorePending: boolean;
  onRestore: (id: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line pb-2.5 last:border-0">
      <div className="min-w-0">
        <div className="text-body-lg text-ink">{declinedProposalDetail(item)}</div>
        {item.summary && <div className="mt-0.5 text-note text-muted-2">{item.summary}</div>}
      </div>
      <div className="flex flex-shrink-0 items-start gap-3">
        <div className="text-right text-micro text-muted-2">
          <div className={item.suppressing ? 'text-warning' : 'text-muted-2'}>
            {item.suppressing ? 'not repeated' : 'was already out of date'}
          </div>
          <div>{formatCompactRelative(item.declined_at)}</div>
        </div>
        <button
          type="button"
          disabled={restorePending}
          onClick={() => onRestore(item.id)}
          className="mt-0.5 whitespace-nowrap border-b border-line-3 pb-0.5 text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
        >
          Allow again
        </button>
      </div>
    </div>
  );
}

/**
 * The suggestions the owner turned down, and the way back.
 *
 * Dismissing a draft does more than close a card: `ownerDeclinedProposal` reads the record and the
 * background worker is refused that same proposal from then on. For a while nothing in the app
 * showed one. The card stopped being drawn, the review count fell by one, no response field named
 * the reason, and there was no path back at all, which made an ordinary click into a permanent,
 * invisible veto. This panel is that surface, and it is drawn whether or not a provider key is
 * configured, because a decline outlives the key and can block a category delete.
 */
function DeclinedProposalsPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: declined } = useQuery({
    queryKey: ['ai-declined'],
    queryFn: () => aiApi.listDeclined(),
    enabled: open,
  });

  const restore = useMutation({
    mutationFn: (id: string) => aiApi.restoreDeclined(id),
    onSuccess: (res) => {
      addToast(restoreDeclinedToast(res));
      qc.invalidateQueries({ queryKey: ['ai-declined'] });
      // The review queue and its counts are derived from the drafts this may have reopened.
      qc.invalidateQueries({ queryKey: ['transaction-review'] });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const items = declined ?? [];

  return (
    <>
      <SettingsRow
        title="Suggestions you turned down"
        sub="The AI does not raise these again on its own. Allow one again to undo that."
        trailing={<span className="text-muted">{open ? 'Hide' : 'Review'}</span>}
        onClick={onToggle}
      />
      {open && (
        <ExpandedPanel>
          {items.length === 0 ? (
            <p className="text-body text-muted-2">You have not turned down any suggestions.</p>
          ) : (
            <div className="space-y-2.5">
              {items.map((item) => (
                <DeclinedProposalRow
                  key={item.id}
                  item={item}
                  restorePending={restore.isPending}
                  onRestore={(id) => restore.mutate(id)}
                />
              ))}
            </div>
          )}
        </ExpandedPanel>
      )}
    </>
  );
}

function AdvisorContextEditor({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data } = useQuery({ queryKey: ['ai-profile'], queryFn: () => aiApi.getProfile() });
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? data?.profile ?? '';
  const dirty = draft !== null && draft !== (data?.profile ?? '');
  const save = useMutation({
    mutationFn: (text: string) => aiApi.saveProfile(text),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-profile'] });
      qc.invalidateQueries({ queryKey: ['ai-context'] });
      setDraft(null);
      addToast({ type: 'success', message: 'Advisor context saved' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });
  return (
    <>
      <SettingsRow
        title="Personal context"
        sub="Facts about you the advisor should always assume"
        trailing={<span className="text-muted">{open ? 'Hide' : 'Edit'}</span>}
        onClick={onToggle}
      />
      {open && (
        <ExpandedPanel>
          <div className="space-y-3">
            <p className="text-body leading-relaxed text-muted">
              Injected into every AI prompt (chat and the background worker) so the advisor reasons from your
              real situation instead of guessing.
            </p>
            <textarea
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              maxLength={4000}
              placeholder="e.g. I autopay my cards in full each month; I'm a student with seasonal income; I prefer a taxable brokerage over a Roth IRA."
              className="w-full resize-y rounded-lg border border-faint bg-rail p-3 font-mono text-note leading-relaxed text-ink outline-none focus:border-sage"
            />
            <div className="flex items-center justify-between">
              <span className="text-note text-muted-2">{value.length}/4000</span>
              <button
                type="button"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate(value)}
                className="rounded-lg bg-sage px-4 py-2 text-body text-card transition-opacity disabled:opacity-50"
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </ExpandedPanel>
      )}
    </>
  );
}

const PROVIDER_LABEL: Record<AiProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
};

const PROVIDER_ENV_VAR: Record<AiProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function credentialSourceLabel(status: AdvisorProviderStatus): string {
  switch (status.credential_source) {
    case 'env':
      return `from ${PROVIDER_ENV_VAR[status.id]}`;
    case 'oauth_profile':
      return 'signed in via `ant auth login`';
    case 'stored':
      return 'stored, encrypted';
    default:
      return 'no credential found';
  }
}

/**
 * The Advisor row's sub-line, judged for the selected model's provider: a key held for another
 * provider does not make this advisor answer, and a missing Anthropic key does not stop it.
 */
export function advisorKeyLine(settings: AdvisorSettings | undefined): string {
  if (!settings) return 'Reading the advisor settings…';
  const model = settings.available.models.find((m) => m.id === settings.model);
  const status = model && settings.available.providers.find((p) => p.id === model.provider);
  if (!model || !status) return `${settings.model} is not a model this server offers · pick one under Model & effort`;
  if (!status.configured) {
    return `No ${PROVIDER_LABEL[status.id]} key for ${model.label} · answers stay local until one is added under Model & effort`;
  }
  return `${PROVIDER_LABEL[status.id]} key ${credentialSourceLabel(status)} · model, memory and context`;
}

/**
 * One provider's key. Never renders a key back: the server does not return one, so this shows
 * where the credential came from and offers to replace or forget it.
 */
function ProviderKeyRow({ status }: { status: AdvisorProviderStatus }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [draft, setDraft] = useState('');
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ai-settings'] });
  };
  const save = useMutation({
    mutationFn: (key: string) => aiApi.saveProviderKey(status.id, key),
    onSuccess: () => {
      setDraft('');
      invalidate();
      addToast({ type: 'success', message: `${PROVIDER_LABEL[status.id]} key saved` });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });
  const forget = useMutation({
    mutationFn: () => aiApi.clearProviderKey(status.id),
    onSuccess: () => {
      invalidate();
      addToast({ type: 'success', message: `${PROVIDER_LABEL[status.id]} key removed` });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const sourceLabel = credentialSourceLabel(status);

  return (
    <div className="rounded-lg border border-line-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-body text-ink">{PROVIDER_LABEL[status.id]}</span>
        <span className={status.configured ? 'text-note text-sage-deep' : 'text-note text-muted-2'}>{sourceLabel}</span>
      </div>
      {/* An environment key is not reachable from here, so no control pretends otherwise. */}
      {status.credential_source !== 'env' && status.credential_source !== 'oauth_profile' && (
        <div className="mt-2 flex gap-2">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={status.configured ? 'Replace the stored key' : 'Paste an API key'}
            className="min-w-0 flex-1 rounded-lg border border-faint bg-rail px-3 py-2 font-mono text-note text-ink outline-none focus:border-sage"
          />
          <button
            type="button"
            disabled={!draft.trim() || save.isPending}
            onClick={() => save.mutate(draft.trim())}
            className="rounded-lg bg-sage px-3 py-2 text-body text-card transition-opacity disabled:opacity-50"
          >
            Save
          </button>
          {status.credential_source === 'stored' && (
            <button
              type="button"
              disabled={forget.isPending}
              onClick={() => forget.mutate()}
              className="rounded-lg border border-line-2 px-3 py-2 text-body text-muted transition-colors hover:bg-well disabled:opacity-50"
            >
              Forget
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function AdvisorModelPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: settings } = useQuery({ queryKey: ['ai-settings'], queryFn: () => aiApi.getSettings() });
  const save = useMutation({
    mutationFn: (update: Parameters<typeof aiApi.saveSettings>[0]) => aiApi.saveSettings(update),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-settings'] });
      qc.invalidateQueries({ queryKey: ['ai-context'] });
      addToast({ type: 'success', message: 'Advisor settings saved' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const selected = settings?.available.models.find((m) => m.id === settings.model);
  const modelLabel = selected?.label ?? settings?.model ?? '';
  // The dial renders from THE SELECTED MODEL's ladder, never from a provider-wide list.
  // Gemini's reasoning dial has three rungs where Anthropic's and OpenAI's have five, and a
  // rung rendered for a model that has no name for it is a control that does nothing.
  const efforts = selected?.efforts ?? [];

  return (
    <>
      <SettingsRow
        title="Model & effort"
        sub={
          settings
            ? `${modelLabel}${efforts.length > 0 ? ` · ${settings.effort} effort` : ' · no effort dial'}`
            : 'Choose the model, the provider, and how hard it thinks'
        }
        trailing={<span className="text-muted">{open ? 'Hide' : 'Configure'}</span>}
        onClick={onToggle}
      />
      {open && settings && (
        <ExpandedPanel>
          <div className="space-y-5">
            <div>
              <div className="mb-1.5 text-body font-medium text-ink">Model</div>
              <div className="flex flex-wrap gap-2">
                {settings.available.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    /* A model whose provider has no key is offered but not selectable: hiding
                       it would make the owner wonder where it went, and selecting it would
                       fail on the first question instead of here. */
                    disabled={save.isPending || !m.configured}
                    title={m.configured ? undefined : `No ${PROVIDER_LABEL[m.provider]} credential`}
                    onClick={() => save.mutate({ model: m.id })}
                    className={`rounded-lg border px-3 py-2 text-left text-body transition-colors disabled:opacity-40 ${
                      settings.model === m.id ? 'border-sage bg-sage/10 text-ink' : 'border-line-2 text-muted hover:bg-well'
                    }`}
                  >
                    <span className="block">{m.label}</span>
                    <span className="block text-note text-muted-2">
                      {PROVIDER_LABEL[m.provider]}
                      {m.configured ? '' : ' · no key'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {selected && (
              <div className="rounded-lg border border-faint bg-rail p-3">
                <div className="text-note text-muted">
                  {formatTokens(selected.context_window)} context · {formatTokens(selected.max_output_tokens)} max output
                </div>
                {/* What caching this model gets, and what it costs, BEFORE it is picked. */}
                <p className="mt-1.5 text-note leading-relaxed text-muted-2">{selected.caching_note}</p>
              </div>
            )}

            <div>
              <div className="mb-1.5 text-body font-medium text-ink">Reasoning effort</div>
              {efforts.length === 0 ? (
                <p className="text-note text-muted-2">
                  {modelLabel} takes no reasoning-effort level, so there is nothing to set here.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {efforts.map((e) => (
                      <button
                        key={e}
                        type="button"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ effort: e })}
                        className={`rounded-lg border px-3 py-2 text-body capitalize transition-colors disabled:opacity-50 ${
                          settings.effort === e ? 'border-sage bg-sage/10 text-ink' : 'border-line-2 text-muted hover:bg-well'
                        }`}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-note text-muted-2">
                    Higher effort reasons more before answering, at more tokens and latency.
                    {efforts.length < 5 && ' This model’s ladder has fewer rungs than the others; only the ones it accepts are shown.'}
                  </p>
                </>
              )}
            </div>

            <div>
              <div className="mb-1.5 text-body font-medium text-ink">Provider keys</div>
              <div className="space-y-2">
                {settings.available.providers.map((p) => (
                  <ProviderKeyRow key={p.id} status={p} />
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-body font-medium text-ink">Background jobs</div>
              <p className="mb-2 text-note text-muted-2">
                Fixed-purpose work does not have to use the advisor’s model or its provider. A cheap
                classifier on one and a reasoning model on another is a reasonable thing to want.
              </p>
              <div className="space-y-3">
                {settings.jobs.map((job) => (
                  <div key={job.job}>
                    <div className="mb-1 text-note capitalize text-muted">{job.job.replace(/_/g, ' ')}</div>
                    {/* Marked the same way the model picker above marks them, because the
                        consequence here is worse: this job runs unattended, and one pointed at
                        a keyless provider skips before it writes a run row, so nothing else on
                        any screen would ever say so. The server refuses the save outright; the
                        suffix is what stops the attempt reading as an arbitrary rejection.
                        `clearable` is off because a job always has a model: the empty option
                        submitted '' and was refused, which is a knob that only ever failed. */}
                    <Select
                      value={job.model}
                      clearable={false}
                      onChange={(value) => save.mutate({ jobs: { [job.job]: value } })}
                      placeholder="Pick a model"
                      options={job.available.map((m) => ({
                        value: m.id,
                        label: `${m.label} · ${PROVIDER_LABEL[m.provider]}${m.configured ? '' : ' · no key'}`,
                      }))}
                    />
                    {/* A saved assignment can go stale later: the key it needed was removed
                        after the fact. The stored choice is deliberately not rewritten, so this
                        line is the only place that state is visible. */}
                    {!job.configured && (
                      <p className="mt-1 text-note leading-relaxed text-warning">
                        No {PROVIDER_LABEL[job.provider]} credential. This job skips every run without
                        recording one, so nothing will reach the digest until a key is added below.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ExpandedPanel>
      )}
    </>
  );
}

export function Settings() {
  const [searchParams] = useSearchParams();
  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [advisorOpen, setAdvisorOpen] = useState(false);
  // A deep link to a row inside the advisor group opens the group too.
  useEffect(() => {
    if (openPanel && (openPanel.startsWith('advisor_') || openPanel.startsWith('ai_'))) setAdvisorOpen(true);
  }, [openPanel]);

  useEffect(() => {
    const section = searchParams.get('section');
    if (section === 'connections' || section === 'simplefin') setOpenPanel('simplefin');
    else if (section === 'coinbase') setOpenPanel('coinbase');
    else if (section === 'data' || section === 'import') setOpenPanel('import');
    else if (section === 'notifications') setOpenPanel('notifications');
    // The category delete refusal names this panel.
    else if (section === 'ai_declined') setOpenPanel('ai_declined');
  }, [searchParams]);

  const { data: credentials } = useQuery({ queryKey: ['credential-status'], queryFn: () => settingsApi.getCredentials() });
  const { data: simplefinConnection } = useQuery({ queryKey: ['simplefin-connection'], queryFn: () => simplefinApi.connection() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: advisorSettings } = useQuery({ queryKey: ['ai-settings'], queryFn: () => aiApi.getSettings() });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: () => rulesApi.list() });
  const { data: memories } = useQuery({ queryKey: ['ai-memory'], queryFn: () => aiApi.listMemory() });
  const autonomyQuery = useQuery(AUTONOMY_QUERY);
  const autonomySentence = autonomyQuery.data ? describeAutonomyForOwner(autonomyQuery.data.kinds) : null;
  const autonomyStatus = autonomyQuery.isError
    ? { sub: 'The boundary could not be read from the server, so nothing here states it.', trailing: 'Unknown' }
    : { sub: 'Reading the boundary from the server…', trailing: 'Reading' };

  const simplefinAccounts = (accounts ?? []).filter((a) => a.connection_type === 'simplefin').length;
  const coinbaseAccounts = (accounts ?? []).filter((a) => a.connection_type === 'coinbase').length;
  const categoryCount = flattenCategories(categories ?? []).length;
  const ruleCount = (rules ?? []).length;
  const memoryCount = (memories ?? []).length;

  const toggle = (panel: PanelId) => setOpenPanel((prev) => (prev === panel ? null : panel));
  const statusText = (connected: boolean) =>
    connected ? <span className="text-sage-deep">Connected</span> : <span className="text-muted">Connect</span>;

  /**
   * A pending re-link blocks EVERY sync, and the panel that resolves it lives inside a collapsed
   * row. A condition that stops the ledger updating cannot be reachable only by guessing which row
   * to expand, so the row states it and opens itself.
   *
   * The query is the same one the panel uses, so it is served from cache rather than fetched twice.
   */
  const { data: pendingRelink } = useQuery({
    queryKey: ['simplefin', 'relink'],
    queryFn: () => simplefinApi.pendingRelink(),
    enabled: Boolean(simplefinConnection),
  });
  const relinkPending = Boolean(pendingRelink?.proposal);

  useEffect(() => {
    if (relinkPending) setOpenPanel('simplefin');
  }, [relinkPending]);

  return (
    <Screen size="editorial">
      <div className="mb-8 flex-shrink-0">
        <h1 className="font-serif text-title font-normal leading-tight text-ink">Settings</h1>
        <div className="mt-1 text-body text-muted">Connections, the advisor, and your data</div>
      </div>

      <div className="flex-1 pb-8">
        {/* Connections */}
        <div className="mb-7">
          <SectionLabel className="mb-1.5">Connections</SectionLabel>
          <SettingsRow
            title="SimpleFIN"
            sub={
              simplefinConnection
                ? `Bank & brokerage · ${simplefinAccounts} account${simplefinAccounts === 1 ? '' : 's'}${
                    simplefinConnection.last_synced_at ? ` · synced ${formatCompactRelative(simplefinConnection.last_synced_at)}` : ''
                  }`
                : 'Bank & brokerage balances and transactions, read-only'
            }
            trailing={
              relinkPending
                ? <span className="text-review-text">Needs your confirmation</span>
                : statusText(Boolean(simplefinConnection))
            }
            onClick={() => toggle('simplefin')}
          />
          {openPanel === 'simplefin' && (
            <ExpandedPanel>
              <SimplefinSection />
            </ExpandedPanel>
          )}
          <SettingsRow
            title="Coinbase"
            sub={
              credentials?.coinbase
                ? `Crypto balances & trades · ${coinbaseAccounts} wallet${coinbaseAccounts === 1 ? '' : 's'}`
                : 'Crypto balances & trades via API key'
            }
            trailing={statusText(Boolean(credentials?.coinbase))}
            onClick={() => toggle('coinbase')}
            last={openPanel !== 'coinbase'}
          />
          {openPanel === 'coinbase' && (
            <ExpandedPanel>
              <CoinbaseSection />
            </ExpandedPanel>
          )}
        </div>

        {/* Advisor */}
        <div className="mb-7">
          <SectionLabel className="mb-1.5">Advisor</SectionLabel>
          <SettingsRow
            title="Advisor"
            sub={advisorKeyLine(advisorSettings)}
            trailing={<span className="text-muted">{advisorOpen ? 'Hide' : 'Open'}</span>}
            onClick={() => setAdvisorOpen((open) => !open)}
            last={!advisorOpen}
          />
          {advisorOpen && (
            <div className="ml-3 border-l border-line pl-3">
            {/* Ungated: it is the only in-app place to add the key the advisor needs. */}
            <AdvisorModelPanel open={openPanel === 'advisor_model'} onToggle={() => toggle('advisor_model')} />
            {/* Ungated: a decline keeps standing after a key is removed, and it is the only remedy
                for the delete blocker a declined proposal puts on a category. */}
            <DeclinedProposalsPanel
              open={openPanel === 'ai_declined'}
              onToggle={() => toggle('ai_declined')}
            />
            <AdvisorContextEditor
              open={openPanel === 'advisor_profile'}
              onToggle={() => toggle('advisor_profile')}
            />
            {/* Statements, not settings: each one carries the observation behind it and is replaced
                rather than edited, so the sub-line states what the store is and the count follows it
                only once there is one. */}
            <SettingsRow
              title="What the advisor takes as given"
              sub={
                memoryCount > 0
                  ? `Durable statements about how you run your money · ${memoryCount} recorded`
                  : 'Durable statements about how you run your money, kept beside the ledger rather than in it'
              }
              trailing={<span className="text-muted">{openPanel === 'advisor_memory' ? 'Hide' : 'Open'}</span>}
              onClick={() => toggle('advisor_memory')}
            />
            {openPanel === 'advisor_memory' && (
              <ExpandedPanel>
                <AdvisorMemorySection />
              </ExpandedPanel>
            )}
            {/* What actually leaves the machine on an advisor call. `GET /api/ai/context` returned
                the full financial context for "the UI preview panel", and no such panel existed:
                two client consumers read `.configured` and `.actions` and nothing read `.context`.
                The owner could ask the advisor anything and could not see what it had been told.
                This is the boundary made visible: the text, and its size, exactly as built. */}
            <SettingsRow
              title="What the advisor is told"
              sub="The financial context every advisor call and background pass starts from, exactly as it is sent"
              trailing={<span className="text-muted">{openPanel === 'advisor_context' ? 'Hide' : 'Open'}</span>}
              onClick={() => toggle('advisor_context')}
            />
            {openPanel === 'advisor_context' && (
              <ExpandedPanel>
                <AdvisorContextPanel />
              </ExpandedPanel>
            )}
            {/* What the AI applies unattended is a fixed domain boundary, not a dial, so this is
                stated rather than configured. The statement is generated from the server's autonomy
                table, so it cannot fall behind the boundary it describes. Every state of that fetch
                is spelled out: a row that claims a boundary it has not read would be worse than one
                that admits it has not read it. */}
            <SettingsRow
              title="What the AI can do on its own"
              sub={autonomySentence ?? autonomyStatus.sub}
              trailing={<span className="text-muted-2">{autonomySentence ? 'Always on' : autonomyStatus.trailing}</span>}
              last
            />
            </div>
          )}
        </div>

        {/* Preferences */}
        <div className="mb-7">
          <SectionLabel className="mb-1.5">Preferences</SectionLabel>
          <SettingsRow
            title="Categories & rules"
            trailing={
              <span className="text-muted">
                {categoryCount} categories · {ruleCount} rule{ruleCount === 1 ? '' : 's'}
              </span>
            }
            onClick={() => toggle('categories')}
          />
          {openPanel === 'categories' && (
            <ExpandedPanel>
              <div className="space-y-8">
                <CategoriesSection />
                <RulesSection />
              </div>
            </ExpandedPanel>
          )}
          <SettingsRow
            title="Notifications"
            sub="What the inbox tells you about, and desktop alerts"
            trailing={<span className="text-muted">Rules</span>}
            onClick={() => toggle('notifications')}
          />
          {openPanel === 'notifications' && (
            <ExpandedPanel>
              <NotificationRulesSection />
            </ExpandedPanel>
          )}
          <SettingsRow title="Appearance" trailing={<ThemeToggle />} last />
        </div>

        {/* Data */}
        <div>
          <SectionLabel className="mb-1.5">Data</SectionLabel>
          <SettingsRow
            title="Import, export and backup"
            sub="CSV import and export, backup and restore, data quality, sync activity, delete all data"
            trailing={<span className="text-muted">{openPanel === 'import' ? 'Hide' : 'Open'}</span>}
            onClick={() => toggle('import')}
            last={openPanel !== 'import'}
          />
          {openPanel === 'import' && (
            <ExpandedPanel>
              <DataSection />
            </ExpandedPanel>
          )}
        </div>
      </div>
    </Screen>
  );
}


/**
 * The context, verbatim, with its size stated.
 *
 * Fetched only while open: it is the largest payload the API serves and it is rebuilt from the
 * database on every request. The size line is the point as much as the text is: "how much of my
 * ledger leaves per call" has a number, and this is where the owner reads it.
 */
function AdvisorContextPanel() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['ai-context', 'preview'],
    queryFn: () => aiApi.getContext(),
    staleTime: 60_000,
  });
  if (isPending) return <SkeletonRows rows={6} />;
  if (isError) {
    return (
      <div className="text-note text-clay">
        Could not load the context{error instanceof Error ? `: ${error.message}` : '.'}
      </div>
    );
  }
  const chars = data.context.length;
  const lines = data.context.split('\n').length;
  return (
    <div>
      <div className="mb-3 text-note text-muted-2 tabular-nums">
        {chars.toLocaleString('en-US')} characters, {lines.toLocaleString('en-US')} lines, roughly{' '}
        {Math.round(chars / 3.8).toLocaleString('en-US')} tokens · built {new Date(data.generated_at).toLocaleString()}
        {' · '}{data.configured ? 'sent to the configured provider on every call' : 'no provider is configured, so nothing is sent'}
      </div>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-well p-3 text-micro leading-relaxed text-ink">
        {data.context}
      </pre>
    </div>
  );
}
