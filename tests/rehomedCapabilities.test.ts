import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth } from 'date-fns';
import type {
  AdvisorDraftAction,
  MerchantRuleSuggestion,
  Transaction,
  TransactionReviewSummary,
} from '../shared/types';
import { Ledger } from '../client/src/views/Ledger';
import { RulesSection } from '../client/src/views/settings/RulesSection';
import { LedgerRowInner } from '../client/src/views/ledger/rows';
import {
  createLedgerRowActions,
  indexDrafts,
  isSetAside,
  readBatchControl,
  readBatchOutcomes,
  readFlags,
  MAX_BATCH_CONFIRM,
  type LedgerRowHandlers,
  type LedgerRowProps,
} from '../client/src/views/ledger/spine';

/**
 * Six capabilities the twelve-to-six consolidation dropped, and where each one landed.
 *
 * The consolidation deleted ten views and moved most of what they did onto the six that remain.
 * Six calls did not move: their fetchers stayed defined in `client/src/lib/api.ts` with no caller
 * anywhere in `client/src`, so the endpoint behind each one was live and unreachable. This file
 * exists because "we re-homed it" is exactly the kind of claim that compiles and does nothing:
 * the first three tests drive the logic the re-homed surfaces run on, and the last two walk the
 * shipped source and fail if a fetcher goes back to having no caller.
 *
 * The seventh, `aiApi.suggestCategories`, was deleted rather than re-homed and is asserted absent.
 */

const ROOT = join(import.meta.dirname, '..');
const API = readFileSync(join(ROOT, 'client/src/lib/api.ts'), 'utf8');

