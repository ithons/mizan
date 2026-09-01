import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ReconciliationReading } from '@shared/types';
import { insightsApi } from '../lib/api';
import { formatWholeCurrency } from '../lib/formatters';
import { SectionLabel, TextButton } from './balance';

/**
 * Whether the ledger explains the balances, on a screen.
 *
 * `GET /api/insights/reconciliation` calls itself "the one check that decides whether every other
 * number in the app is true" and was the only data route in the app with no client caller. It ran
 * on request and reached nothing but the advisor's prompt, so the owner could be told the answer
 * by asking, and could not see it. This repo already holds that a fetcher with no caller is a
 * dropped capability rather than dead code; a route with no fetcher is the same thing one layer
 * down.
 *
 * SILENT ON A HEALTHY LEDGER, which is rule 3 and is the whole design of this component. Nothing
 * renders unless `unreconciled` or `flow_conservation` is non-empty. In particular it does NOT
 * render `residual_all_accounts`: that figure sums the raw residual over every account including
 * the market-driven ones the filter exempts, so it is routinely large on a ledger that is entirely
 * fine, and putting it on screen would be a standing number the owner cannot act on. It stays on
 * the route, under a name that says which population it covers, for the advisor to reason with.
 *
 * A market-driven account never appears here. Its balance moves when a price moves, so a residual
 * on it is not evidence of anything; `reconciliation.ts` exempts it and says why. Mis-signed
 * transfers on a brokerage are caught by the flow-conservation half instead, which compares two
 * ledgers to each other and never to a balance.
 */
export function LedgerIntegrityPanel({ className = '' }: { className?: string }) {
  const navigate = useNavigate();
  const { data } = useQuery<ReconciliationReading>({
    queryKey: ['insights', 'reconciliation'],
    queryFn: insightsApi.reconciliation,
    staleTime: 60_000,
  });

  const unreconciled = data?.unreconciled ?? [];
  const flows = data?.flow_conservation ?? [];
  // Two snapshots are the minimum a horizon can be drawn between; below that the check has not run
  // rather than passed, and saying nothing is right either way.
  if (unreconciled.length === 0 && flows.length === 0) return null;

  return (
    <div className={className}>
      <SectionLabel className="mb-2">What the ledger does not explain</SectionLabel>

      {unreconciled.map((account) => (
        <div key={account.account_id} className="border-b border-line py-3 last:border-0">
          <div className="flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <div className="truncate text-body-lg text-ink">{account.account_name}</div>
              <div className="mt-0.5 text-note text-muted-2">
                {/* The two figures are stated separately because they answer different questions:
                    what the balance did, and what the rows account for. A single "off by" number
                    would hide which side is which. */}
                Between {account.first_date} and {account.last_date} the balance moved{' '}
                {formatWholeCurrency(account.observed_delta)} and the transactions account for{' '}
                {formatWholeCurrency(account.explained_delta)}
                {account.direction_conflict ? ', in the opposite direction' : ''}.
              </div>
            </div>
            <div className="whitespace-nowrap text-right">
              <div className="font-serif text-sub tabular-nums text-clay">
                {formatWholeCurrency(Math.abs(account.adjusted_residual))}
              </div>
              <div className="mt-0.5 text-note text-muted-2">unexplained</div>
            </div>
          </div>
          <div className="mt-1.5">
            <TextButton onClick={() => navigate(`/accounts/${account.account_id}`)}>
              Open {account.account_name}
            </TextButton>
          </div>
        </div>
      ))}

      {flows.map((flow) => (
        <div
          key={`${flow.account_a_id}-${flow.account_b_id}`}
          className="border-b border-line py-3 last:border-0"
        >
          <div className="flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <div className="truncate text-body-lg text-ink">
                {flow.account_a_name ?? 'An account'} and {flow.account_b_name ?? 'another account'}
              </div>
              <div className="mt-0.5 text-note text-muted-2">
                {/* Says what was compared, not what to conclude. The detector establishes that two
                    ledgers disagree about the same movement; it does not establish which side is
                    wrong, and the copy must not imply that it does. */}
                {flow.leg_count} rows between {flow.first_date} and {flow.last_date} record the same
                movement leaving both accounts. One side has the wrong sign.
              </div>
            </div>
            <div className="whitespace-nowrap text-right">
              <div className="font-serif text-sub tabular-nums text-clay">
                {formatWholeCurrency(flow.movement)}
              </div>
              <div className="mt-0.5 text-note text-muted-2">at issue</div>
            </div>
          </div>
          <div className="mt-1.5">
            {/* The last mile. The detector has named a pair and a movement for months; what it
                never did was hand the owner the rows, so acting on it meant going and finding them.
                One account at a time, because the ledger's account filter holds one account: the
                two sides are compared by opening each. Range `all` because a finding's own dates
                reach back further than any default window. */}
            <TextButton onClick={() => navigate(`/ledger?accountId=${flow.account_a_id}&range=all`)}>
              Open {flow.account_a_name ?? 'the first account'}
            </TextButton>
            <span className="px-2 text-note text-muted-2">·</span>
            <TextButton onClick={() => navigate(`/ledger?accountId=${flow.account_b_id}&range=all`)}>
              Open {flow.account_b_name ?? 'the second account'}
            </TextButton>
          </div>
        </div>
      ))}
    </div>
  );
}
