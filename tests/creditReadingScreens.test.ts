import test from 'node:test';
import assert from 'node:assert/strict';
import { creditBalancePhrase, readOwedTotal } from '../client/src/lib/accountBalance';
// Reports and Today are gone; both readings live on `/` now, in one module rather than one per
// screen. The assertions are unchanged, which is the point of moving the logic out of the views.
import {
  afterPayoff,
  formatPayoffFigure,
  payoffState,
  readCardCredit,
  type Buckets,
} from '../client/src/views/instrumentReadings';
import type { Account } from '../shared/types';

/**
 * The screens that still read a credit as debt of the same size after the accounts views were
 * fixed: Reports (the payoff chart and its liabilities row) and Today (the "Owed" figure), both of
 * which now live in `instrumentReadings.ts`. Balances are dollars here, the unit the API hands the
 * client.
 *
 * This file used to also cover the client-built advisor prompts (`buildAccountAdvisorPrompt`,
 * `buildNetWorthEvidenceAdvisorPrompt`). Those builders had no production caller and were deleted
 * on 2026-09-01; see the header of `client/src/lib/advisorPrompts.ts`. The property they were
 * protecting, that a card in credit is described to the model the way the server describes it,
 * lives where the model actually reads it: `aiContext.ts`, pinned in `tests/aiContextSections`.
 */

const CREDIT_TOTAL = 852.89; // Discover 563.26 + Chase Freedom Flex 283.81 + BofA 5.82

test('a liabilities total below zero reads as credit, and an ordinary one is untouched', () => {
  const credit = readOwedTotal(-CREDIT_TOTAL);
  assert.equal(credit.inCredit, true);
  assert.equal(credit.label, 'In credit');
  assert.equal(credit.amount, CREDIT_TOTAL, 'the sign is spent on the label, not printed twice');

  // Healthy sheets, which is every sheet the owner has had until now: nothing changes.
  const owed = readOwedTotal(3947.93);
  assert.deepEqual(owed, { label: 'Owed', amount: 3947.93, inCredit: false });
  assert.deepEqual(readOwedTotal(0), { label: 'Owed', amount: 0, inCredit: false });
  // Reports calls its row "Liabilities"; only the credit reading overrides the caller's word.
  assert.equal(readOwedTotal(3947.93, 'Liabilities').label, 'Liabilities');
  assert.equal(readOwedTotal(-CREDIT_TOTAL, 'Liabilities').label, 'In credit');
});

function sheet(liquid: number, liabilities: number): Buckets {
  return { liquid, equity: 12000, crypto: 800, other: 0, liabilities, netWorth: liquid + 12800 - liabilities };
}

test('the payoff chart cannot pay off a credit, and cannot invent the cash it is not', () => {
  const now = sheet(7735.16, -CREDIT_TOTAL);
  const after = afterPayoff(now);

  // The bug: `liquid - liabilities` with liabilities negative drew the After-payoff Cash bar
  // $852.89 wider than Now, money the owner does not have.
  assert.equal(after.liquid, now.liquid, 'a credit is not cash to be freed by paying anything off');
  assert.equal(after.liabilities, now.liabilities, 'and it does not disappear from the sheet either');
});

test('an ordinary debt sheet pays off exactly as it always did', () => {
  const affordable = afterPayoff(sheet(7735.16, 4228.68));
  assert.equal(round(affordable.liquid), 3506.48);
  assert.equal(round(affordable.liabilities), 0);

  const unaffordable = afterPayoff(sheet(7735.16, 9000));
  assert.equal(round(unaffordable.liquid), 0);
  assert.equal(round(unaffordable.liabilities), 1264.84);

  assert.deepEqual(afterPayoff(sheet(7735.16, 0)), sheet(7735.16, 0), 'no debt, no reshuffle');

  // The property the chart rests on, across the whole domain including the negative half.
  for (const liabilities of [-CREDIT_TOTAL, -0.01, 0, 12.5, 4228.68, 9000]) {
    const before = sheet(7735.16, liabilities);
    const after = afterPayoff(before);
    assert.ok(after.liquid <= before.liquid, `paying off ${liabilities} must never grow cash`);
    assert.ok(after.liquid >= 0, `paying off ${liabilities} must never owe cash`);
  }
});

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acct_discover',
    connection_type: 'simplefin',
    institution_name: 'Discover',
    account_name: 'Discover',
    type: 'credit',
    current_balance: -563.26,
    currency: 'USD',
    is_manual: false,
    is_hidden: false,
    is_liability: true,
    sort_order: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

