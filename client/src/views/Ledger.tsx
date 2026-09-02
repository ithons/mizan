import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth, startOfYear, subMonths } from 'date-fns';
import { Search } from 'lucide-react';
import type {
  AdvisorDraftAction,
  DuplicateCandidateGroup,
  RecurringForecastOccurrence,
  RecurringPattern,
  Transaction,
  TransferCandidatePair,
} from '@shared/types';
import { accountsApi, categoriesApi, aiApi, recurringApi, transactionsApi } from '../lib/api';
import { creditNote, isInCredit } from '../lib/accountBalance';
import { formatCurrency, formatWholeCurrency } from '../lib/formatters';
import { chordOf, useShortcuts } from '../lib/keyboard';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import { useAppStore } from '../store';
import { QueryErrorBanner } from '../components/QueryErrorBanner';
import { SkeletonRows } from '../components/SkeletonLoader';
import {
  CategoryPicker,
  Figure,
  Screen,
  ScreenHeader,
  SectionLabel,
  Select,
  TextButton,
} from '../components/balance';
import { AddEntryModal, AddScheduledModal, EditEntryModal } from './ledger/modals';
import { LedgerColumnHeader, LedgerRow, ScheduledRow } from './ledger/rows';
import {
  MAX_BATCH_CONFIRM,
  MAX_SUGGESTED_IDS,
  SCHEDULE_STATES,
  PROVENANCE_FILTER_OPTIONS,
  buildSpine,
  createLedgerRowActions,
  readBatchControl,
  readBatchOutcomes,
  readProvenanceFilter,
  filterChips,
  indexDrafts,
  readSchedule,
  suggestedChipCount,
  withCategoryOverride,
  type LedgerFilter,
  type LedgerRowHandlers,
} from './ledger/spine';

/**
 * The ledger: one surface, one date spine, with today's rule drawn across it.
 *
 * It replaces three screens, and both of the deletions are structural rather than tidying.
 *
 * BILLS DIED because a bill is a transaction that has not happened yet. Giving future money its
 * own screen is the mechanism by which a forecast gets read as a fact: two screens, two layouts,
 * two vocabularies, and nothing on either one saying that the second is a projection of the first.
 * The 30-day forecast is now the top of this ledger, above the rule, on the same spine, in the
 * estimate ink this app already uses for a figure it derived rather than measured.
 *
 * REVIEW DIED because it was a filter built as a screen. Uncategorized rows, duplicate candidates
 * and transfer candidates are predicates over the transactions table; each of them was a tab.
 * They are chips here, and the decisions they carry happen on the rows they are about.
 *
 * This is `/ledger`. `/transactions`, `/bills` and `/review` redirect here; `/transactions` carries
 * its search string across, because `?uncategorized=1&range=all` is a live deep link this screen
 * still answers.
 */

const RANGES = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'three-months', label: 'Last 3 months' },
  // Present so every window on `/` has an exact counterpart here. A category drill-down that
  // narrowed six months to three would show a subset of the rows behind the figure it was opened
  // from, and the two totals would disagree with nothing on screen saying why.
  { id: 'six-months', label: 'Last 6 months' },
  { id: 'this-year', label: 'This year' },
  { id: 'all', label: 'All time' },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

function rangeDates(id: RangeId): { startDate?: string; endDate?: string } {
  const now = new Date();
  const fmt = (d: Date) => format(d, 'yyyy-MM-dd');
  switch (id) {
    case 'this-month':
      return { startDate: fmt(startOfMonth(now)), endDate: fmt(endOfMonth(now)) };
    case 'last-month': {
      const prev = subMonths(now, 1);
      return { startDate: fmt(startOfMonth(prev)), endDate: fmt(endOfMonth(prev)) };
    }
    case 'three-months':
      return { startDate: fmt(startOfMonth(subMonths(now, 2))), endDate: fmt(endOfMonth(now)) };
    case 'six-months':
      return { startDate: fmt(startOfMonth(subMonths(now, 5))), endDate: fmt(endOfMonth(now)) };
    case 'this-year':
      return { startDate: fmt(startOfYear(now)), endDate: fmt(now) };
    case 'all':
      return {};
  }
}

/** Rows per request. The server caps `limit` at 500; 100 keeps the first paint small. */
const PAGE_SIZE = 100;