/** Every `.ts`/`.tsx` under client/src except the fetcher module itself, as one string per file. */
function clientSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && full !== join(ROOT, 'client/src/lib/api.ts')) {
        out.push({ path: full, text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(ROOT, 'client/src'));
  return out;
}

const SOURCES = clientSources();

function callersOf(call: string): string[] {
  return SOURCES.filter((f) => f.text.includes(call)).map((f) => f.path.slice(ROOT.length + 1));
}

// ─── The batch confirm, which is also how a guard refusal becomes readable ─────

test('a batch confirm reports both halves, and every skip lands on the draft it is about', () => {
  // The live shapes: an applied draft, a guard refusal carrying its own sentence, and the two
  // tokens `confirmAdvisorDraftsByIds` writes in place of prose.
  const reading = readBatchOutcomes([
    { id: 'd1', status: 'applied', label: 'Categorize AMZN as Shopping' },
    {
      id: 'd2',
      status: 'skipped',
      reason: 'A rule you wrote already files AMZN under Shopping.',
      label: 'Create a rule for AMZN',
    },
    { id: 'd3', status: 'skipped', reason: 'not_found_or_resolved' },
    { id: 'd4', status: 'skipped', reason: 'unreadable_payload' },
  ]);

  assert.equal(reading.applied, 1);
  assert.equal(reading.skipped, 3);
  // The guard's sentence reaches the row verbatim. This is the whole point of the re-home: before
  // it, `BatchConfirmOutcome` was declared in api.ts with zero consumers, so a refusal reason was
  // unreachable in the interface no matter what the guards wrote.
  assert.equal(reading.refusals.d2, 'A rule you wrote already files AMZN under Shopping.');
  // A token is not a sentence. Neither of these renders as an enum.
  assert.doesNotMatch(reading.refusals.d3, /not_found_or_resolved/);
  assert.doesNotMatch(reading.refusals.d4, /unreadable_payload/);
  assert.match(reading.refusals.d3, /already accepted or dropped/);
  // Both counts are said out loud; an applied-only message would report a partial apply as a whole.
  assert.match(reading.message ?? '', /Applied 1 suggestion/);
  assert.match(reading.message ?? '', /left 3 alone/);
});

test('a skip with no reason at all still gets a line', () => {
  // Silence about a draft the owner just asked to apply reads as success.
  const reading = readBatchOutcomes([{ id: 'd1', status: 'skipped' }]);
  assert.equal(reading.applied, 0);
  assert.ok(reading.refusals.d1.length > 0);
  assert.match(reading.message ?? '', /left 1 alone/);
});

test('an all-applied batch says so and marks no rows', () => {
  const reading = readBatchOutcomes([
    { id: 'd1', status: 'applied' },
    { id: 'd2', status: 'applied' },
  ]);
  assert.equal(reading.skipped, 0);
  assert.deepEqual(reading.refusals, {});
  assert.equal(reading.message, 'Applied 2 suggestions.');
});

test('an empty batch says nothing rather than announcing zero', () => {
  const reading = readBatchOutcomes([]);
  assert.equal(reading.message, null);
});

test('the batch has a stated ceiling', () => {
  // Every draft is applied in its own transaction inside one request, and nothing streams
  // progress, so the number sent at once is bounded and the screen says when it bound it.
  assert.equal(MAX_BATCH_CONFIRM, 50);
});

// ─── Setting a row aside ──────────────────────────────────────────────────────

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

test('a set-aside row is marked, because the list still holds it after the count drops it', () => {
  // `getCounts` (services/transactionReview.ts), the worker's pull (services/aiWorker.ts) and
  // `draftLiveness` (services/advisorDrafts.ts) all exclude review_status = 'dismissed'.
  // `listTransactions` does not: `filters.uncategorized` is `category_id IS NULL` and nothing
  // more. So the row stays on screen under a chip that has stopped counting it, and the only
  // thing that can make that readable is a mark on the row.
  assert.equal(isSetAside(txn({ review_status: 'dismissed' })), true);
  assert.equal(isSetAside(txn({ review_status: 'open' })), false);
  assert.equal(isSetAside(txn({ review_status: 'reviewed' })), false);
  assert.deepEqual(readFlags(txn({ review_status: 'dismissed' })), ['set_aside']);
  assert.deepEqual(readFlags(txn({ review_status: 'reviewed' })), []);
});

test('set aside stacks with the integrity flags rather than replacing them', () => {
  assert.deepEqual(
    readFlags(txn({ review_status: 'dismissed', duplicate_status: 'candidate', pending: true })),
    ['pending', 'duplicate', 'set_aside']
  );
});

// ─── The fetchers, and who calls them now ─────────────────────────────────────

/**
 * The six orphans, re-derived rather than trusted: each was defined in api.ts and called from
 * nowhere in client/src after the consolidation. Five were re-homed and one was deleted.
 */
const REHOMED: Array<{ call: string; landed: string }> = [
  { call: 'aiApi.confirmDrafts', landed: 'client/src/views/Ledger.tsx' },
  { call: 'transactionsApi.markReview', landed: 'client/src/views/Ledger.tsx' },
  { call: 'rulesApi.dismissSuggestion', landed: 'client/src/views/settings/RulesSection.tsx' },
  { call: 'rulesApi.approveSuggestions', landed: 'client/src/views/settings/RulesSection.tsx' },
  { call: 'reportsApi.trends', landed: 'client/src/views/Instrument.tsx' },
  { call: 'reportsApi.networthAttribution', landed: 'client/src/views/Instrument.tsx' },
];

test('every re-homed fetcher has a caller, and it is the screen the re-home claims', () => {
  for (const { call, landed } of REHOMED) {
    const method = call.split('.')[1];
    assert.ok(API.includes(`${method}:`), `${call} is no longer defined in api.ts`);
    const callers = callersOf(call);
    assert.ok(callers.length > 0, `${call} is defined and called from nowhere in client/src`);
    assert.ok(
      callers.includes(landed),
      `${call} is called from ${callers.join(', ')}, not from ${landed}`
    );
  }
});

test('the deleted fetcher is gone from the client entirely', () => {
  // `suggestCategories` returns a bare merchant -> category map with no draft behind it, so the
  // only way a screen could apply one is `bulkCategory`, and `bulkCategorizeTransactions` writes
  // `source: 'human', markManual: true` and upserts a human-source merchant rule per merchant.
  // Applying a model's guess through it would stamp the model's choice as the owner's.
  assert.doesNotMatch(API, /^\s*suggestCategories:/m, 'the fetcher is back in api.ts');
  assert.deepEqual(callersOf('aiApi.suggestCategories'), []);
});

test('no screen cites the retired review inbox as somewhere the owner can go', () => {
  // `aiWriteGuards.ts` used to say a refusal "reaches them through the ReviewInbox skip line",
  // and api.ts cited ReviewInbox as what reads a batch outcome. Both screens are gone; the
  // sentences that named them are corrected to name what actually renders the refusal now.
  const guards = readFileSync(join(ROOT, 'server/src/services/aiWriteGuards.ts'), 'utf8');
  assert.doesNotMatch(guards, /ReviewInbox/);
  assert.match(guards, /readBatchOutcomes/, 'the guard no longer names any surface that shows it');
  // api.ts may name it once, in the note recording that it is gone.
  const mentions = API.match(/ReviewInbox/g) ?? [];
  assert.equal(mentions.length, 0, 'api.ts still cites ReviewInbox as a live screen');
});

// ─── The row, rendered ────────────────────────────────────────────────────────

/** Every element in the returned tree, flattened, so a button can be found and fired. */
function nodes(node: unknown, found: Array<{ props: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return found;
  found.push({ props });
  nodes(props.children, found);
  return found;
}

function buttonLabelled(tree: unknown, label: string) {
  return nodes(tree).find((n) => n.props.children === label);
}

function rowProps(transaction: Transaction, log: string[]): LedgerRowProps {
  const handlers: LedgerRowHandlers = {
    toggleSelect: () => {},
    open: () => {},
    accept: () => {},
    override: () => {},
    dismissDraft: () => {},
    keepCopy: () => {},
    keepBoth: () => {},
    confirmTransfer: () => {},
    rejectTransfer: () => {},
    setAside: (id) => log.push(`setAside:${id}`),
    bringBack: (id) => log.push(`bringBack:${id}`),
  };
  return {
    transaction,
    selected: false,
    draft: null,
    isCursor: false,
    categories: [],
    busy: false,
    refusal: null,
    duplicateGroups: new Map(),
    transferPairs: new Map(),
    actions: createLedgerRowActions({ current: handlers }),
  };
}

test('an uncategorized row offers the exit, and firing it asks for the right transaction', () => {
  const log: string[] = [];
  const tree = LedgerRowInner(rowProps(txn({ id: 't_open' }), log));

  const button = buttonLabelled(tree, 'Set aside');
  assert.ok(button, 'no way out of the queue is rendered on an uncategorized row');
  (button.props.onClick as () => void)();
  assert.deepEqual(log, ['setAside:t_open']);
});

test('a set-aside row offers the way back, so the door is not one-way', () => {
  const log: string[] = [];
  const tree = LedgerRowInner(rowProps(txn({ id: 't_dis', review_status: 'dismissed' }), log));

  assert.equal(buttonLabelled(tree, 'Set aside'), undefined, 'an already set-aside row offers it twice');
  const undo = buttonLabelled(tree, 'Undo');
  assert.ok(undo, 'a set-aside row cannot be brought back');
  (undo.props.onClick as () => void)();
  assert.deepEqual(log, ['bringBack:t_dis']);

  // And it says what it is, in the neutral outline rather than the open-question tint: the row is
  // still on the list under a chip that has stopped counting it.
  const mark = nodes(tree).find((n) => n.props.children === 'set aside');
  assert.ok(mark, 'a set-aside row is indistinguishable from one still waiting');
  assert.match(String(mark.props.className), /border-line-3 text-muted/);
  assert.doesNotMatch(String(mark.props.className), /bg-review-bg/);
});

test('a filed row is offered no exit, because the queue was never counting it', () => {
  const tree = LedgerRowInner(rowProps(txn({ category_id: 'c_food', category_name: 'Food' }), []));
  assert.equal(buttonLabelled(tree, 'Set aside'), undefined);
});

test('a pending row is offered no exit either', () => {
  // `getCounts` files a pending row under its own queue, not under uncategorized, so setting one
  // aside would take it off a list it is not on.
  const tree = LedgerRowInner(rowProps(txn({ pending: true }), []));
  assert.equal(buttonLabelled(tree, 'Set aside'), undefined);
});

// ─── The rules screen, rendered ───────────────────────────────────────────────

test('a rule suggestion can be refused as well as accepted, and the batch is offered', () => {
  // The one-way door: `suggestMerchantRules` recomputes its list on every call, so before this the
  // only way to make a suggestion stop appearing was to accept it.
  const suggestions: MerchantRuleSuggestion[] = [
    {
      pattern: 'AMZN MKTP',
      category_id: 'c_shop',
      category_name: 'Shopping',
      categorized_count: 12,
      uncategorized_count: 3,
      confidence: 0.92,
      affected_transaction_ids: ['t1', 't2', 't3'],
      preview_transactions: [],
      reason: '12 of 15 AMZN MKTP entries are already filed under Shopping.',
    },
    {
      pattern: 'LYFT',
      category_id: 'c_ride',
      category_name: 'Rideshare',
      categorized_count: 9,
      uncategorized_count: 1,
      confidence: 0.88,
      affected_transaction_ids: ['t4'],
      preview_transactions: [],
      reason: '9 of 10 LYFT entries are already filed under Rideshare.',
    },
  ];

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(['rules'], []);
  client.setQueryData(['rules', 'suggestions'], suggestions);
  client.setQueryData(['categories'], []);

  const body = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(RulesSection))
    )
  );

  assert.match(body, /Accept<\/button>/, 'the accept half of the door is gone');
  assert.match(body, /Not a rule<\/button>/, 'a suggestion can still only be said yes to');
  // Two suggestions, so the batch is worth offering and names the count it would apply.
  assert.match(body, /Accept all 2/);
});