test('the credit phrase is one string, shared with the server context', () => {
  // services/aiContext.ts emits `${fmt(-bal)} credit balance (the card owes you)`. Two surfaces
  // describing the same card must not describe it two different ways.
  assert.equal(creditBalancePhrase('$563.26'), '$563.26 credit balance (the card owes you)');
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── The credit the total hides ───────────────────────────────────────────────
//
// Three cards in credit and two in debt sum to an ordinary positive liabilities total, so
// `readOwedTotal` correctly reports "Owed" and the credit disappears. Today therefore reads the
// cards themselves, through the same two helpers the Accounts screen uses.

const CARDS: Account[] = [
  account({ id: 'c1', account_name: 'Discover', current_balance: -563.26 }),
  account({ id: 'c2', account_name: 'Chase Freedom Flex', current_balance: -283.81 }),
  account({ id: 'c3', account_name: 'BofA Cash Rewards', current_balance: -5.82 }),
  account({ id: 'c4', account_name: 'Chase Sapphire', current_balance: 4791.94 }),
  account({ id: 'c5', account_name: 'Capital One Savor', current_balance: 8.88 }),
];

test('the cards in credit are counted even though the total they sum to is a debt', () => {
  const total = CARDS.reduce((s, c) => s + c.current_balance, 0);
  assert.equal(round(total), 3947.93, 'the sheet as a whole owes money');
  assert.equal(readOwedTotal(round(total)).inCredit, false, 'so the total is not a credit reading');

  const reading = readCardCredit(CARDS);
  assert.equal(reading.inCredit, 3);
  assert.equal(reading.cards, 5);
  assert.equal(round(reading.total), CREDIT_TOTAL);
});

test('an ordinary set of cards reports no credit at all', () => {
  const healthy = CARDS.map((c) => account({ ...c, current_balance: Math.abs(c.current_balance) }));
  assert.deepEqual(readCardCredit(healthy), { inCredit: 0, cards: 5, total: 0 });
  // A card settled at exactly zero is not in credit either.
  assert.equal(readCardCredit([account({ current_balance: 0 })]).inCredit, 0);
});

test('only credit cards are counted, so the word "cards" is always accurate', () => {
  const mixed: Account[] = [
    ...CARDS,
    account({ id: 'l1', account_name: 'Overpaid loan', type: 'other', current_balance: -20 }),
    account({ id: 'a1', account_name: 'Checking', type: 'checking', is_liability: false, current_balance: -40 }),
    account({ id: 'h1', account_name: 'Old card', current_balance: -99, is_hidden: true }),
  ];
  const reading = readCardCredit(mixed);
  assert.equal(reading.cards, 5, 'a loan and an overdrawn checking account are not cards');
  assert.equal(reading.inCredit, 3, 'and a hidden card is not on the screen it is counted for');
  assert.equal(round(reading.total), CREDIT_TOTAL);
});

// ─── The payoff section on a sheet with nothing to pay off ────────────────────
//
// `afterPayoff` returns its input in three of the four states below, and the section drew both
// columns in all four: two bar charts, identical bar for bar, with only the prose distinguishing
// them. The second column is now drawn only where the two sheets actually differ.

test('the payoff comparison is drawn only when a payoff would move something', () => {
  assert.deepEqual(payoffState(sheet(7735.16, 4228.68)), {
    kind: 'payable',
    payable: 4228.68,
    remaining: 0,
  });

  // Debt beyond the cash on hand: still a real comparison, and the sentence has to say what is left.
  // Exact, not rounded: these are API dollars, but the state is settled in cents, so the figures the
  // paragraph prints are the figures the sheet holds.
  const partial = payoffState(sheet(7735.16, 9000));
  assert.equal(partial.kind, 'payable');
  assert.equal(partial.kind === 'payable' && partial.payable, 7735.16);
  assert.equal(partial.kind === 'payable' && partial.remaining, 1264.84);

  // The three states where both columns would have been identical.
  assert.deepEqual(payoffState(sheet(7735.16, 0)), { kind: 'no_debt' });
  assert.deepEqual(payoffState(sheet(0, 4228.68)), { kind: 'no_cash', owed: 4228.68 });
  assert.deepEqual(payoffState(sheet(7735.16, -CREDIT_TOTAL)), { kind: 'in_credit', credit: CREDIT_TOTAL });
});

test('a state that draws one column is exactly a state afterPayoff leaves alone', () => {
  // The section's rule and the maths it draws are the same rule, across the whole domain: a second
  // column appears if and only if the two sheets differ somewhere. Every figure the paragraph reads
  // off the state is checked here too, exactly: the version of this test that asserted only `kind`
  // is the one the float defect below walked through.
  for (const liquid of [0, 0.01, 7735.16]) {
    for (const liabilities of [-CREDIT_TOTAL, -0.01, 0, 12.5, 4228.68, 9000]) {
      const now = sheet(liquid, liabilities);
      const after = afterPayoff(now);
      const differs = after.liquid !== now.liquid || after.liabilities !== now.liabilities;
      const state = payoffState(now);
      assert.equal(
        state.kind === 'payable',
        differs,
        `two columns drawn for liquid ${liquid} / liabilities ${liabilities} that read the same`
      );
      if (state.kind === 'payable') {
        assert.equal(state.payable, liquid - after.liquid, `payable disagrees with the drawn cash bar at ${liquid}/${liabilities}`);
        assert.equal(state.remaining, after.liabilities, `remaining disagrees with the drawn debt bar at ${liquid}/${liabilities}`);
      }
    }
  }
});

// ─── The sentence about what is left owed ─────────────────────────────────────
//
// `payable` was read back off the payoff as `liquid - afterPayoff(b).liquid`, and undoing a
// subtraction with another subtraction does not return its input in binary float. On a sheet whose
// cash covers the debt entirely, `remaining` came back around 1e-13 rather than 0, the `> 0` guard
// fired, and the paragraph rendered "$0 would still be owed, with no cash left to reach it" over a
// sheet that had cleared the debt and kept change. Both halves were false.

test('a debt cash covers entirely leaves exactly nothing owed, at every cent of it', () => {
  // The owner's latest liquid, against every whole-cent debt it can cover. The old expression
  // returned a nonzero `remaining` on 73,738 of these 529,149 sheets; there is no tolerance here,
  // because a remainder is a claim and 1e-13 of a dollar is not one.
  const liquid = 5291.49;
  for (let owedCents = 1; owedCents <= 529149; owedCents++) {
    const state = payoffState(sheet(liquid, owedCents / 100));
    assert.equal(state.kind, 'payable');
    if (state.kind !== 'payable') return;
    assert.equal(state.remaining, 0, `debt of ${owedCents} cents is fully covered, so nothing is left owed`);
    assert.equal(state.payable, owedCents / 100);
  }
});

test('a debt cash cannot cover leaves the shortfall, to the cent', () => {
  // The other side of the same guard: `remaining` has to be the real shortfall, not float dust and
  // not the whole debt. Cash is held at a cent so the shortfall is the debt minus one cent.
  for (let owedCents = 2; owedCents <= 20000; owedCents++) {
    const state = payoffState(sheet(0.01, owedCents / 100));
    assert.equal(state.kind === 'payable' && state.remaining, (owedCents - 1) / 100);
  }
});

test('a figure under a dollar is printed as itself, not as nothing', () => {
  // Whole dollars are right for a total and wrong for the subject of a sentence: "$0 would still be
  // owed" is false at a 40 cent shortfall, and the guard that lets it through is the same `> 0`.
  assert.equal(formatPayoffFigure(0.4), '$0.40');
  assert.equal(formatPayoffFigure(0.01), '$0.01');
  assert.equal(formatPayoffFigure(0), '$0.00');
  // At a dollar and above nothing changes: this screen rounds.
  assert.equal(formatPayoffFigure(1), '$1');
  assert.equal(formatPayoffFigure(1264.84), '$1,265');

  const shortfall = payoffState(sheet(0.01, 0.41));
  assert.equal(shortfall.kind === 'payable' && formatPayoffFigure(shortfall.remaining), '$0.40');
});
