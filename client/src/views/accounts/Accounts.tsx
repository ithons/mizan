import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Account } from '@shared/types';
import { accountsApi, syncApi } from '../../lib/api';
import { formatCompactRelative, formatWholeCurrency } from '../../lib/formatters';
import { ACCOUNT_TYPE_LABELS } from '../../lib/constants';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { useAppStore } from '../../store';
import { Screen, ScreenHeader, SectionLabel, Row, TextButton } from '../../components/balance';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { AddManualAccountModal, EditAccountModal } from './Modals';

const GROUPS: Array<{ name: string; match: (a: Account) => boolean }> = [
  { name: 'Cash', match: (a) => !a.is_liability && ['checking', 'savings', 'cash'].includes(a.type) },
  { name: 'Investments', match: (a) => !a.is_liability && ['brokerage', 'ira_traditional', 'ira_roth'].includes(a.type) },
  { name: 'Crypto', match: (a) => !a.is_liability && a.type === 'crypto_wallet' },
  { name: 'Credit cards', match: (a) => a.type === 'credit' },
  { name: 'Loans', match: (a) => a.is_liability && a.type !== 'credit' },
  { name: 'Other', match: () => true },
];

function signedBalance(a: Account): number {
  return a.is_liability ? -Math.abs(a.current_balance) : a.current_balance;
}

const CONNECTION_LABELS: Record<Account['connection_type'], string> = {
  simplefin: 'SimpleFIN',
  coinbase: 'Coinbase',
  manual: 'Manual',
};

function accountMeta(a: Account): string {
  const verb = a.connection_type === 'manual' ? 'updated' : 'synced';
  return `${CONNECTION_LABELS[a.connection_type] ?? 'Manual'} · ${verb} ${formatCompactRelative(a.updated_at)}`;
}

