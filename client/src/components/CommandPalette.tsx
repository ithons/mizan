import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Loader2, Sparkles, ArrowRight, BrainCircuit, CornerDownLeft } from 'lucide-react';
import { aiApi, settingsApi, syncApi } from '../lib/api';
import { useAppStore } from '../store';
import type { AdvisorDraftAction } from '@shared/types';

interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

// Restrict Command Palette drafts to lower-stakes, easily reversible actions (transactions & budgets).
// High-stakes actions (goals, investments) should be handled via explicit UI or chat.
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

const NAV_TARGETS = [
  { label: 'Today', route: '/' },
  { label: 'Accounts', route: '/accounts' },
  { label: 'Transactions', route: '/transactions' },
  { label: 'Cash flow', route: '/cash-flow' },
  { label: 'Reports', route: '/reports' },
  { label: 'Budget', route: '/budget' },
  { label: 'Bills', route: '/bills' },
  { label: 'Goals', route: '/goals' },
  { label: 'Investments', route: '/investments' },
  { label: 'Advisor', route: '/advisor' },
  { label: 'Settings', route: '/settings' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { addToast } = useAppStore();
  const qc = useQueryClient();

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedQuery(query), 400);
    return () => clearTimeout(handler);
  }, [query]);

  // Global hotkey: Cmd/Ctrl + K, plus the in-app "Search or ask" affordances.
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
    const handleOpenEvent = () => setOpen(true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mizan:open-palette', handleOpenEvent);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mizan:open-palette', handleOpenEvent);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
      setDebouncedQuery('');
      setActiveIdx(0);
    }
  }, [open]);

  const { data: analysis, isLoading: isAnalyzing } = useQuery({
    queryKey: ['advisor', 'analyze', debouncedQuery],
    queryFn: () => aiApi.analyze(debouncedQuery),
    enabled: debouncedQuery.trim().length > 3 && open,
    staleTime: 1000 * 60,
  });

  const confirmMutation = useMutation({
    mutationFn: aiApi.confirmDraft,
    onSuccess: (response) => {
      void qc.invalidateQueries();
      addToast({ type: 'success', message: response.message || 'Action applied' });
      setOpen(false);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const commands = useMemo<Command[]>(() => {
    const go = (route: string) => () => {
      setOpen(false);
      navigate(route);
    };
    return [
      ...NAV_TARGETS.map((t) => ({
        id: `nav:${t.route}`,
        label: `Go to ${t.label}`,
        keywords: t.label,
        run: go(t.route),
      })),
      {
        id: 'action:add-transaction',
        label: 'Add transaction',
        hint: 'manual entry',
        run: () => {
          setOpen(false);
          navigate('/transactions');
          setTimeout(() => window.dispatchEvent(new Event('mizan:add-transaction')), 120);
        },
      },
      {
        id: 'action:sync',
        label: 'Sync now',
        hint: '⌘S',
        run: () => {
          setOpen(false);
          syncApi.run().catch((err: unknown) => {
            addToast({ type: 'error', message: err instanceof Error ? err.message : 'Sync failed' });
          });
        },
      },
      {
        id: 'action:export-csv',
        label: 'Export transactions CSV',
        run: () => {
          setOpen(false);
          settingsApi.exportCsv().catch((err: unknown) => {
            addToast({ type: 'error', message: err instanceof Error ? err.message : 'Export failed' });
          });
        },
      },
    ];
  }, [navigate, addToast]);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const words = q.split(/\s+/);
    return commands.filter((c) => {
      const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [commands, query]);

  useEffect(() => setActiveIdx(0), [query]);

  if (!open) return null;

  const drafts = (analysis?.drafts || []).filter((draft) => ALLOWED_PALETTE_DRAFTS.has(draft.payload.kind));
  const showAiEmpty = query.trim().length > 3 && !isAnalyzing && drafts.length === 0 && filteredCommands.length === 0;

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filteredCommands.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && filteredCommands[activeIdx]) {
      e.preventDefault();
      filteredCommands[activeIdx].run();
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-ink/20 backdrop-blur-sm transition-opacity" onClick={() => setOpen(false)} />
      <div className="fixed left-1/2 top-[18%] z-50 flex max-h-[62vh] w-full max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-card">
        <div className="flex items-center border-b border-line px-4 py-3">
          <Search size={18} className="mr-3 flex-shrink-0 text-muted" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 border-none bg-transparent p-0 text-lg text-ink placeholder:text-faint focus:outline-none focus:ring-0"
            placeholder="Search, jump, or ask Mizān…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          {isAnalyzing && <Loader2 size={16} className="ml-3 flex-shrink-0 animate-spin text-sage" />}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {filteredCommands.length > 0 && (
            <div className="mb-1">
              {filteredCommands.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={c.run}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    i === activeIdx ? 'bg-rail text-ink' : 'text-ink-soft'
                  }`}
                >
                  <span>{c.label}</span>
                  <span className="flex items-center gap-2 text-[11px] text-faint">
                    {c.hint}
                    {i === activeIdx && <CornerDownLeft size={12} />}
                  </span>
                </button>
              ))}
            </div>
          )}

          {drafts.length > 0 && (
            <div className="space-y-1">
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-2">Suggested actions</div>
              {drafts.map((draft: AdvisorDraftAction) => {
                const isApplying = confirmMutation.isPending && confirmMutation.variables?.id === draft.id;
                return (
                  <div key={draft.id} className="group flex cursor-default flex-col gap-2 rounded-lg border border-transparent p-3 transition-colors hover:bg-rail/60">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <Sparkles size={14} className="mt-0.5 flex-shrink-0 text-sage" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink">{draft.label}</p>
                          <p className="mt-0.5 text-xs leading-relaxed text-muted">{draft.summary}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => confirmMutation.mutate(draft)}
                        disabled={isApplying}
                        className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {isApplying ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                      </button>
                    </div>
                    {draft.changes.length > 0 && (
                      <div className="ml-6 grid grid-cols-1 gap-1">
                        {draft.changes.map((change) => (
                          <div key={`${draft.id}:${change.field}`} className="flex items-center justify-between gap-3 text-[11px]">
                            <span className="text-muted">{change.field}</span>
                            <span className="truncate text-right text-ink-soft">
                              {change.before !== null ? String(change.before) : 'None'}{' '}
                              <ArrowRight size={10} className="mx-1 inline opacity-50" />{' '}
                              {change.after !== null ? String(change.after) : 'None'}
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

          {showAiEmpty && (
            <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
              <BrainCircuit size={24} className="mb-2 text-muted" />
              <p className="text-sm font-medium text-ink">No matches</p>
              <p className="mt-1 text-xs text-muted">Try rephrasing, or take it to the Advisor for a real answer.</p>
              <button
                onClick={() => {
                  setOpen(false);
                  navigate('/advisor', { state: { advisorPrompt: { source: 'dashboard', prompt: query, recordKind: 'palette' } } });
                }}
                className="mt-4 flex items-center gap-1 text-xs text-sage-deep hover:underline"
              >
                Ask Advisor <ArrowRight size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line bg-card-alt px-4 py-2 text-[10px] text-muted">
          <span>
            <kbd className="mr-1 rounded bg-line px-1.5 py-0.5 font-mono">↑↓</kbd>
            <kbd className="mr-1 rounded bg-line px-1.5 py-0.5 font-mono">↵</kbd> to jump ·{' '}
            <kbd className="rounded bg-line px-1.5 py-0.5 font-mono">esc</kbd> to close
          </span>
          <span>Drafts require explicit confirmation</span>
        </div>
      </div>
    </>
  );
}
