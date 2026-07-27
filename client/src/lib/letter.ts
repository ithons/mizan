import { format, parseISO } from 'date-fns';
import { formatCurrency, formatWholeCurrency } from './formatters';

/**
 * Builds the Today screen as prose.
 *
 * Kept separate from the view because the hard part is not layout, it is degeneracy. A readout
 * that has no data shows "$0" and looks merely empty; a sentence that has no data says "You have
 * $0.00 this afternoon" and sounds certain. Every figure here is therefore nullable, null means
 * "not known" rather than "zero", and a paragraph whose subject is unknown is not written at all.
 */

export type LetterToken =
  | { kind: 'text'; value: string }
  /** A figure, set apart from the prose so the eye can find it without leaving the sentence. */
  | { kind: 'figure'; value: string }
  | { kind: 'action'; value: string; to: string };

export interface LetterParagraph {
  id: string;
  tokens: LetterToken[];
  /** Secondary voice: provenance and footnotes, not the substance of the day. */
  muted?: boolean;
}

export interface LetterBill {
  /** Identifies the recurring series, so the same bill overdue and due again is not named twice. */
  pattern_id: string;
  merchant_name: string;
  expected_date: string;
  amount: number;
  amount_varies?: boolean;
}

export interface LetterGoal {
  name: string;
  remaining_amount: number;
}

export interface LetterInput {
  now: Date;
  /** null wherever the number could not be loaded, so its sentence is omitted rather than zeroed. */
  netWorth: number | null;
  owed: number | null;
  weekDelta: number | null;
  reviewCount: number | null;
  overdueCount: number;
  oldestOverdue: LetterBill | null;
  nextBill: LetterBill | null;
  safeToSpend: number | null;
  topGoal: LetterGoal | null;
  recentAiCount: number;
  /** Date the net-worth series stops being reconstructed, if it ever was. */
  measuredFrom: string | null;
}

const text = (value: string): LetterToken => ({ kind: 'text', value });
const figure = (value: string): LetterToken => ({ kind: 'figure', value });
const action = (value: string, to: string): LetterToken => ({ kind: 'action', value, to });

