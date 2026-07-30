import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AccountBalanceHistory } from '@shared/types';
import { accountsApi, investmentsApi, transactionsApi } from '../../lib/api';
import { ACCOUNT_TYPE_LABELS } from '../../lib/constants';
import {
  formatCompactRelative,
  formatCurrencyColored,
  formatDate,
  formatWholeCurrency,
} from '../../lib/formatters';
import { creditNote, isInCredit, signedAccountBalance } from '../../lib/accountBalance';
import { Screen, SectionLabel, TextButton, TrendChart } from '../../components/balance';
import { SkeletonRows } from '../../components/SkeletonLoader';

const INVESTMENT_TYPES = new Set(['brokerage', 'ira_traditional', 'ira_roth', 'crypto_wallet']);

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Where the line starts, and why it stops there instead of running back to zero.
 *
 * A chart that begins mid-air is making a claim about everything to the left of it. The ledger can
 * only reach the account's first transaction, or the point where its imported history begins, and
 * saying which is the difference between "nothing happened before this" and "nothing was recorded".
 */
export function seriesOrigin(history: AccountBalanceHistory): string | null {
  const from = history.start_date ? formatDate(history.start_date) : '';
  const count = plural(history.transaction_count, 'transaction');
  switch (history.start_reason) {
    case 'first_transaction':
      return `Reconstructed from this account's ${count}, back to ${from}, the first one recorded.`;
    case 'backfill_floor':
      return `Reconstructed from this account's ${count}. The ledger begins ${from}; nothing earlier was ever imported, so the line does not go there.`;
    case 'requested_window':
      return `Reconstructed from this account's ledger over the window shown, from ${from}.`;
    case 'snapshot_series':
      return 'Drawn from recorded balance sheets rather than this account’s ledger: reversing individual buys and sells cannot reconstruct a price move.';
    case 'no_ledger':
      return 'No transactions on this account yet, so there is no balance history to draw.';
    case 'account_not_found':
      return null;
  }
}

/**
 * What the dots on the line are.
 *
 * The line is the ledger's reconstruction and the dots are balances the Net worth screen recorded,
 * drawn at the value they recorded. Where the two land apart the reader sees it. Nothing here
 * measures the distance between them or calls it anything: every previous version of this line
 * computed a difference off day boundaries, and a snapshot taken partway through an ordinary day of
 * inflows and outflows sits away from every one of those boundaries without anything being wrong.
 */
export function seriesMeasurements(history: AccountBalanceHistory): string | null {
  if (history.basis !== 'ledger' || history.measurements.length === 0) return null;
  return history.measurements.length === 1
    ? 'The dot is the one balance recorded for this account on a day net worth was captured.'
    : `Dots mark the ${history.measurements.length} balances recorded for this account on days net worth was captured.`;
}

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

  // One line, one style. A ledger series is a reconstruction end to end and says so in `origin`;
  // only the snapshot basis carries reverse-replayed points, and those stay dashed.
  const chart = useMemo(
    () => (history?.points ?? []).map((p) => ({ date: p.date, value: p.balance, estimated: p.source === 'estimated' })),
    [history]
  );
  const marks = useMemo(
    () => (history?.measurements ?? []).map((m) => ({ date: m.date, value: m.balance })),
    [history]
  );

  const origin = history ? seriesOrigin(history) : null;
  const measurements = history ? seriesMeasurements(history) : null;
  const signedBalance = account ? signedAccountBalance(account) : 0;
  const inCredit = account ? isInCredit(account) : false;
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
        <div className="text-right">
          <div
            className={`font-serif text-display tabular-nums ${
              inCredit ? 'text-sage-deep' : signedBalance < 0 ? 'text-clay' : 'text-ink'
            }`}
          >
            {formatWholeCurrency(signedBalance)}
          </div>
          {inCredit && <div className="mt-1 text-note text-sage-deep">{creditNote(account)}</div>}
        </div>
      </div>

      {history && (
        <div className="mb-8">
          <SectionLabel className="mb-2">Balance over time</SectionLabel>
          {chart.length >= 2 && <TrendChart history={chart} marks={marks} height={110} />}
          {origin && <div className="mt-2 text-note text-muted-2">{origin}</div>}
          {measurements && <div className="mt-1 text-note text-muted-2">{measurements}</div>}
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
