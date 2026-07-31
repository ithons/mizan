import { format, isToday, isTomorrow, isYesterday, parseISO } from 'date-fns';
import type {
  AdvisorDraftAction,
  Category,
  DuplicateCandidateGroup,
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringPattern,
  Transaction,
  TransactionFilters,
  TransferCandidatePair,
} from '@shared/types';

/**
 * The ledger's pure half: everything that decides WHAT a row says, with no React in it.
 *
 * It lives apart from the view because every claim on this screen is a claim about the owner's
 * money, and the rule this codebase runs on is that a claim has to be reproducible. A function
 * here can be driven by a test over the real row shapes; a ternary buried in JSX cannot.
 */

// ─── Provenance ───────────────────────────────────────────────────────────────

/**
 * Who decided this row's category.
 *
 * `transactions.category_source` has been recorded per row since migration 041 and has been
 * rendered on no screen at all, which means the owner cannot tell a category they chose from one
 * the model chose, on the surface where they would act on it. Measured on a fresh copy of the live
 * `.mizan/mizan.db`, latest applied migration `053_drop_budget_groups.sql`, on 2026-07-31:
 *
 *   sqlite> SELECT COALESCE(category_source,'NULL'), COUNT(*) FROM transactions GROUP BY 1;
 *   NULL 2412 | ai 88 | human 62 | rule 13 | heuristic 13   (2,588 rows)
 *
 * NULL is the majority and it is NOT "nobody decided": migration 041 records it as "set before
 * provenance was tracked". So `null` renders as nothing at all, and the legend beside the filter
 * says what nothing means. Inventing a mark for it would be inventing a fact.
 *
 * Both markers are read, not just `category_source`, for the reason `draftLiveness` gives at
 * `server/src/services/advisorDrafts.ts`: neither is reliable alone. On this database they agree
 * exactly (all 62 `manually_categorized = 1` rows are also `category_source = 'human'`, measured
 * with `SELECT manually_categorized, category_source IS NULL, COUNT(*) ... GROUP BY 1,2`), which
 * is agreement rather than redundancy being unnecessary.
 */
export type ProvenanceMark = 'you' | 'model' | 'rule' | 'match';

export type ProvenanceView = Pick<Transaction, 'category_source' | 'manually_categorized'>;

export function readProvenance(t: ProvenanceView): ProvenanceMark | null {
  if (t.manually_categorized || t.category_source === 'human') return 'you';
  switch (t.category_source) {
    case 'ai':
      return 'model';
    case 'rule':
      return 'rule';
    case 'heuristic':
      return 'match';
    default:
      return null;
  }
}

/** The word each mark is said with. Short because it sits on every row that carries one. */
export const PROVENANCE_LABEL: Record<ProvenanceMark, string> = {
  you: 'you',
  model: 'model',
  rule: 'rule',
  match: 'match',
};

/** The `categorySource` values the server accepts, as the owner reads them. */
export type ProvenanceFilter = NonNullable<TransactionFilters['categorySource']>[number];

export const PROVENANCE_FILTER_OPTIONS: Array<{ value: ProvenanceFilter; label: string }> = [
  { value: 'human', label: 'You set it' },
  { value: 'ai', label: 'The model set it' },
  { value: 'rule', label: 'A merchant rule set it' },
  { value: 'heuristic', label: 'A match set it' },
  { value: 'none', label: 'Not recorded' },
];

/**
 * A `Select` hands back a bare string, and the server refuses anything outside the enum with a
 * 400. Narrowing here rather than casting means an unknown value becomes "no filter" instead of a
 * request the ledger cannot render the failure of.
 */
export function readProvenanceFilter(value: string): ProvenanceFilter | undefined {
  return PROVENANCE_FILTER_OPTIONS.find((o) => o.value === value)?.value;
}

// ─── Direction ────────────────────────────────────────────────────────────────

