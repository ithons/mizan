import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Loader2, Sparkles, ArrowRight, BrainCircuit, CornerDownLeft, ChevronLeft } from 'lucide-react';
import { aiApi, settingsApi, syncApi } from '../lib/api';
import { formatCurrency, formatDateShort, formatRelativeTime } from '../lib/formatters';
import { useAppStore } from '../store';
import type {
  AdvisorDraftAction,
  AiDigest,
  AiDigestAction,
  AiDigestRevertResult,
  AiDigestRow,
} from '@shared/types';

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
  { label: 'Review', route: '/review' },
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

/**
 * The digest lives here rather than on a screen of its own.
 *
 * Advisor is a tab today and Phase 8 retires it in favour of this palette, so a panel built into
 * the Advisor view would be built to be deleted. The palette is also the right home on its merits:
 * "what did the AI change" is a question asked from wherever you happen to be standing, and ⌘K
 * answers it over the current screen instead of navigating away from the data it is about.
 */

type DigestWindow = '7d' | '30d' | 'all';

const DIGEST_WINDOWS: ReadonlyArray<{ id: DigestWindow; label: string; days: number | null }> = [
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'Everything', days: null },
];

function windowSince(win: DigestWindow): string | null {
  const days = DIGEST_WINDOWS.find((w) => w.id === win)?.days ?? null;
  if (days === null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function categoryLabel(id: string | null, name: string | null): string {
  if (id === null) return 'Uncategorized';
  return name ?? 'a category since deleted';
}

/**
 * What "Put it all back" would restore, or null when there is nothing to offer.
 *
 * Gated on rows AND rules. A window whose only AI activity is a rule retirement has zero revertable
 * rows and something to put back all the same, which is exactly the case the per-action line
 * already described ("Changed no transactions. The rule above can be put back.") while no button
 * rendered beside it. `retire_merchant_rule` is autonomous BECAUSE it touches no transaction, so
 * counting only transactions hides precisely the writes the owner never confirmed.
 */
export function revertOffer(digest: AiDigest): string | null {
  const rows = digest.revertable_rows;
  const rules = digest.revertable_rules;
  if (rows === 0 && rules === 0) return null;

  const rowText = `${rows} row${rows === 1 ? '' : 's'}`;
  const ruleText = `${rules} merchant rule${rules === 1 ? '' : 's'}`;
  let restores: string;
  if (rules === 0) restores = `Putting all of it back restores ${rowText}.`;
  else if (rows === 0) restores = `Putting all of it back restores ${ruleText} and changes no transaction.`;
  else restores = `Putting all of it back restores ${rowText} and ${ruleText}.`;

  const left =
    digest.changed_since_rows > 0
      ? ` ${digest.changed_since_rows} row${digest.changed_since_rows === 1 ? ' was' : 's were'} changed after the AI touched ${digest.changed_since_rows === 1 ? 'it' : 'them'} and ${digest.changed_since_rows === 1 ? 'is' : 'are'} left alone.`
      : '';
  const replaced =
    digest.replaced_within_action_rows > 0
      ? ` ${digest.replaced_within_action_rows} earlier value${digest.replaced_within_action_rows === 1 ? '' : 's'} the AI overwrote with its own later one ${digest.replaced_within_action_rows === 1 ? 'stays' : 'stay'} as ${digest.replaced_within_action_rows === 1 ? 'it is' : 'they are'}.`
      : '';
  return `${restores}${left}${replaced}`;
}

/**
 * What the revert actually put back.
 *
 * The rules half was dropped entirely, and a plan that reverted fewer rules than it claimed read as
 * a complete success. Both halves are stated, and the shortfall is named rather than absorbed.
 */
export function revertToast(result: AiDigestRevertResult): { type: 'success' | 'info'; message: string } {
  const rules = result.reverted_rules;
  const missedRules = result.planned_rules - result.reverted_rules;
  const left =
    result.changed_since_rows > 0
      ? `, ${result.changed_since_rows} left alone because something else changed them since`
      : '';
  const ruleClause = rules > 0 ? ` and ${rules} merchant rule(s)` : '';
  const message = `Put back ${result.reverted_rows} row(s)${ruleClause}${left}.`;
  if (missedRules <= 0) return { type: 'success', message };
  return {
    type: 'info',
    message: `${message} ${missedRules} rule(s) the plan counted could not be put back.`,
  };
}

function DigestRowLine({ row }: { row: AiDigestRow }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line-2 py-1.5 text-note">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="w-14 flex-shrink-0 tabular-nums text-muted-2">{formatDateShort(row.date)}</span>
        <span className="truncate text-ink">{row.merchant}</span>
        <span className="flex-shrink-0 tabular-nums text-muted">{formatCurrency(row.amount)}</span>
      </div>
      <div className="flex flex-shrink-0 items-baseline gap-1.5 text-right">
        <span className="text-muted-2 line-through">{categoryLabel(row.before_category_id, row.before_category_name)}</span>
        <ArrowRight size={10} className="inline opacity-50" />
        <span className={row.status === 'standing' ? 'text-ink' : 'text-muted'}>
          {categoryLabel(row.after_category_id, row.after_category_name)}
        </span>
        {row.status === 'reverted' && <span className="text-micro text-muted-2">already put back</span>}
        {row.blocked_reason === 'changed_since' && (
          <span className="text-micro text-muted-2">
            changed since{row.changed_since_by_source ? ` by ${row.changed_since_by_source}` : ''}
          </span>
        )}
        {/* The write on top belongs to this same action, so nothing outside it touched the row. */}
        {row.blocked_reason === 'replaced_by_same_action' && (
          <span className="text-micro text-muted-2">this action wrote it again later</span>
        )}
        {/* Not standing, but the plan reaches it: only a newer action in this same window is on top. */}
        {row.status === 'superseded' && row.revertable && (
          <span className="text-micro text-muted-2">a later AI change replaced this</span>
        )}
      </div>
    </div>
  );
}

function DigestActionBlock({ action }: { action: AiDigestAction }) {
  const undone = action.owner_feedback.find((f) => f.signal === 'undo');
  const overrides = action.owner_feedback.filter((f) => f.signal === 'manual_override').length;

  return (
    <div className="border-t border-line py-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate text-body-lg text-ink">{action.label}</span>
        <span className="flex-shrink-0 text-micro text-muted-2">
          {action.source === 'worker_auto' ? 'applied on its own' : 'you confirmed'} ·{' '}
          {formatRelativeTime(action.created_at)}
        </span>
      </div>
      {action.summary && action.summary !== action.label && (
        <p className="mt-0.5 text-note leading-relaxed text-muted">{action.summary}</p>
      )}

      {(undone || overrides > 0) && (
        <p className="mt-1 text-micro text-muted-2">
          {undone && `You undid this on ${formatDateShort(undone.created_at)}.`}
          {overrides > 0 && ` You replaced ${overrides} of its rows by hand.`}
        </p>
      )}

      {action.rule && (
        <p className="mt-1 text-note text-muted">
          Rule <span className="font-mono text-ink">{action.rule.pattern}</span>
          <ArrowRight size={10} className="mx-1 inline opacity-50" />
          {categoryLabel(action.rule.category_id, action.rule.category_name)}
          {action.rule.retired_at ? ' (retired since)' : ''}
        </p>
      )}

      {action.record_state === 'rows' && (
        <div className="mt-1.5">
          {action.rows.map((row) => (
            <DigestRowLine key={row.revision_id} row={row} />
          ))}
        </div>
      )}
      {/* A complete record of an action that changed no transaction. Reads as the fact it is, not a
          gap. It is not the same as "nothing to put back": retiring a rule changes no transaction
          by design, and undo restores it. */}
      {action.record_state === 'no_rows_changed' && (
        <p className="mt-1 text-note text-muted-2">
          Changed no transactions
          {action.revertable_rules > 0
            ? `. The rule above can be put back.`
            : `${action.rule ? ', so only the rule above changed' : ''}. Nothing to put back.`}
        </p>
      )}
      {action.record_state === 'unrecorded' && (
        <p className="mt-1 text-note text-muted-2">
          Applied before this ledger kept a row-by-row record, so whether it changed any transaction
          was never written down.
        </p>
      )}
    </div>
  );
}

function AiDigestPanel({ onBack }: { onBack: () => void }) {
  const [win, setWin] = useState<DigestWindow>('30d');
  const { addToast } = useAppStore();
  const qc = useQueryClient();

  // Pinned once per window so the digest, the button copy and the revert all name the same instant.
  const since = useMemo(() => windowSince(win), [win]);

  const { data: digest, isLoading } = useQuery({
    queryKey: ['ai-digest', since],
    queryFn: () => aiApi.digest(since),
  });

  const revert = useMutation({
    // The digest's own cap goes back with the request, so the revert plans over exactly the actions
    // this panel counted rather than a wider window of its own choosing.
    mutationFn: (args: { from: string; limit: number }) =>
      aiApi.revertDigestSince(args.from, args.limit),
    onSuccess: (result) => {
      void qc.invalidateQueries();
      addToast(revertToast(result));
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  // "Everything" has no lower bound until the data supplies one: the oldest action on record.
  const oldest = digest && digest.actions.length > 0 ? digest.actions[digest.actions.length - 1].created_at : null;
  const revertFrom = since ?? oldest;
  const offer = digest ? revertOffer(digest) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-note text-muted transition-colors hover:text-ink">
          <ChevronLeft size={14} /> Back
        </button>
        <div className="flex items-center gap-3 text-note">
          {DIGEST_WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setWin(w.id)}
              className={w.id === win ? 'text-ink' : 'text-muted-2 transition-colors hover:text-muted'}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {isLoading && <p className="py-6 text-body text-muted">Reading the revision log…</p>}

        {digest && digest.action_count === 0 && (
          <p className="py-6 text-body-lg text-ink">
            {since
              ? 'The AI has changed nothing in this window.'
              : 'The AI has never changed anything on this ledger.'}
          </p>
        )}

        {digest && digest.action_count > 0 && (
          <>
            <div className="py-3 text-body text-muted">
              {digest.row_count} row{digest.row_count === 1 ? '' : 's'} across {digest.action_count} action
              {digest.action_count === 1 ? '' : 's'}. {digest.standing_rows} still stand
              {digest.standing_rows === 1 ? 's' : ''} as the AI left {digest.standing_rows === 1 ? 'it' : 'them'}.
              {digest.already_reverted_rows > 0 && ` ${digest.already_reverted_rows} you have already put back.`}
              {digest.actions_that_changed_no_rows > 0 &&
                ` ${digest.actions_that_changed_no_rows} changed no transactions.`}
              {digest.actions_unrecorded > 0 &&
                ` ${digest.actions_unrecorded} predate${digest.actions_unrecorded === 1 ? 's' : ''} the row-by-row record.`}
            </div>

            {/* No button while truncated: this panel cannot describe what it would do, and a revert
                that reaches past the counts above is the same lie as one that falls short. */}
            {digest.truncated && (
              <p className="mb-2 rounded-lg bg-well px-3 py-2.5 text-note leading-relaxed text-muted">
                More than {digest.action_limit} actions fall in this window, so the counts above cover
                only the {digest.action_limit} most recent. Narrow the window to put any of it back.
              </p>
            )}

            {!digest.truncated && offer && revertFrom && (
              <div className="mb-2 flex items-center justify-between gap-4 rounded-lg bg-well px-3 py-2.5">
                <p className="text-note leading-relaxed text-muted">{offer}</p>
                <button
                  type="button"
                  disabled={revert.isPending}
                  onClick={() => revert.mutate({ from: revertFrom, limit: digest.action_limit })}
                  className="flex-shrink-0 rounded-lg bg-ink px-3 py-1.5 text-note font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {revert.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Put it all back'}
                </button>
              </div>
            )}

            {digest.actions.map((action) => (
              <DigestActionBlock key={action.action_id} action={action} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'search' | 'digest'>('search');
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
      setMode('search');
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
        id: 'action:ai-digest',
        label: 'What the AI changed',
        hint: 'review and undo',
        keywords: 'digest audit undo revert advisor history changes',
        run: () => setMode('digest'),
      },
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

  if (mode === 'digest') {
    return (
      <>
        <div className="fixed inset-0 z-50 bg-ink/20 backdrop-blur-sm transition-opacity" onClick={() => setOpen(false)} />
        <div className="fixed left-1/2 top-[12%] z-50 flex max-h-[76vh] w-full max-w-3xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-card shadow-e3">
          <AiDigestPanel onBack={() => setMode('search')} />
        </div>
      </>
    );
  }

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
      <div className="fixed left-1/2 top-[18%] z-50 flex max-h-[62vh] w-full max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line-2 bg-card shadow-e3">
        <div className="flex items-center border-b border-line px-4 py-3">
          <Search size={18} className="mr-3 flex-shrink-0 text-muted" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 border-none bg-transparent p-0 text-sub text-ink placeholder:text-muted-2 focus:outline-none focus:ring-0"
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
                  className={`relative flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-body-lg transition-colors before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-full ${
                    i === activeIdx
                      ? 'bg-well font-medium text-ink before:bg-sage'
                      : 'text-ink-soft before:bg-transparent'
                  }`}
                >
                  <span>{c.label}</span>
                  <span className="flex items-center gap-2 text-micro text-muted-2">
                    {c.hint}
                    {i === activeIdx && <CornerDownLeft size={12} />}
                  </span>
                </button>
              ))}
            </div>
          )}

          {drafts.length > 0 && (
            <div className="space-y-1">
              <div className="px-3 py-1.5 text-rule font-semibold uppercase tracking-wider text-muted-2">Suggested actions</div>
              {drafts.map((draft: AdvisorDraftAction) => {
                const isApplying = confirmMutation.isPending && confirmMutation.variables?.id === draft.id;
                return (
                  <div key={draft.id} className="group flex cursor-default flex-col gap-2 rounded-lg border border-transparent p-3 transition-colors hover:bg-well/60">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <Sparkles size={14} className="mt-0.5 flex-shrink-0 text-sage" />
                        <div className="min-w-0">
                          <p className="truncate text-body-lg font-medium text-ink">{draft.label}</p>
                          <p className="mt-0.5 text-note leading-relaxed text-muted">{draft.summary}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => confirmMutation.mutate(draft)}
                        disabled={isApplying}
                        className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-note font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {isApplying ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                      </button>
                    </div>
                    {draft.changes.length > 0 && (
                      <div className="ml-6 grid grid-cols-1 gap-1">
                        {draft.changes.map((change) => (
                          <div key={`${draft.id}:${change.field}`} className="flex items-center justify-between gap-3 text-micro">
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
              <p className="text-body-lg font-medium text-ink">No matches</p>
              <p className="mt-1 text-note text-muted">Try rephrasing, or take it to the Advisor for a real answer.</p>
              <button
                onClick={() => {
                  setOpen(false);
                  navigate('/advisor', { state: { advisorPrompt: { source: 'dashboard', prompt: query, recordKind: 'palette' } } });
                }}
                className="mt-4 flex items-center gap-1 text-note text-sage-deep hover:underline"
              >
                Ask Advisor <ArrowRight size={12} />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line bg-card-alt px-4 py-2 text-rule text-muted">
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
