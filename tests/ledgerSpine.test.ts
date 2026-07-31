import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AdvisorDraftAction,
  Category,
  RecurringForecast,
  RecurringForecastOccurrence,
  RecurringPattern,
  Transaction,
} from '../shared/types';
import { readState } from '../client/src/components/balance/Figure';
import {
  MAX_SUGGESTED_IDS,
  SCHEDULE_STATES,
  buildSpine,
  createLedgerRowActions,
  filterChips,
  indexDrafts,
  keystrokeBelongsToLedger,
  monthlyAmount,
  occurrenceAmount,
  occurrenceDate,
  readDirection,
  readFlags,
  readProvenance,
  readSchedule,
  withCategoryOverride,
  type FocusedElement,
  type LedgerRowHandlers,
} from '../client/src/views/ledger/spine';

/**
 * The ledger's claims, driven directly.
 *
 * Every assertion here is about something the screen SAYS: who set a category, whether a positive
 * amount is income or money coming back, which side of today's rule an entry falls on, and which
 * of the model's proposals the row under the cursor is about.
 */

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    account_id: 'a1',
    date: '2026-07-20',
    amount: -1000,
    original_name: 'TEST',
    pending: false,
    is_manual: false,
    source_type: 'simplefin',
    duplicate_status: 'none',
    transfer_status: 'none',
    review_status: 'open',
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function occurrence(overrides: Partial<RecurringForecastOccurrence> = {}): RecurringForecastOccurrence {
  return {
    id: 'o1',
    pattern_id: 'p1',
    merchant_name: 'spotify',
    frequency: 'monthly',
    expected_date: '2026-08-03',
    amount: -699,
    is_income: false,
    is_confirmed: true,
    confidence: 1,
    confidence_label: 'confirmed',
    status: 'upcoming',
    days_until: 3,
    needs_review: false,
    ...overrides,
  };
}

// ─── Provenance ───────────────────────────────────────────────────────────────

test('provenance: every recorded author gets a word, and an unrecorded one gets nothing', () => {
  assert.equal(readProvenance(txn({ category_source: 'human' })), 'you');
  assert.equal(readProvenance(txn({ category_source: 'ai' })), 'model');
  assert.equal(readProvenance(txn({ category_source: 'rule' })), 'rule');
  assert.equal(readProvenance(txn({ category_source: 'heuristic' })), 'match');

  // The majority case on the real ledger. Migration 041 records NULL as "set before provenance was
  // tracked", so the row says nothing rather than claiming nobody chose it. Re-measured on a fresh
  // copy of .mizan/mizan.db, latest applied migration 053_drop_budget_groups.sql, on 2026-07-31:
  //   SELECT COALESCE(category_source,'NULL'), COUNT(*) FROM transactions GROUP BY 1;
  //   -> NULL 2412 | ai 88 | human 62 | rule 13 | heuristic 13, over 2,588 rows.
  assert.equal(readProvenance(txn({ category_source: null })), null);
  assert.equal(readProvenance(txn()), null);
});

test('provenance: a hand edit is read from either marker, never from one alone', () => {
  // `draftLiveness` reads both because neither is reliable alone. The screen must agree with the
  // server about who owns a row, or the owner sees "model" on something they set themselves.
  assert.equal(readProvenance(txn({ manually_categorized: true, category_source: null })), 'you');
  assert.equal(readProvenance(txn({ manually_categorized: true, category_source: 'ai' })), 'you');
  assert.equal(readProvenance(txn({ manually_categorized: false, category_source: 'human' })), 'you');
});

// ─── Direction ────────────────────────────────────────────────────────────────

test('direction: a positive row in a non-income category is a credit, not income', () => {
  // Deliberately NOT called a refund. Re-measured over July 2026 on a fresh copy of
  // .mizan/mizan.db at migration 053_drop_budget_groups.sql, 2026-07-31:
  //   SELECT COALESCE(t.merchant_name, t.original_name), t.amount / 100.0, c.name
  //     FROM transactions t JOIN categories c ON c.id = t.category_id
  //    WHERE t.date BETWEEN '2026-07-01' AND '2026-07-31' AND t.amount > 0 AND c.is_income = 0;
  // 11 rows. FIVE are filed under the category named Transfer In ($2,373.14, $1,000.00, $780.00,
  // $280.76, $200.00); a sixth is transfer-shaped under Credit Card Payment ($965.90); the other
  // FIVE are returns (Amazon $955.19, Amazon $759.36, REI $281.29, Amazon $57.38, Lyft $1.02).
  // Six movements and five returns, with no column separating them, so the mark says only what
  // the query established. The two amounts below are the largest of each group.
  assert.equal(readDirection(txn({ amount: 95519, category_id: 'cat_shopping', category_is_income: false })), 'credit');
  assert.equal(readDirection(txn({ amount: 237314, category_id: 'cat_xfer_in', category_is_income: false })), 'credit');
  // $544.18 is the July paycheck, four of them, the only merchant in that month whose positive
  // rows carry an income category.
  assert.equal(readDirection(txn({ amount: 54418, category_id: 'cat_income', category_is_income: true })), 'income');
  assert.equal(readDirection(txn({ amount: -4211, category_id: 'cat_groceries' })), 'spend');
});