/**
 * A positive row is not automatically income.
 *
 * `services/schemaDoc.ts` states this as a sign convention the model is told about, and the screen
 * that shows the rows contradicted it: the old Transactions view painted every `amount > 0` row in
 * the income colour, so a $759.36 Amazon credit and a $544.18 paycheck were the same green. That
 * miscolouring is the row-level face of the first rendering hazard: July 2026 Shopping is negative
 * precisely because credits like these outweigh that month's purchases, and a ledger that calls
 * each of them income cannot explain how.
 *
 * The mark says `credit` rather than `refund`, and the difference is the whole rule this codebase
 * runs on. Re-measured on a fresh copy of `.mizan/mizan.db`, latest applied migration
 * `053_drop_budget_groups.sql`, on 2026-07-31:
 *
 *   SELECT COALESCE(t.merchant_name, t.original_name), t.amount / 100.0, c.name
 *     FROM transactions t JOIN categories c ON c.id = t.category_id
 *    WHERE t.date BETWEEN '2026-07-01' AND '2026-07-31' AND t.amount > 0 AND c.is_income = 0
 *    ORDER BY t.amount DESC;
 *
 * 11 rows, out of 129 in that month. FIVE carry the category literally named Transfer In:
 * Automatic Payment $2,373.14, Chase Account $1,000.00, Cash Deposit $780.00, Automatic Payment
 * $280.76, Transfer from Venmo $200.00. A sixth is transfer-shaped but filed under Credit Card
 * Payment: Credit Card Payment $965.90. The remaining FIVE are returns: Amazon $955.19, Amazon
 * $759.36, REI $281.29, Amazon $57.38, Lyft $1.02. So the split is 6 movements and 5 returns,
 * and the category name is the only thing that distinguishes them: `categories` has `is_income`
 * and `is_investment` and nothing for transfers. The mark therefore says only what the query
 * established, money in filed somewhere that is not income, and never guesses which of the two.
 *
 * An uncategorized inflow is `unplaced`. With no category there is nothing to place it against,
 * and guessing is the claim this rule exists to stop.
 */
export type Direction = 'income' | 'credit' | 'spend' | 'unplaced';

export type DirectionView = Pick<Transaction, 'amount' | 'category_id' | 'category_is_income'>;

export function readDirection(t: DirectionView): Direction {
  if (t.amount <= 0) return 'spend';
  if (!t.category_id) return 'unplaced';
  return t.category_is_income ? 'income' : 'credit';
}

// ─── The spine ────────────────────────────────────────────────────────────────

/**
 * One calendar day, holding whichever side of the rule it falls on.
 *
 * Scheduled and settled days are built into separate lists rather than merged, because merging
 * them is exactly the claim this screen refuses to make: a forecast occurrence and a posted
 * transaction are not the same kind of fact and must not become interchangeable rows in one array
 * that some later sort could shuffle together.
 */
export interface SpineDay<T> {
  date: string;
  label: string;
  entries: T[];
}

export interface Spine {
  /** Days strictly ahead of the rule, furthest future first. */
  scheduled: Array<SpineDay<RecurringForecastOccurrence>>;
  /**
   * Occurrences the forecast expected before today and has not seen arrive. They break the spine's
   * monotone order by construction, so they are pulled out and labelled rather than filed under a
   * past date where they would read as something that happened.
   */
  overdue: RecurringForecastOccurrence[];
  /** Days at or behind the rule, most recent first. */
  settled: Array<SpineDay<Transaction>>;
}

/** The date an occurrence actually falls on, after any adjustment the owner made. */
export function occurrenceDate(o: RecurringForecastOccurrence): string {
  return o.adjusted_date ?? o.expected_date;
}

/** The amount an occurrence actually carries, after any adjustment the owner made. */
export function occurrenceAmount(o: RecurringForecastOccurrence): number {
  return o.adjusted_amount ?? o.amount;
}

function dayLabel(dateStr: string): string {
  const d = parseISO(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  if (isToday(d)) return `Today · ${format(d, 'MMM d')}`;
  if (isTomorrow(d)) return `Tomorrow · ${format(d, 'MMM d')}`;
  if (isYesterday(d)) return `Yesterday · ${format(d, 'MMM d')}`;
  return format(d, 'EEEE · MMM d');
}

function groupDays<T>(items: T[], dateOf: (item: T) => string): Array<SpineDay<T>> {
  const byDate = new Map<string, T[]>();
  for (const item of items) {
    const date = dateOf(item);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(item);
    else byDate.set(date, [item]);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entries]) => ({ date, label: dayLabel(date), entries }));
}

