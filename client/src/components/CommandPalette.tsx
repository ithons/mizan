import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Loader2, Sparkles, Check, ArrowRight, BrainCircuit } from 'lucide-react';
import { aiApi } from '../lib/api';
import { useAppStore } from '../store';
import type { AdvisorDraftAction } from '@shared/types';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { addToast } = useAppStore();
  const qc = useQueryClient();

  // Debounce user input
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(query);
    }, 500);
    return () => clearTimeout(handler);
  }, [query]);

  // Global hotkey: Cmd/Ctrl + K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  // Auto-focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setDebouncedQuery('');
    }
  }, [open]);

  // AI Analysis Query
  const { data: analysis, isLoading: isAnalyzing } = useQuery({
    queryKey: ['advisor', 'analyze', debouncedQuery],
    queryFn: () => aiApi.analyze(debouncedQuery),
    enabled: debouncedQuery.trim().length > 3 && open,
    staleTime: 1000 * 60, // 1 minute
  });

  // Apply Draft Mutation
  const confirmMutation = useMutation({
    mutationFn: aiApi.confirmDraft,
    onSuccess: (response) => {
      void qc.invalidateQueries();
      addToast({ type: 'success', message: response.message || 'Action applied' });
      setOpen(false);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (!open) return null;

  // Restrict Command Palette drafts to lower-stakes, easily reversible actions (transactions & budgets).
  // High-stakes actions (goals, tax envelopes, investments) should be handled via explicit UI or chat.
  const ALLOWED_PALETTE_DRAFTS = new Set([
    'categorize_transaction',
    'create_merchant_rule',
    'update_budget',
    'create_budget_group',
    'rename_budget_group',
    'assign_category_to_budget_group',
    'confirm_recurring',
    'create_recurring_adjustment',
  ]);

  const drafts = (analysis?.drafts || []).filter((draft) => ALLOWED_PALETTE_DRAFTS.has(draft.payload.kind));
  const hasResults = drafts.length > 0;

  return (
    <>
      <div 
        className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 transition-opacity" 
        onClick={() => setOpen(false)}
      />
      <div className="fixed left-1/2 top-[20%] -translate-x-1/2 w-full max-w-2xl border border-line-2 bg-card rounded-xl z-50 overflow-hidden flex flex-col max-h-[60vh]">
        <div className="flex items-center px-4 py-3 border-b border-border">
          <Search size={18} className="text-muted mr-3 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent border-none text-text text-lg focus:outline-none placeholder:text-faint"
            placeholder="Type a command or ask Mizān... (e.g. 'Categorize Uber as Transport')"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {isAnalyzing && <Loader2 size={16} className="text-positive animate-spin ml-3 flex-shrink-0" />}
        </div>
        
        {query.trim().length > 0 && (
          <div className="flex-1 overflow-y-auto p-2">
            {!isAnalyzing && !hasResults && debouncedQuery.length > 3 && (
              <div className="px-4 py-8 text-center flex flex-col items-center justify-center">
                <BrainCircuit size={24} className="text-muted mb-2" />
                <p className="text-sm text-text font-medium">No actions found</p>
                <p className="text-xs text-muted mt-1">Try rephrasing your command, or open the Advisor for complex questions.</p>
                <button 
                  onClick={() => {
                    setOpen(false);
                    navigate('/advisor', { state: { advisorPrompt: { source: 'palette', prompt: query, recordKind: 'dashboard' } } });
                  }}
                  className="mt-4 text-xs text-positive hover:underline flex items-center gap-1"
                >
                  Ask Advisor <ArrowRight size={12} />
                </button>
              </div>
            )}
            
            {hasResults && (
              <div className="space-y-1">
                <div className="px-3 py-1.5 text-[10px] font-semibold text-muted uppercase tracking-wider">
                  Suggested Actions
                </div>
                {drafts.map((draft: AdvisorDraftAction, index: number) => {
                  const isApplying = confirmMutation.isPending && confirmMutation.variables?.id === draft.id;
                  
                  return (
                    <div 
                      key={draft.id} 
                      className={`group flex flex-col gap-2 p-3 rounded-lg border ${index === 0 ? 'border-positive/30 bg-positive/5' : 'border-transparent hover:bg-black/5'} transition-colors cursor-default`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-2 min-w-0">
                          <Sparkles size={14} className="text-positive mt-0.5 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text truncate">{draft.label}</p>
                            <p className="text-xs text-muted leading-relaxed mt-0.5">{draft.summary}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => confirmMutation.mutate(draft)}
                          disabled={isApplying}
                          className="flex-shrink-0 flex items-center gap-1.5 text-xs bg-text text-surface font-medium rounded px-3 py-1.5 hover:opacity-90 disabled:opacity-50 transition-opacity"
                        >
                          {isApplying ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                        </button>
                      </div>
                      
                      {draft.changes.length > 0 && (
                        <div className="ml-6 grid grid-cols-1 gap-1">
                          {draft.changes.map((change) => (
                            <div key={`${draft.id}:${change.field}`} className="flex items-center justify-between gap-3 text-[11px]">
                              <span className="text-muted">{change.field}</span>
                              <span className="font-mono text-text text-right truncate">
                                {change.before !== null ? String(change.before) : 'None'} <ArrowRight size={10} className="inline mx-1 opacity-50" /> {change.after !== null ? String(change.after) : 'None'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        
        <div className="px-4 py-2 border-t border-border bg-background/50 flex justify-between items-center text-[10px] text-muted">
          <span><kbd className="font-mono bg-border px-1.5 py-0.5 rounded mr-1">esc</kbd> to close</span>
          <span>Drafts require explicit confirmation</span>
        </div>
      </div>
    </>
  );
}
