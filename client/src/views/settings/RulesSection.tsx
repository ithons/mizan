import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Edit2,
  X,
  Check,
  AlertTriangle,
  Download,
  Link2,
  Unlink,
  RefreshCw,
  Info,
  Wallet,
  Tag,
  Database,
  CheckCircle,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import {
  settingsApi,
  plaidApi,
  coinbaseApi,
  categoriesApi,
  rulesApi,
  syncApi,
  flattenCategories,
} from '../../lib/api';
import { formatRelativeTime } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { Modal } from '../../components/Modal';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { SyncActivityPanel } from '../../components/SyncActivityPanel';
import { PageLoader } from '../../components/LoadingSpinner';
import type { Category, MerchantRule, MerchantRuleSuggestion, SyncRun } from '@shared/types';

const CATEGORY_PRESET_COLORS = [
  '#32bfa3', '#6487f0', '#ef6f8a', '#e2a53f', '#9b8dee',
  '#ee8d5b', '#70c4e0', '#e070b8', '#70e07a', '#a0a0b8',
  '#c4a86e', '#6e8ec4',
];

export function RulesSection() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState('');

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
    }),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      setPattern('');
      setCategoryId('');
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
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px_auto] gap-2">
        <input
          className="bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveRule()}
          placeholder="Merchant contains..."
        />
        <select
          className="bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>
        <button
          className="flex items-center gap-1.5 px-3 py-2 text-xs bg-text text-surface font-medium rounded hover:opacity-90 disabled:opacity-40"
          onClick={saveRule}
          disabled={createMutation.isPending}
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      {selectedCategory && (
        <p className="text-xs text-muted">
          New matches will be categorized as <span className="text-text">{selectedCategory.name}</span>.
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="border border-amber/30 bg-amber/10 rounded">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-amber/20">
            <Sparkles size={13} className="text-amber" />
            <p className="text-xs font-medium text-text">Suggested rules</p>
          </div>
          <div className="divide-y divide-amber/15">
            {suggestions.map((suggestion) => (
              <div key={`${suggestion.pattern}:${suggestion.category_id}`} className="flex items-center gap-3 px-3 py-3">
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: suggestion.category_color ?? '#6b6b7a' }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text truncate">{suggestion.pattern}</p>
                  <p className="text-xs text-muted">
                    {suggestion.categorized_count} categorized as {suggestion.category_name}
                    {' '}
                    - {suggestion.uncategorized_count} uncategorized
                    {' '}
                    - {Math.round(suggestion.confidence * 100)}% confidence
                  </p>
                </div>
                <button
                  className="flex items-center gap-1.5 text-xs text-[#273238] bg-amber rounded px-2.5 py-1.5 hover:opacity-90 disabled:opacity-40"
                  onClick={() => suggestionMutation.mutate(suggestion)}
                  disabled={suggestionMutation.isPending}
                >
                  <Check size={12} />
                  Accept
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">{rules.length} rules</p>
        <button
          className="flex items-center gap-1.5 text-xs text-muted border border-border rounded px-3 py-1.5 hover:text-text disabled:opacity-40"
          onClick={() => applyMutation.mutate()}
          disabled={applyMutation.isPending || rules.length === 0}
        >
          <Check size={13} />
          Apply Rules
        </button>
      </div>

      <div className="bg-background border border-border rounded divide-y divide-border">
        {rules.map((rule: MerchantRule) => (
          <div key={rule.id} className="flex items-center gap-3 px-3 py-3">
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: rule.category_color ?? '#6b6b7a' }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-text truncate">{rule.pattern}</p>
              <p className="text-xs text-muted">
                {rule.category_name ?? 'Unknown category'}
                {rule.match_count !== undefined && ` · ${rule.match_count} matches`}
              </p>
            </div>
            <button
              className="p-1 text-muted hover:text-rose"
              onClick={() => deleteMutation.mutate(rule.id)}
              title="Delete rule"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {rules.length === 0 && (
          <p className="text-xs text-muted text-center py-6">No rules yet</p>
        )}
      </div>
    </div>
  );
}

// ─── Data Section ─────────────────────────────────────────────────────────────
