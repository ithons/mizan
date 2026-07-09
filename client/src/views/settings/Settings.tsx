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
import { TaxesSection } from './TaxesSection';

const AUTO_APPLY_PREFERENCE_KEY = 'advisor_auto_apply_high_confidence';

type PanelId = 'simplefin' | 'coinbase' | 'import' | 'categories' | 'taxes' | null;

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

export function Settings() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [searchParams] = useSearchParams();
  const [openPanel, setOpenPanel] = useState<PanelId>(null);

  useEffect(() => {
    if (searchParams.get('section') === 'connections') setOpenPanel('simplefin');
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
  const autoApply = autoApplyPref?.value ?? false;

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
          <SettingsRow
            title="Tax withholding"
            sub="Set aside a share of taxable income automatically"
            trailing={<span className="text-muted">Configure →</span>}
            onClick={() => toggle('taxes')}
          />
          {openPanel === 'taxes' && (
            <ExpandedPanel>
              <TaxesSection />
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
