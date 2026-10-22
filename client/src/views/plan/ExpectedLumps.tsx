import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExpectLumpPayload, ExpectedLumpsResponse } from '@shared/types';
import { expectedLumpsApi } from '../../lib/api';
import { formatCurrency, formatDate, formatDateShort } from '../../lib/formatters';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { useAppStore } from '../../store';
import { SectionLabel, TextButton } from '../../components/balance';

export function lumpRange(low: number, high: number): string {
  return low === high ? formatCurrency(low) : `${formatCurrency(low)} to ${formatCurrency(high)}`;
}

export function lumpWindow(start: string, end: string): string {
  return start.slice(0, 4) === end.slice(0, 4) ? `${formatDateShort(start)} to ${formatDate(end)}` : `${formatDate(start)} to ${formatDate(end)}`;
}

function LumpRow({ label, low, high, start, end, note, children }: {
  label: string;
  low: number;
  high: number;
  start: string;
  end: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-line-2 py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate text-body-lg text-ink">{label}</span>
        <span className="flex-shrink-0 text-body tabular-nums text-estimate">{lumpRange(low, high)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-note">
        <span className="text-estimate">{lumpWindow(start, end)}</span>
        <span className="flex items-baseline gap-4">
          <span className="text-muted-2">{note}</span>
          {children}
        </span>
      </div>
    </div>
  );
}

/** Confirmed and candidate lumps. Rendered only when there is one; none of it is in free to spend. */
export function ExpectedLumps({ data }: { data: ExpectedLumpsResponse }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const settle = (message: string) => {
    invalidateFinancialData(qc);
    addToast({ type: 'success', message });
  };
  const fail = (err: Error) => addToast({ type: 'error', message: err.message });
  const decide = useMutation({
    mutationFn: ({ payload, decision }: { payload: ExpectLumpPayload; decision: 'confirm' | 'dismiss' }) =>
      expectedLumpsApi.decide(payload, decision),
    onSuccess: (_result, { decision }) => settle(decision === 'confirm' ? 'Expected deposit confirmed' : 'Suggestion dismissed'),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => expectedLumpsApi.dismiss(id),
    onSuccess: () => settle('Expected deposit removed'),
    onError: fail,
  });

  if (data.confirmed.length === 0 && data.candidates.length === 0) return null;
  const busy = decide.isPending || remove.isPending;

  return (
    <section className="mb-9">
      <SectionLabel
        className="mb-1"
        explain={
          <p>
            Large deposits that have come back at irregular intervals. Each is an estimate of a window and a
            range, and none is counted in free to spend.
          </p>
        }
      >
        Expected, not scheduled
      </SectionLabel>
      <div className="mt-2">
        {data.confirmed.map((lump) => (
          <LumpRow key={lump.id} label={lump.label} low={lump.amount_low} high={lump.amount_high} start={lump.window_start} end={lump.window_end} note="confirmed">
            <TextButton onClick={() => remove.mutate(lump.id)} disabled={busy}>Remove</TextButton>
          </LumpRow>
        ))}
        {data.candidates.map((candidate) => {
          const { payload } = candidate;
          const seen = candidate.occurrences.length;
          return (
            <LumpRow
              key={payload.merchant_key}
              label={payload.label}
              low={payload.amount_low}
              high={payload.amount_high}
              start={payload.window_start}
              end={payload.window_end}
              note={seen > 0 ? `came ${seen} times, last ${formatDate(payload.last_occurrence)}` : `last ${formatDate(payload.last_occurrence)}`}
            >
              <TextButton variant="primary" onClick={() => decide.mutate({ payload, decision: 'confirm' })} disabled={busy}>Confirm</TextButton>
              <TextButton onClick={() => decide.mutate({ payload, decision: 'dismiss' })} disabled={busy}>Dismiss</TextButton>
            </LumpRow>
          );
        })}
      </div>
    </section>
  );
}
