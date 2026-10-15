import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdvisorAutonomyEntry } from '@shared/types';
import { aiApi, type AiActionUndoResult } from '../lib/api';
import { formatCompactRelative } from '../lib/formatters';
import { useAppStore } from '../store';

/**
 * The autonomy table, fetched once.
 *
 * It is a property of the running server rather than of the data, so nothing in a session can
 * change it and there is nothing to refetch. Two panels read it under the same key, which is what
 * keeps the Undo buttons and the sentence describing the boundary derived from one answer.
 */
export const AUTONOMY_QUERY = {
  queryKey: ['ai-autonomy'],
  queryFn: () => aiApi.getAutonomy(),
  staleTime: Infinity,
};

/**
 * Which actions offer Undo, derived from the same table instead of hand-listed beside it.
 *
 * `exact_inverse` is one of the four criteria a write has to meet to be autonomous, so an
 * autonomous kind is undoable by construction. The set this replaces named two kinds and left
 * `retire_merchant_rule` with a working, tested server-side undo that no screen could reach.
 */
export function undoableKinds(entries: readonly AdvisorAutonomyEntry[]): ReadonlySet<string> {
  return new Set(entries.filter((e) => e.autonomy === 'autonomous').map((e) => e.kind));
}

/**
 * What an undo actually did, including the halves this toast used to drop.
 *
 * An undone rule retirement puts back no transaction, so reporting only rows read as "Reverted 0
 * transactions" for a revert that worked. A rule the server could not restore is named, and the
 * toast stops claiming plain success, because a partial revert that reads as a complete one is the
 * failure `rule_failures` was added to prevent.
 */
export function undoActionToast(result: AiActionUndoResult): { type: 'success' | 'info'; message: string } {
  const rules = result.reverted_rules ?? 0;
  const failures = result.rule_failures ?? [];
  const rowText = `Reverted ${result.reverted} transaction${result.reverted === 1 ? '' : 's'}`;
  const ruleText = `${rules} merchant rule${rules === 1 ? '' : 's'}`;

  let message: string;
  if (rules === 0) message = rowText;
  else if (result.reverted === 0) message = `Put back ${ruleText}`;
  else message = `${rowText} and put back ${ruleText}`;

  if (failures.length === 0) return { type: 'success', message };
  return { type: 'info', message: `${message}. ${failures.join(' ')}` };
}

type AiActionListItem = Awaited<ReturnType<typeof aiApi.listActions>>[number];

export function AiActionRow({
  action,
  undoable,
  undoPending,
  onUndo,
}: {
  action: AiActionListItem;
  undoable: boolean;
  undoPending: boolean;
  onUndo: (id: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line pb-2.5 last:border-0">
      <div className="min-w-0">
        <div className="text-body-lg text-ink">{action.label}</div>
        <div className="mt-0.5 text-note text-muted-2">{action.summary}</div>
      </div>
      <div className="flex flex-shrink-0 items-start gap-3">
        <div className="text-right text-micro text-muted-2">
          <div className={action.source === 'worker_auto' ? 'text-warning' : 'text-sage-deep'}>
            {action.source === 'worker_auto' ? 'auto-applied' : 'you confirmed'}
          </div>
          <div>{formatCompactRelative(action.created_at)}</div>
        </div>
        {undoable && (
          <button
            type="button"
            disabled={undoPending}
            onClick={() => onUndo(action.id)}
            className="mt-0.5 whitespace-nowrap border-b border-line-3 pb-0.5 text-note text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            Undo
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * How many actions this panel draws before the owner asks for more.
 *
 * A drawing decision, and the panel says so out loud. The number it replaces was a server-side
 * `LIMIT 50` with no page after it: on the owner's ledger 92 of 142 recorded actions were past it,
 * and Undo lives on the row, so those 92 had no reachable undo at all. This one has a control
 * beneath it and a count beside it, so nothing is silently absent.
 */
export const ACTIONS_PER_PAGE = 50;

/**
 * What the panel says about the actions it is NOT drawing, or null when it is drawing them all.
 *
 * Split out and exported because "the list is capped" and "the owner is told the list is capped"
 * are two different facts, and only the second one makes the rest reachable. The cap this replaces
 * lived on the server, said nothing, and offered no way through.
 */
export function hiddenActionsNote(
  total: number,
  shown: number
): { showing: string; more: string } | null {
  if (shown >= total) return null;
  return {
    showing: `Showing ${shown} of ${total}`,
    more: `Show the remaining ${total - shown}`,
  };
}


/** Every action the AI applied, newest first, with Undo where the server can keep that promise. */
export function AiActionsList({ enabled = true }: { enabled?: boolean }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: actions } = useQuery({ queryKey: ['ai-actions'], queryFn: () => aiApi.listActions(), enabled });
  const { data: autonomy } = useQuery({ ...AUTONOMY_QUERY, enabled });
  // No table, no Undo: offering to put something back is a promise the boundary has to back.
  const undoable = undoableKinds(autonomy?.kinds ?? []);
  const [shown, setShown] = useState(ACTIONS_PER_PAGE);

  const undo = useMutation({
    mutationFn: (id: string) => aiApi.undoAction(id),
    onSuccess: (res) => {
      addToast(undoActionToast(res));
      qc.invalidateQueries();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const total = actions?.length ?? 0;
  const visible = actions?.slice(0, shown) ?? [];
  const hidden = hiddenActionsNote(total, visible.length);

  if (total === 0) return <p className="text-body text-muted-2">No AI actions yet.</p>;
  return (
    <>
      <div className="space-y-2.5">
        {visible.map((a) => (
          <AiActionRow
            key={a.id}
            action={a}
            undoable={undoable.has(a.kind)}
            undoPending={undo.isPending}
            onUndo={(id) => undo.mutate(id)}
          />
        ))}
      </div>
      {hidden && (
        <div className="mt-3 flex items-center justify-between text-note text-muted-2">
          <span>{hidden.showing}</span>
          <button
            type="button"
            onClick={() => setShown(total)}
            className="border-b border-line-3 pb-0.5 text-muted transition-colors hover:text-ink"
          >
            {hidden.more}
          </button>
        </div>
      )}
    </>
  );
}
