import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { accountsApi, aiApi, categoriesApi, flattenCategories, rulesApi, settingsApi, simplefinApi } from '../../lib/api';
import { formatCompactRelative } from '../../lib/formatters';
import { useThemePreference, type ThemePreference } from '../../lib/theme';
import { useAppStore } from '../../store';
import { Screen, SectionLabel } from '../../components/balance';
import { SimplefinSection } from './SimplefinSection';
import { CoinbaseSection } from './CoinbaseSection';
import { CategoriesSection } from './CategoriesSection';
import { RulesSection } from './RulesSection';
import { DataSection } from './DataSection';

type PanelId = 'simplefin' | 'coinbase' | 'import' | 'categories' | 'advisor_profile' | 'advisor_model' | 'ai_actions' | null;

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

const UNDOABLE_AI_KINDS = new Set(['categorize_transaction', 'create_merchant_rule']);

// The SDK accepts three credential forms, not just an env API key (services/anthropicClient.ts).
// /api/ai/context already reported which one is in use; nothing displayed it.
const CREDENTIAL_SOURCE_LABEL: Record<string, string> = {
  api_key: 'ANTHROPIC_API_KEY',
  auth_token: 'ANTHROPIC_AUTH_TOKEN',
  oauth_profile: 'signed in via `ant auth login`',
  none: 'no credential found',
};

function AiActionsPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: actions } = useQuery({
    queryKey: ['ai-actions'],
    queryFn: () => aiApi.listActions(),
    enabled: open,
  });

  const undo = useMutation({
    mutationFn: (id: string) => aiApi.undoAction(id),
    onSuccess: (res) => {
      addToast({
        type: 'success',
        message: `Reverted ${res.reverted} transaction${res.reverted === 1 ? '' : 's'}`,
      });
      // Categories moved, so every derived surface is stale: reports, budgets, review counts.
      qc.invalidateQueries();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <>
      <SettingsRow
        title="What the AI has done"
        sub="Every action the AI applied to your data, and the ones you can put back"
        trailing={<span className="text-muted">{open ? 'Hide' : 'Review →'}</span>}
        onClick={onToggle}
      />
      {open && (
        <ExpandedPanel>
          {(!actions || actions.length === 0) ? (
            <p className="text-body text-muted-2">No AI actions yet.</p>
          ) : (
            <div className="space-y-2.5">
              {actions.map((a) => (
                <div key={a.id} className="flex items-start justify-between gap-3 border-b border-line pb-2.5 last:border-0">
                  <div className="min-w-0">
                    <div className="text-body-lg text-ink">{a.label}</div>
                    <div className="mt-0.5 text-note text-muted-2">{a.summary}</div>
                  </div>
                  <div className="flex flex-shrink-0 items-start gap-3">
                    <div className="text-right text-micro text-muted-2">
                      <div className={a.source === 'worker_auto' ? 'text-warning' : 'text-sage-deep'}>
                        {a.source === 'worker_auto' ? 'auto-applied' : 'you confirmed'}
                      </div>
                      <div>{formatCompactRelative(a.created_at)}</div>
                    </div>
                    {UNDOABLE_AI_KINDS.has(a.kind) && (
                      <button
                        type="button"
                        disabled={undo.isPending}
                        onClick={() => undo.mutate(a.id)}
                        className="mt-0.5 whitespace-nowrap border-b border-line-3 pb-0.5 text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
                      >
                        Undo
                      </button>
                    )}
                  </div>
                </div>
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
        trailing={<span className="text-muted">{open ? 'Hide' : 'Edit →'}</span>}
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
              className="w-full resize-y rounded-lg border border-line-2 bg-rail p-3 font-mono text-note leading-relaxed text-ink outline-none focus:border-sage"
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

function AdvisorModelPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
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

  const modelLabel = settings?.available.models.find((m) => m.id === settings.model)?.label ?? settings?.model ?? '';

  return (
    <>
      <SettingsRow
        title="Model & effort"
        sub={settings ? `${modelLabel} · ${settings.effort} effort` : 'Choose the model and how hard it thinks'}
        trailing={<span className="text-muted">{open ? 'Hide' : 'Configure →'}</span>}
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
                    disabled={save.isPending}
                    onClick={() => save.mutate({ model: m.id })}
                    className={`rounded-lg border px-3 py-2 text-body transition-colors disabled:opacity-50 ${
                      settings.model === m.id ? 'border-sage bg-sage/10 text-ink' : 'border-line-2 text-muted hover:bg-well'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-body font-medium text-ink">Reasoning effort</div>
              <div className="flex gap-2">
                {settings.available.efforts.map((e) => (
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
              <p className="mt-1.5 text-note text-muted-2">Higher effort reasons more before answering, at more tokens and latency.</p>
            </div>
          </div>
        </ExpandedPanel>
      )}
    </>
  );
}

export function Settings() {
  const { addToast } = useAppStore();
  const [searchParams] = useSearchParams();
  const [openPanel, setOpenPanel] = useState<PanelId>(null);

  useEffect(() => {
    const section = searchParams.get('section');
    if (section === 'connections' || section === 'simplefin') setOpenPanel('simplefin');
    else if (section === 'coinbase') setOpenPanel('coinbase');
    else if (section === 'data' || section === 'import') setOpenPanel('import');
    else if (section === 'ai_actions') setOpenPanel('ai_actions');
  }, [searchParams]);

  const { data: credentials } = useQuery({ queryKey: ['credential-status'], queryFn: () => settingsApi.getCredentials() });
  const { data: simplefinConnection } = useQuery({ queryKey: ['simplefin-connection'], queryFn: () => simplefinApi.connection() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: aiContext } = useQuery({ queryKey: ['ai-context'], queryFn: () => aiApi.getContext() });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: () => rulesApi.list() });
  const backup = useMutation({
    mutationFn: () => settingsApi.exportBackupJson(),
    onSuccess: () => addToast({ type: 'success', message: 'Backup downloaded' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });
  const exportCsv = useMutation({
    mutationFn: () => settingsApi.exportCsv(),
    onSuccess: () => addToast({ type: 'success', message: 'CSV exported' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const simplefinAccounts = (accounts ?? []).filter((a) => a.connection_type === 'simplefin').length;
  const coinbaseAccounts = (accounts ?? []).filter((a) => a.connection_type === 'coinbase').length;
  const categoryCount = flattenCategories(categories ?? []).length;
  const ruleCount = (rules ?? []).length;

  const toggle = (panel: PanelId) => setOpenPanel((prev) => (prev === panel ? null : panel));
  const statusText = (connected: boolean) =>
    connected ? <span className="text-sage-deep">Connected</span> : <span className="text-muted">Connect →</span>;

  return (
    <Screen size="editorial">
      <div className="mb-8 flex-shrink-0">
        <h1 className="font-serif text-display font-normal leading-tight text-ink">Settings</h1>
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
            trailing={statusText(Boolean(simplefinConnection))}
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
          />
          {openPanel === 'coinbase' && (
            <ExpandedPanel>
              <CoinbaseSection />
            </ExpandedPanel>
          )}
          <SettingsRow
            title="CSV import"
            sub="For accounts not covered above"
            trailing={<span className="text-muted">Import →</span>}
            onClick={() => toggle('import')}
            last
          />
          {openPanel === 'import' && (
            <ExpandedPanel>
              <DataSection />
            </ExpandedPanel>
          )}
        </div>

        {/* Advisor */}
        <div className="mb-7">
          <SectionLabel className="mb-1.5">Advisor</SectionLabel>
          <SettingsRow
            title="Anthropic API key"
            sub={
              aiContext?.configured
                ? `Conversational chat enabled · ${CREDENTIAL_SOURCE_LABEL[aiContext.credential_source ?? 'none']}`
                : 'Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or sign in with `ant auth login` · optional'
            }
            trailing={
              aiContext?.configured ? <span className="text-sage-deep">Set</span> : <span className="text-muted-2">Not set</span>
            }
          />
          {aiContext?.configured && (
            <AdvisorModelPanel open={openPanel === 'advisor_model'} onToggle={() => toggle('advisor_model')} />
          )}
          {aiContext?.configured && (
            <AiActionsPanel open={openPanel === 'ai_actions'} onToggle={() => toggle('ai_actions')} />
          )}
          <AdvisorContextEditor
            open={openPanel === 'advisor_profile'}
            onToggle={() => toggle('advisor_profile')}
          />
          {/* What the AI applies unattended is a fixed domain boundary now, not a dial: it
              categorizes and writes merchant rules on its own, and everything that changes a
              target you set waits for you. Stated rather than configured. */}
          <SettingsRow
            title="What the AI can do on its own"
            sub="Categorizes transactions and writes merchant rules · budgets, goals, and bills always wait for you"
            trailing={<span className="text-muted-2">Always on</span>}
            last
          />
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
          <SettingsRow title="Appearance" trailing={<ThemeToggle />} last />
        </div>

        {/* Data */}
        <div>
          <SectionLabel className="mb-1.5">Data</SectionLabel>
          <SettingsRow
            title="Local backup"
            sub="Full JSON snapshot of the database"
            trailing={<span className="text-muted">{backup.isPending ? 'Backing up…' : 'Back up now →'}</span>}
            onClick={() => backup.mutate()}
          />
          <SettingsRow
            title="Export all data"
            trailing={<span className="text-muted">{exportCsv.isPending ? 'Exporting…' : 'CSV →'}</span>}
            onClick={() => exportCsv.mutate()}
            last
          />
        </div>

        <div className="mt-8 text-note leading-relaxed text-muted-2">
          Mizān v1.0 · data stored in <span className="font-mono text-note">.mizan/</span> · MIT licensed
        </div>
      </div>
    </Screen>
  );
}
