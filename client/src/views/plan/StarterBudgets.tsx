import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StarterBudgetReading } from '@shared/types';
import { budgetsApi } from '../../lib/api';
import { formatCurrency } from '../../lib/formatters';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { useAppStore } from '../../store';
import { SectionLabel, TextButton } from '../../components/balance';
import { SuggestionRow } from './SuggestionRow';

export function starterNote(starter: StarterBudgetReading): string {
  const n = starter.months.length;
  return `median of ${n} months ${formatCurrency(starter.median)}, at or under in ${starter.months_at_or_under} of ${n}`;
}

/** Budgets to start from, for steady categories that have none. Rendered only when there is one. */
export function StarterBudgets({ starters }: { starters: StarterBudgetReading[] }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const decide = useMutation({
    mutationFn: ({ categoryId, decision }: { categoryId: string; decision: 'add' | 'dismiss' }) =>
      budgetsApi.decideStarter(categoryId, decision),
    onSuccess: (_result, { decision }) => {
      invalidateFinancialData(qc);
      // Add writes an advisor action and may supersede an older draft; dismiss writes a decline.
      void qc.invalidateQueries({ queryKey: ['ai-actions'] });
      void qc.invalidateQueries({ queryKey: ['ai-declined'] });
      void qc.invalidateQueries({ queryKey: ['ai-drafts'] });
      addToast({ type: 'success', message: decision === 'add' ? 'Budget added' : 'Suggestion dismissed' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (starters.length === 0) return null;

  return (
    <section className="mb-9">
      <SectionLabel
        className="mb-1"
        explain={
          <p>
            Categories you spent in for at least 9 of the last 12 complete months and have no budget for. Each
            amount is the median month rounded to $10, so about half the months came in above it. Adding one sets a
            monthly budget without rollover, which you can edit like any other.
          </p>
        }
      >
        Budgets to start from
      </SectionLabel>
      <div className="mt-2">
        {starters.map((starter) => (
          <SuggestionRow
            key={starter.category_id}
            label={starter.category_name}
            figure={`${formatCurrency(starter.amount)} a month`}
            figureInk="text-ink"
            detail={starterNote(starter)}
            detailInk="text-muted-2"
          >
            <TextButton variant="primary" onClick={() => decide.mutate({ categoryId: starter.category_id, decision: 'add' })} disabled={decide.isPending}>Add</TextButton>
            <TextButton onClick={() => decide.mutate({ categoryId: starter.category_id, decision: 'dismiss' })} disabled={decide.isPending}>Dismiss</TextButton>
          </SuggestionRow>
        ))}
      </div>
    </section>
  );
}
