import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { aiApi } from '../../lib/api';
import { useAppStore } from '../../store';
import { InkButton, Select, TextButton } from '../../components/balance';
import type { AiMemory, AiMemoryKind, AiMemoryScope } from '@shared/types';

/**
 * What the advisor takes as given about how the owner runs their money.
 *
 * The store is only defensible if the owner can read every statement, see what produced it, and
 * strike anything wrong, so this panel is not a diagnostic view: it is the write path. Nothing here
 * reports a count of what is missing, and an install with no statements shows the same explanation
 * and the same form as one with ten.
 *
 * NOTHING ON THIS SCREEN JUDGES THE SENTENCE. An earlier build refused any statement matching a set
 * of figure patterns and told the owner so here. It refused `401(k)` and `the 15th of each month`
 * and admitted "four hundred dollars a month", and the owner had no way to know which. The date and
 * observation count printed under each statement are what reach the advisor with it, so the copy
 * describes that mechanism rather than promising a filter.
 */

const KIND_OPTIONS: Array<{ value: AiMemoryKind; label: string; hint: string }> = [
  { value: 'preference', label: 'Preference', hint: 'What you choose when both options are open' },
  { value: 'constraint', label: 'Constraint', hint: 'Something you will not or cannot do' },
  { value: 'intent', label: 'Intent', hint: 'What you are working towards' },
  { value: 'interpretation', label: 'Interpretation', hint: 'How you read your own numbers' },
];

const SCOPE_OPTIONS: Array<{ value: AiMemoryScope; label: string }> = [
  { value: 'household', label: 'My finances as a whole' },
  { value: 'account', label: 'An account' },
  { value: 'category', label: 'A category' },
  { value: 'merchant', label: 'A merchant' },
  { value: 'goal', label: 'A goal' },
];

const SUBJECT_PLACEHOLDER: Record<AiMemoryScope, string> = {
  household: '',
  account: 'e.g. Fidelity Individual',
  category: 'e.g. Groceries',
  merchant: 'e.g. Amazon',
  goal: 'e.g. Emergency fund',
};