/**
 * One list, one date spine, with today's rule in it.
 *
 * A bill is a transaction that has not happened yet. Giving future money its own screen was the
 * mechanism by which a forecast got read as a fact, so the forecast sits above the rule on the
 * same spine, in the same row shape, in estimate ink. Reading downward is reading backward in
 * time, which puts the nearest scheduled item immediately above the rule and today's postings
 * immediately below it.
 *
 * `today` is passed in rather than read from the clock so the boundary is testable, and because
 * the app's month boundaries are local while SQLite's `date('now')` is UTC (`schemaDoc.ts`).
 *
 * One pass over each input. On the live ledger the settled input is 2,588 rows at its widest.
 */
export function buildSpine(
  transactions: Transaction[],
  occurrences: RecurringForecastOccurrence[],
  today: string
): Spine {
  const ahead: RecurringForecastOccurrence[] = [];
  const overdue: RecurringForecastOccurrence[] = [];
  for (const o of occurrences) {
    if (occurrenceDate(o) < today) overdue.push(o);
    else ahead.push(o);
  }
  overdue.sort((a, b) => occurrenceDate(a).localeCompare(occurrenceDate(b)));

  return {
    scheduled: groupDays(ahead, occurrenceDate),
    overdue,
    settled: groupDays(transactions, (t) => t.date),
  };
}

// ─── Drafts on the rows they are about ────────────────────────────────────────

/**
 * The model's open proposals, keyed by the row each one is about.
 *
 * 253 drafts and 142 advisor actions exist on the live database and none has ever rendered beside
 * the data it changed (`SELECT status, COUNT(*) FROM advisor_drafts GROUP BY 1` gives confirmed
 * 235, open 15, dismissed 3; `SELECT COUNT(*) FROM advisor_actions` gives 142, both re-measured on
 * a fresh copy at migration `053_drop_budget_groups.sql` on 2026-07-31).
 *
 * Only `categorize_transaction` names a transaction. Everything else the model proposes is about
 * something that is not a row, and `otherDrafts` keeps those visible instead of dropping them,
 * because a queue that silently swallows a proposal is the failure this app already reverted once.
 */
export interface DraftIndex {
  byTransaction: Map<string, AdvisorDraftAction>;
  otherDrafts: AdvisorDraftAction[];
  /** Every transaction id the model has an open proposal about, in the order given. */
  transactionIds: string[];
}