test('direction: an uncategorized inflow is not called anything', () => {
  // With no category there is nothing to place it against, and guessing is the claim this rule
  // exists to stop. It must not fall through to `income`.
  assert.equal(readDirection(txn({ amount: 1000, category_id: null })), 'unplaced');
});

// ─── The spine ────────────────────────────────────────────────────────────────

test('spine: scheduled sits ahead of the rule and settled behind it, both newest first', () => {
  const spine = buildSpine(
    [txn({ id: 'a', date: '2026-07-29' }), txn({ id: 'b', date: '2026-07-31' }), txn({ id: 'c', date: '2026-07-29' })],
    [
      occurrence({ id: 'o-near', expected_date: '2026-08-02' }),
      occurrence({ id: 'o-far', expected_date: '2026-08-26' }),
    ],
    '2026-07-31'
  );

  assert.deepEqual(spine.scheduled.map((d) => d.date), ['2026-08-26', '2026-08-02']);
  assert.deepEqual(spine.settled.map((d) => d.date), ['2026-07-31', '2026-07-29']);
  // Reading down the spine is reading backwards in time, so the NEAREST scheduled item is the last
  // thing above the rule and today's postings are the first thing below it.
  assert.equal(spine.scheduled.at(-1)?.date, '2026-08-02');
  assert.equal(spine.settled[0].date, '2026-07-31');
  assert.equal(spine.settled[1].entries.length, 2);
});

test('spine: an item still expected today has not happened yet', () => {
  const spine = buildSpine([], [occurrence({ expected_date: '2026-07-31' })], '2026-07-31');
  assert.equal(spine.scheduled.length, 1);
  assert.equal(spine.overdue.length, 0);
});

test('spine: an overdue occurrence is pulled out rather than filed under a past date', () => {
  // A past-dated thing that has not happened breaks the spine's monotone order by construction.
  // Filing it under its date would put it below the rule, where every other row has occurred.
  const spine = buildSpine(
    [txn({ date: '2026-07-25' })],
    [occurrence({ id: 'late', expected_date: '2026-07-20', status: 'overdue' })],
    '2026-07-31'
  );
  assert.equal(spine.scheduled.length, 0);
  assert.deepEqual(spine.overdue.map((o) => o.id), ['late']);
  assert.deepEqual(spine.settled.map((d) => d.date), ['2026-07-25']);
});

test('spine: an adjusted date moves the occurrence, and an adjusted amount travels with it', () => {
  const moved = occurrence({ expected_date: '2026-07-20', adjusted_date: '2026-08-05', adjusted_amount: -800 });
  assert.equal(occurrenceDate(moved), '2026-08-05');
  assert.equal(occurrenceAmount(moved), -800);
  const spine = buildSpine([], [moved], '2026-07-31');
  assert.equal(spine.overdue.length, 0);
  assert.equal(spine.scheduled[0].date, '2026-08-05');
});

test('spine: the two halves never merge into one array', () => {
  // A forecast occurrence and a posted transaction are different kinds of fact. Keeping them in
  // separate lists is what stops a later sort from shuffling them together.
  const spine = buildSpine([txn({ date: '2026-08-02' })], [occurrence({ expected_date: '2026-08-02' })], '2026-07-31');
  assert.equal(spine.scheduled.length, 1);
  assert.equal(spine.settled.length, 1);
  assert.equal(spine.scheduled[0].entries.length, 1);
  assert.equal(spine.settled[0].entries.length, 1);
});

// ─── Drafts on their rows ─────────────────────────────────────────────────────

function draft(id: string, transactionId: string, categoryId = 'cat_food'): AdvisorDraftAction {
  return {
    id,
    kind: 'categorize_transaction',
    label: `Categorize X as Y`,
    summary: 'because',
    route: '/ledger',
    payload: { kind: 'categorize_transaction', transaction_id: transactionId, category_id: categoryId },
    changes: [{ field: 'Category', before: null, after: 'Y' }],
    citations: [],
    confirmation_required: true,
  };
}

