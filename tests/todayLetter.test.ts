import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLetter, partOfDay, type LetterInput, type LetterParagraph } from '../client/src/lib/letter';

const AFTERNOON = new Date('2026-07-27T14:30:00');

/** Everything unknown. Each test turns on only the fields its sentence needs. */
const NOTHING: LetterInput = {
  now: AFTERNOON,
  netWorth: null,
  owed: null,
  weekDelta: null,
  reviewCount: null,
  overdueCount: 0,
  oldestOverdue: null,
  nextBill: null,
  safeToSpend: null,
  topGoal: null,
  recentAiCount: 0,
  measuredFrom: null,
};

const input = (over: Partial<LetterInput>): LetterInput => ({ ...NOTHING, ...over });
const ids = (ps: LetterParagraph[]): string[] => ps.map((p) => p.id);
const plain = (ps: LetterParagraph[], id: string): string =>
  ps.find((p) => p.id === id)?.tokens.map((t) => t.value).join('') ?? '';

test('partOfDay dates the note the way a person would', () => {
  assert.equal(partOfDay(new Date('2026-07-27T02:00:00')), 'tonight');
  assert.equal(partOfDay(new Date('2026-07-27T09:00:00')), 'this morning');
  assert.equal(partOfDay(new Date('2026-07-27T14:00:00')), 'this afternoon');
  assert.equal(partOfDay(new Date('2026-07-27T21:00:00')), 'tonight');
});

test('a full day reads as one letter, in order', () => {
  const paragraphs = buildLetter(
    input({
      netWorth: 41208.67,
      owed: 5281.45,
      weekDelta: 1842,
      reviewCount: 23,
      overdueCount: 2,
      oldestOverdue: { pattern_id: 'p_coned', merchant_name: 'Con Edison', expected_date: '2026-07-22', amount: -184.2 },
      nextBill: { pattern_id: 'p_trup', merchant_name: 'Trupanion', expected_date: '2026-08-02', amount: -39.02 },
      safeToSpend: 1204,
      topGoal: { name: 'Emergency fund', remaining_amount: 2800 },
      recentAiCount: 4,
      measuredFrom: '2026-03-03',
    })
  );

  assert.deepEqual(ids(paragraphs), [
    'standing',
    'review',
    'overdue',
    'next-bill',
    'spending',
    'advisor',
    'footnote',
  ]);
  assert.equal(
    plain(paragraphs, 'standing'),
    'You have $41,208.67 this afternoon, after $5,281.45 owed. That is $1,842 more than a week ago.'
  );
});

/**
 * The reason this module exists. A readout with no data shows "$0" and looks empty; a sentence
 * with no data sounds certain about a number nobody gave it.
 */
test('a figure that could not be loaded takes its whole sentence with it', () => {
  const paragraphs = buildLetter(input({ reviewCount: 3 }));
  assert.deepEqual(ids(paragraphs), ['review']);
  assert.ok(!plain(paragraphs, 'standing').includes('$0.00'));
});

test('nothing known at all is an invitation, not a blank page', () => {
  const paragraphs = buildLetter(NOTHING);
  assert.deepEqual(ids(paragraphs), ['invitation']);
  assert.ok(paragraphs[0].tokens.some((t) => t.kind === 'action' && t.to === '/onboarding'));
});

test('a footnote on its own is not a report about your money', () => {
  const paragraphs = buildLetter(input({ measuredFrom: '2026-03-03' }));
  assert.deepEqual(ids(paragraphs), ['invitation']);
});

test('owing nothing is stated, not omitted or rendered as $0.00 owed', () => {
  const paragraphs = buildLetter(input({ netWorth: 1200, owed: 0 }));
  assert.equal(plain(paragraphs, 'standing'), 'You have $1,200.00 this afternoon, and you owe nothing.');
});

test('a flat week is not reported as a rise of nothing', () => {
  const paragraphs = buildLetter(input({ netWorth: 1200, owed: 0, weekDelta: 0 }));
  assert.ok(plain(paragraphs, 'standing').endsWith('That is exactly where you were a week ago.'));
});

test('a fall in net worth is worded as a fall', () => {
  const paragraphs = buildLetter(input({ netWorth: 1200, owed: 0, weekDelta: -340 }));
  assert.ok(plain(paragraphs, 'standing').includes('$340 less than a week ago.'));
});

test('an empty review queue says so instead of counting to zero', () => {
  const paragraphs = buildLetter(input({ reviewCount: 0 }));
  assert.equal(plain(paragraphs, 'review'), 'Everything is categorized. Nothing is waiting on you.');
});

test('one uncategorized transaction is singular', () => {
  const paragraphs = buildLetter(input({ reviewCount: 1 }));
  assert.ok(plain(paragraphs, 'review').startsWith('1 transaction still has no category.'));
});

