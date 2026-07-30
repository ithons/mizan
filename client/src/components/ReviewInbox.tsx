import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import type {
  AdvisorDraftAction,
  Category,
  MerchantRuleSuggestion,
  RecurringPattern,
  Transaction,
  TransferCandidatePair,
} from '@shared/types';
import { aiApi, categoriesApi, recurringApi, rulesApi, transactionsApi } from '../lib/api';
import { formatCurrency } from '../lib/formatters';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { useAppStore } from '../store';
import { Screen, ScreenHeader, CategoryPicker } from './balance';
import { QueryState } from './QueryState';

// Page size for the uncategorized backlog, matching the server's `limit` cap. Pages are merged
// before grouping so a merchant's cluster is never split across page boundaries — grouping one
// page at a time would show "5 Klarna" on page 1 and "4 Klarna" on page 2 and defeat the point.
const BACKLOG_LIMIT = 500;

// Matches MAX_SUGGEST_MERCHANTS on the server: one request lists every merchant in the prompt and
// gets one object back per merchant, so an unbounded batch would truncate the reply.
const AI_SUGGEST_BATCH = 60;

function merchantLabel(t: Transaction): string {
  return (t.merchant_name || t.original_name || '').trim() || 'Unknown merchant';
}

// Mirrors the server's merchant_key normalization (services/rules.ts) closely enough to group
// what a rule would treat as one merchant.
function merchantKey(t: Transaction): string {
  return merchantLabel(t).toLowerCase();
}

// date-fns `format` throws RangeError on an unparseable date; degrade instead of blanking the view.
function shortDate(value: string): string {
  try {
    const parsed = parseISO(value);
    return Number.isNaN(parsed.getTime()) ? value : format(parsed, 'MMM d, yyyy');
  } catch {
    return value;
  }
}

function findCategoryName(categories: Category[], id: string): string | null {
  for (const category of categories) {
    if (category.id === id) return category.name;
    const child = category.children?.find((c) => c.id === id);
    if (child) return child.name;
  }
  return null;
}

/**
 * Rewrites a `categorize_transaction` draft to the category the user actually picked.
 * The server applies the client-supplied payload, so overriding `category_id` changes the outcome —
 * the label and change record are rewritten too so the AI audit trail doesn't claim something else.
 */
function withCategoryOverride(
  draft: AdvisorDraftAction,
  categoryId: string,
  categories: Category[]
): AdvisorDraftAction {
  if (draft.payload.kind !== 'categorize_transaction') return draft;
  if (draft.payload.category_id === categoryId) return draft;

  const name = findCategoryName(categories, categoryId);
  const previousName = findCategoryName(categories, draft.payload.category_id);

  return {
    ...draft,
    label:
      name && previousName && draft.label.endsWith(` as ${previousName}`)
        ? `${draft.label.slice(0, -` as ${previousName}`.length)} as ${name}`
        : draft.label,
    summary: name ? `${draft.summary} (you chose ${name})` : draft.summary,
    payload: { ...draft.payload, category_id: categoryId },
    changes: draft.changes.map((change) =>
      change.field.toLowerCase().includes('category') && name ? { ...change, after: name } : change
    ),
  };
}

interface MerchantGroup {
  key: string;
  label: string;
  ids: string[];
  /** The underlying rows, so a group can be expanded to show exactly what was grouped. */
  items: Transaction[];
  total: number;
  latestDate: string;
  accountName: string | null;
}

function groupByMerchant(transactions: Transaction[]): MerchantGroup[] {
  const map = new Map<string, MerchantGroup>();
  for (const t of transactions) {
    const key = merchantKey(t);
    const existing = map.get(key);
    if (existing) {
      existing.ids.push(t.id);
      existing.items.push(t);
      existing.total += t.amount;
      if (t.date > existing.latestDate) existing.latestDate = t.date;
    } else {
      map.set(key, {
        key,
        label: merchantLabel(t),
        ids: [t.id],
        items: [t],
        total: t.amount,
        latestDate: t.date,
        accountName: t.account_name ?? null,
      });
    }
  }
  // Biggest clusters first — that's where the backlog collapses fastest.
  return [...map.values()].sort(
    (a, b) => b.ids.length - a.ids.length || (a.latestDate < b.latestDate ? 1 : -1)
  );
}

