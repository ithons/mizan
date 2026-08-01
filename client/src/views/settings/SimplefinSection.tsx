import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SimplefinRelinkPairStrength,
  SimplefinRelinkPairView,
  SimplefinRelinkPendingResponse,
  SimplefinRelinkStoredCarryView,
  SimplefinRelinkUnpairedProviderView,
  SimplefinRelinkUnpairedStoredView,
} from '@shared/types';
import { simplefinApi } from '../../lib/api';
import { formatCurrency, formatDate, formatRelativeTime } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { Card, InkButton, SectionLabel, TextButton } from '../../components/balance';

export function SimplefinSection() {
  const [setupToken, setSetupToken] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();

  const { data: relink } = useQuery({
    queryKey: ['simplefin', 'relink'],
    queryFn: simplefinApi.pendingRelink,
  });
  const [relinkBusy, setRelinkBusy] = useState(false);

  useEffect(() => {
    fetchConnection();
  }, []);

  const fetchConnection = async () => {
    try {
      const data = await simplefinApi.connection();
      setStatus(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await simplefinApi.setup({ setupToken });
      setSetupToken('');
      await fetchConnection();
    } catch (e: any) {
      setError(e.message || 'Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect SimpleFIN?')) return;
    setLoading(true);
    try {
      await simplefinApi.disconnect();
      await fetchConnection();
    } catch (e: any) {
      setError(e.message || 'Failed to disconnect');
    } finally {
      setLoading(false);
    }
  };

  const handleResync = async () => {
    if (
      !confirm(
        'Re-requests up to 2 years of history from SimpleFIN. Most institutions only expose data from when you connected, so this may not add much, but it doesn\'t hurt to check. Continue?'
      )
    )
      return;
    setResyncing(true);
    setError(null);
    try {
      const result = await simplefinApi.resync();
      await fetchConnection();
      if (result.transactionsAdded === 0 && result.transactionsModified === 0) {
        addToast({ type: 'info', message: 'Resync complete: no additional history was available' });
      } else {
        addToast({
          type: 'success',
          message: `Resync complete: ${result.transactionsAdded} new transaction(s), ${result.transactionsModified} updated`,
        });
      }
    } catch (e: any) {
      addToast({ type: 'error', message: e.message || 'Resync failed' });
    } finally {
      setResyncing(false);
    }
  };

  const settleRelink = async (run: () => Promise<string>) => {
    setRelinkBusy(true);
    try {
      const message = await run();
      addToast({ type: 'success', message });
      await queryClient.invalidateQueries({ queryKey: ['simplefin', 'relink'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e: any) {
      addToast({ type: 'error', message: e.message || 'Could not settle the re-link' });
    } finally {
      setRelinkBusy(false);
    }
  };

  const handleAdopt = (pairs: Array<{ stored_account_id: string; provider_account_id: string }>) =>
    settleRelink(async () => {
      const id = relink?.proposal?.id;
      if (!id) throw new Error('The re-link proposal is no longer pending');
      const result = await simplefinApi.adoptRelink(id, { pairs });
      const adopted = result.adopted.length;
      return `Moved ${adopted} provider id${adopted === 1 ? '' : 's'} onto existing accounts.`;
    });

  const handleDismissRelink = (reason: string) =>
    settleRelink(async () => {
      const id = relink?.proposal?.id;
      if (!id) throw new Error('The re-link proposal is no longer pending');
      await simplefinApi.dismissRelink(id, { reason });
      return 'Recorded these as new accounts. Syncing can run again.';
    });

  return (
    <div className="space-y-4">
      <p className="text-body text-muted">Primary bank connection, powered by MX. Read-only.</p>

      {error && <div className="text-body-lg text-clay">{error}</div>}

      <RelinkPanel
        pending={relink}
        busy={relinkBusy}
        onConfirm={handleAdopt}
        onDismiss={handleDismissRelink}
      />

      {status ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-body-lg">
            <span className="mr-2 text-sage-deep">● Connected</span>
            <span className="text-muted">
              {status.last_synced_at ? `Last synced ${formatRelativeTime(status.last_synced_at)}` : 'SimpleFIN active'}
            </span>
          </div>
          <div className="flex items-center gap-5">
            <TextButton onClick={handleResync} disabled={loading || resyncing}>
              {resyncing ? 'Resyncing…' : 'Resync full history'}
            </TextButton>
            <TextButton onClick={handleDisconnect} disabled={loading || resyncing} className="hover:!text-clay">
              Disconnect
            </TextButton>
          </div>
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-4">
          <div>
            <label className="mz-label">Setup token</label>
            <input
              type="text"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              placeholder="Paste your base64 setup token"
              className="mz-field"
              required
            />
          </div>
          <InkButton type="submit" disabled={loading || !setupToken}>
            {loading ? 'Connecting…' : 'Connect SimpleFIN'}
          </InkButton>
        </form>
      )}
    </div>
  );
}

// ─── Re-link ─────────────────────────────────────────────────────────────────
//
// The screen the owner settles a re-minted provider id on. On 2026-08-01 nine accounts arrived
// under new ids, nine duplicates were created and the nine originals were zeroed. Adoption undoes
// the need for any of that, but only if the owner confirms the RIGHT pairing, so this panel is
// built to be read rather than clicked through: every pair states the comparison behind it, both
// sides' leftovers are shown rather than hidden, no pair is selected on arrival, and the confirm
// control is disabled until the owner has picked at least one.

/** Total over the union, so a fourth strength cannot render as an empty label. */
const PAIR_STRENGTH_WORD: Readonly<Record<SimplefinRelinkPairStrength, string>> = {
  exact: 'Exact',
  strong: 'Strong',
  inferred: 'Inferred',
};

/**
 * A balance in the terms the row means it. A liability is stored positive as owed and is
 * legitimately negative when the card is in credit, and those are different states that have to
 * read differently.
 */
export function relinkBalanceLine(balance: number, isLiability: boolean): string {
  if (!isLiability) return formatCurrency(balance);
  if (balance < 0) return `${formatCurrency(Math.abs(balance))} in credit`;
  return `${formatCurrency(balance)} owed`;
}

/**
 * What the existing row carries, in one sentence.
 *
 * `undefined` is not "nothing": it is an account the proposal names that is no longer in the
 * ledger, and saying that is the point. Rendering a zero count for it would be a number nothing
 * measured.
 */
export function relinkCarryLine(carry: SimplefinRelinkStoredCarryView | undefined): string {
  if (!carry) return 'No longer in this ledger.';
  const count = carry.transaction_count;
  const transactions = `${count.toLocaleString('en-US')} transaction${count === 1 ? '' : 's'}`;
  if (count === 0) return 'No transactions yet.';
  return carry.first_transaction_date
    ? `${transactions}, starting ${formatDate(carry.first_transaction_date)}.`
    : `${transactions}.`;
}

interface RelinkPanelProps {
  pending: SimplefinRelinkPendingResponse | null | undefined;
  busy: boolean;
  onConfirm: (pairs: Array<{ stored_account_id: string; provider_account_id: string }>) => void;
  onDismiss: (reason: string) => void;
}

/**
 * Renders nothing at all when nothing is pending, which is the state of nearly every install
 * nearly all of the time. Not an empty panel, not a "no re-link detected" line: a standing panel
 * saying a detector found nothing is the shape that made a clean ledger read as having open
 * conditions.
 */
export function RelinkPanel({ pending, busy, onConfirm, onDismiss }: RelinkPanelProps) {
  const proposal = pending?.proposal ?? null;
  // Nothing is selected on arrival, and the effect below re-clears it whenever a different
  // proposal arrives, so a selection can never outlive the pairing it was made against.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [dismissReason, setDismissReason] = useState('');
  const proposalId = proposal?.id ?? null;

  useEffect(() => {
    setSelected({});
    setDismissReason('');
  }, [proposalId]);

  if (!proposal || proposal.status !== 'pending') return null;

  const carryFor = (accountId: string) =>
    pending?.carries.find((c) => c.account_id === accountId);
  const storedFor = (accountId: string) =>
    proposal.stored_accounts.find((a) => a.account_id === accountId);
  const providerFor = (providerAccountId: string) =>
    proposal.provider_accounts.find((a) => a.provider_account_id === providerAccountId);

  const chosen = proposal.pairs.filter((p) => selected[p.stored_account_id]);
  const canConfirm = chosen.length > 0 && !busy;

  return (
    <Card elevation={3} padding="lg" className="space-y-6">
      <div className="space-y-2">
        <SectionLabel>Account re-link</SectionLabel>
        <p className="text-body-lg text-ink">{proposal.headline}</p>
        <p className="text-body text-muted">{proposal.recovery_action}</p>
        <p className="text-note text-muted-2">Detected {formatDate(proposal.detected_at)}.</p>
      </div>

      <div className="space-y-1.5 border-l-2 border-line-2 pl-3">
        <p className="text-body text-ink">
          Confirming moves the new provider id onto the account you paired it with. That account
          keeps its name, its type, its transactions and the date its history starts, and no new
          account is created.
        </p>
        <p className="text-body text-clay">
          A pair confirmed onto the wrong account cannot be undone from this screen. The id moves,
          and from then on that provider account&rsquo;s transactions land on the row you chose.
        </p>
      </div>

      {proposal.pairs.length > 0 && (
        <div className="space-y-3">
          <SectionLabel summary={`${chosen.length} of ${proposal.pairs.length} selected`}>
            Proposed pairs
          </SectionLabel>
          {proposal.pairs.map((pair) => {
            const stored = storedFor(pair.stored_account_id);
            const provider = providerFor(pair.provider_account_id);
            const isSelected = Boolean(selected[pair.stored_account_id]);
            return (
              <PairCard
                key={pair.stored_account_id}
                pair={pair}
                storedType={stored?.type ?? null}
                storedBalance={
                  stored ? relinkBalanceLine(stored.balance, stored.is_liability) : null
                }
                carry={carryFor(pair.stored_account_id)}
                providerCurrency={provider?.currency ?? null}
                providerBalance={provider?.balance ?? null}
                selected={isSelected}
                disabled={busy}
                onToggle={() =>
                  setSelected((prev) => ({
                    ...prev,
                    [pair.stored_account_id]: !prev[pair.stored_account_id],
                  }))
                }
              />
            );
          })}
        </div>
      )}

      {proposal.unpaired_stored.length > 0 && (
        <UnpairedStored rows={proposal.unpaired_stored} carryFor={carryFor} />
      )}

      {proposal.unpaired_provider.length > 0 && (
        <UnpairedProvider rows={proposal.unpaired_provider} />
      )}

      <div className="space-y-2 border-t border-line pt-4">
        <InkButton
          disabled={!canConfirm}
          onClick={() =>
            onConfirm(
              chosen.map((p) => ({
                stored_account_id: p.stored_account_id,
                provider_account_id: p.provider_account_id,
              }))
            )
          }
        >
          {chosen.length === 0
            ? 'Select the pairs to confirm'
            : `Confirm ${chosen.length} pair${chosen.length === 1 ? '' : 's'}`}
        </InkButton>
        <p className="text-note text-muted">
          Pairs you leave unselected are not touched, and this stays here until every one is
          settled.
        </p>
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <SectionLabel>If these are new accounts, not a re-link</SectionLabel>
        <p className="text-body text-muted">
          Dismissing records that answer so the next sync stops asking, and lets it run. The
          existing accounts keep the provider ids they have now, so on a sync where SimpleFIN
          reports no errors they will be absent from the response, read as closed, and have their
          balances set to $0. Their transactions stay where they are.
        </p>
        <label className="mz-label" htmlFor="relink-dismiss-reason">
          Why these are new accounts
        </label>
        <input
          id="relink-dismiss-reason"
          type="text"
          className="mz-field"
          value={dismissReason}
          onChange={(e) => setDismissReason(e.target.value)}
          placeholder="e.g. I opened two accounts at a new bank"
        />
        <TextButton
          disabled={busy || dismissReason.trim().length === 0}
          onClick={() => onDismiss(dismissReason.trim())}
        >
          Dismiss: these are new accounts
        </TextButton>
      </div>
    </Card>
  );
}

interface PairCardProps {
  pair: SimplefinRelinkPairView;
  storedType: string | null;
  storedBalance: string | null;
  carry: SimplefinRelinkStoredCarryView | undefined;
  providerCurrency: string | null;
  providerBalance: number | null;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}

function PairCard({
  pair,
  storedType,
  storedBalance,
  carry,
  providerCurrency,
  providerBalance,
  selected,
  disabled,
  onToggle,
}: PairCardProps) {
  return (
    <Card elevation={selected ? 2 : 1} padding="md" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
        <div className="space-y-1">
          <p className="text-micro uppercase tracking-[0.18em] text-muted-2">In this ledger</p>
          <p className="text-body-lg text-ink">{pair.stored_account_name}</p>
          <p className="text-body text-muted">
            {pair.stored_institution_name}
            {storedType ? ` · ${storedType}` : ''}
            {storedBalance ? ` · ${storedBalance}` : ''}
          </p>
          <p className="text-note text-muted">{relinkCarryLine(carry)}</p>
          {carry?.backfill_floor_date && (
            <p className="text-note text-muted">
              Your own history owns this account below {formatDate(carry.backfill_floor_date)}.
            </p>
          )}
          {carry?.name_source === 'manual' && (
            <p className="text-note text-muted">You named this account.</p>
          )}
          {carry?.type_source === 'manual' && (
            <p className="text-note text-muted">You set its type.</p>
          )}
          <p className="text-note text-muted-2">Currently {pair.stored_simplefin_account_id}</p>
        </div>

        <p className="self-center text-note text-muted-2 sm:px-2">would adopt</p>

        <div className="space-y-1">
          <p className="text-micro uppercase tracking-[0.18em] text-muted-2">Sent by SimpleFIN</p>
          <p className="text-body-lg text-ink">{pair.provider_account_name}</p>
          <p className="text-body text-muted">
            {pair.provider_institution_name}
            {providerCurrency ? ` · ${providerCurrency}` : ''}
          </p>
          <p className="text-note text-muted">
            {providerBalance === null
              ? 'No balance this response could read.'
              : `Balance as sent, ${formatCurrency(providerBalance)}.`}
          </p>
          <p className="text-note text-muted-2">{pair.provider_account_id}</p>
        </div>
      </div>

      <p className="text-body text-ink">
        <span className="text-muted">{PAIR_STRENGTH_WORD[pair.strength]}. </span>
        {pair.reason}
      </p>

      <label className="flex cursor-pointer items-center gap-2 text-note text-muted">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
          className="h-3.5 w-3.5 accent-sage"
        />
        Confirm this pair
      </label>
    </Card>
  );
}

function UnpairedStored({
  rows,
  carryFor,
}: {
  rows: SimplefinRelinkUnpairedStoredView[];
  carryFor: (accountId: string) => SimplefinRelinkStoredCarryView | undefined;
}) {
  return (
    <div className="space-y-2">
      <SectionLabel>Accounts here that nothing was sent for ({rows.length})</SectionLabel>
      <p className="text-body text-muted">
        No pairing is proposed for these. An account genuinely closed at the bank belongs here, and
        so does one whose candidates were too close to separate.
      </p>
      {rows.map((row) => (
        <Card key={row.account_id} elevation={1} padding="sm" className="space-y-1">
          <p className="text-body-lg text-ink">{row.account_name}</p>
          <p className="text-body text-muted">
            {row.institution_name} · {relinkBalanceLine(row.balance, row.is_liability)}
          </p>
          <p className="text-note text-muted">{relinkCarryLine(carryFor(row.account_id))}</p>
          <p className="text-body text-ink">{row.reason}</p>
        </Card>
      ))}
    </div>
  );
}

function UnpairedProvider({ rows }: { rows: SimplefinRelinkUnpairedProviderView[] }) {
  return (
    <div className="space-y-2">
      <SectionLabel>Accounts SimpleFIN sent that nothing here matches ({rows.length})</SectionLabel>
      <p className="text-body text-muted">
        Nothing is created for these by confirming. Once this is settled and syncing runs again, an
        account SimpleFIN sends under an id this ledger has never seen is added as a new account.
      </p>
      {rows.map((row) => (
        <Card key={row.provider_account_id} elevation={1} padding="sm" className="space-y-1">
          <p className="text-body-lg text-ink">{row.name}</p>
          <p className="text-body text-muted">
            {row.institution_name} · {row.currency}
            {row.balance === null ? '' : ` · ${formatCurrency(row.balance)} as sent`}
          </p>
          <p className="text-body text-ink">{row.reason}</p>
        </Card>
      ))}
    </div>
  );
}