test('drafts: a proposal about a row is keyed by that row', () => {
  const index = indexDrafts([draft('d1', 't1'), draft('d2', 't2')]);
  assert.equal(index.byTransaction.get('t1')?.id, 'd1');
  assert.deepEqual(index.transactionIds, ['t1', 't2']);
  assert.equal(index.otherDrafts.length, 0);
});

test('drafts: a proposal about something that is not a row is kept, not dropped', () => {
  // The queue that hid what it could not place was built once and reverted, because a suggestion
  // the owner cannot see is worse than one that refuses when clicked.
  const goal: AdvisorDraftAction = {
    id: 'd9',
    kind: 'update_goal_target',
    label: 'Raise the emergency fund target',
    summary: 'because',
    route: '/goals',
    payload: { kind: 'update_goal_target', goal_id: 'g1', target_amount: 500000 },
    changes: [],
    citations: [],
    confirmation_required: true,
  };
  const index = indexDrafts([draft('d1', 't1'), goal]);
  assert.deepEqual(index.otherDrafts.map((d) => d.id), ['d9']);
  assert.equal(index.transactionIds.length, 1);
});

test('drafts: two proposals about one row do not silently replace each other', () => {
  // The accept key sends the draft the row is rendering. If a later draft overwrote the map entry
  // the row would show one proposal and apply another.
  const index = indexDrafts([draft('first', 't1', 'cat_a'), draft('second', 't1', 'cat_b')]);
  assert.equal(index.byTransaction.get('t1')?.id, 'first');
  assert.deepEqual(index.transactionIds, ['t1']);
});

test('override: picking a different category rewrites the payload AND the audit trail', () => {
  const categories: Category[] = [
    { id: 'cat_food', name: 'Food', is_income: false } as Category,
    { id: 'cat_travel', name: 'Travel', is_income: false } as Category,
  ];
  const original = { ...draft('d1', 't1', 'cat_food'), label: 'Categorize AG TRAVEL PLAZA as Food' };
  const overridden = withCategoryOverride(original, 'cat_travel', categories);

  assert.equal(overridden.payload.kind, 'categorize_transaction');
  assert.equal(
    overridden.payload.kind === 'categorize_transaction' ? overridden.payload.category_id : null,
    'cat_travel'
  );
  assert.equal(overridden.label, 'Categorize AG TRAVEL PLAZA as Travel');
  assert.equal(overridden.changes[0].after, 'Travel');
  assert.match(overridden.summary, /you chose Travel/);
});

test('override: choosing the category already proposed changes nothing', () => {
  const original = draft('d1', 't1', 'cat_food');
  assert.equal(withCategoryOverride(original, 'cat_food', []), original);
});

// ─── Flags ────────────────────────────────────────────────────────────────────

test('flags: only open questions are marked, never settled ones', () => {
  assert.deepEqual(readFlags(txn({ duplicate_status: 'candidate' })), ['duplicate']);
  assert.deepEqual(readFlags(txn({ transfer_status: 'candidate' })), ['transfer']);
  assert.deepEqual(readFlags(txn({ pending: true })), ['pending']);
  // A confirmed transfer is settled work and still belongs in the ledger. Marking it would make
  // a finished decision look like an open one.
  assert.deepEqual(readFlags(txn({ transfer_status: 'confirmed' })), []);
  assert.deepEqual(readFlags(txn({ duplicate_status: 'dismissed' })), []);
});

// ─── The scheduled band ───────────────────────────────────────────────────────

function forecast(overrides: Partial<RecurringForecast> = {}): RecurringForecast {
  return {
    days: 30,
    income: 2176.72,
    bills: 64.04,
    net: 2112.68,
    confirmed_income: 2176.72,
    confirmed_bills: 64.04,
    likely_income: 0,
    likely_bills: 0,
    uncertain_income: 0,
    uncertain_bills: 0,
    overdue_count: 0,
    review_count: 0,
    occurrences: [
      occurrence({ id: 'o1', pattern_id: 'p_pay' }),
      occurrence({ id: 'o2', pattern_id: 'p_pay' }),
      occurrence({ id: 'o3', pattern_id: 'p_spotify' }),
    ],
    ...overrides,
  };
}

