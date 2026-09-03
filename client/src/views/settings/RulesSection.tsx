import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { categoriesApi, rulesApi, flattenCategories, type RuleApprovalSkip } from '../../lib/api';
import { formatCurrency, formatDate } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { PageLoader } from '../../components/LoadingSpinner';
import { InkButton, SectionLabel, TextButton, CategoryPicker } from '../../components/balance';
import type { MerchantRule, MerchantRuleSuggestion } from '@shared/types';

export function RulesSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [applyToAll, setApplyToAll] = useState(false);
  // What the last batch approval refused, kept on screen rather than in the toast that announced
  // it: a skip names a pattern, and the owner needs to read which one.
  const [skipped, setSkipped] = useState<RuleApprovalSkip[]>([]);

  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: rulesApi.list,
  });

  const { data: suggestions = [] } = useQuery({
    queryKey: ['rules', 'suggestions'],
    queryFn: rulesApi.suggestions,
  });

  const { data: categoriesTree = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const categories = flattenCategories(categoriesTree);

  const selectedCategory = categories.find((category) => category.id === categoryId);

  const createMutation = useMutation({
    mutationFn: () => rulesApi.create({
      pattern,
      category_id: categoryId,
      apply_existing: true,
      apply_existing_overwrite: applyToAll,
    }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      setPattern('');
      setCategoryId('');
      setApplyToAll(false);
      addToast({
        type: 'success',
        message: result.applied > 0
          ? `Rule saved and applied to ${result.applied} transactions`
          : 'Rule saved',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const suggestionMutation = useMutation({
    mutationFn: (suggestion: MerchantRuleSuggestion) => rulesApi.create({
      pattern: suggestion.pattern,
      category_id: suggestion.category_id,
      apply_existing: true,
    }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      addToast({
        type: 'success',
        message: result.applied > 0
          ? `Rule saved and applied to ${result.applied} transactions`
          : 'Rule saved',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  /**
   * Refuse a suggestion for good.
   *
   * `suggestMerchantRules` recomputes the list on every call, so without this the only way to make
   * a suggestion stop appearing is to accept it. That is a one-way door: the screen could say yes
   * and could not say no. `dismissRuleSuggestion` (server/src/services/rules.ts) appends the
   * normalized merchant key to the `dismissed_rule_suggestions` preference, which the generator
   * subtracts on every later call.
   */
  const dismissMutation = useMutation({
    mutationFn: (suggestion: MerchantRuleSuggestion) => rulesApi.dismissSuggestion(suggestion.pattern),
    onMutate: () => setSkipped([]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', 'suggestions'] });
      addToast({ type: 'success', message: 'Suggestion dismissed' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  /**
   * Accept every suggestion at once.
   *
   * Not a loop over `rulesApi.create`: the batch endpoint recomputes each pattern's affected rows
   * server-side, so a page left open overnight cannot relabel a set that has since changed, and it
   * answers with a `skipped` list naming every approval it could not honour. A loop of creates has
   * nowhere to report a partial failure except the last toast that happened to fire.
   */
  const approveAllMutation = useMutation({
    mutationFn: (all: MerchantRuleSuggestion[]) =>
      rulesApi.approveSuggestions(all.map((s) => ({ pattern: s.pattern, category_id: s.category_id }))),
    // The skips name patterns from the previous list. Once a new approval starts they are about a
    // set that no longer exists, so they go before it rather than after it.
    onMutate: () => setSkipped([]),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      setSkipped(result.skipped);
      addToast({
        type: result.approved > 0 ? 'success' : 'error',
        message:
          `${result.approved} rule${result.approved === 1 ? '' : 's'} saved, applied to ${result.applied} ` +
          `transaction${result.applied === 1 ? '' : 's'}` +
          (result.skipped.length > 0 ? `, ${result.skipped.length} left alone` : ''),
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: rulesApi.delete,
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Rule retired. You can put it back from the retired list.' });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const applyMutation = useMutation({
    mutationFn: () => rulesApi.apply({ only_uncategorized: true }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      addToast({
        type: 'success',
        message: result.updated > 0
          ? `Applied rules to ${result.updated} transactions`
          : 'No uncategorized matches found',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const recategorizeMutation = useMutation({
    mutationFn: () => rulesApi.recategorize(),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      addToast({
        type: 'success',
        message: result.updated > 0
          ? `Re-checked all transactions · ${result.updated} recategorized`
          : 'Re-checked all transactions · nothing changed',
      });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const saveRule = () => {
    if (!pattern.trim()) {
      addToast({ type: 'error', message: 'Pattern is required' });
      return;
    }
    if (!categoryId) {
      addToast({ type: 'error', message: 'Choose a category' });
      return;
    }
    createMutation.mutate();
  };

  if (rulesLoading) return <PageLoader />;

  return (
    <div className="space-y-5">
      <SectionLabel>Rules</SectionLabel>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px_auto]">
        <input
          className="mz-field"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveRule()}
          placeholder="Merchant contains…"
        />
        <CategoryPicker
          variant="field" value={categoryId} categories={categoriesTree} onChange={setCategoryId}
          placeholder="Category" clearable={false} className="flex-1"
        />
        <InkButton onClick={saveRule} disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Adding…' : 'Add'}
        </InkButton>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-note text-muted">
        <input
          type="checkbox"
          checked={applyToAll}
          onChange={(e) => setApplyToAll(e.target.checked)}
          className="h-3.5 w-3.5 accent-sage"
        />
        Also re-label all past transactions matching this rule (keeps ones you categorized by hand)
      </label>

      {selectedCategory && (
        <p className="text-note text-muted">
          New matches will be categorized as <span className="text-ink">{selectedCategory.name}</span>.
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="rounded-xl border border-sage-tint-border bg-sage-tint">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-sage-tint-border px-4 py-2.5">
            <span className="text-note font-medium text-ink">Suggested rules</span>
            {suggestions.length > 1 && (
              <TextButton
                variant="primary"
                onClick={() => approveAllMutation.mutate(suggestions)}
                disabled={approveAllMutation.isPending}
              >
                {approveAllMutation.isPending ? 'Saving…' : `Accept all ${suggestions.length}`}
              </TextButton>
            )}
          </div>
          {suggestions.map((suggestion, i) => (
            <div
              key={`${suggestion.pattern}:${suggestion.category_id}`}
              className={`flex items-center gap-3 px-4 py-3 ${i < suggestions.length - 1 ? 'border-b border-sage-tint-border' : ''}`}
            >
              <div
                className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: suggestion.category_color ?? 'var(--mz-dot)' }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-lg text-ink">{suggestion.pattern}</p>
                <p className="text-note text-muted">
                  {suggestion.categorized_count} categorized as {suggestion.category_name} · {suggestion.uncategorized_count}{' '}
                  uncategorized · {Math.round(suggestion.confidence * 100)}% confidence
                </p>
                <p className="mt-1 text-note text-muted-2">{suggestion.reason}</p>
                {suggestion.preview_transactions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {suggestion.preview_transactions.slice(0, 4).map((transaction) => (
                      <span
                        key={transaction.id}
                        className="rounded border border-line-2 bg-card px-1.5 py-0.5 text-micro text-muted"
                      >
                        {transaction.will_apply ? 'Will update' : transaction.category_name ?? 'Evidence'}{' '}
                        {formatDate(transaction.date)} {formatCurrency(transaction.amount)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <TextButton
                variant="primary"
                onClick={() => suggestionMutation.mutate(suggestion)}
                disabled={suggestionMutation.isPending || approveAllMutation.isPending}
              >
                Accept
              </TextButton>
              {/* The other half of the door. Accepting was reachable and refusing was not, and a
                  suggestion the owner declines is regenerated on every visit until they give in. */}
              {/* No `hover:!text-clay` here, unlike the Delete button on the rules below. The
                  reason this line used to give was contrast, and that reason is dead: `clay` on
                  `sage-tint` measures  5.73:1 light and  6.42:1 dark, so it clears AA in both
                  themes and would separate these two buttons by nothing at all.
                  What separates them is what they do. `clay` is this app's destructive tone, and
                  `deleteMutation` below removes a rule the owner wrote, while this button runs
                  `dismissMutation` and declines a suggestion the owner never had. That is a role
                  argument and not a measurement, so it is a design call open to being revisited
                  on design grounds; contrast no longer decides it either way. */}
              <TextButton
                onClick={() => dismissMutation.mutate(suggestion)}
                disabled={dismissMutation.isPending || approveAllMutation.isPending}
              >
                Not a rule
              </TextButton>
            </div>
          ))}
          {skipped.length > 0 && (
            <div className="border-t border-sage-tint-border px-4 py-3">
              {/* Not `text-clay`, and again not for contrast: `clay` on `sage-tint` measures
                   5.73:1 light and  6.42:1 dark and clears AA in both themes, so the figure this
                  line used to carry is dead. The reason that holds is what the sentence says.
                  Nothing failed here: a suggestion mizān declined to make is not an error, and
                  clay would report one. `text-ink` is 15.76:1 light and 12.90:1 dark on the same
                  ground, and the weight carries the emphasis instead. */}
              <p className="text-note font-medium text-ink">
                {skipped.length} suggestion{skipped.length === 1 ? ' was' : 's were'} left alone:
              </p>
              <ul className="mt-1 space-y-0.5">
                {skipped.map((skip) => (
                  <li key={skip.pattern} className="text-note text-muted">
                    <span className="text-ink">{skip.pattern}</span>
                    {skip.reason === 'unknown_category'
                      ? ' names a category that no longer exists.'
                      : ' is no longer a suggestion mizān makes.'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-note text-muted">
          {rules.length} rule{rules.length === 1 ? '' : 's'}
        </p>
        <div className="flex items-center gap-4">
          <TextButton
            onClick={() => recategorizeMutation.mutate()}
            disabled={recategorizeMutation.isPending}
          >
            {recategorizeMutation.isPending ? 'Re-checking…' : 'Re-check all transactions'}
          </TextButton>
          <TextButton onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending || rules.length === 0}>
            {applyMutation.isPending ? 'Applying…' : 'Apply to uncategorized'}
          </TextButton>
        </div>
      </div>

      <div>
        {rules.map((rule: MerchantRule, i) => (
          <div key={rule.id} className={`flex items-center gap-3 px-1 py-3 ${i < rules.length - 1 ? 'border-b border-line' : ''}`}>
            <div
              className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: rule.category_color ?? 'var(--mz-dot)' }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-lg text-ink">{rule.pattern}</p>
              <p className="text-note text-muted">
                {rule.category_name ?? 'Unknown category'}
                {rule.match_count !== undefined && ` · ${rule.match_count} matches`}
              </p>
            </div>
            <TextButton onClick={() => deleteMutation.mutate(rule.id)} className="hover:!text-clay">
              Delete
            </TextButton>
          </div>
        ))}
        {rules.length === 0 && <p className="py-4 text-note text-muted-2">No rules yet.</p>}
      </div>
    </div>
  );
}
