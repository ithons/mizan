import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RecurringForecastOccurrence, Transaction } from '../shared/types';
import { createLedgerRowActions, type LedgerRowProps } from '../client/src/views/ledger/spine';
import {
  LEDGER_AMOUNT_TYPE,
  LEDGER_COLUMNS,
  LedgerColumnHeader,
  LedgerRowInner,
  ScheduledRow,
} from '../client/src/views/ledger/rows';

/**
 * "A scheduled item and a posted entry get the same columns and the same alignment."
 *
 * That sentence is the entire argument for merging the forecast into the ledger, and it was false
 * in the shipped markup in two ways. The scheduled row carried a trailing `ml-3 w-[52px]`
 * Skip/Undo column the posted row did not, so the amount column's right edge sat 64px further left
 * above the rule than below it. And the fixed 130px column held the ACCOUNT below the rule and the
 * CATEGORY above it, two different facts in one column, with no header on either half.
 *
 * These tests walk the element tree each row actually returns, so the claim is checked against the
 * markup rather than against a constant that the markup may or may not be using. Both row
 * functions and the header are plain functions of their props, so they can be called directly with
 * no renderer.
 */

const COLUMN_ORDER = ['select', 'entry', 'category', 'amount', 'action'];

interface Column {
  col: string;
  className: string;
}

/** Every `data-col` element in render order, wherever it sits in the returned tree. */
function columnsOf(node: unknown, found: Column[] = []): Column[] {
  if (Array.isArray(node)) {
    for (const child of node) columnsOf(child, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (!props) return found;
  const col = props['data-col'];
  if (typeof col === 'string') found.push({ col, className: String(props.className ?? '') });
  columnsOf(props.children, found);
  return found;
}

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    account_id: 'a1',
    account_name: 'Chase Checking',
    date: '2026-07-20',
    amount: -4211,
    original_name: 'BLUE BOTTLE',
    merchant_name: 'Blue Bottle',
    category_name: 'Coffee',
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

function postedProps(overrides: Partial<LedgerRowProps> = {}): LedgerRowProps {
  return {
    transaction: txn(),
    selected: false,
    draft: null,
    isCursor: false,
    categories: [],
    busy: false,
    refusal: null,
    duplicateGroups: new Map(),
    transferPairs: new Map(),
    actions: createLedgerRowActions({
      current: {
        toggleSelect: () => {},
        open: () => {},
        accept: () => {},
        override: () => {},
        dismissDraft: () => {},
        keepCopy: () => {},
        keepBoth: () => {},
        confirmTransfer: () => {},
        rejectTransfer: () => {},
        setAside: () => {},
        bringBack: () => {},
      },
    }),
    ...overrides,
  };
}

function occurrence(overrides: Partial<RecurringForecastOccurrence> = {}): RecurringForecastOccurrence {
  return {
    id: 'o1',
    pattern_id: 'p1',
    merchant_name: 'spotify',
    category_name: 'Streaming',
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

const scheduledProps = {
  busy: false,
  onSkip: () => {},
  onUndoSkip: () => {},
  onConfirmPattern: () => {},
  onDismissPattern: () => {},
};

test('both sides of the rule emit the same five columns, in the same order', () => {
  const posted = columnsOf(LedgerRowInner(postedProps()));
  const scheduled = columnsOf(ScheduledRow({ occurrence: occurrence(), ...scheduledProps }));
  const header = columnsOf(LedgerColumnHeader());

  assert.deepEqual(posted.map((c) => c.col), COLUMN_ORDER);
  assert.deepEqual(scheduled.map((c) => c.col), COLUMN_ORDER);
  assert.deepEqual(header.map((c) => c.col), COLUMN_ORDER);
});

test('every column is the same width on both sides and in the header', () => {
  // The posted row used to stop after `amount`. A missing 52px column plus its 12px margin is the
  // 64px by which the two amount edges disagreed.
  const trees = {
    posted: columnsOf(LedgerRowInner(postedProps())),
    scheduled: columnsOf(ScheduledRow({ occurrence: occurrence(), ...scheduledProps })),
    header: columnsOf(LedgerColumnHeader()),
  };

  for (const [where, cols] of Object.entries(trees)) {
    for (const { col, className } of cols) {
      const expected = LEDGER_COLUMNS[col as keyof typeof LEDGER_COLUMNS];
      assert.ok(
        className.startsWith(expected),
        `${where}.${col} does not start from LEDGER_COLUMNS.${col}: ${className}`
      );
    }
  }
});

test('the two amount columns are set in the same face, size and figures', () => {
  // Same box is not the same alignment: tabular figures at a different size line up at the box
  // edge and nowhere else. Ink is the one thing allowed to differ, and it is the signal.
  const posted = columnsOf(LedgerRowInner(postedProps())).find((c) => c.col === 'amount');
  const scheduled = columnsOf(ScheduledRow({ occurrence: occurrence(), ...scheduledProps })).find(
    (c) => c.col === 'amount'
  );

  assert.ok(posted && scheduled);
  assert.ok(posted.className.includes(LEDGER_AMOUNT_TYPE));
  assert.ok(scheduled.className.includes(LEDGER_AMOUNT_TYPE));
  assert.ok(posted.className.includes('text-ink'));
  assert.ok(scheduled.className.includes('text-estimate'));
});

test('the 130px column carries the category on both sides, never the account', () => {
  // The account is not in this column because the scheduled half has none to put there: a
  // recurring pattern is a merchant and a cadence (`recurring_patterns` has no account_id), so
  // which account it lands in is unknown until it posts. Category is the field both halves have.
  const postedTree = LedgerRowInner(postedProps({ transaction: txn({ category_name: 'Coffee' }) }));
  const scheduledTree = ScheduledRow({ occurrence: occurrence({ category_name: 'Streaming' }), ...scheduledProps });

  const posted = columnsOf(postedTree).find((c) => c.col === 'category');
  const scheduled = columnsOf(scheduledTree).find((c) => c.col === 'category');
  assert.equal(posted?.className, LEDGER_COLUMNS.category);
  assert.equal(scheduled?.className, LEDGER_COLUMNS.category);

  // Both columns hold a CategoryPill, and the account did not silently vanish: it moved onto the
  // entry column's second line, where the scheduled row carries its cadence.
  assert.match(JSON.stringify(postedTree), /"name":"Coffee"/);
  assert.match(JSON.stringify(scheduledTree), /"name":"Streaming"/);
  assert.match(JSON.stringify(postedTree), /Chase Checking/);
});

test('a skipped scheduled item keeps its money legible', () => {
  // It used to be the whole row at opacity-50, which took the amount to 2.26:1 on light paper and
  // 2.86:1 on dark card, both below WCAG AA. Line-through plus `muted` reads 5.67:1 light paper,
  // 7.04:1 light card, 6.95:1 dark paper, 5.84:1 dark card, computed from the triplets in
  // client/src/index.css.
  const tree = ScheduledRow({
    occurrence: occurrence({ adjustment_action: 'skip', adjustment_id: 'adj1' }),
    ...scheduledProps,
  });
  const amount = columnsOf(tree).find((c) => c.col === 'amount');

  assert.ok(amount);
  assert.ok(amount.className.includes('text-muted'));
  assert.ok(amount.className.includes('line-through'));
  assert.equal(JSON.stringify(tree).includes('opacity-50'), false);
});