test('schedule: every figure comes off the forecast service, and patterns are counted once', () => {
  // Reproduces `buildRecurringForecast(db, 30)` re-run against a read-only copy of .mizan/mizan.db
  // at migration 053_drop_budget_groups.sql on 2026-07-31: 7 occurrences, income $2,176.72, bills
  // $64.04, net +$2,112.68, 0 overdue, produced by 4 distinct patterns (trupanion, spotify,
  // backblaze, mass inst payroll ppd).
  const reading = readSchedule(forecast(), []);
  assert.equal(reading.incoming, 2176.72);
  assert.equal(reading.outgoing, 64.04);
  assert.equal(reading.net, 2112.68);
  assert.equal(reading.patternCount, 2);
});

test('schedule: a signed net reads as two states, not as one number in red', () => {
  assert.equal(readState(2112.68, SCHEDULE_STATES), 'more scheduled in than out');
  assert.equal(readState(-500, SCHEDULE_STATES), 'more scheduled out than in');
  assert.equal(readState(0, SCHEDULE_STATES), 'scheduled in and out are equal');
});

test('schedule: no forecast yet reads as zero, and says so through the same states', () => {
  const reading = readSchedule(undefined, []);
  assert.equal(reading.net, 0);
  assert.equal(reading.patternCount, 0);
});

test('schedule: only outgoing patterns count toward the monthly bill total', () => {
  const pattern = (o: Partial<RecurringPattern>): RecurringPattern =>
    ({
      id: 'p',
      merchant_name: 'x',
      average_amount: 30,
      frequency: 'monthly',
      is_active: true,
      is_confirmed: true,
      transaction_count: 4,
      ...o,
    }) as RecurringPattern;

  const reading = readSchedule(undefined, [
    pattern({ id: 'bill', average_amount: 39.02, average_signed_amount: -39.02 }),
    pattern({ id: 'pay', average_amount: 544.18, average_signed_amount: 544.18 }),
    pattern({ id: 'stopped', average_amount: 100, average_signed_amount: -100, is_active: false }),
  ]);
  assert.equal(reading.monthlyBillTotal, 39.02);
});

test('schedule: frequency is converted to a monthly figure, not restated', () => {
  const weekly = { average_amount: 10, frequency: 'weekly', is_active: true } as RecurringPattern;
  assert.ok(Math.abs(monthlyAmount(weekly) - 43.3333) < 0.001);
});

// ─── Filters ──────────────────────────────────────────────────────────────────

test('filters: every retired review tab is one chip, with its own count', () => {
  const chips = filterChips({ uncategorized: 0, suggested: 7, duplicates: 0, transfers: 0 });
  assert.deepEqual(chips.map((c) => c.id), ['all', 'uncategorized', 'suggested', 'duplicates', 'transfers']);
  // "Everything" carries no count on purpose: the header already prints the row total for the
  // active filter, and a second total beside it would be a second number to keep true.
  assert.equal(chips[0].count, null);
  assert.equal(chips[2].count, 7);
});

// ─── Cost ─────────────────────────────────────────────────────────────────────

test('the whole live ledger builds its spine in one pass', () => {
  // The full row count on a fresh copy of .mizan/mizan.db at migration 053_drop_budget_groups.sql
  // on 2026-07-31:
  //   SELECT COUNT(*) FROM transactions;  -> 2588
  // Reachable in one view with the range set to "all time" and every page loaded.
  const rows: Transaction[] = [];
  for (let i = 0; i < 2588; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String(((i / 28) | 0) % 12 + 1).padStart(2, '0');
    rows.push(txn({ id: `t${i}`, date: `2026-${month}-${day}` }));
  }

  const started = performance.now();
  const spine = buildSpine(rows, [], '2026-07-31');
  const elapsed = performance.now() - started;

  assert.equal(spine.settled.reduce((n, d) => n + d.entries.length, 0), 2588);
  // Median 1.95ms, max 2.32ms over 20 warm runs of exactly this input, re-measured 2026-07-31.
  // The bound below is two orders of magnitude looser: it is here to catch a rewrite that makes
  // the grouping quadratic, not to police a millisecond on someone else's machine.
  assert.ok(elapsed < 250, `buildSpine over 2,588 rows took ${elapsed.toFixed(1)}ms`);
});

// ─── Whose keystroke it is ────────────────────────────────────────────────────

function focused(o: Partial<FocusedElement> = {}): FocusedElement {
  return { tagName: 'DIV', role: null, tabIndex: -1, isContentEditable: false, ...o };
}

test('keys: the ledger only claims a keystroke when nothing is focused', () => {
  // How focus reads while the owner is reading the list. `document.body` and every plain element
  // report tabIndex -1, and a keydown that reaches `window` from a page with nothing focused has
  // the body as its target.
  assert.equal(keystrokeBelongsToLedger(null), true);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'BODY' })), true);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'DIV' })), true);
});

