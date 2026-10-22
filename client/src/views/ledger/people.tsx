import { useQuery } from '@tanstack/react-query';
import type { CounterpartiesResponse, Counterparty } from '@shared/types';
import { transactionsApi } from '../../lib/api';
import { formatCurrency, formatDate } from '../../lib/formatters';
import { QueryErrorBanner } from '../../components/QueryErrorBanner';
import { SkeletonRows } from '../../components/SkeletonLoader';
import { Details, SectionLabel } from '../../components/balance';

export const COUNTERPARTIES_KEY = ['transactions', 'counterparties'] as const;

function balanceLine(c: Counterparty): string {
  if (c.state === 'settled') return 'Even';
  const gap = formatCurrency(Math.abs(c.net));
  return c.net < 0 ? `Sent ${gap} more than received` : `Received ${gap} more than sent`;
}

function PersonRow({ person }: { person: Counterparty }) {
  const ink = person.state === 'sent_more' && person.older_than_window ? 'text-review-text' : 'text-ink';
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-2.5">
      <div className="min-w-0">
        <div className="text-body-lg text-ink">{person.name}</div>
        <div className="text-note text-muted-2">
          sent <span className="tabular-nums">{formatCurrency(person.sent)}</span> · received{' '}
          <span className="tabular-nums">{formatCurrency(person.received)}</span> · last {formatDate(person.last_date)}
        </div>
      </div>
      <div className={`text-body tabular-nums ${ink}`}>{balanceLine(person)}</div>
    </div>
  );
}

function channelLine(c: Counterparty): string {
  const out = formatCurrency(c.sent);
  const into = formatCurrency(c.received);
  switch (c.kind) {
    case 'cash': return `${out} withdrawn, cash that left tracking · ${into} deposited`;
    case 'wallet': return `${out} out to it · ${into} back from it`;
    default: return `${out} out · ${into} in`;
  }
}

function ChannelRow({ channel }: { channel: Counterparty }) {
  const note = channel.kind === 'wallet' ? 'a wallet you do not track, not a person' : channel.kind === 'cash' ? 'ATM and banking center' : 'wires';
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-2.5">
      <div className="min-w-0">
        <div className="text-body-lg text-ink">{channel.name}</div>
        <div className="text-note text-muted-2">{note} · last {formatDate(channel.last_date)}</div>
      </div>
      <div className="text-body tabular-nums text-ink">{channelLine(channel)}</div>
    </div>
  );
}

function People({ reading }: { reading: CounterpartiesResponse }) {
  const open = reading.people.filter((p) => p.state === 'sent_more');
  const receivedMore = reading.people.filter((p) => p.state === 'received_more');
  const settled = reading.people.filter((p) => p.state === 'settled');
  return (
    <section className="mb-8">
      <SectionLabel className="mb-1">Sent more than received</SectionLabel>
      {open.length === 0 ? (
        <p className="py-2.5 text-body text-muted-2">No one has been sent more than came back from them.</p>
      ) : (
        open.map((p) => <PersonRow key={p.key} person={p} />)
      )}
      {receivedMore.length > 0 && (
        <Details summary={`Received more than sent · ${receivedMore.length}`} className="mt-4">
          <p className="mb-2 text-note text-muted-2">
            Often someone paying back their share of something you paid for on a card. That purchase sits in
            spending, so none of this is money you owe.
          </p>
          {receivedMore.map((p) => <PersonRow key={p.key} person={p} />)}
        </Details>
      )}
      {settled.length > 0 && (
        <Details summary={`Settled · ${settled.length}`} className="mt-4">
          {settled.map((p) => <PersonRow key={p.key} person={p} />)}
        </Details>
      )}
    </section>
  );
}

export function PeopleAndCash() {
  const q = useQuery({ queryKey: COUNTERPARTIES_KEY, queryFn: () => transactionsApi.counterparties() });
  if (q.isPending) return <SkeletonRows rows={6} />;
  if (q.isError) return <QueryErrorBanner items={[{ query: q, label: 'people and cash' }]} />;
  const reading = q.data;
  return (
    <div className="mt-2">
      <p className="mb-5 max-w-[640px] text-note text-muted-2">
        Transfers to and from people, wallets you do not track, and cash. Reports leave these out of spending,
        and nothing here counts toward it. Only the transfers are visible here, so a balance is what moved, not
        what anyone owes. Within {formatCurrency(reading.settle_tolerance)} counts as even, and someone sent more
        than came back is marked for review after {reading.window_days} days with no activity.
      </p>
      <People reading={reading} />
      {reading.channels.length > 0 && (
        <section className="mb-8">
          <SectionLabel className="mb-1">Wallets and cash</SectionLabel>
          {reading.channels.map((c) => <ChannelRow key={c.key} channel={c} />)}
        </section>
      )}
      {reading.unclassified.rows > 0 && (
        <p className="text-note text-muted-2">
          <span className="tabular-nums">{reading.unclassified.rows}</span> other transfer{reading.unclassified.rows === 1 ? '' : 's'} to
          or from no recognised person, wallet or cash machine are not listed.
        </p>
      )}
    </div>
  );
}