function kindLabel(kind: AiMemoryKind): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function ReviseForm({ memory, onDone }: { memory: AiMemory; onDone: () => void }) {
  const qc = useQueryClient();
  const [statement, setStatement] = useState(memory.statement);
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);

  const revise = useMutation({
    mutationFn: () => aiApi.reviseMemory(memory.id, { statement, evidence }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-memory'] });
      qc.invalidateQueries({ queryKey: ['ai-context'] });
      onDone();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-line-2 bg-rail p-3">
      <p className="text-note text-muted-2">
        The statement you replace is kept, dated, under this one.
      </p>
      <textarea
        className="mz-field w-full resize-y"
        rows={2}
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
      />
      <textarea
        className="mz-field w-full resize-y"
        rows={2}
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        placeholder="What changed your mind"
      />
      {error && <p className="text-note text-warning">{error}</p>}
      <div className="flex items-center gap-4">
        <InkButton onClick={() => revise.mutate()} disabled={revise.isPending}>
          {revise.isPending ? 'Saving…' : 'Replace'}
        </InkButton>
        <TextButton onClick={onDone}>Cancel</TextButton>
      </div>
    </div>
  );
}

export function AdvisorMemorySection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: memories = [] } = useQuery({ queryKey: ['ai-memory'], queryFn: aiApi.listMemory });

  const [kind, setKind] = useState<AiMemoryKind>('preference');
  const [scope, setScope] = useState<AiMemoryScope>('household');
  const [subject, setSubject] = useState('');
  const [statement, setStatement] = useState('');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revising, setRevising] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ai-memory'] });
    qc.invalidateQueries({ queryKey: ['ai-context'] });
  };

  const create = useMutation({
    mutationFn: () =>
      aiApi.createMemory({
        scope,
        subject: scope === 'household' ? null : subject,
        statement,
        kind,
        evidence,
      }),
    onSuccess: () => {
      invalidate();
      setStatement('');
      setEvidence('');
      setSubject('');
      setError(null);
    },
    // The server's refusal names what was wrong with the sentence, so it is shown next to the
    // sentence rather than thrown into a toast that outlives the form.
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => aiApi.deleteMemory(id),
    onSuccess: () => {
      invalidate();
      addToast({ type: 'success', message: 'Statement struck' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const activeKind = KIND_OPTIONS.find((option) => option.value === kind);

  return (
    <div className="space-y-5">
      <p className="text-body leading-relaxed text-muted">
        These reach the advisor in every conversation, marked as belief rather than measurement. Each one is given with
        the date you recorded it and the number of observations behind it, and the advisor is told to read every
        statement as of that date, so a number inside one stands as a number from that day rather than a current one.
        The observation you write under a statement is not put into the prompt.
      </p>

      <div>
        {memories.map((memory, i) => (
          <div
            key={memory.id}
            className={`py-3 ${i < memories.length - 1 ? 'border-b border-line' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body-lg leading-relaxed text-ink">{memory.statement}</p>
                <p className="mt-0.5 text-note text-muted">
                  {kindLabel(memory.kind)}
                  {memory.subject ? ` · ${memory.subject}` : ''} · recorded {memory.created_at.slice(0, 10)} ·{' '}
                  {memory.evidence_count} observation{memory.evidence_count === 1 ? '' : 's'}
                  {memory.source === 'ai' ? ' · the advisor concluded this' : ''}
                </p>
                <p className="mt-1.5 text-note leading-relaxed text-muted-2">{memory.evidence}</p>
                {memory.prior_statements.map((prior) => (
                  <p key={prior.id} className="mt-1 text-micro leading-relaxed text-muted-2">
                    Until {prior.superseded_at.slice(0, 10)}: {prior.statement}
                  </p>
                ))}
              </div>
              <div className="flex flex-shrink-0 items-center gap-3">
                <TextButton onClick={() => setRevising(revising === memory.id ? null : memory.id)}>
                  Revise
                </TextButton>
                <TextButton onClick={() => remove.mutate(memory.id)} className="hover:!text-clay">
                  Strike
                </TextButton>
              </div>
            </div>
            {revising === memory.id && (
              <ReviseForm memory={memory} onDone={() => setRevising(null)} />
            )}
          </div>
        ))}
      </div>

      <div className="space-y-2 rounded-xl border border-line-2 bg-rail p-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Select
            value={kind}
            options={KIND_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => setKind(value as AiMemoryKind)}
            placeholder="Kind"
            clearable={false}
            className="flex-1"
          />
          <Select
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={(value) => setScope(value as AiMemoryScope)}
            placeholder="About"
            clearable={false}
            className="flex-1"
          />
        </div>
        {activeKind && <p className="text-note text-muted-2">{activeKind.hint}</p>}
        {scope !== 'household' && (
          <input
            className="mz-field w-full"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={SUBJECT_PLACEHOLDER[scope]}
          />
        )}
        <textarea
          className="mz-field w-full resize-y"
          rows={2}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          placeholder="e.g. Funds the taxable brokerage before the Roth"
        />
        <textarea
          className="mz-field w-full resize-y"
          rows={2}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="What you observed, or told the advisor, that makes this true"
        />
        <p className="text-note leading-relaxed text-muted-2">
          A statement is recorded exactly as you write it. Nothing is refused for carrying a number, because no rule can
          tell the 401(k) or the 15th of the month from a figure that will go stale, and a filter wrong in either
          direction is worse than none. What holds instead is the date: the advisor is given every statement as of the
          day you recorded it. Revise one when it stops being true.
        </p>
        {error && <p className="text-note leading-relaxed text-warning">{error}</p>}
        <InkButton onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Recording…' : 'Record'}
        </InkButton>
      </div>
    </div>
  );
}