export function indexDrafts(drafts: AdvisorDraftAction[]): DraftIndex {
  const byTransaction = new Map<string, AdvisorDraftAction>();
  const otherDrafts: AdvisorDraftAction[] = [];
  const transactionIds: string[] = [];

  for (const draft of drafts) {
    if (draft.payload.kind !== 'categorize_transaction') {
      otherDrafts.push(draft);
      continue;
    }
    const id = draft.payload.transaction_id;
    // First proposal wins. The server orders drafts and a second one about the same row would
    // otherwise silently replace the one whose id the accept key is about to send.
    if (byTransaction.has(id)) continue;
    byTransaction.set(id, draft);
    transactionIds.push(id);
  }

  return { byTransaction, otherDrafts, transactionIds };
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
 * Rewrites a `categorize_transaction` draft to the category the owner actually picked.
 *
 * The server applies the payload the client sends, so overriding `category_id` changes the
 * outcome. The label, summary and change record are rewritten with it, or the audit trail would
 * record the model as having proposed something it did not.
 *
 * Carried unchanged out of the retired review inbox, where it was the one piece of that screen
 * that could not be expressed as a filter.
 */
export function withCategoryOverride(
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

/** The category a `categorize_transaction` draft is proposing, or null for every other kind. */
export function proposedCategoryId(draft: AdvisorDraftAction): string | null {
  return draft.payload.kind === 'categorize_transaction' ? draft.payload.category_id : null;
}

// ─── What is flagged on a row ─────────────────────────────────────────────────

export type RowFlag = 'duplicate' | 'transfer' | 'pending' | 'excluded';

export type FlagView = Pick<
  Transaction,
  'duplicate_status' | 'transfer_status' | 'pending' | 'transfer_pair_id'
>;

/**
 * Everything the integrity passes have said about this row, as words.
 *
 * `duplicate_status = 'candidate'` and `transfer_status = 'candidate'` were two tabs on the
 * retired review screen. They are columns on the row, so they are flags on the row, and the
 * filter chips that select them are the same predicate said once.
 *
 * `confirmed` on either is deliberately not a flag: a confirmed transfer still shows in the
 * ledger and still has a category, and marking it would make settled work look like open work.
 * Only `excluded` is marked, because a row that stopped counting toward spending while staying
 * visible is a state the owner cannot otherwise see.
 */
export function readFlags(t: FlagView): RowFlag[] {
  const flags: RowFlag[] = [];
  if (t.pending) flags.push('pending');
  if (t.duplicate_status === 'candidate') flags.push('duplicate');
  if (t.transfer_status === 'candidate') flags.push('transfer');
  return flags;
}

export const FLAG_LABEL: Record<RowFlag, string> = {
  duplicate: 'possible duplicate',
  transfer: 'possible transfer',
  pending: 'pending',
  excluded: 'not counted',
};

// ─── The scheduled band ───────────────────────────────────────────────────────

const FREQUENCY_PER_MONTH: Record<RecurringPattern['frequency'], number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
};

export function monthlyAmount(p: RecurringPattern): number {
  return Math.abs(p.average_amount) * FREQUENCY_PER_MONTH[p.frequency];
}

/** An active pattern whose money goes out. Income patterns are not bills. */
export function isBillPattern(p: RecurringPattern): boolean {
  const signed = p.average_signed_amount ?? -Math.abs(p.average_amount);
  return p.is_active && signed < 0;
}

export interface ScheduledReading {
  /** Sum of scheduled income over the window, as the forecast service computed it. */
  incoming: number;
  /** Sum of scheduled bills over the window, positive magnitude, as the service computed it. */
  outgoing: number;
  /** Signed. Two different states, not one number in red. */
  net: number;
  /** How many recurring items produced this, so the total is never read as "everything ahead". */
  patternCount: number;
  monthlyBillTotal: number;
}

/**
 * What the scheduled band is allowed to say.
 *
 * Every figure comes straight off `buildRecurringForecast`, which returns the whole window rather
 * than a page of it, so these are sums of a complete set and not of what happened to be loaded.
 * The settled half of this screen is paged, which is exactly why it carries no totals at all.
 *
 * `net` is signed, and the two directions are different states. Re-measured on 2026-07-31 by
 * running `buildRecurringForecast(db, 30)` against a read-only copy of `.mizan/mizan.db` at
 * migration `053_drop_budget_groups.sql`: 7 occurrences from 4 distinct patterns, income
 * $2,176.72, bills $64.04, net +$2,112.68, 0 overdue.
 */
export function readSchedule(
  forecast: RecurringForecast | undefined,
  patterns: RecurringPattern[]
): ScheduledReading {
  const bills = patterns.filter(isBillPattern);
  return {
    incoming: forecast?.income ?? 0,
    outgoing: forecast?.bills ?? 0,
    net: forecast?.net ?? 0,
    patternCount: new Set((forecast?.occurrences ?? []).map((o) => o.pattern_id)).size,
    monthlyBillTotal: bills.reduce((sum, p) => sum + monthlyAmount(p), 0),
  };
}

/**
 * The two readings of a signed 30-day net.
 *
 * "More scheduled in than out" and "more scheduled out than in" are states of the world; a red
 * minus sign in the slot where a black number sits is neither of them. Deliberately not the words
 * "free to spend": this is scheduled recurring flow, not what is left after everything else.
 */
export const SCHEDULE_STATES = {
  positive: 'more scheduled in than out',
  negative: 'more scheduled out than in',
  zero: 'scheduled in and out are equal',
} as const;

export function occurrenceMeta(o: RecurringForecastOccurrence): string {
  const freq = o.frequency.charAt(0).toUpperCase() + o.frequency.slice(1);
  const varies = o.amount_varies ? ' · amount varies' : '';
  return `${freq} · ${o.confidence_label}${varies}`;
}

// ─── Whose keystroke it is ────────────────────────────────────────────────────

/**
 * The slice of the focused element the shortcut guard reads, kept as data so it can be driven by
 * a test. `readFocusedElement` is the only thing here that touches the DOM.
 */
export interface FocusedElement {
  tagName: string;
  /** The `role` ATTRIBUTE, not the reflected property: the attribute is what every browser has. */
  role: string | null;
  tabIndex: number;
  isContentEditable: boolean;
}

/**
 * Tags that are controls whatever else they say about themselves.
 *
 * `OPTION` is here because a listbox option can hold focus in some browsers, and `SUMMARY` and
 * `DETAILS` because they are operable without any role or tabindex.
 */
const CONTROL_TAGS = new Set([
  'A',
  'AREA',
  'BUTTON',
  'DETAILS',
  'INPUT',
  'OPTION',
  'SELECT',
  'SUMMARY',
  'TEXTAREA',
]);

/** Roles that mean "the owner is operating this", including every role a custom widget adopts. */
const CONTROL_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menu',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/**
 * Whether a bare `j`/`k`/`a`/`x` belongs to the ledger or to whatever has focus.
 *
 * The guard this replaces was a tagName allowlist, `['INPUT','TEXTAREA','SELECT']`, and it had a
 * hole wide enough to write through. `components/balance/Select` renders a `<button
 * role="combobox">`, whose tagName is BUTTON: focusing the account filter or the range control and
 * pressing `a` confirmed the AI draft under the cursor and wrote it, and `x` dismissed it. Every
 * filter chip, every Skip button, every row's select circle and the row's own Accept and Dismiss
 * buttons had the same hole, so `x` pressed twice dismissed a second draft.
 *
 * A tagName list is the wrong shape because the question is not which element it is. It is whether
 * focus rests on a control at all. Anything focusable is something the owner is operating; the
 * ledger's keys mean something only when focus is on the page itself, which is where it sits while
 * the owner is reading the list. Focus lands ON the control rather than inside it, so this needs
 * no ancestor walk, with the one exception of `contenteditable`, which every descendant inherits.
 */
export function keystrokeBelongsToLedger(el: FocusedElement | null): boolean {
  if (!el) return true;
  if (el.isContentEditable) return false;
  if (CONTROL_TAGS.has(el.tagName.toUpperCase())) return false;
  if (el.role !== null && CONTROL_ROLES.has(el.role.trim().toLowerCase())) return false;
  // A deliberate tabindex is the author saying "this is operable". `document.body` and every plain
  // element report -1, which is how "nothing is focused" reaches here.
  return el.tabIndex < 0;
}

export function readFocusedElement(target: EventTarget | null): FocusedElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return {
    tagName: target.tagName,
    role: target.getAttribute('role'),
    tabIndex: target.tabIndex,
    isContentEditable: target.isContentEditable,
  };
}

