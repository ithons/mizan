import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { categoriesApi, rulesApi, flattenCategories } from '../../lib/api';
import { formatCurrency, formatDate } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { PageLoader } from '../../components/LoadingSpinner';
import { InkButton, SectionLabel, TextButton } from '../../components/balance';
import type { MerchantRule, MerchantRuleSuggestion } from '@shared/types';

export function RulesSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [applyToAll, setApplyToAll] = useState(false);

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

  const deleteMutation = useMutation({
    mutationFn: rulesApi.delete,
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Rule deleted' });
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
        <select className="mz-field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>
        <InkButton onClick={saveRule} disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Adding…' : 'Add'}
        </InkButton>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={applyToAll}
          onChange={(e) => setApplyToAll(e.target.checked)}
          className="h-3.5 w-3.5 accent-sage"
        />
        Also re-label all past transactions matching this rule (keeps ones you categorized by hand)
      </label>

      {selectedCategory && (
        <p className="text-xs text-muted">
          New matches will be categorized as <span className="text-ink">{selectedCategory.name}</span>.
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="rounded-xl border border-sage-tint-border bg-sage-tint">
          <div className="border-b border-sage-tint-border px-4 py-2.5 text-xs font-medium text-ink">Suggested rules</div>
          {suggestions.map((suggestion, i) => (
            <div
              key={`${suggestion.pattern}:${suggestion.category_id}`}
              className={`flex items-center gap-3 px-4 py-3 ${i < suggestions.length - 1 ? 'border-b border-sage-tint-border' : ''}`}
            >
              <div
                className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: suggestion.category_color ?? '#7a6c5d' }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{suggestion.pattern}</p>
                <p className="text-xs text-muted">
                  {suggestion.categorized_count} categorized as {suggestion.category_name} · {suggestion.uncategorized_count}{' '}
                  uncategorized · {Math.round(suggestion.confidence * 100)}% confidence
                </p>
                <p className="mt-1 text-xs text-muted-2">{suggestion.reason}</p>
                {suggestion.preview_transactions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {suggestion.preview_transactions.slice(0, 4).map((transaction) => (
                      <span
                        key={transaction.id}
                        className="rounded border border-line-2 bg-card px-1.5 py-0.5 text-[11px] text-muted"
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
                disabled={suggestionMutation.isPending}
              >
                Accept
              </TextButton>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
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
              style={{ backgroundColor: rule.category_color ?? '#7a6c5d' }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-ink">{rule.pattern}</p>
              <p className="text-xs text-muted">
                {rule.category_name ?? 'Unknown category'}
                {rule.match_count !== undefined && ` · ${rule.match_count} matches`}
              </p>
            </div>
            <TextButton onClick={() => deleteMutation.mutate(rule.id)} className="hover:!text-clay">
              Delete
            </TextButton>
          </div>
        ))}
        {rules.length === 0 && <p className="py-4 text-xs text-muted-2">No rules yet.</p>}
      </div>
    </div>
  );
}
