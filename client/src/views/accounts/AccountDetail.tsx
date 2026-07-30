import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { accountsApi, investmentsApi, transactionsApi } from '../../lib/api';
import { ACCOUNT_TYPE_LABELS } from '../../lib/constants';
import { formatCompactRelative, formatCurrencyColored, formatDate, formatWholeCurrency } from '../../lib/formatters';
import { Screen, SectionLabel, TextButton, TrendChart } from '../../components/balance';
import { SkeletonRows } from '../../components/SkeletonLoader';

const INVESTMENT_TYPES = new Set(['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet']);

export function AccountDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const { data: accounts, isLoading } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const account = accounts?.find((a) => a.id === id) ?? null;
  const isInvestment = account ? INVESTMENT_TYPES.has(account.type) : false;

  const { data: history } = useQuery({
    queryKey: ['account', id, 'history'],
    queryFn: () => accountsApi.history(id),
    enabled: Boolean(id),
    retry: false,
  });
  const { data: holdings } = useQuery({
    queryKey: ['account', id, 'holdings'],
    queryFn: () => investmentsApi.holdingsByAccount(id),
    enabled: Boolean(id) && isInvestment,
    retry: false,
  });
  const { data: txPage } = useQuery({
    queryKey: ['account', id, 'transactions'],
    queryFn: () => transactionsApi.list({ accountId: [id], limit: 25 }),
    enabled: Boolean(id),
  });

  const chart = useMemo(
    // `estimated` was never carried, so this chart drew reverse-replay reconstructions as one
    // solid measured line: Wealthfront Cash appeared to hold $1,517 and collapse to $0.00 at the
    // end of June, an event that never happened for an account that was not yet connected.
    () => (history ?? []).map((p) => ({ date: p.date, value: p.balance, estimated: p.estimated })),
    [history]
  );

  const signedBalance = account ? (account.is_liability ? -Math.abs(account.current_balance) : account.current_balance) : 0;
  const transactions = txPage?.data ?? [];

  if (isLoading) {
    return (
      <Screen>
        <SkeletonRows rows={6} />
      </Screen>
    );
  }

  if (!account) {
    return (
      <Screen>
        <div className="py-10 text-body-lg text-muted">
          Account not found.{' '}
          <button type="button" onClick={() => navigate('/accounts')} className="text-ink underline underline-offset-2">
            Back to accounts
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <button
        type="button"
        onClick={() => navigate('/accounts')}
        className="mb-4 text-note text-muted-2 transition-colors hover:text-ink"
      >
        ← Accounts
      </button>

      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-serif text-display font-normal leading-tight text-ink">{account.account_name}</h1>
          <div className="mt-1 text-body text-muted">
            {account.institution_name || 'Manual'} · {ACCOUNT_TYPE_LABELS[account.type] ?? account.type} · updated{' '}
            {formatCompactRelative(account.updated_at)}
          </div>
        </div>
        <div className={`font-serif text-display tabular-nums ${signedBalance < 0 ? 'text-clay' : 'text-ink'}`}>
          {formatWholeCurrency(signedBalance)}
        </div>
      </div>

      {chart.length >= 2 && (
        <div className="mb-8">
          <SectionLabel className="mb-2">Balance over time</SectionLabel>
          <TrendChart history={chart} height={110} />
        </div>
      )}

      {isInvestment && holdings && holdings.length > 0 && (
        <div className="mb-8">
          <SectionLabel underline className="mb-1.5">
            Holdings
          </SectionLabel>
          {holdings.map((h) => (
            <div key={h.id} className="flex items-baseline justify-between border-b border-line py-2 last:border-0">
              <div className="min-w-0">
                <div className="truncate text-body-lg text-ink">{h.ticker ?? h.security_name ?? 'Holding'}</div>
                <div className="text-note text-muted-2">{h.quantity} units</div>
              </div>
              <div className="tabular-nums text-body-lg text-ink">{formatWholeCurrency(h.institution_value)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-8">
        <div className="mb-1.5 flex items-baseline justify-between">
          <SectionLabel underline className="flex-1">
            Recent transactions
          </SectionLabel>
          <TextButton onClick={() => navigate('/transactions')}>View all →</TextButton>
        </div>
        {transactions.length === 0 ? (
          <div className="py-6 text-body text-muted">No transactions for this account yet.</div>
        ) : (
          transactions.map((t) => {
            const amount = formatCurrencyColored(t.amount);
            return (
              <div key={t.id} className="flex items-baseline justify-between border-b border-line py-2 last:border-0">
                <div className="min-w-0">
                  <div className="truncate text-body-lg text-ink">{t.merchant_name || t.original_name || 'Transaction'}</div>
                  <div className="text-note text-muted-2">{formatDate(t.date)}</div>
                </div>
                <div className={`tabular-nums text-body-lg ${amount.className}`}>{amount.text}</div>
              </div>
            );
          })
        )}
      </div>
    </Screen>
  );
}