test('one suggestion is not a batch', () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(['rules'], []);
  client.setQueryData(['categories'], []);
  client.setQueryData(['rules', 'suggestions'], [
    {
      pattern: 'LYFT',
      category_id: 'c_ride',
      category_name: 'Rideshare',
      categorized_count: 9,
      uncategorized_count: 1,
      confidence: 0.88,
      affected_transaction_ids: ['t4'],
      preview_transactions: [],
      reason: 'nine of ten',
    },
  ] satisfies MerchantRuleSuggestion[]);

  const body = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(RulesSection))
    )
  );
  assert.doesNotMatch(body, /Accept all/);
  // The single-suggestion refusal is still there: the door swings both ways at any size.
  assert.match(body, /Not a rule<\/button>/);
});

// ─── The ledger, mounted ──────────────────────────────────────────────────────

/**
 * The screen itself, with the row that has nowhere else to go.
 *
 * Rendered under the default chip ("Everything"), which is what a server render sees: the deep
 * link that turns a chip on runs in an effect and effects do not run here. That makes this test
 * the gating one. The batch control is deliberately absent under "Everything", where the model's
 * proposals are scattered through a month of entries and "accept all 14" would name a set the
 * owner cannot see; `readBatchOutcomes` above drives what it does once it is pressed.
 */
