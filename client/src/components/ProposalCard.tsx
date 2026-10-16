import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdvisorDraftAction } from '@shared/types';
import { aiApi } from '../lib/api';
import { TextButton } from './balance';

type ProposalState = { kind: 'open' } | { kind: 'applied' } | { kind: 'dismissed' } | { kind: 'failed'; reason: string };

const SKIP_REASONS: Record<string, string> = {
  not_found_or_resolved: 'It was already resolved.',
  unreadable_payload: 'The proposal could not be read.',
  apply_failed: 'It could not be applied; the data it names may have changed.',
};

export function ProposalCard({ proposal }: { proposal: AdvisorDraftAction }) {
  const qc = useQueryClient();
  const [state, setState] = useState<ProposalState>({ kind: 'open' });
  const confirm = useMutation({
    mutationFn: () => aiApi.confirmDrafts([proposal.id]),
    onSuccess: (result) => {
      const outcome = result.outcomes[0];
      if (outcome?.status === 'applied') {
        setState({ kind: 'applied' });
        void qc.invalidateQueries();
      } else {
        setState({ kind: 'failed', reason: SKIP_REASONS[outcome?.reason ?? ''] ?? outcome?.reason ?? 'It was not applied.' });
      }
    },
    onError: (err: Error) => setState({ kind: 'failed', reason: err.message }),
  });
  const dismiss = useMutation({
    mutationFn: () => aiApi.dismissDraft(proposal.id),
    onSuccess: () => setState({ kind: 'dismissed' }),
    onError: (err: Error) => setState({ kind: 'failed', reason: err.message }),
  });
  const busy = confirm.isPending || dismiss.isPending;

  return (
    <div className="rounded-lg border border-line-2 px-3.5 py-2.5">
      <div className="text-body-lg text-ink">{proposal.label}</div>
      {proposal.changes.length > 0 && (
        <dl className="mt-1.5 grid gap-0.5 text-body">
          {proposal.changes.map((change, index) => (
            <div key={index} className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{change.field}:</dt>
              <dd className="text-ink tabular-nums">
                {change.before !== null && <span className="text-muted">{String(change.before)} → </span>}
                {String(change.after)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {proposal.summary && <div className="mt-1 text-note text-muted">{proposal.summary}</div>}
      <div className="mt-2 flex items-center gap-5 text-body">
        {state.kind === 'open' && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => confirm.mutate()}
              className="border-b border-ink pb-0.5 text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
            >
              {confirm.isPending ? 'Applying…' : 'Confirm'}
            </button>
            <TextButton onClick={() => dismiss.mutate()} disabled={busy}>Dismiss</TextButton>
          </>
        )}
        {state.kind === 'applied' && <span className="text-sage-deep">Done.</span>}
        {state.kind === 'dismissed' && <span className="text-muted">Dismissed.</span>}
        {state.kind === 'failed' && <span className="text-clay">{state.reason}</span>}
      </div>
    </div>
  );
}

