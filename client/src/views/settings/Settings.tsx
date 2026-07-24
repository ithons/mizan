import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { accountsApi, aiApi, categoriesApi, flattenCategories, rulesApi, settingsApi, simplefinApi } from '../../lib/api';
import { formatCompactRelative } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { Screen, SectionLabel } from '../../components/balance';
import { SimplefinSection } from './SimplefinSection';
import { CoinbaseSection } from './CoinbaseSection';
import { CategoriesSection } from './CategoriesSection';
import { RulesSection } from './RulesSection';
import { DataSection } from './DataSection';

const AUTO_APPLY_PREFERENCE_KEY = 'advisor_auto_apply_high_confidence';

type PanelId = 'simplefin' | 'coinbase' | 'import' | 'categories' | 'ai_disclosure' | 'advisor_profile' | 'advisor_model' | 'ai_actions' | null;

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
        onClick ? 'cursor-pointer hover:bg-rail' : ''
      } ${last ? '' : 'border-b border-line'}`}
    >
      <div>
        <div className="text-[15.5px] text-ink">{title}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-2">{sub}</div>}
      </div>
      <div className="flex-shrink-0 pl-4 text-[13px]">{trailing}</div>
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`relative h-5 w-[34px] rounded-[11px] transition-colors disabled:opacity-50 ${on ? 'bg-sage' : 'bg-line-3'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-card transition-all ${on ? 'right-0.5' : 'left-0.5'}`}
      />
    </button>
  );
}

function ExpandedPanel({ children }: { children: ReactNode }) {
  return <div className="mb-2 mt-1 rounded-xl border border-line-2 bg-card p-5">{children}</div>;
}

function AiActionsPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { data: actions } = useQuery({
    queryKey: ['ai-actions'],
    queryFn: () => aiApi.listActions(),
    enabled: open,
  });
  return (
    <>
      <SettingsRow
        title="What the AI has done"
        sub="Every action the AI applied to your data — auto-applied or confirmed by you"
        trailing={<span className="text-muted">{open ? 'Hide' : 'Review →'}</span>}
        onClick={onToggle}
      />
      {open && (
        <ExpandedPanel>
          {(!actions || actions.length === 0) ? (
            <p className="text-[13.5px] text-muted-2">No AI actions yet.</p>
          ) : (
            <div className="space-y-2.5">
              {actions.map((a) => (
                <div key={a.id} className="flex items-start justify-between gap-3 border-b border-line pb-2.5 last:border-0">
                  <div className="min-w-0">
                    <div className="text-[14px] text-ink">{a.label}</div>
                    <div className="mt-0.5 text-xs text-muted-2">{a.summary}</div>
                  </div>
                  <div className="flex-shrink-0 text-right text-[11px] text-muted-2">
                    <div className={a.source === 'worker_auto' ? 'text-warning' : 'text-sage-deep'}>
                      {a.source === 'worker_auto' ? 'auto-applied' : 'you confirmed'}
                    </div>
                    <div>{formatCompactRelative(a.created_at)}</div>
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
            <p className="text-[13.5px] leading-relaxed text-muted">
              Injected into every AI prompt (chat and the background worker) so the advisor reasons from your
              real situation instead of guessing.
            </p>
            <textarea
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              maxLength={4000}
              placeholder="e.g. I autopay my cards in full each month; I'm a student with seasonal income; I prefer a taxable brokerage over a Roth IRA."
              className="w-full resize-y rounded-lg border border-line-2 bg-rail p-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none focus:border-sage"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-2">{value.length}/4000</span>
              <button
                type="button"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate(value)}
                className="rounded-lg bg-sage px-4 py-2 text-[13px] text-card transition-opacity disabled:opacity-50"
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

  const enabled = new Set(settings?.context_sections ?? []);
  const modelLabel = settings?.available.models.find((m) => m.id === settings.model)?.label ?? settings?.model ?? '';

  const toggleSection = (id: string) => {
    if (!settings) return;
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save.mutate({ context_sections: [...next] });
  };

  return (
    <>
      <SettingsRow
        title="Model & context"
        sub={settings ? `${modelLabel} · ${settings.effort} effort · ${enabled.size}/${settings.available.sections.length} context sections` : 'Choose model, effort, and what the advisor sees'}
        trailing={<span className="text-muted">{open ? 'Hide' : 'Configure →'}</span>}
        onClick={onToggle}
      />
      {open && settings && (
        <ExpandedPanel>
          <div className="space-y-5">
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-ink">Model</div>
              <div className="flex flex-wrap gap-2">
                {settings.available.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ model: m.id })}
                    className={`rounded-lg border px-3 py-2 text-[13px] transition-colors disabled:opacity-50 ${
                      settings.model === m.id ? 'border-sage bg-sage/10 text-ink' : 'border-line-2 text-muted hover:bg-rail'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[13px] font-medium text-ink">Reasoning effort</div>
              <div className="flex gap-2">
                {settings.available.efforts.map((e) => (
                  <button
                    key={e}
                    type="button"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ effort: e })}
                    className={`rounded-lg border px-3 py-2 text-[13px] capitalize transition-colors disabled:opacity-50 ${
                      settings.effort === e ? 'border-sage bg-sage/10 text-ink' : 'border-line-2 text-muted hover:bg-rail'
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-2">Higher effort reasons more before answering, at more tokens and latency.</p>
            </div>

            <div>
              <div className="mb-1.5 text-[13px] font-medium text-ink">Financial context sections</div>
              <p className="mb-2 text-xs text-muted-2">
                What the snapshot injected into every prompt includes. Accounts, net worth, and your personal context are always sent.
              </p>
              <div className="space-y-2">
                {settings.available.sections.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center justify-between gap-3">
                    <span className="text-[13.5px] text-ink">{s.label}</span>
                    <Toggle on={enabled.has(s.id)} onChange={() => toggleSection(s.id)} disabled={save.isPending} />
                  </label>
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
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [searchParams] = useSearchParams();
  const [openPanel, setOpenPanel] = useState<PanelId>(null);

  useEffect(() => {
    const section = searchParams.get('section');
    if (section === 'connections' || section === 'simplefin') setOpenPanel('simplefin');
    else if (section === 'coinbase') setOpenPanel('coinbase');
    else if (section === 'data' || section === 'import') setOpenPanel('import');
  }, [searchParams]);

  const { data: credentials } = useQuery({ queryKey: ['credential-status'], queryFn: () => settingsApi.getCredentials() });
  const { data: simplefinConnection } = useQuery({ queryKey: ['simplefin-connection'], queryFn: () => simplefinApi.connection() });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: aiContext } = useQuery({ queryKey: ['ai-context'], queryFn: () => aiApi.getContext() });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: () => rulesApi.list() });
  const { data: autoApplyPref } = useQuery({
    queryKey: ['settings', 'preferences', AUTO_APPLY_PREFERENCE_KEY],
    queryFn: () => settingsApi.getPreference<boolean>(AUTO_APPLY_PREFERENCE_KEY),
  });

  const setAutoApply = useMutation({
    mutationFn: (value: boolean) => settingsApi.setPreference(AUTO_APPLY_PREFERENCE_KEY, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'preferences', AUTO_APPLY_PREFERENCE_KEY] }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

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
  const autoApply = autoApplyPref?.value ?? true;

  const toggle = (panel: PanelId) => setOpenPanel((prev) => (prev === panel ? null : panel));
  const statusText = (connected: boolean) =>
    connected ? <span className="text-sage-deep">Connected</span> : <span className="text-muted">Connect →</span>;

  return (
    <Screen size="editorial">
      <div className="mb-8 flex-shrink-0">
        <h1 className="font-serif text-[27px] font-normal leading-tight text-ink">Settings</h1>
        <div className="mt-1 text-[13.5px] text-muted">Everything runs on your machine · no account, no cloud</div>
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
                ? 'Conversational chat enabled'
                : 'Set ANTHROPIC_API_KEY in .env to enable conversational chat · optional'
            }
            trailing={
              aiContext?.configured ? <span className="text-sage-deep">Set</span> : <span className="text-muted-2">Not set</span>
            }
          />
          {aiContext?.configured && (
            <>
              <SettingsRow
                title="What Mizān sends to Anthropic"
                sub="AI is enabled · review exactly what leaves your machine"
                trailing={<span className="text-muted">{openPanel === 'ai_disclosure' ? 'Hide' : 'Review →'}</span>}
                onClick={() => toggle('ai_disclosure')}
              />
              {openPanel === 'ai_disclosure' && (
                <ExpandedPanel>
                  <div className="space-y-3 text-[13.5px] leading-relaxed text-muted">
                    <p>
                      Because <span className="text-ink">ANTHROPIC_API_KEY</span> is set, Mizān sends the financial
                      snapshot below to Anthropic's API in two cases: every time you send a message in Advisor, and
                      automatically after every sync, when the background worker proposes drafts. Nothing is sent when
                      no key is configured.
                    </p>
                    <p>
                      In Advisor, the model can also call read-only tools to look up your transactions, spending by
                      category, and monthly cash flow — so specific rows may be sent in response to what you ask.
                    </p>
                    <p>
                      The background worker sends a bit more than the snapshot below: your category list and up to 15 of
                      your uncategorized transactions (merchant and amount), so it can propose categorizations.
                      Confirming an auto-categorization also creates a merchant rule so similar transactions are handled
                      the same way in future.
                    </p>
                    <p>
                      Each sync also fetches crypto spot prices from Coinbase. That request carries no personal data.
                    </p>
                    <p className="text-ink">This is the base snapshot, regenerated live:</p>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line-2 bg-rail p-3 font-mono text-[12px] text-ink">
                      {aiContext.context || 'No context available yet — run a sync first.'}
                    </pre>
                  </div>
                </ExpandedPanel>
              )}
            </>
          )}
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
          <SettingsRow
            title="Auto-apply high-confidence drafts"
            sub="Categorization & rules over 90% confidence"
            trailing={<Toggle on={autoApply} onChange={(v) => setAutoApply.mutate(v)} disabled={setAutoApply.isPending} />}
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
          <SettingsRow title="Appearance" trailing={<span className="text-muted">Light</span>} last />
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

        <div className="mt-8 text-xs leading-relaxed text-muted-2">
          Mizān v1.0 · data stored in <span className="font-mono text-xs">.mizan/</span> · MIT licensed
        </div>
      </div>
    </Screen>
  );
}