function renderLedger(transactions: Transaction[], drafts: AdvisorDraftAction[] = []): string {
  const now = new Date();
  const filters = {
    startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
    endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
    search: undefined,
    accountId: undefined,
    categoryId: undefined,
    categorySource: undefined,
    limit: 100,
  };
  const review: TransactionReviewSummary = {
    total_open: transactions.length,
    // No `route`: the destination of a queue is the client's, not the server's. `QUEUE_DESTINATIONS`
    // in views/Instrument.tsx is keyed exhaustively on TransactionReviewQueueId, so a new queue with
    // nowhere to go is a compile error there rather than a dead row here. These four fields are what
    // getTransactionReviewSummary actually publishes for this queue.
    queues: [{
      id: 'uncategorized',
      label: 'Needs a category',
      count: 1,
      action_label: 'Review',
      severity: 'attention',
    }],
    rule_suggestions: [],
    recurring_candidates: [],
    duplicate_candidates: [],
    transfer_candidates: [],
    ai_drafts: drafts,
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(['transactions', 'review'], review);
  client.setQueryData(['recurring', 'forecast', 30], { days: 30, occurrences: [] });
  client.setQueryData(['recurring'], []);
  client.setQueryData(['accounts'], []);
  client.setQueryData(['categories'], []);
  client.setQueryData(['transactions', filters], {
    pages: [{ data: transactions, total: transactions.length, page: 1, limit: 100 }],
    pageParams: [1],
  });

  const realError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return;
    realError(...args);
  };
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, { initialEntries: ['/ledger'] }, createElement(Ledger))
      )
    );
  } finally {
    console.error = realError;
  }
}