export function Ledger() {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [searchParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [range, setRange] = useState<RangeId>('this-month');
  const [filter, setFilter] = useState<LedgerFilter>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [showAddScheduled, setShowAddScheduled] = useState(false);
  const [cursor, setCursor] = useState(0);
  // Guard refusals, kept per draft until the next attempt. A toast is gone before the owner has
  // read why a suggestion was left alone, and the reason is the whole value of a refusal.
  const [refusals, setRefusals] = useState<Record<string, string>>({});

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Deep links the retired screens answered: /transactions?uncategorized=1&range=all.
  // Plus `accountId`, which is how a finding hands over the rows it is made of rather than a
  // description of them: `LedgerIntegrityPanel` links here so acting on a flow-conservation
  // finding does not mean going and finding the rows by hand.
  useEffect(() => {
    if (searchParams.get('uncategorized') === '1') {
      setFilter('uncategorized');
      setRange('all');
    }
    const requested = searchParams.get('range');
    if (requested && RANGES.some((r) => r.id === requested)) setRange(requested as RangeId);
    const account = searchParams.get('accountId');
    if (account) setAccountFilter(account);
    // The drill-down half of Phase 14. The whole stack already filtered by category: the schema,
    // the service, the fetcher and this screen's own CategoryPicker. The only thing missing was a
    // way to ask for it from somewhere else, so a figure on `/` named a category and the owner had
    // to come here and re-select it by hand to see the rows behind it.
    const category = searchParams.get('categoryId');
    if (category) setCategoryFilter(category);
  }, [searchParams]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [range, debouncedSearch, accountFilter, categoryFilter, sourceFilter, filter]);

  useEffect(() => {
    const open = () => setShowAddEntry(true);
    window.addEventListener('mizan:add-transaction', open);
    return () => window.removeEventListener('mizan:add-transaction', open);
  }, []);

  const reviewQ = useQuery({ queryKey: ['transactions', 'review'], queryFn: () => transactionsApi.review() });
  const forecastQ = useQuery({ queryKey: ['recurring', 'forecast', 30], queryFn: () => recurringApi.forecast(30) });
  const patternsQ = useQuery({ queryKey: ['recurring'], queryFn: () => recurringApi.list() });
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const categoriesQ = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });

  const summary = reviewQ.data;
  const accounts = accountsQ.data;
  const categories = useMemo(() => categoriesQ.data ?? [], [categoriesQ.data]);

  const drafts = useMemo(() => indexDrafts(summary?.ai_drafts ?? []), [summary?.ai_drafts]);

  const provenance = readProvenanceFilter(sourceFilter);
  const filters = useMemo(() => {
    const base = {
      ...rangeDates(range),
      search: debouncedSearch || undefined,
      accountId: accountFilter ? [accountFilter] : undefined,
      categoryId: categoryFilter ? [categoryFilter] : undefined,
      categorySource: provenance ? [provenance] : undefined,
      limit: PAGE_SIZE,
    };
    switch (filter) {
      case 'uncategorized':
        // No reviewStatus gate. Adding one hid the entire imported backlog, because categorization
        // side effects set review_status = 'reviewed'.
        return { ...base, uncategorized: true };
      case 'suggested':
        return { ...base, ids: drafts.transactionIds.slice(0, MAX_SUGGESTED_IDS) };
      case 'duplicates':
        return { ...base, duplicateStatus: 'candidate' as const };
      case 'transfers':
        return { ...base, transferStatus: 'candidate' as const };
      case 'all':
        return base;
    }
  }, [range, debouncedSearch, accountFilter, categoryFilter, provenance, filter, drafts.transactionIds]);

  const pagesQ = useInfiniteQuery({
    queryKey: ['transactions', filters],
    queryFn: ({ pageParam }) => transactionsApi.list({ ...filters, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.limit < last.total ? last.page + 1 : undefined),
  });
  const { data: pages, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = pagesQ;

  const transactions = useMemo(() => pages?.pages.flatMap((p) => p.data) ?? [], [pages]);
  const totalCount = pages?.pages[0]?.total ?? 0;

  // A failed request used to render as an empty list, indistinguishable from no matches.
  const failableQueries = [
    { query: pagesQ, label: 'the ledger' },
    { query: reviewQ, label: 'open questions' },
    { query: forecastQ, label: 'scheduled items' },
    { query: patternsQ, label: 'recurring items' },
    { query: accountsQ, label: 'accounts' },
    { query: categoriesQ, label: 'categories' },
  ];

  const today = format(new Date(), 'yyyy-MM-dd');
  // The scheduled half belongs to the whole ledger, not to a worklist: with a chip on, this
  // screen is a queue and a forecast in it is noise.
  const occurrences = filter === 'all' ? forecastQ.data?.occurrences ?? [] : [];
  const spine = useMemo(() => buildSpine(transactions, occurrences, today), [transactions, occurrences, today]);
  const schedule = useMemo(
    () => readSchedule(forecastQ.data, patternsQ.data ?? []),
    [forecastQ.data, patternsQ.data]
  );

  const duplicateGroups = useMemo(() => {
    const map = new Map<string, DuplicateCandidateGroup>();
    for (const g of summary?.duplicate_candidates ?? []) map.set(g.group_id, g);
    return map;
  }, [summary?.duplicate_candidates]);
  const transferPairs = useMemo(() => {
    const map = new Map<string, TransferCandidatePair>();
    for (const p of summary?.transfer_candidates ?? []) map.set(p.pair_id, p);
    return map;
  }, [summary?.transfer_candidates]);

  const chips = filterChips({
    uncategorized: summary?.queues.find((q) => q.id === 'uncategorized')?.count ?? 0,
    // Every open draft, not only the ones that are about a row. See `suggestedChipCount`.
    suggested: suggestedChipCount(drafts),
    duplicates: (summary?.duplicate_candidates ?? []).reduce((n, g) => n + g.transaction_ids.length, 0),
    transfers: (summary?.transfer_candidates ?? []).length * 2,
  });

  // Rows on screen that carry a proposal, in render order. The keyboard cursor walks exactly this.
  const suggestedOnScreen = useMemo(
    () => transactions.filter((t) => drafts.byTransaction.has(t.id)).map((t) => t.id),
    [transactions, drafts.byTransaction]
  );
  useEffect(() => setCursor(0), [suggestedOnScreen.length]);

  const onError = (err: Error) => addToast({ type: 'error', message: err.message });
  const invalidateReview = () => {
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['recurring'] });
  };

  const confirmDraft = useMutation({
    mutationFn: (d: AdvisorDraftAction) => aiApi.confirmDraft(d),
    onMutate: (d) =>
      setRefusals((prev) => {
        const next = { ...prev };
        delete next[d.id];
        return next;
      }),
    onSuccess: () => invalidateFinancialData(qc),
    // The guards answer a refusal with a 409 carrying its own sentence. It belongs on the row.
    onError: (err: Error, d) => setRefusals((prev) => ({ ...prev, [d.id]: err.message })),
  });
  const dismissDraft = useMutation({
    mutationFn: (id: string) => aiApi.dismissDraft(id),
    onSuccess: invalidateReview,
    onError,
  });
  /**
   * Accept every proposal on screen in one request.
   *
   * The reason this exists rather than being "click accept N times" is what happens when a guard
   * refuses. `POST /api/ai/drafts/confirm` answers 200 with a per-draft outcome even when some
   * were refused, so the refusals arrive as a list, not as one error. They go into the same
   * `refusals` map the single-confirm 409 writes to, which puts each sentence on the row it is
   * about; the toast only says how many landed on each side. Ids only: the server reads every
   * payload back from `advisor_drafts`, so a batch can apply only what the worker proposed.
   */
  const confirmBatch = useMutation({
    mutationFn: (ids: string[]) => aiApi.confirmDrafts(ids),
    onMutate: (ids) =>
      setRefusals((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      }),
    onSuccess: (result) => {
      const reading = readBatchOutcomes(result.outcomes);
      setRefusals((prev) => ({ ...prev, ...reading.refusals }));
      invalidateFinancialData(qc);
      if (reading.message) {
        addToast({ type: reading.applied > 0 ? 'success' : 'error', message: reading.message });
      }
    },
    onError,
  });
  // `'dismissed'` is the only exit from the needs-a-category queue that is not filing the row, and
  // `'open'` is the way back. Both invalidate the whole financial set rather than just the review
  // summary, because the queue count on this screen and the one on `/` read the same summary.
  const setAside = useMutation({
    mutationFn: (id: string) => transactionsApi.markReview(id, 'dismissed'),
    onSuccess: () => invalidateFinancialData(qc),
    onError,
  });
  const bringBack = useMutation({
    mutationFn: (id: string) => transactionsApi.markReview(id, 'open'),
    onSuccess: () => invalidateFinancialData(qc),
    onError,
  });
  const bulkCategorize = useMutation({
    mutationFn: ({ ids, categoryId }: { ids: string[]; categoryId: string }) =>
      transactionsApi.bulkCategory(ids, categoryId),
    onSuccess: (_r, { ids }) => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: `Categorized ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}` });
      setSelectedIds(new Set());
      setBulkCategory('');
    },
    onError,
  });
  const keepCopy = useMutation({
    mutationFn: ({ groupId, keepId }: { groupId: string; keepId: string }) =>
      transactionsApi.confirmDuplicateGroup(groupId, keepId),
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      addToast({
        type: 'success',
        message: `${result.excluded} cop${result.excluded === 1 ? 'y' : 'ies'} stopped counting toward spending`,
      });
    },
    onError,
  });
  const keepBoth = useMutation({
    mutationFn: (groupId: string) => transactionsApi.dismissDuplicateGroup(groupId),
    onSuccess: invalidateReview,
    onError,
  });
  const confirmTransfer = useMutation({
    mutationFn: (pairId: string) => transactionsApi.confirmTransferPair(pairId),
    onSuccess: () => invalidateFinancialData(qc),
    onError,
  });
  const rejectTransfer = useMutation({
    mutationFn: (pairId: string) => transactionsApi.dismissTransferPair(pairId),
    onSuccess: invalidateReview,
    onError,
  });
  const skipOccurrence = useMutation({
    mutationFn: (o: RecurringForecastOccurrence) =>
      recurringApi.upsertAdjustment(o.pattern_id, {
        original_date: o.original_expected_date ?? o.expected_date,
        action: 'skip',
      }),
    onSuccess: invalidateReview,
    onError,
  });
  const undoSkip = useMutation({
    mutationFn: (o: RecurringForecastOccurrence) => recurringApi.deleteAdjustment(o.pattern_id, o.adjustment_id!),
    onSuccess: invalidateReview,
    onError,
  });
  const confirmPattern = useMutation({
    mutationFn: (id: string) => recurringApi.confirm(id),
    onSuccess: invalidateReview,
    onError,
  });
  const dismissPattern = useMutation({
    mutationFn: (id: string) => recurringApi.dismiss(id),
    onSuccess: invalidateReview,
    onError,
  });

  // Everything a row can ask this screen to do, rebuilt each render because it closes over state
  // that changes (`categories`). It is never handed to a row directly: `rowActions` is.
  const handlers: LedgerRowHandlers = {
    toggleSelect: (id) =>
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    open: (t: Transaction) => setEditing(t),
    accept: (draft: AdvisorDraftAction) => confirmDraft.mutate(draft),
    override: (draft: AdvisorDraftAction, categoryId: string) =>
      confirmDraft.mutate(withCategoryOverride(draft, categoryId, categories)),
    dismissDraft: (id: string) => dismissDraft.mutate(id),
    keepCopy: (groupId: string, keepId: string) => keepCopy.mutate({ groupId, keepId }),
    keepBoth: (groupId: string) => keepBoth.mutate(groupId),
    confirmTransfer: (pairId: string) => confirmTransfer.mutate(pairId),
    rejectTransfer: (pairId: string) => rejectTransfer.mutate(pairId),
    setAside: (id: string) => setAside.mutate(id),
    bringBack: (id: string) => bringBack.mutate(id),
  };
  const latestHandlers = useRef(handlers);
  // After every commit, not on a dependency list: the handlers object is new on every render by
  // construction, and every event that reads it fires after the commit that produced it.
  useEffect(() => {
    latestHandlers.current = handlers;
  });
  // `useState` with a lazy initialiser, not `useMemo`: React guarantees state survives a render
  // and explicitly does not guarantee that for a memo. The whole point of this object is that its
  // identity never changes, so it may not be built on something React is allowed to discard.
  const [rowActions] = useState(() => createLedgerRowActions(latestHandlers));

  /**
   * One key to accept. `j`/`k` walk the proposals on screen; `a` applies the one under the cursor
   * and `x` drops it. They are bare unmodified keys that write to the database, so they are the
   * strictest thing in the shortcut table: `screen` layer, which is dead the instant anything is
   * open over this view, and `page` focus, which is dead the instant the owner is operating a
   * control.
   *
   * There is deliberately no test here for an open modal or an open sheet. This screen used to
   * carry `showAddEntry || showAddScheduled || editing`, an enumeration of the overlays it happened
   * to know about, and the ⌘K sheet was not on the list: with the digest open, focus fell back to
   * `document.body` and `a` accepted a draft behind the sheet. A list of exceptions cannot cover a
   * surface that has not been written yet, so the registry answers "is anything covering this" and
   * this screen no longer has an opinion.
   */
  const cursorId = suggestedOnScreen[cursor];
  const cursorDraft = cursorId ? drafts.byTransaction.get(cursorId) : undefined;
  useShortcuts(
    'ledger',
    {
      'ledger.nextSuggestion': () => setCursor((c) => Math.min(suggestedOnScreen.length - 1, c + 1)),
      'ledger.prevSuggestion': () => setCursor((c) => Math.max(0, c - 1)),
      'ledger.acceptSuggestion': () => {
        if (cursorDraft) rowActions.accept(cursorDraft);
      },
      'ledger.dismissSuggestion': () => {
        if (cursorDraft) rowActions.dismissDraft(cursorDraft.id);
      },
    },
    suggestedOnScreen.length > 0
  );

  useEffect(() => {
    if (!cursorId) return;
    document.querySelector('[data-cursor="on"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursorId]);

  const selectChip = (id: LedgerFilter) => {
    setFilter(id);
    // The queues are lifetime-wide and this month holds almost none of them: turning a chip on
    // without widening the range showed "Needs a category · 426" above an empty list.
    if (id !== 'all') setRange('all');
  };

  const selectedAccount = accounts?.find((a) => a.id === accountFilter);
  const rangeLabel = RANGES.find((r) => r.id === range)?.label.toLowerCase() ?? '';
  const activeChip = chips.find((c) => c.id === filter);
  const busy =
    confirmDraft.isPending ||
    confirmBatch.isPending ||
    dismissDraft.isPending ||
    keepCopy.isPending ||
    keepBoth.isPending ||
    confirmTransfer.isPending ||
    rejectTransfer.isPending ||
    setAside.isPending ||
    bringBack.isPending;
  const scheduleBusy = skipOccurrence.isPending || undoSkip.isPending || confirmPattern.isPending || dismissPattern.isPending;

  // Patterns still awaiting a verdict that have no occurrence inside the window, so confirming
  // them is reachable even when nothing they produce is on screen.
  const scheduledPatternIds = new Set((forecastQ.data?.occurrences ?? []).map((o) => o.pattern_id));
  const unscheduledCandidates: RecurringPattern[] = (summary?.recurring_candidates ?? []).filter(
    (p) => !scheduledPatternIds.has(p.id)
  );

  const suggestedTruncated = filter === 'suggested' && drafts.transactionIds.length > MAX_SUGGESTED_IDS;

  const batch = readBatchControl(filter, suggestedOnScreen, drafts);

  return (
    <Screen size="wide">
      <ScreenHeader
        title="Ledger"
        sub={
          <>
            <span className="tabular-nums">{totalCount.toLocaleString()}</span> entr{totalCount === 1 ? 'y' : 'ies'} ·{' '}
            {activeChip && filter !== 'all' ? activeChip.label.toLowerCase() : rangeLabel}
          </>
        }
        actions={
          <>
            <TextButton onClick={() => setShowAddEntry(true)}>Add entry</TextButton>
            <TextButton onClick={() => setShowAddScheduled(true)}>Add scheduled item</TextButton>
          </>
        }
        className="mb-5"
      />
      <QueryErrorBanner items={failableQueries} className="mb-5" />

      <div className="mb-3 flex flex-shrink-0 flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex max-w-[380px] flex-1 items-center gap-2.5 border-b border-line-3 px-0.5 py-2">
          <Search size={15} className="flex-shrink-0 text-muted-2" aria-hidden />
          <input
            className="w-full border-none bg-transparent p-0 text-body-lg text-ink placeholder:text-muted-2 focus:outline-none focus:ring-0"
            placeholder="Search merchant, note, or amount"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={accountFilter}
          onChange={setAccountFilter}
          placeholder="All accounts"
          options={(accounts ?? []).filter((a) => !a.is_hidden).map((a) => ({ value: a.id, label: a.account_name }))}
        />
        <CategoryPicker value={categoryFilter} onChange={setCategoryFilter} placeholder="Category" categories={categories} />
        <Select
          value={sourceFilter}
          onChange={setSourceFilter}
          placeholder="Set by anyone"
          options={PROVENANCE_FILTER_OPTIONS}
        />
        <Select
          value={range}
          onChange={(v) => setRange(v as RangeId)}
          placeholder="This month"
          clearable={false}
          options={RANGES.map((r) => ({ value: r.id, label: r.label }))}
        />
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={() => selectChip(chip.id)}
            aria-pressed={filter === chip.id}
            /* `review-bg`, not `review-active`: `review-text` on `review-active` measures 4.21:1
               light and 3.74:1 dark, so it is under AA in BOTH themes now, where the figure this
               note used to carry recorded only a light failure. On `review-bg` it is 4.62:1 light
               and 4.56:1 dark and clears in both. The failing pair renders nowhere and is not a
               standing exception, but establishing that takes two commands rather than one, because
               `tailwind.config.js:73` exposes `review-active` as a utility and a grep of
               `client/src` structurally cannot see whether it is used. On 2026-08-01:
                 `grep -rn review-active client/src`  -> 7 lines in 2 files, being the four token
                    declarations in `index.css` and this comment's own three lines
                 `grep -rn 'bg-review-active\|text-review-active' client/src`  -> nothing
               So it is a declared ground with no call site, which is why the sub-AA pair is not
               listed as an exception: nothing renders it. */
            className={`rounded-md px-2.5 py-1 text-body transition-colors ${
              filter === chip.id ? 'bg-review-bg text-review-text' : 'text-muted hover:text-ink'
            }`}
          >
            {chip.label}
            {chip.count !== null && <span className="tabular-nums"> · {chip.count}</span>}
          </button>
        ))}
      </div>

      {/* Said once, in words, with no figure in it: the share of rows with no recorded author is a
          moving number and a hardcoded one could only ever go stale. */}
      <p className="mb-5 text-note text-muted-2">
        Each entry carries a mark for who chose its category. No mark means it was set before mizān recorded
        who set it.
        {/* The letters are read out of the shortcut table, so a rebinding cannot leave this
            sentence teaching a key the keyboard no longer sends here. */}
        {suggestedOnScreen.length > 0 &&
          ` Press ${chordOf('ledger.nextSuggestion')} and ${chordOf('ledger.prevSuggestion')} to move between` +
            ` suggestions, ${chordOf('ledger.acceptSuggestion')} to accept, ${chordOf('ledger.dismissSuggestion')}` +
            ' to drop, with nothing else focused and nothing open over this screen.'}
        {filter === 'uncategorized' &&
          ' An entry that will never have a category can be set aside, which stops the count above' +
            ' from carrying it and stops the advisor proposing about it. It stays on this list,' +
            ' marked, so setting one aside is never a way of losing it.'}
      </p>

      {selectedAccount && (
        <p className="mb-5 text-body text-muted">
          {selectedAccount.account_name} ·{' '}
          {isInCredit(selectedAccount) ? (
            <>
              <span className="tabular-nums text-sage-deep">
                {formatCurrency(Math.abs(selectedAccount.current_balance))}
              </span>{' '}
              {creditNote(selectedAccount)}
            </>
          ) : (
            <>
              <span className="tabular-nums text-ink">{formatCurrency(selectedAccount.current_balance)}</span>{' '}
              {selectedAccount.is_liability ? 'owed' : 'balance'}
            </>
          )}
        </p>
      )}

      {selectedIds.size > 0 && (
        <div className="mz-rise-fast mb-3 flex flex-wrap items-center gap-4 rounded-lg bg-rail px-3 py-2">
          <span className="text-body text-ink">{selectedIds.size} selected</span>
          <CategoryPicker
            value={bulkCategory}
            onChange={setBulkCategory}
            placeholder="Set category…"
            clearable={false}
            categories={categories}
          />
          <button
            type="button"
            disabled={!bulkCategory || bulkCategorize.isPending}
            onClick={() => bulkCategorize.mutate({ ids: [...selectedIds], categoryId: bulkCategory })}
            className="border-b border-ink pb-0.5 text-body text-ink transition-opacity disabled:opacity-40"
          >
            {bulkCategorize.isPending ? 'Applying…' : 'Apply'}
          </button>
          <TextButton onClick={() => setSelectedIds(new Set())} className="ml-auto">
            Clear
          </TextButton>
        </div>
      )}

      {/* Whether this is offered at all, and over which drafts, is `readBatchControl`. */}
      {batch && (
        <div className="mz-rise-fast mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-rail px-3 py-2">
          <span className="text-body text-ink">
            <span className="tabular-nums">{batch.ids.length}</span> proposals on this list
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => confirmBatch.mutate(batch.ids)}
            className="border-b border-ink pb-0.5 text-body text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
          >
            {confirmBatch.isPending ? 'Applying…' : `Accept all ${batch.ids.length} as proposed`}
          </button>
          {/* `text-muted`, not `text-muted-2`, and no longer for contrast. `muted-2` on `rail`
              measures 5.56:1 light and 7.30:1 dark, so it clears AA in both themes and the
              reason this line used to give is dead. It held before the 2026-08-01 palette;
              index.css records that there, alongside the tones tests/railGround.test.ts delisted
              at the same time, and it is not restated here as though it were current. What picks
              the tone now is emphasis and not measurement: this sentence qualifies the button
              beside it and is meant to be read before it is pressed, so it takes the same weight
              as the count on its left. `muted` on `rail` is 7.01:1 light and 9.03:1 dark. */}
          <span className="max-w-[54ch] text-note text-muted">
            Each is applied on its own. Any the write guards refuse are left exactly as they are, with
            the reason printed on the entry it is about.
            {batch.truncated && ` Only the first ${MAX_BATCH_CONFIRM} are sent at a time.`}
          </span>
        </div>
      )}

      {drafts.otherDrafts.length > 0 && filter === 'suggested' && (
        <div className="mb-5 border-b border-line pb-4">
          <SectionLabel className="mb-2">Suggestions that are not about an entry</SectionLabel>
          {drafts.otherDrafts.map((d) => (
            <p key={d.id} className="py-1 text-body text-estimate">
              {d.label} · <span className="text-muted-2">{d.summary}</span>
            </p>
          ))}
        </div>
      )}

      {suggestedTruncated && (
        <p className="mb-3 text-note text-review-text">
          Showing the first {MAX_SUGGESTED_IDS} of {drafts.transactionIds.length} suggestions. Accept or drop some to
          see the rest.
        </p>
      )}

      {/* ── Ahead of the rule ──────────────────────────────────────────────── */}
      {filter === 'all' && (
        <>
          <SectionLabel
            summary={
              schedule.monthlyBillTotal > 0
                ? `${formatWholeCurrency(schedule.monthlyBillTotal)} of recurring bills per month`
                : undefined
            }
            className="mb-3"
          >
            Scheduled · next 30 days
          </SectionLabel>

          <div className="mb-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
            <Figure
              scale="group"
              value={schedule.net}
              states={SCHEDULE_STATES}
              label="Expected over 30 days"
            >
              {formatCurrency(Math.abs(schedule.net))}
            </Figure>
            <p className="max-w-[420px] text-note text-muted-2">
              <span className="tabular-nums text-muted">{formatCurrency(schedule.incoming)}</span> in and{' '}
              <span className="tabular-nums text-muted">{formatCurrency(schedule.outgoing)}</span> out, from{' '}
              {schedule.patternCount} recurring item{schedule.patternCount === 1 ? '' : 's'} mizān has detected.
              Anything it has not detected as recurring is not in this figure.
            </p>
          </div>

          {/* Once per half, because the rule separates them by a screenful. Not over an empty
              half: a header with nothing under it names columns that do not exist yet. */}
          {(spine.scheduled.length > 0 || spine.overdue.length > 0) && <LedgerColumnHeader />}

          {spine.overdue.length > 0 && (
            <>
              <SectionLabel className="mb-1 mt-4">Expected before today, not seen yet</SectionLabel>
              {spine.overdue.map((o) => (
                <ScheduledRow
                  key={o.id}
                  occurrence={o}
                  busy={scheduleBusy}
                  onSkip={(x) => skipOccurrence.mutate(x)}
                  onUndoSkip={(x) => undoSkip.mutate(x)}
                  onConfirmPattern={(x) => confirmPattern.mutate(x.pattern_id)}
                  onDismissPattern={(x) => dismissPattern.mutate(x.pattern_id)}
                />
              ))}
            </>
          )}

          {spine.scheduled.map((day) => (
            <div key={day.date}>
              <div className="px-1 pb-1 pt-4 text-micro uppercase tracking-[0.18em] text-muted-2">{day.label}</div>
              {day.entries.map((o) => (
                <ScheduledRow
                  key={o.id}
                  occurrence={o}
                  busy={scheduleBusy}
                  onSkip={(x) => skipOccurrence.mutate(x)}
                  onUndoSkip={(x) => undoSkip.mutate(x)}
                  onConfirmPattern={(x) => confirmPattern.mutate(x.pattern_id)}
                  onDismissPattern={(x) => dismissPattern.mutate(x.pattern_id)}
                />
              ))}
            </div>
          ))}

          {spine.scheduled.length === 0 && spine.overdue.length === 0 && (
            <p className="py-3 text-body text-muted-2">
              Nothing scheduled in the next 30 days. Recurring charges appear here once mizān has seen enough of them.
            </p>
          )}

          {unscheduledCandidates.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <SectionLabel className="mb-1">Might repeat, not confirmed</SectionLabel>
              {unscheduledCandidates.map((p) => (
                <div key={p.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-1.5">
                  <span className="text-body-lg text-ink">{p.merchant_name}</span>
                  <span className="text-note text-muted-2">
                    {p.frequency} · seen {p.transaction_count} times · {formatCurrency(p.average_amount)}
                  </span>
                  <button
                    type="button"
                    disabled={scheduleBusy}
                    onClick={() => confirmPattern.mutate(p.id)}
                    className="border-b border-ink pb-0.5 text-body text-ink transition-opacity hover:opacity-75 disabled:opacity-40"
                  >
                    Confirm it repeats
                  </button>
                  <button
                    type="button"
                    disabled={scheduleBusy}
                    onClick={() => dismissPattern.mutate(p.id)}
                    className="text-body text-muted transition-colors hover:text-ink disabled:opacity-40"
                  >
                    Not recurring
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* THE RULE. The only full-width ink line on the sheet, and the only thing separating
              what is expected from what happened. Everything above it is drawn in estimate ink
              because none of it has occurred; everything below it is a posted row. */}
          <div className="mt-7 flex items-center gap-4">
            <div className="h-px flex-1 bg-ink-soft" />
            <span className="text-micro font-semibold uppercase tracking-[0.18em] text-ink-soft">
              Today · {format(new Date(), 'EEEE, MMMM d')}
            </span>
            <div className="h-px flex-1 bg-ink-soft" />
          </div>
        </>
      )}

      {/* ── Behind the rule ────────────────────────────────────────────────── */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col">
        {(isLoading || spine.settled.length > 0) && <LedgerColumnHeader />}

        {isLoading && <SkeletonRows rows={8} />}

        {!isLoading && spine.settled.length === 0 && (
          <p className="px-3 py-10 text-body-lg text-muted">
            {debouncedSearch || accountFilter || categoryFilter || sourceFilter || filter !== 'all'
              ? 'Nothing matches these filters.'
              : 'No entries in this period. The ledger reaches back only as far as each account’s provider sends.'}
          </p>
        )}

        {spine.settled.map((day) => (
          <div key={day.date}>
            <div className="px-1 pb-1 pt-4 text-micro uppercase tracking-[0.18em] text-muted-2">{day.label}</div>
            {day.entries.map((t) => {
              const draft = drafts.byTransaction.get(t.id) ?? null;
              return (
                <LedgerRow
                  key={t.id}
                  transaction={t}
                  selected={selectedIds.has(t.id)}
                  draft={draft}
                  isCursor={cursorId === t.id}
                  categories={categories}
                  busy={busy}
                  refusal={draft ? refusals[draft.id] ?? null : null}
                  duplicateGroups={duplicateGroups}
                  transferPairs={transferPairs}
                  actions={rowActions}
                />
              );
            })}
          </div>
        ))}

        {hasNextPage && (
          <div className="flex justify-center py-6">
            <TextButton onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage
                ? 'Loading…'
                : `Load more · ${(totalCount - transactions.length).toLocaleString()} remaining`}
            </TextButton>
          </div>
        )}
      </div>

      <AddEntryModal open={showAddEntry} onClose={() => setShowAddEntry(false)} />
      <AddScheduledModal open={showAddScheduled} onClose={() => setShowAddScheduled(false)} categories={categories} />
      <EditEntryModal transaction={editing} onClose={() => setEditing(null)} />
    </Screen>
  );
}