test('keys: a focused Select does NOT hand `a` to the ledger', () => {
  // The defect this replaces. `components/balance/Select` renders <button role="combobox">, whose
  // tagName is BUTTON, so the old ['INPUT','TEXTAREA','SELECT'] allowlist let the key through:
  // focusing the account filter or the range control and pressing `a` confirmed the AI draft under
  // the cursor and wrote it to the database, and `x` dismissed it.
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'BUTTON', role: 'combobox', tabIndex: 0 })), false);
});

test('keys: every other control on this screen keeps its own keystrokes too', () => {
  // Filter chips, Skip/Undo, the row select circles, and the row's own Accept and Dismiss buttons.
  // `x` pressed twice used to dismiss a second draft because the first press left focus on the
  // Dismiss button and the second still reached the window listener.
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'BUTTON', tabIndex: 0 })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'INPUT', tabIndex: 0 })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'TEXTAREA', tabIndex: 0 })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'SELECT', tabIndex: 0 })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'A', tabIndex: 0 })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'SUMMARY', tabIndex: 0 })), false);
  // A widget that is a control by role alone, and one that is a control by tabindex alone.
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'DIV', role: 'textbox' })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'DIV', role: 'option' })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'DIV', tabIndex: 0 })), false);
  // Case and stray whitespace in an attribute must not open the hole again.
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'button' })), false);
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'DIV', role: ' ComboBox ' })), false);
  // contenteditable is inherited, so a descendant of an editor reports it too.
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'SPAN', isContentEditable: true })), false);
});

test('keys: a container the page merely scrolls does not count as a control', () => {
  // tabindex="-1" is "focusable by script, not by the owner". Treating it as a control would make
  // the shortcuts inert after any programmatic focus, which is the opposite failure.
  assert.equal(keystrokeBelongsToLedger(focused({ tagName: 'DIV', tabIndex: -1 })), true);
});

// ─── The row's handlers ───────────────────────────────────────────────────────

function recordingHandlers(log: string[]): LedgerRowHandlers {
  return {
    toggleSelect: (id) => log.push(`toggleSelect:${id}`),
    open: (t) => log.push(`open:${t.id}`),
    accept: (d) => log.push(`accept:${d.id}`),
    override: (d, c) => log.push(`override:${d.id}:${c}`),
    dismissDraft: (id) => log.push(`dismissDraft:${id}`),
    keepCopy: (g, k) => log.push(`keepCopy:${g}:${k}`),
    keepBoth: (g) => log.push(`keepBoth:${g}`),
    confirmTransfer: (p) => log.push(`confirmTransfer:${p}`),
    rejectTransfer: (p) => log.push(`rejectTransfer:${p}`),
  };
}

test('actions: the object a row holds never changes, and never goes stale', () => {
  // The identity is the whole point: react-query 5 returns a fresh `{ ...result, mutate }` from
  // every `useMutation` call, so handlers built per render defeated the row's memo on every row.
  // Reading through the ref is what keeps that from costing correctness: `override` needs the
  // category list, which arrives after the first render.
  const first: string[] = [];
  const latest = { current: recordingHandlers(first) };
  const actions = createLedgerRowActions(latest);

  actions.accept({ id: 'd1' } as AdvisorDraftAction);
  assert.deepEqual(first, ['accept:d1']);

  const second: string[] = [];
  latest.current = recordingHandlers(second);
  actions.accept({ id: 'd2' } as AdvisorDraftAction);
  actions.override({ id: 'd3' } as AdvisorDraftAction, 'cat_travel');
  actions.dismissDraft('d4');
  actions.toggleSelect('t1');
  actions.keepCopy('g1', 't2');
  actions.keepBoth('g2');
  actions.confirmTransfer('p1');
  actions.rejectTransfer('p2');

  // Nothing more reached the first set: every call went to whatever the ref held at call time.
  assert.deepEqual(first, ['accept:d1']);
  assert.deepEqual(second, [
    'accept:d2',
    'override:d3:cat_travel',
    'dismissDraft:d4',
    'toggleSelect:t1',
    'keepCopy:g1:t2',
    'keepBoth:g2',
    'confirmTransfer:p1',
    'rejectTransfer:p2',
  ]);
});

test('the id filter has a stated ceiling rather than a silent one', () => {
  // The server refuses more than this many ids. The view slices to it and says that it did, so a
  // long queue is never shown as a short one.
  assert.equal(MAX_SUGGESTED_IDS, 200);
});
