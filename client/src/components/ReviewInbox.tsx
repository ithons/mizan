import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

// The whole uncategorized backlog is loaded at once (server caps `limit` at 500) so merchants can
// be grouped accurately — grouping only a page at a time would split "14 Klarna charges" across
// pages and defeat the point.
const BACKLOG_LIMIT = 500;

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
      existing.total += t.amount;
      if (t.date > existing.latestDate) existing.latestDate = t.date;
    } else {
      map.set(key, {
        key,
        label: merchantLabel(t),
        ids: [t.id],
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
  children,
}: {
  title: string;
  sub: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[14.5px] text-ink">{title}</div>
          <div className="mt-0.5 text-xs text-muted-2">{sub}</div>
        </div>
        {right && <div className="flex-shrink-0 tabular-nums text-[14px] text-ink">{right}</div>}
      </div>
      {children && <div className="mt-2.5 flex flex-wrap items-center gap-4 text-[13.5px]">{children}</div>}
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

  const reviewQ = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const summary = reviewQ.data;
  const backlogQ = useQuery({
    queryKey: ['transactions', 'review', 'backlog'],
    queryFn: () => transactionsApi.list({ uncategorized: true, pending: false, limit: BACKLOG_LIMIT }),
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
  const confirmDraft = useMutation({
    mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d),
    onSuccess: invalidateAll,
    onError,
  });
  const dismissDraft = useMutation({ mutationFn: (id: string) => aiApi.dismissDraft(id), onSuccess: invalidate, onError });
  const createRule = useMutation({
    mutationFn: ({ suggestion, categoryId }: { suggestion: MerchantRuleSuggestion; categoryId: string }) =>
      rulesApi.create({ pattern: suggestion.pattern, category_id: categoryId, apply_existing: true }),
    onSuccess: invalidateAll,
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

  const backlog = backlogQ.data?.data ?? [];
  const backlogTotal = backlogQ.data?.total ?? 0;
  const groups = useMemo(() => groupByMerchant(backlog), [backlog]);

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
            className={`rounded-md px-2.5 py-1 text-[13px] transition-colors ${
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
            {selectedIds.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line-2 bg-rail px-3 py-2">
                <span className="text-[13px] text-ink">{selectedIds.size} selected</span>
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
              <p className="py-6 text-[13.5px] text-muted-2">Nothing needs a category. </p>
            ) : (
              groups.map((group) => {
                const selected = group.ids.every((id) => selectedIds.has(id));
                const repeated = group.ids.length > 1;
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
                          <span className="block truncate text-[14.5px] text-ink">{group.label}</span>
                          <span className="mt-0.5 block text-xs text-muted-2">
                            {repeated
                              ? `${group.ids.length} transactions · latest ${shortDate(group.latestDate)}`
                              : `${shortDate(group.latestDate)}${group.accountName ? ` · ${group.accountName}` : ''}`}
                          </span>
                        </span>
                      </button>
                      <span className="flex-shrink-0 tabular-nums text-[14px] text-ink">
                        {formatCurrency(group.total)}
                      </span>
                    </div>
                    <div className="mt-2.5">
                      <CategoryPicker
                        value=""
                        placeholder={repeated ? `Categorize all ${group.ids.length}…` : 'Categorize…'}
                        categories={categoryList}
                        onChange={(categoryId) => {
                          if (!categoryId) return;
                          // A repeated merchant applies to its whole cluster at once; a one-off
                          // just updates that transaction.
                          if (repeated) {
                            categorizeMerchant.mutate({ ids: group.ids, categoryId });
                          } else {
                            categorize.mutate({ id: group.ids[0], categoryId });
                          }
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )}

            {backlogTotal > backlog.length && (
              <p className="pt-3 text-xs text-muted-2">
                Showing {backlog.length} of {backlogTotal}. Categorize some to load the rest.
              </p>
            )}
          </>
        )}

        {tab === 'ai' &&
          (counts.ai === 0 ? (
            <p className="py-6 text-[13.5px] text-muted-2">No AI suggestions right now.</p>
          ) : (
            (summary?.ai_drafts ?? []).map((draft) => {
              const proposed =
                draft.payload.kind === 'categorize_transaction' ? draft.payload.category_id : undefined;
              return (
                <SectionRow key={draft.id} title={draft.label} sub={draft.summary}>
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
            })
          ))}

        {tab === 'transfers' &&
          (counts.transfers === 0 ? (
            <p className="py-6 text-[13.5px] text-muted-2">No transfer pairs to confirm.</p>
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
            <p className="py-6 text-[13.5px] text-muted-2">No possible duplicates.</p>
          ) : (
            (summary?.duplicate_candidates ?? []).map((g) => (
              <SectionRow
                key={g.group_id}
                title={g.merchant_name}
                sub={`${shortDate(g.date)} · ${g.count} identical charges on ${g.account_name}`}
                right={formatCurrency(g.amount)}
              >
                <ActionButton label="Keep both" onClick={() => dismissDuplicate.mutate(g.group_id)} />
                <span className="text-xs text-muted-2">To remove one, open it in Transactions.</span>
              </SectionRow>
            ))
          ))}

        {tab === 'recurring' &&
          (counts.recurring === 0 ? (
            <p className="py-6 text-[13.5px] text-muted-2">No recurring patterns to confirm.</p>
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
            <p className="py-6 text-[13.5px] text-muted-2">No rule suggestions.</p>
          ) : (
            (summary?.rule_suggestions ?? []).map((s) => (
              <SectionRow
                key={`${s.pattern}:${s.category_id}`}
                title={`${s.pattern} → always categorize as…`}
                sub={`applies to ${s.affected_transaction_ids.length} transaction${
                  s.affected_transaction_ids.length === 1 ? '' : 's'
                } · suggested: ${s.category_name}`}
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
            ))
          ))}
      </QueryState>

      {/* Dismissing a single transaction stays available from the category tab's row menu in
          Transactions; keeping it off the worklist keeps each row to one decision. */}
      {tab === 'category' && selectedIds.size > 0 && (
        <button
          type="button"
          onClick={() => [...selectedIds].forEach((id) => dismissTransaction.mutate(id))}
          className="mt-4 text-xs text-muted-2 transition-colors hover:text-ink"
        >
          Or dismiss {selectedIds.size} selected (hide without categorizing)
        </button>
      )}
    </Screen>
  );
}
