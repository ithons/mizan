import React from 'react';
import { ArrowLeftRight, ArrowRight, CheckCircle2, Clock, Sparkles, Tag, RefreshCw, Trash2 } from 'lucide-react';
import type {
  MerchantRuleSuggestion,
  TransactionReviewQueueId,
  TransactionReviewSummary,
} from '@shared/types';
import { CategoryBadge } from '../../components/CategoryBadge';

const queueTone: Record<TransactionReviewQueueId, { color: string; icon: React.ElementType }> = {
  uncategorized: { color: '#d4a44c', icon: Tag },
  rule_suggestions: { color: '#5b8dee', icon: Sparkles },
  pending: { color: '#f0c040', icon: Clock },
  recurring_candidates: { color: '#4ecba3', icon: RefreshCw },
  duplicate_candidates: { color: '#e07070', icon: Trash2 },
  transfer_candidates: { color: '#5b8dee', icon: ArrowLeftRight },
};

export function TransactionReviewPanel({
  summary,
  onQueueSelect,
  onApplySuggestion,
  applyingPattern,
}: {
  summary?: TransactionReviewSummary;
  onQueueSelect: (queueId: TransactionReviewQueueId) => void;
  onApplySuggestion: (suggestion: MerchantRuleSuggestion) => void;
  applyingPattern?: string | null;
}) {
  const queues = summary?.queues ?? [];
  const suggestions = summary?.rule_suggestions.slice(0, 3) ?? [];
  const totalOpen = summary?.total_open ?? 0;

  return (
    <div className="mb-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-text">Review Queue</h2>
          <p className="text-xs text-muted font-mono">{totalOpen} open</p>
        </div>
        {totalOpen === 0 && (
          <div className="flex items-center gap-1.5 text-xs text-[#4ecba3]">
            <CheckCircle2 size={13} />
            Clear
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
        {queues.map((queue) => {
          const tone = queueTone[queue.id];
          const Icon = tone.icon;
          return (
            <button
              key={queue.id}
              className="border border-border bg-surface rounded p-3 text-left hover:border-[#4ecba3]/40 transition-colors disabled:opacity-50"
              onClick={() => onQueueSelect(queue.id)}
              disabled={queue.count === 0}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <Icon size={14} style={{ color: tone.color }} />
                <span className="font-mono text-sm text-text">{queue.count}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted truncate">{queue.label}</span>
                {queue.count > 0 && <ArrowRight size={11} className="text-muted flex-shrink-0" />}
              </div>
            </button>
          );
        })}
      </div>

      {suggestions.length > 0 && (
        <div className="border border-border bg-surface rounded divide-y divide-border">
          {suggestions.map((suggestion) => (
            <div key={`${suggestion.pattern}:${suggestion.category_id}`} className="flex items-center gap-3 px-3 py-2">
              <Sparkles size={13} className="text-[#5b8dee] flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm text-text truncate">{suggestion.pattern}</span>
                  <CategoryBadge
                    name={suggestion.category_name}
                    color={suggestion.category_color}
                    icon={suggestion.category_icon}
                  />
                </div>
                <p className="text-xs text-muted">
                  {suggestion.uncategorized_count} uncategorized, {Math.round(suggestion.confidence * 100)}% confidence
                </p>
              </div>
              <button
                className="text-xs text-muted hover:text-[#4ecba3] disabled:opacity-40"
                onClick={() => onApplySuggestion(suggestion)}
                disabled={applyingPattern === suggestion.pattern}
              >
                {applyingPattern === suggestion.pattern ? 'Applying...' : 'Apply'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