/** "this morning" / "this afternoon" / "tonight", matching how a person would date a note. */
export function partOfDay(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'tonight';
  if (hour < 12) return 'this morning';
  if (hour < 18) return 'this afternoon';
  return 'tonight';
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Merchant names come from the bank as typed, so plenty are lowercase ("bluebik rides"). Only
 * the leading character is touched: anything more would be editing the user's own data.
 */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function openingParagraph(input: LetterInput): LetterParagraph | null {
  if (input.netWorth == null) return null;

  const tokens: LetterToken[] = [
    text('You have '),
    figure(formatCurrency(input.netWorth)),
    text(` ${partOfDay(input.now)}`),
  ];

  if (input.owed != null && input.owed > 0) {
    tokens.push(text(', after '), figure(formatCurrency(input.owed)), text(' owed.'));
  } else if (input.owed != null) {
    tokens.push(text(', and you owe nothing.'));
  } else {
    tokens.push(text('.'));
  }

  if (input.weekDelta != null) {
    if (input.weekDelta === 0) {
      tokens.push(text(' That is exactly where you were a week ago.'));
    } else {
      tokens.push(
        text(' That is '),
        figure(formatWholeCurrency(Math.abs(input.weekDelta))),
        text(input.weekDelta < 0 ? ' less than a week ago.' : ' more than a week ago.')
      );
    }
  }

  return { id: 'standing', tokens };
}

function reviewParagraph(input: LetterInput): LetterParagraph | null {
  if (input.reviewCount == null) return null;

  if (input.reviewCount === 0) {
    return { id: 'review', tokens: [text('Everything is categorized. Nothing is waiting on you.')] };
  }

  return {
    id: 'review',
    tokens: [
      figure(String(input.reviewCount)),
      text(` ${plural(input.reviewCount, 'transaction still has', 'transactions still have')} no category. `),
      action('Sort them', '/review'),
      text(', or leave them and I will keep guessing.'),
    ],
  };
}

function overdueParagraph(input: LetterInput): LetterParagraph | null {
  const bill = input.oldestOverdue;
  if (!bill) return null;

  const tokens: LetterToken[] = [
    text(
      `${sentenceCase(bill.merchant_name)} was due ${format(parseISO(bill.expected_date), 'd MMMM')} and has not come through: `
    ),
    figure(formatCurrency(Math.abs(bill.amount))),
  ];

  if (input.overdueCount > 1) {
    tokens.push(text(', one of '), figure(String(input.overdueCount)), text(' now past due.'));
  } else {
    tokens.push(text('.'));
  }

  // The same series overdue and due again is one fact, not two. Naming the merchant twice in
  // consecutive sentences reads as a stutter and hides that it is the same bill.
  if (input.nextBill && input.nextBill.pattern_id === bill.pattern_id) {
    tokens.push(text(` It is due again ${format(parseISO(input.nextBill.expected_date), 'EEEE d MMMM')}.`));
  }

  return { id: 'overdue', tokens };
}

function nextBillParagraph(input: LetterInput): LetterParagraph | null {
  const bill = input.nextBill;
  if (!bill) return null;
  // Already folded into the overdue sentence as "It is due again ...".
  if (input.oldestOverdue && input.oldestOverdue.pattern_id === bill.pattern_id) return null;

  const tokens: LetterToken[] = [
    text(`Next out is ${bill.merchant_name}, `),
    figure(formatCurrency(Math.abs(bill.amount))),
  ];

  // The amount is a median of a series that moves, so quoting it flat would be a fabrication.
  if (bill.amount_varies) tokens.push(text(' or thereabouts'));
  tokens.push(text(`, on ${format(parseISO(bill.expected_date), 'EEEE d MMMM')}.`));

  return { id: 'next-bill', tokens };
}

function spendingParagraph(input: LetterInput): LetterParagraph | null {
  if (input.safeToSpend == null && !input.topGoal) return null;

  const tokens: LetterToken[] = [];

  if (input.safeToSpend != null) {
    tokens.push(
      input.safeToSpend > 0
        ? text('Spending as usual, you have ')
        : text('Once bills and goals are covered there is ')
    );
    tokens.push(figure(formatCurrency(input.safeToSpend)));
    tokens.push(text(input.safeToSpend > 0 ? ' free this month.' : ' left over this month.'));
  }

  if (input.topGoal) {
    tokens.push(
      text(`${tokens.length ? ' ' : ''}${input.topGoal.name} needs `),
      figure(formatWholeCurrency(input.topGoal.remaining_amount)),
      text(' more to close.')
    );
  }

  return { id: 'spending', tokens };
}

function advisorParagraph(input: LetterInput): LetterParagraph | null {
  if (input.recentAiCount <= 0) return null;

  return {
    id: 'advisor',
    muted: true,
    tokens: [
      text('I categorized '),
      figure(String(input.recentAiCount)),
      text(` ${plural(input.recentAiCount, 'thing', 'things')} since yesterday. `),
      action('Look at what I did', '/settings?section=ai_actions'),
      text(' if you want; all of it can be put back.'),
    ],
  };
}

function footnoteParagraph(input: LetterInput): LetterParagraph | null {
  if (!input.measuredFrom) return null;

  return {
    id: 'footnote',
    muted: true,
    tokens: [
      text(
        `Net worth is measured daily from ${format(parseISO(input.measuredFrom), 'd MMMM')}. ` +
          'Anything earlier is reconstructed from your transactions and should be read as a shape, not a figure.'
      ),
    ],
  };
}

/**
 * An empty screen is an invitation, not a blank. Reached on a fresh install, and on the much
 * worse case where every request failed — the error banner names what broke, this says what to do.
 */
function invitationParagraph(): LetterParagraph {
  return {
    id: 'invitation',
    tokens: [
      text('There is nothing to report yet. '),
      action('Connect an account', '/onboarding'),
      text(' and I will start writing these.'),
    ],
  };
}

export function buildLetter(input: LetterInput): LetterParagraph[] {
  const paragraphs = [
    openingParagraph(input),
    reviewParagraph(input),
    overdueParagraph(input),
    nextBillParagraph(input),
    spendingParagraph(input),
    advisorParagraph(input),
    footnoteParagraph(input),
  ].filter((p): p is LetterParagraph => p !== null);

  // A footnote about how net worth is measured is not a report about your money.
  const hasSubstance = paragraphs.some((p) => !p.muted);
  return hasSubstance ? paragraphs : [invitationParagraph()];
}