function SectionRow({
  title,
  sub,
  right,
  lead,
  children,
}: {
  title: string;
  sub: string;
  right?: React.ReactNode;
  /** Optional leading control (a selection checkbox for rows that support bulk actions). */
  lead?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {lead}
          <div className="min-w-0">
            <div className="truncate text-body-lg text-ink">{title}</div>
            <div className="mt-0.5 text-note text-muted-2">{sub}</div>
          </div>
        </div>
        {right && <div className="flex-shrink-0 tabular-nums text-body-lg text-ink">{right}</div>}
      </div>
      {children && <div className="mt-2.5 flex flex-wrap items-center gap-4 text-body">{children}</div>}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  tone = 'primary',
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'quiet';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        tone === 'primary'
          ? 'border-b border-ink pb-0.5 text-ink transition-opacity disabled:opacity-40'
          : 'text-muted transition-colors hover:text-ink disabled:opacity-40'
      }
    >
      {label}
    </button>
  );
}

type TabId = 'category' | 'ai' | 'transfers' | 'duplicates' | 'recurring' | 'rules';

export function ReviewInbox() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();

  const [tab, setTab] = useState<TabId>('category');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const [selectedPatterns, setSelectedPatterns] = useState<Set<string>>(new Set());
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // merchant label -> AI-proposed category. Advisory only; applied on an explicit click.
  const [suggestions, setSuggestions] = useState<Record<string, { id: string; name: string }>>({});
  const [suggestProgress, setSuggestProgress] = useState<{ done: number; total: number } | null>(null);

  const reviewQ = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const summary = reviewQ.data;
  // Paged rather than a single capped fetch: merchant grouping needs the whole backlog to be
  // accurate, and the server caps `limit` at 500, so anything larger must page and be merged.
  const backlogQ = useInfiniteQuery({
    queryKey: ['transactions', 'review', 'backlog'],
    queryFn: ({ pageParam }) =>
      transactionsApi.list({ uncategorized: true, pending: false, limit: BACKLOG_LIMIT, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const categoryList = categories ?? [];

  const onError = (err: Error) => addToast({ type: 'error', message: err.message });
  // No optimistic hiding: rows disappear when the refetched data no longer contains them. The old
  // inbox hid rows on a timer and tried to restore them on failure, which raced and permanently
  // hid items whose action had actually errored.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['recurring'] });
  };
  const invalidateAll = () => invalidateFinancialData(qc);

  const categorize = useMutation({
    mutationFn: ({ id, categoryId }: { id: string; categoryId: string }) =>
      transactionsApi.update(id, { category_id: categoryId }),
    onSuccess: invalidateAll,
    onError,
  });
  const bulkCategorize = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) =>
      transactionsApi.bulkCategory(ids, categoryId),
    onSuccess: (_r, { ids }) => {
      invalidateAll();
      setSelectedIds(new Set());
      setBulkCategory('');
      addToast({ type: 'success', message: `Categorized ${ids.length} transaction${ids.length === 1 ? '' : 's'}` });
    },
    onError,
  });
  // Applies to exactly the ids in the group — and `bulkCategorizeTransactions` already upserts a
  // merchant rule per distinct merchant, so future transactions are covered too.
  //
  // Deliberately NOT rulesApi.create(apply_existing): rule matching is substring + fuzzy, so a rule
  // built from a group label would silently sweep in neighbouring merchants ("AMK BIG BEND BASIN
  // STO" also matches "…STORE", and a generic label like "SERVICE FEE" matches far too much).
  const categorizeMerchant = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) =>
      transactionsApi.bulkCategory(ids, categoryId),
    onSuccess: (_r, { ids }) => {
      invalidateAll();
      addToast({
        type: 'success',
        message: `Categorized ${ids.length} transaction${ids.length === 1 ? '' : 's'} · rule saved for next time`,
      });
    },
    onError,
  });
  const dismissTransaction = useMutation({
    mutationFn: (id: string) => transactionsApi.markReview(id, 'dismissed'),
    onSuccess: invalidate,
    onError,
  });
  // Asks the model to propose a category per merchant. Nothing is written — the result only
  // pre-fills each row so a suggestion can be accepted with one click or overridden.
  //
  // Runs the whole backlog in sequential batches (the endpoint caps each request, since the prompt
  // lists every merchant and the reply returns one object each). Sequential rather than parallel:
  // it keeps cost predictable, avoids rate limits, and lets chips appear as they arrive.
  const suggestCategories = useMutation({
    mutationFn: async (merchants: string[]) => {
      let suggested = 0;
      let failure: Error | null = null;
      setSuggestProgress({ done: 0, total: merchants.length });

      for (let i = 0; i < merchants.length; i += AI_SUGGEST_BATCH) {
        const batch = merchants.slice(i, i + AI_SUGGEST_BATCH);
        try {
          const results = await aiApi.suggestCategories(batch);
          // Applied per batch so partial progress survives a later failure.
          setSuggestions((prev) => {
            const next = { ...prev };
            for (const r of results) next[r.merchant] = { id: r.category_id, name: r.category_name };
            return next;
          });
          suggested += results.length;
        } catch (err) {
          failure = err instanceof Error ? err : new Error('Suggestion request failed');
          break;
        }
        setSuggestProgress({ done: Math.min(i + batch.length, merchants.length), total: merchants.length });
      }
      return { suggested, total: merchants.length, failure };
    },
    onSuccess: ({ suggested, total, failure }) => {
      if (failure) {
        addToast({
          type: 'error',
          message: `Stopped after ${suggested} suggestion${suggested === 1 ? '' : 's'} — ${failure.message}`,
        });
        return;
      }
      const declined = total - suggested;
      addToast({
        type: suggested > 0 ? 'success' : 'info',
        message:
          suggested === 0
            ? 'No confident suggestions — these merchants are too ambiguous to guess'
            : `Suggested ${suggested} of ${total}${declined > 0 ? ` · ${declined} left blank (unclear)` : ''}`,
      });
    },
    onSettled: () => setSuggestProgress(null),
    onError,
  });
  const confirmDraft = useMutation({
    mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d),
    onSuccess: invalidateAll,
    onError,
  });
  const dismissDraft = useMutation({ mutationFn: (id: string) => aiApi.dismissDraft(id), onSuccess: invalidate, onError });
  const confirmDrafts = useMutation({
    mutationFn: (ids: string[]) => aiApi.confirmDrafts(ids),
    onSuccess: (result) => {
      setSelectedDrafts(new Set());
      // Drafts apply independently, so a batch can partly fail. Naming the count that did NOT apply
      // is the difference between a trustworthy bulk action and one that quietly drops work.
      const skipped = result.skipped > 0 ? ` · ${result.skipped} skipped` : '';
      addToast({
        type: result.skipped > 0 ? 'error' : 'success',
        message: `Applied ${result.applied} suggestion${result.applied === 1 ? '' : 's'}${skipped}`,
      });
      invalidateAll();
    },
    onError,
  });
  const createRule = useMutation({
    mutationFn: ({ suggestion, categoryId }: { suggestion: MerchantRuleSuggestion; categoryId: string }) =>
      rulesApi.create({ pattern: suggestion.pattern, category_id: categoryId, apply_existing: true }),
    onSuccess: invalidateAll,
    onError,
  });
  const approveSuggestions = useMutation({
    mutationFn: (patterns: string[]) =>
      rulesApi.approveSuggestions(patterns.map((pattern) => ({ pattern }))),
    onSuccess: (result) => {
      setSelectedPatterns(new Set());
      // Report what actually happened. A partially-skipped approval that renders as plain success
      // is how a user ends up trusting rules that were never created.
      const skipped = result.skipped.length > 0 ? ` · ${result.skipped.length} skipped` : '';
      addToast({
        type: result.skipped.length > 0 ? 'error' : 'success',
        message: `${result.approved} rule${result.approved === 1 ? '' : 's'} created · ${result.applied} categorized${skipped}`,
      });
      invalidateAll();
    },
    onError,
  });
  const dismissSuggestion = useMutation({
    mutationFn: (pattern: string) => rulesApi.dismissSuggestion(pattern),
    onSuccess: invalidate,
    onError,
  });
  const confirmRecurring = useMutation({ mutationFn: (p: RecurringPattern) => recurringApi.confirm(p.id), onSuccess: invalidate, onError });
  const dismissRecurring = useMutation({ mutationFn: (p: RecurringPattern) => recurringApi.dismiss(p.id), onSuccess: invalidate, onError });
  const dismissDuplicate = useMutation({
    mutationFn: (groupId: string) => transactionsApi.dismissDuplicateGroup(groupId),
    onSuccess: invalidate,
    onError,
  });
  // Keeps one copy and flags the rest as confirmed duplicates, which reporting excludes. They are
  // flagged rather than deleted because a provider row would just come back on the next sync.
  const confirmDuplicate = useMutation({
    mutationFn: ({ groupId, keepId }: { groupId: string; keepId: string }) =>
      transactionsApi.confirmDuplicateGroup(groupId, keepId),
    onSuccess: (result) => {
      invalidateAll();
      addToast({
        type: 'success',
        message: `Excluded ${result.excluded} duplicate cop${result.excluded === 1 ? 'y' : 'ies'} from reports`,
      });
    },
    onError,
  });
  const confirmTransfer = useMutation({
    mutationFn: (p: TransferCandidatePair) => transactionsApi.confirmTransferPair(p.pair_id),
    onSuccess: invalidateAll,
    onError,
  });
  const dismissTransfer = useMutation({
    mutationFn: (p: TransferCandidatePair) => transactionsApi.dismissTransferPair(p.pair_id),
    onSuccess: invalidate,
    onError,
  });

  const backlog = useMemo(() => backlogQ.data?.pages.flatMap((p) => p.data) ?? [], [backlogQ.data]);
  const backlogTotal = backlogQ.data?.pages[0]?.total ?? 0;
  const groups = useMemo(() => groupByMerchant(backlog), [backlog]);
  // Once suggestions exist, float the groups that have one to the top. Default order is by cluster
  // size, and the largest clusters tend to be exactly the ones the model declines (Klarna and other
  // BNPL/person-to-person descriptors), which otherwise buries every actionable proposal.
  const orderedGroups = useMemo(() => {
    if (Object.keys(suggestions).length === 0) return groups;
    return [...groups].sort((a, b) => {
      const rank = (g: MerchantGroup) => (suggestions[g.label] ? 0 : 1);
      return rank(a) - rank(b) || b.ids.length - a.ids.length;
    });
  }, [groups, suggestions]);

  const counts: Record<TabId, number> = {
    category: summary?.queues.find((q) => q.id === 'uncategorized')?.count ?? 0,
    ai: summary?.ai_drafts.length ?? 0,
    transfers: summary?.transfer_candidates.length ?? 0,
    duplicates: summary?.duplicate_candidates.length ?? 0,
    recurring: summary?.recurring_candidates.length ?? 0,
    rules: summary?.rule_suggestions.length ?? 0,
  };
  const TABS: Array<{ id: TabId; label: string }> = [
    { id: 'category', label: 'Needs category' },
    { id: 'ai', label: 'AI suggestions' },
    { id: 'transfers', label: 'Transfers' },
    { id: 'duplicates', label: 'Duplicates' },
    { id: 'recurring', label: 'Recurring' },
    { id: 'rules', label: 'Rule suggestions' },
  ];

  const toggleSelected = (ids: string[]) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });

  return (
    <Screen>
      <ScreenHeader
        title="Review"
        sub="Everything waiting on a decision — categorize in bulk, confirm suggestions, resolve duplicates"
        className="mb-5"
      />

      {/* Filter strip: every queue visible with its real count, so nothing is hidden behind a card */}
      <div className="mb-5 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-md px-2.5 py-1 text-body transition-colors ${
              tab === t.id ? 'bg-review-active text-review-text' : 'text-muted hover:text-ink'
            }`}
          >
            {t.label} · {counts[t.id]}
          </button>
        ))}
      </div>

      <QueryState
        isLoading={reviewQ.isPending || (tab === 'category' && backlogQ.isPending)}
        isError={reviewQ.isError || (tab === 'category' && backlogQ.isError)}
        error={reviewQ.error ?? backlogQ.error}
        onRetry={() => {
          void reviewQ.refetch();
          void backlogQ.refetch();
        }}
        label="your review queue"
        skeletonRows={5}
      >
        {tab === 'category' && (
          <>
            {groups.length > 0 && (() => {
              // Every merchant that doesn't already have a proposal — the mutation batches them.
              const pending = groups.filter((g) => !suggestions[g.label]).map((g) => g.label);
              return (
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={suggestCategories.isPending || pending.length === 0}
                    onClick={() => suggestCategories.mutate(pending)}
                    className="rounded-md border border-line-2 px-2.5 py-1 text-body text-ink transition-colors hover:bg-well disabled:opacity-50"
                  >
                    {suggestProgress
                      ? `Suggesting… ${suggestProgress.done}/${suggestProgress.total}`
                      : pending.length === 0
                        ? 'All merchants have a suggestion'
                        : `Suggest categories with AI · ${pending.length}`}
                  </button>
                  <span className="text-note text-muted-2">
                    Proposals only — nothing is applied until you click one.
                  </span>
                </div>
              );
            })()}

            {selectedIds.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line-2 bg-rail px-3 py-2">
                <span className="text-body text-ink">{selectedIds.size} selected</span>
                <CategoryPicker
                  value={bulkCategory}
                  onChange={setBulkCategory}
                  categories={categoryList}
                  placeholder="Categorize as…"
                />
                <ActionButton
                  label={bulkCategorize.isPending ? 'Applying…' : 'Apply'}
                  disabled={!bulkCategory || bulkCategorize.isPending}
                  onClick={() => bulkCategorize.mutate({ ids: [...selectedIds], categoryId: bulkCategory })}
                />
                <ActionButton label="Clear" tone="quiet" onClick={() => setSelectedIds(new Set())} />
              </div>
            )}

            {groups.length === 0 ? (
              <p className="py-6 text-body text-muted-2">Nothing needs a category. </p>
            ) : (
              orderedGroups.map((group) => {
                const selected = group.ids.every((id) => selectedIds.has(id));
                const repeated = group.ids.length > 1;
                const isOpen = expanded.has(group.key);
                const suggestion = suggestions[group.label];
                const applyCategory = (categoryId: string) => {
                  if (!categoryId) return;
                  // A repeated merchant applies to its whole cluster at once; a one-off just
                  // updates that transaction.
                  if (repeated) categorizeMerchant.mutate({ ids: group.ids, categoryId });
                  else categorize.mutate({ id: group.ids[0], categoryId });
                };
                return (
                  <div key={group.key} className="border-b border-line py-3 last:border-0">
                    <div className="flex items-baseline justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => toggleSelected(group.ids)}
                        className="flex min-w-0 items-baseline gap-2 text-left"
                        aria-pressed={selected}
                      >
                        <span
                          className={`mt-1 h-3.5 w-3.5 flex-shrink-0 rounded-[3px] border ${
                            selected ? 'border-ink bg-ink' : 'border-line-3'
                          }`}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-body-lg text-ink">{group.label}</span>
                          <span className="mt-0.5 block text-note text-muted-2">
                            {repeated
                              ? `${group.ids.length} transactions · latest ${shortDate(group.latestDate)}`
                              : `${shortDate(group.latestDate)}${group.accountName ? ` · ${group.accountName}` : ''}`}
                          </span>
                        </span>
                      </button>
                      <span className="flex-shrink-0 tabular-nums text-body-lg text-ink">
                        {formatCurrency(group.total)}
                      </span>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                      {suggestion && (
                        <button
                          type="button"
                          onClick={() => applyCategory(suggestion.id)}
                          className="rounded-md border border-sage-tint-border bg-sage-tint px-2.5 py-1 text-body text-sage-text transition-opacity hover:opacity-80"
                        >
                          AI: {suggestion.name} · apply{repeated ? ` to ${group.ids.length}` : ''}
                        </button>
                      )}
                      <CategoryPicker
                        value=""
                        placeholder={
                          suggestion
                            ? 'or pick another…'
                            : repeated
                              ? `Categorize all ${group.ids.length}…`
                              : 'Categorize…'
                        }
                        categories={categoryList}
                        onChange={applyCategory}
                      />
                      {repeated && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                          className="text-body text-muted transition-colors hover:text-ink"
                        >
                          {isOpen ? 'Hide transactions' : `Show ${group.ids.length} transactions`}
                        </button>
                      )}
                    </div>

                    {/* The exact rows behind the group, so it's clear what's being categorized
                        together — the raw statement text often differs from the grouped label. */}
                    {isOpen && (
                      <div className="mt-2 border-l border-line-2 pl-3">
                        {group.items.map((t) => (
                          <div key={t.id} className="flex items-baseline justify-between gap-3 py-1.5 text-body">
                            <div className="min-w-0">
                              <div className="truncate text-ink-soft">{t.original_name || merchantLabel(t)}</div>
                              <div className="text-note text-muted-2">
                                {shortDate(t.date)}
                                {t.account_name ? ` · ${t.account_name}` : ''}
                              </div>
                            </div>
                            <span className="flex-shrink-0 tabular-nums text-muted">{formatCurrency(t.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {backlogQ.hasNextPage && (
              <button
                type="button"
                onClick={() => void backlogQ.fetchNextPage()}
                disabled={backlogQ.isFetchingNextPage}
                className="mt-3 text-body text-muted transition-colors hover:text-ink disabled:opacity-50"
              >
                {backlogQ.isFetchingNextPage
                  ? 'Loading…'
                  : `Load more · ${backlogTotal - backlog.length} remaining`}
              </button>
            )}
          </>
        )}

        {tab === 'ai' &&
          (counts.ai === 0 ? (
            <p className="py-6 text-body text-muted-2">No AI suggestions right now.</p>
          ) : (
            <>
              {/* Confirming a worker pass one card at a time is the bottleneck the batch endpoint
                  exists to remove. Overriding a category still needs the per-row picker below, so
                  bulk confirm applies each draft exactly as proposed. */}
              <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-line pb-3">
                <button
                  type="button"
                  onClick={() => {
                    const all = (summary?.ai_drafts ?? []).map((d) => d.id);
                    setSelectedDrafts((prev) => (prev.size === all.length ? new Set() : new Set(all)));
                  }}
                  className="text-body text-muted transition-colors hover:text-ink"
                >
                  {selectedDrafts.size === (summary?.ai_drafts ?? []).length ? 'Clear selection' : 'Select all'}
                </button>
                {selectedDrafts.size > 0 && (
                  <>
                    <span className="text-body text-ink">{selectedDrafts.size} selected</span>
                    <ActionButton
                      label={confirmDrafts.isPending ? 'Applying…' : `Confirm ${selectedDrafts.size} as proposed`}
                      disabled={confirmDrafts.isPending}
                      onClick={() => confirmDrafts.mutate([...selectedDrafts])}
                    />
                  </>
                )}
              </div>
              {(summary?.ai_drafts ?? []).map((draft) => {
              const proposed =
                draft.payload.kind === 'categorize_transaction' ? draft.payload.category_id : undefined;
              const checked = selectedDrafts.has(draft.id);
              return (
                <SectionRow
                  key={draft.id}
                  title={draft.label}
                  sub={draft.summary}
                  lead={
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={`Select suggestion: ${draft.label}`}
                      onClick={() =>
                        setSelectedDrafts((prev) => {
                          const next = new Set(prev);
                          if (next.has(draft.id)) next.delete(draft.id);
                          else next.add(draft.id);
                          return next;
                        })
                      }
                      className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border transition-colors ${
                        checked ? 'border-ink bg-ink' : 'border-line-3'
                      }`}
                    />
                  }
                >
                  {proposed !== undefined ? (
                    <>
                      {/* Pre-filled with the AI's guess so a wrong one can be corrected, not just
                          accepted or thrown away. */}
                      <CategoryPicker
                        value={proposed}
                        categories={categoryList}
                        placeholder="Category"
                        onChange={(categoryId) =>
                          confirmDraft.mutate(withCategoryOverride(draft, categoryId, categoryList))
                        }
                      />
                      <ActionButton
                        label="Confirm"
                        disabled={confirmDraft.isPending}
                        onClick={() => confirmDraft.mutate(draft)}
                      />
                    </>
                  ) : (
                    <ActionButton
                      label="Confirm"
                      disabled={confirmDraft.isPending}
                      onClick={() => confirmDraft.mutate(draft)}
                    />
                  )}
                  <ActionButton label="Dismiss" tone="quiet" onClick={() => dismissDraft.mutate(draft.id)} />
                </SectionRow>
              );
            })}
            </>
          ))}

        {tab === 'transfers' &&
          (counts.transfers === 0 ? (
            <p className="py-6 text-body text-muted-2">No transfer pairs to confirm.</p>
          ) : (
            (summary?.transfer_candidates ?? []).map((p) => (
              <SectionRow
                key={p.pair_id}
                title={`${p.from_account_name} → ${p.to_account_name}`}
                sub={`${shortDate(p.date)} · looks like a transfer, not spending`}
                right={formatCurrency(Math.abs(p.amount))}
              >
                <ActionButton label="Confirm transfer" onClick={() => confirmTransfer.mutate(p)} />
                <ActionButton label="Not a transfer" tone="quiet" onClick={() => dismissTransfer.mutate(p)} />
              </SectionRow>
            ))
          ))}

        {tab === 'duplicates' &&
          (counts.duplicates === 0 ? (
            <p className="py-6 text-body text-muted-2">No possible duplicates.</p>
          ) : (
            (summary?.duplicate_candidates ?? []).map((g) => (
              <SectionRow
                key={g.group_id}
                title={g.merchant_name}
                sub={`${shortDate(g.date)} · ${g.count} identical charges on ${g.account_name}`}
                right={formatCurrency(g.amount)}
              >
                <ActionButton label="Keep both" onClick={() => dismissDuplicate.mutate(g.group_id)} />
                <ActionButton
                  label={`It's a duplicate · exclude ${g.count - 1}`}
                  tone="quiet"
                  disabled={confirmDuplicate.isPending || g.transaction_ids.length < 2}
                  onClick={() =>
                    confirmDuplicate.mutate({ groupId: g.group_id, keepId: g.transaction_ids[0] })
                  }
                />
                <span className="text-note text-muted-2">
                  Excluded copies stay in Transactions but stop counting toward spending.
                </span>
              </SectionRow>
            ))
          ))}

        {tab === 'recurring' &&
          (counts.recurring === 0 ? (
            <p className="py-6 text-body text-muted-2">No recurring patterns to confirm.</p>
          ) : (
            (summary?.recurring_candidates ?? []).map((p) => (
              <SectionRow
                key={p.id}
                title={p.merchant_name}
                sub={`${p.frequency} · seen ${p.transaction_count} times`}
                right={formatCurrency(p.average_amount)}
              >
                <ActionButton label="Confirm" onClick={() => confirmRecurring.mutate(p)} />
                <ActionButton label="Not recurring" tone="quiet" onClick={() => dismissRecurring.mutate(p)} />
              </SectionRow>
            ))
          ))}

        {tab === 'rules' &&
          (counts.rules === 0 ? (
            <p className="py-6 text-body text-muted-2">No rule suggestions.</p>
          ) : (
            <>
              {/* Approving one at a time is the bottleneck when the backlog is dozens of merchants
                  deep; each row still keeps its own picker for the ones needing a different call. */}
              <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-line pb-3">
                <button
                  type="button"
                  onClick={() => {
                    const all = (summary?.rule_suggestions ?? []).map((s) => s.pattern);
                    setSelectedPatterns((prev) => (prev.size === all.length ? new Set() : new Set(all)));
                  }}
                  className="text-body text-muted transition-colors hover:text-ink"
                >
                  {selectedPatterns.size === (summary?.rule_suggestions ?? []).length ? 'Clear selection' : 'Select all'}
                </button>
                {selectedPatterns.size > 0 && (
                  <>
                    <span className="text-body text-ink">{selectedPatterns.size} selected</span>
                    <ActionButton
                      label={approveSuggestions.isPending ? 'Approving…' : `Approve ${selectedPatterns.size} as suggested`}
                      disabled={approveSuggestions.isPending}
                      onClick={() => approveSuggestions.mutate([...selectedPatterns])}
                    />
                  </>
                )}
              </div>
              {(summary?.rule_suggestions ?? []).map((s) => {
                const checked = selectedPatterns.has(s.pattern);
                return (
                  <SectionRow
                    key={`${s.pattern}:${s.category_id}`}
                    title={`${s.pattern} → always categorize as…`}
                    sub={`applies to ${s.affected_transaction_ids.length} transaction${
                      s.affected_transaction_ids.length === 1 ? '' : 's'
                    } · suggested: ${s.category_name}`}
                    lead={
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`Select rule for ${s.pattern}`}
                        onClick={() =>
                          setSelectedPatterns((prev) => {
                            const next = new Set(prev);
                            if (next.has(s.pattern)) next.delete(s.pattern);
                            else next.add(s.pattern);
                            return next;
                          })
                        }
                        className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border transition-colors ${
                          checked ? 'border-ink bg-ink' : 'border-line-3'
                        }`}
                      />
                    }
                  >
                    <CategoryPicker
                      value={s.category_id}
                      categories={categoryList}
                      placeholder="Category"
                      onChange={(categoryId) => createRule.mutate({ suggestion: s, categoryId })}
                    />
                    <ActionButton
                      label="Create rule"
                      onClick={() => createRule.mutate({ suggestion: s, categoryId: s.category_id })}
                    />
                    <ActionButton label="Skip" tone="quiet" onClick={() => dismissSuggestion.mutate(s.pattern)} />
                  </SectionRow>
                );
              })}
            </>
          ))}
      </QueryState>

      {/* Dismissing a single transaction stays available from the category tab's row menu in
          Transactions; keeping it off the worklist keeps each row to one decision. */}
      {tab === 'category' && selectedIds.size > 0 && (
        <button
          type="button"
          onClick={() => [...selectedIds].forEach((id) => dismissTransaction.mutate(id))}
          className="mt-4 text-note text-muted-2 transition-colors hover:text-ink"
        >
          Or dismiss {selectedIds.size} selected (hide without categorizing)
        </button>
      )}
    </Screen>
  );
}