test('the review sentence offers a way to act on it', () => {
  const paragraphs = buildLetter(input({ reviewCount: 5 }));
  const link = paragraphs[0].tokens.find((t) => t.kind === 'action');
  assert.deepEqual(link, { kind: 'action', value: 'Sort them', to: '/review' });
});

test('a single overdue bill does not claim to be one of several', () => {
  const paragraphs = buildLetter(
    input({
      overdueCount: 1,
      oldestOverdue: { pattern_id: 'p_coned', merchant_name: 'Con Edison', expected_date: '2026-07-22', amount: -184.2 },
    })
  );
  assert.equal(plain(paragraphs, 'overdue'), 'Con Edison was due 22 July and has not come through: $184.20.');
});

/**
 * Real data hit this immediately: one bike-share pattern was both the oldest overdue occurrence
 * and the next upcoming one, so the letter named the same merchant in two consecutive sentences
 * and read as a stutter that hid the fact that it was one bill.
 */
test('the same series overdue and due again is one sentence, not two', () => {
  const paragraphs = buildLetter(
    input({
      overdueCount: 1,
      oldestOverdue: { pattern_id: 'p_bike', merchant_name: 'bluebik rides', expected_date: '2026-07-20', amount: -1.91 },
      nextBill: { pattern_id: 'p_bike', merchant_name: 'bluebik rides', expected_date: '2026-07-27', amount: -1.91 },
    })
  );

  assert.deepEqual(ids(paragraphs), ['overdue']);
  assert.equal(
    plain(paragraphs, 'overdue'),
    'Bluebik rides was due 20 July and has not come through: $1.91. It is due again Monday 27 July.'
  );
});

test('a different series still gets its own next-bill sentence', () => {
  const paragraphs = buildLetter(
    input({
      overdueCount: 1,
      oldestOverdue: { pattern_id: 'p_bike', merchant_name: 'bluebik rides', expected_date: '2026-07-20', amount: -1.91 },
      nextBill: { pattern_id: 'p_trup', merchant_name: 'Trupanion', expected_date: '2026-08-02', amount: -39.02 },
    })
  );
  assert.deepEqual(ids(paragraphs), ['overdue', 'next-bill']);
});

test('a merchant that opens a sentence is capitalized without editing the name itself', () => {
  const paragraphs = buildLetter(
    input({
      overdueCount: 1,
      oldestOverdue: { pattern_id: 'p_bike', merchant_name: 'bluebik rides', expected_date: '2026-07-20', amount: -1.91 },
    })
  );
  assert.ok(plain(paragraphs, 'overdue').startsWith('Bluebik rides'));
});

/** A median of a series that moves is not a bill; quoting it flat would be a fabrication. */
test('a variable bill amount is hedged', () => {
  const paragraphs = buildLetter(
    input({ nextBill: { pattern_id: 'p_coned', merchant_name: 'Con Edison', expected_date: '2026-08-02', amount: -184.2, amount_varies: true } })
  );
  assert.ok(plain(paragraphs, 'next-bill').includes('$184.20 or thereabouts, on Sunday 2 August.'));
});

test('a fixed bill amount is not hedged', () => {
  const paragraphs = buildLetter(
    input({ nextBill: { pattern_id: 'p_trup', merchant_name: 'Trupanion', expected_date: '2026-08-02', amount: -39.02 } })
  );
  assert.ok(!plain(paragraphs, 'next-bill').includes('thereabouts'));
});

test('nothing free this month is worded as nothing left over, not as money to spend', () => {
  const paragraphs = buildLetter(input({ safeToSpend: 0 }));
  assert.equal(plain(paragraphs, 'spending'), 'Once bills and goals are covered there is $0.00 left over this month.');
});

test('a goal with no safe-to-spend figure still gets its sentence', () => {
  const paragraphs = buildLetter(input({ topGoal: { name: 'Emergency fund', remaining_amount: 2800 } }));
  assert.equal(plain(paragraphs, 'spending'), 'Emergency fund needs $2,800 more to close.');
});

test('the advisor paragraph points at the undo surface and appears only when it acted', () => {
  assert.equal(ids(buildLetter(input({ reviewCount: 0, recentAiCount: 0 }))).includes('advisor'), false);

  const paragraphs = buildLetter(input({ reviewCount: 0, recentAiCount: 1 }));
  const link = paragraphs.find((p) => p.id === 'advisor')?.tokens.find((t) => t.kind === 'action');
  assert.deepEqual(link, { kind: 'action', value: 'Look at what I did', to: '/settings?section=ai_actions' });
  assert.ok(plain(paragraphs, 'advisor').includes('1 thing since yesterday'));
});