// ─── What a row is handed ─────────────────────────────────────────────────────

/** Everything a ledger row can ask the screen to do. One object, so it can be one prop. */
export interface LedgerRowHandlers {
  toggleSelect: (transactionId: string) => void;
  open: (transaction: Transaction) => void;
  accept: (draft: AdvisorDraftAction) => void;
  override: (draft: AdvisorDraftAction, categoryId: string) => void;
  dismissDraft: (draftId: string) => void;
  keepCopy: (groupId: string, keepId: string) => void;
  keepBoth: (groupId: string) => void;
  confirmTransfer: (pairId: string) => void;
  rejectTransfer: (pairId: string) => void;
}

/**
 * The handlers as an object whose identity never changes, reading through to the current ones.
 *
 * react-query 5 returns `{ ...result, mutate }` from `useMutation`, a fresh object literal on
 * every render (node_modules/@tanstack/react-query/src/useMutation.ts). Six of the row's props
 * were `useCallback`s built on those objects, so all six changed identity every render and the
 * row's `memo` comparison could never hold. Collapsing them into one object created once fixes
 * that at the identity level rather than by hoping a dependency array happens to be stable.
 *
 * Reading through a ref rather than capturing is what stops the trade: `override` needs the
 * category list, which arrives after the first render, and a captured copy would apply the model's
 * original proposal instead of the owner's pick.
 */