test('the ledger mounts with the queue exit on the row and no batch control under Everything', () => {
  const body = renderLedger([txn({ id: 't_open', merchant_name: 'CASH DEPOSIT' })]);

  assert.match(body, /CASH DEPOSIT/, 'the seeded entry did not render');
  assert.match(body, /Set aside<\/button>/, 'the queue exit is not reachable on the screen');
  assert.doesNotMatch(body, /Accept all/, 'the batch control is offered where the set is not visible');
});

test('a set-aside entry renders its mark and its way back on the real screen', () => {
  const body = renderLedger([txn({ id: 't_dis', merchant_name: 'CASH DEPOSIT', review_status: 'dismissed' })]);

  assert.match(body, /set aside/);
  assert.match(body, /Undo<\/button>/);
  assert.doesNotMatch(body, /Set aside<\/button>/);
});

// ─── Which drafts "accept all" would send ─────────────────────────────────────

function categorizeDraft(id: string, transactionId: string): AdvisorDraftAction {
  return {
    id,
    kind: 'categorize_transaction',
    label: `Categorize ${transactionId}`,
    summary: 'proposal',
    payload: { kind: 'categorize_transaction', transaction_id: transactionId, category_id: 'c_food' },
    changes: [],
    citations: [],
    confirmation_required: true,
  } as unknown as AdvisorDraftAction;
}

test('accept all is offered only under the chip whose list IS the batch', () => {
  const drafts = indexDrafts([categorizeDraft('d1', 't1'), categorizeDraft('d2', 't2')]);
  const onScreen = ['t1', 't2'];

  for (const filter of ['all', 'uncategorized', 'duplicates', 'transfers'] as const) {
    assert.equal(
      readBatchControl(filter, onScreen, drafts),
      null,
      `${filter} offers a batch over a list that is not the batch`
    );
  }
  assert.deepEqual(readBatchControl('suggested', onScreen, drafts), { ids: ['d1', 'd2'], truncated: false });
});

test('accept all sends the drafts on screen, in the order the list is in, and nothing else', () => {
  // 't3' has an open proposal that has not been rendered yet: the list is paged. It must not be in
  // a batch the owner triggered by looking at the first page.
  const drafts = indexDrafts([
    categorizeDraft('d1', 't1'),
    categorizeDraft('d2', 't2'),
    categorizeDraft('d3', 't3'),
  ]);
  const control = readBatchControl('suggested', ['t2', 't1'], drafts);
  assert.deepEqual(control, { ids: ['d2', 'd1'], truncated: false });
});

test('one proposal is not a batch, and zero is not either', () => {
  const drafts = indexDrafts([categorizeDraft('d1', 't1')]);
  assert.equal(readBatchControl('suggested', ['t1'], drafts), null);
  assert.equal(readBatchControl('suggested', [], drafts), null);
});

test('a queue past the ceiling is capped and says so rather than sending a prefix in silence', () => {
  const many = Array.from({ length: MAX_BATCH_CONFIRM + 7 }, (_, i) => categorizeDraft(`d${i}`, `t${i}`));
  const control = readBatchControl(
    'suggested',
    many.map((_, i) => `t${i}`),
    indexDrafts(many)
  );
  assert.ok(control);
  assert.equal(control.ids.length, MAX_BATCH_CONFIRM);
  assert.equal(control.truncated, true);
});