export function Accounts() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [searchParams] = useSearchParams();
  const handledSetupActionRef = useRef(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);

  const { data: accounts, isLoading } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });

  // Handle onboarding deep links: ?connect=bank routes to connections, ?manual=1 opens the add modal.
  useEffect(() => {
    if (handledSetupActionRef.current) return;
    const connect = searchParams.get('connect');
    const manual = searchParams.get('manual');
    if (connect !== 'bank' && manual !== '1') return;
    handledSetupActionRef.current = true;
    navigate('/accounts', { replace: true });
    if (connect === 'bank') {
      navigate('/settings?section=connections');
      return;
    }
    setShowAddModal(true);
  }, [navigate, searchParams]);

  const visible = useMemo(() => (accounts ?? []).filter((a) => !a.is_hidden), [accounts]);
  const hidden = useMemo(() => (accounts ?? []).filter((a) => a.is_hidden), [accounts]);

  const groups = useMemo(() => {
    const remaining = new Set(visible.map((a) => a.id));
    return GROUPS.map((g) => {
      const rows = visible.filter((a) => remaining.has(a.id) && g.match(a));
      rows.forEach((a) => remaining.delete(a.id));
      return { name: g.name, rows, total: rows.reduce((s, a) => s + signedBalance(a), 0) };
    }).filter((g) => g.rows.length > 0);
  }, [visible]);

  const assets = visible.reduce((s, a) => s + Math.max(0, signedBalance(a)), 0);
  const liabilities = visible.reduce((s, a) => s + Math.min(0, signedBalance(a)), 0);
  const netWorth = assets + liabilities;

  const selected = (accounts ?? []).find((a) => a.id === selectedId) ?? null;

  const syncAll = useMutation({
    mutationFn: () => syncApi.run(),
    onSuccess: () => addToast({ type: 'info', message: 'Sync started' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const toggleHidden = useMutation({
    mutationFn: (a: Account) => accountsApi.update(a.id, { is_hidden: !a.is_hidden }),
    onSuccess: () => invalidateFinancialData(qc),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteAccount = useMutation({
    mutationFn: (a: Account) => accountsApi.delete(a.id),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Account removed' });
      setRemoving(null);
      setSelectedId(null);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const renderRow = (a: Account, dimmed = false) => (
    <Row
      key={a.id}
      onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}
      className={`justify-between px-3 py-4 ${dimmed ? 'opacity-55' : ''} ${
        selectedId === a.id ? 'bg-rail' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-lg bg-rail font-serif text-[15px] text-muted">
          {(a.institution_name || a.account_name).charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15.5px] text-ink">{a.account_name}</div>
          <div className="mt-0.5 text-[12.5px] text-muted-2">{accountMeta(a)}</div>
        </div>
      </div>
      <span className={`font-serif text-[19px] tabular-nums ${signedBalance(a) < 0 ? 'text-clay' : 'text-ink'}`}>
        {formatWholeCurrency(signedBalance(a))}
      </span>
    </Row>
  );

  return (
    <Screen>
      <ScreenHeader
        title="Accounts"
        sub={
          <>
            {visible.length} account{visible.length === 1 ? '' : 's'} · net worth{' '}
            <span className="tabular-nums">{formatWholeCurrency(netWorth)}</span>
          </>
        }
        actions={
          <>
            <TextButton onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
              Sync all
            </TextButton>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="text-[13.5px] text-ink transition-opacity hover:opacity-75"
            >
              + Add account
            </button>
          </>
        }
        className="mb-7"
      />

      {/* 3-up summary */}
      <div className="mb-8 grid max-w-[720px] flex-shrink-0 grid-cols-3 gap-4">
        {[
          { label: 'Assets', value: assets, tone: 'text-ink' },
          { label: 'Liabilities', value: liabilities, tone: liabilities < 0 ? 'text-clay' : 'text-ink' },
          { label: 'Net worth', value: netWorth, tone: 'text-ink' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-line-2 bg-card p-4">
            <div className="text-xs text-muted">{s.label}</div>
            <div className={`mt-1.5 font-serif text-[22px] leading-tight tabular-nums ${s.tone}`}>
              {formatWholeCurrency(s.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 gap-12">
        {/* Grouped account list */}
        <div className="min-w-0 max-w-[720px] flex-1 overflow-y-auto">
          {isLoading && (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-line/60" />
              ))}
            </div>
          )}
          {!isLoading && visible.length === 0 && (
            <div className="py-10 text-[14px] text-muted">
              No accounts yet.{' '}
              <button
                type="button"
                onClick={() => navigate('/settings?section=connections')}
                className="text-ink underline underline-offset-2"
              >
                Connect SimpleFIN or Coinbase
              </button>{' '}
              or add one manually.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.name} className="mb-7">
              <SectionLabel underline summary={formatWholeCurrency(g.total)} className="mb-1.5">
                {g.name}
              </SectionLabel>
              {g.rows.map((a) => renderRow(a))}
            </div>
          ))}
          {hidden.length > 0 && (
            <div className="mb-7">
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
                className="mb-1.5 text-[12.5px] text-muted-2 transition-colors hover:text-ink"
              >
                {hidden.length} hidden account{hidden.length === 1 ? '' : 's'} · {showHidden ? 'collapse' : 'show'}
              </button>
              {showHidden && hidden.map((a) => renderRow(a, true))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="w-[300px] flex-shrink-0">
            <div className="mb-4 flex items-baseline justify-between">
              <span className="font-serif text-xl text-ink">{selected.account_name}</span>
            </div>
            <div className={`font-serif text-[28px] tabular-nums ${signedBalance(selected) < 0 ? 'text-clay' : 'text-ink'}`}>
              {formatWholeCurrency(signedBalance(selected))}
            </div>
            <div className="mt-6">
              {[
                { label: 'Institution', value: selected.institution_name || '—' },
                { label: 'Type', value: ACCOUNT_TYPE_LABELS[selected.type] ?? selected.type },
                { label: 'Connection', value: CONNECTION_LABELS[selected.connection_type] ?? 'Manual' },
                { label: 'Updated', value: formatCompactRelative(selected.updated_at) },
              ].map((row, i, arr) => (
                <div
                  key={row.label}
                  className={`flex items-baseline justify-between py-2 ${i < arr.length - 1 ? 'border-b border-line' : ''}`}
                >
                  <span className="text-[13px] text-muted">{row.label}</span>
                  <span className="text-[13.5px] text-ink">{row.value}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-col items-start gap-3">
              <TextButton variant="primary" onClick={() => setEditing(selected)}>
                Edit account
              </TextButton>
              <TextButton onClick={() => navigate('/transactions')}>View transactions →</TextButton>
              <TextButton onClick={() => toggleHidden.mutate(selected)}>
                {selected.is_hidden ? 'Unhide from lists' : 'Hide from lists'}
              </TextButton>
              <TextButton onClick={() => setRemoving(selected)} className="hover:!text-clay">
                Remove…
              </TextButton>
            </div>
          </div>
        )}
      </div>

      <AddManualAccountModal open={showAddModal} onClose={() => setShowAddModal(false)} />
      <EditAccountModal open={editing != null} account={editing} onClose={() => setEditing(null)} />
      <ConfirmRemoveModal
        open={removing != null}
        onClose={() => setRemoving(null)}
        title="Remove account"
        description={`This removes "${removing?.account_name}" and all of its transactions from Mizān. It does not touch the real account.`}
        confirmLabel="Remove account"
        onConfirm={() => removing && deleteAccount.mutate(removing)}
        isPending={deleteAccount.isPending}
      />
    </Screen>
  );
}