export function createLedgerRowActions(latest: { current: LedgerRowHandlers }): LedgerRowHandlers {
  return {
    toggleSelect: (transactionId) => latest.current.toggleSelect(transactionId),
    open: (transaction) => latest.current.open(transaction),
    accept: (draft) => latest.current.accept(draft),
    override: (draft, categoryId) => latest.current.override(draft, categoryId),
    dismissDraft: (draftId) => latest.current.dismissDraft(draftId),
    keepCopy: (groupId, keepId) => latest.current.keepCopy(groupId, keepId),
    keepBoth: (groupId) => latest.current.keepBoth(groupId),
    confirmTransfer: (pairId) => latest.current.confirmTransfer(pairId),
    rejectTransfer: (pairId) => latest.current.rejectTransfer(pairId),
  };
}

export interface LedgerRowProps {
  transaction: Transaction;
  selected: boolean;
  /** The model's open proposal about this row, if it has one. */
  draft: AdvisorDraftAction | null;
  /** True when the keyboard cursor is on this row, so `a` accepts this proposal and no other. */
  isCursor: boolean;
  categories: Category[];
  busy: boolean;
  /** Why the write guards refused this draft, shown in place rather than in a toast that expires. */
  refusal: string | null;
  /**
   * The open integrity questions, keyed by the id the row already carries.
   *
   * Passed as maps rather than as a per-row object so the comparison below stays a reference
   * check: a `{ groupId, count }` literal built in the parent's render would be a new object every
   * time and would defeat it on every row.
   */
  duplicateGroups: Map<string, DuplicateCandidateGroup>;
  transferPairs: Map<string, TransferCandidatePair>;
  actions: LedgerRowHandlers;
}

/**
 * The comparison `memo` makes, written out so a test can count how many rows a keystroke costs.
 *
 * This is exactly React's default shallow comparison. It is spelled out rather than left implicit
 * because "the memo holds" is the performance claim the long-ledger design rests on, and a claim
 * nothing can drive is a claim nobody can catch going false. `tests/ledgerRow.test.ts` runs it
 * over 2,588 prop sets, the whole live ledger (`SELECT COUNT(*) FROM transactions` -> 2588 on a
 * fresh copy at migration `053_drop_budget_groups.sql`, 2026-07-31), and asserts that moving the
 * cursor one row changes props on exactly two of them.
 */
export function sameLedgerRow(prev: LedgerRowProps, next: LedgerRowProps): boolean {
  const keys = Object.keys(next) as Array<keyof LedgerRowProps>;
  if (keys.length !== Object.keys(prev).length) return false;
  return keys.every((key) => Object.is(prev[key], next[key]));
}

// ─── Filters ──────────────────────────────────────────────────────────────────

/**
 * The review screen, as what it always was.
 *
 * Uncategorized rows, duplicate candidates and transfer candidates are predicates over the
 * transactions table, and each was built as a tab on a separate screen. Each is one filter here.
 * `suggested` is the one that cannot be written as a column predicate: liveness is decided in
 * TypeScript by `draftLiveness`, so the ids come from the review summary that already applied it,
 * and re-deriving the same rule in SQL would be the second source of truth this codebase keeps
 * getting burned by.
 */
export type LedgerFilter = 'all' | 'uncategorized' | 'suggested' | 'duplicates' | 'transfers';

export interface FilterChip {
  id: LedgerFilter;
  label: string;
  count: number | null;
}

export function filterChips(counts: {
  uncategorized: number;
  suggested: number;
  duplicates: number;
  transfers: number;
}): FilterChip[] {
  return [
    { id: 'all', label: 'Everything', count: null },
    { id: 'uncategorized', label: 'Needs a category', count: counts.uncategorized },
    { id: 'suggested', label: 'Model suggests', count: counts.suggested },
    { id: 'duplicates', label: 'Possible duplicates', count: counts.duplicates },
    { id: 'transfers', label: 'Possible transfers', count: counts.transfers },
  ];
}

/**
 * The maximum number of ids one `suggested` request may name.
 *
 * `GET /api/transactions` takes ids as repeated query params, and the server refuses more than
 * this. It is a real ceiling rather than a formality, so the view states when it has been reached
 * instead of quietly showing a prefix of the queue.
 */
export const MAX_SUGGESTED_IDS = 200;
