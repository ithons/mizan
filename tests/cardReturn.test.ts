import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CardReviewCard, UnattributedRedemption } from '../shared/types';
import { CardReturn } from '../client/src/views/accounts/CardReturn';

const CHROMATIC = ['clay', 'gold', 'estimate', 'review', 'sage'];

function chromaticIn(html: string): string[] {
  return CHROMATIC.filter((family) => new RegExp(`\\b(?:text|bg|border|fill|stroke)-${family}\\b|\\b(?:text|bg|border|fill|stroke)-${family}-`).test(html));
}

const SAPPHIRE: CardReviewCard = {
  account_id: 'sapphire',
  account_name: 'Chase Sapphire',
  institution_name: 'Chase Bank',
  ledger_from: '2026-02-01',
  life: { redeemed: 0, fees: 95, net: -95, spend: 21636.1 },
  trailing_12: { redeemed: 0, fees: 95, net: -95, spend: 21636.1 },
  redemptions: [],
  fees: [{ transaction_id: 'f1', date: '2026-02-01', amount: -95, descriptor: 'ANNUAL MEMBERSHIP FEE', account_id: 'sapphire', account_name: 'Chase Sapphire', kind: 'annual' }],
  last_annual_fee_date: '2026-02-01',
  next_annual_fee_date: '2027-02-01',
};

const PLAIN: CardReviewCard = {
  ...SAPPHIRE,
  account_id: 'plain',
  account_name: 'Plain',
  life: { redeemed: 0, fees: 0, net: 0, spend: 42 },
  trailing_12: { redeemed: 0, fees: 0, net: 0, spend: 42 },
  fees: [],
  last_annual_fee_date: null,
  next_annual_fee_date: null,
};

const CASH_REDEMPTION: UnattributedRedemption = {
  transaction_id: 'r1',
  date: '2026-08-10',
  amount: 944.89,
  descriptor: 'Cash Redemption',
  account_id: 'checking',
  account_name: 'Chase Checking',
  same_institution_card_ids: ['sapphire', 'flex'],
};

function render(card: CardReviewCard, unattributed: UnattributedRedemption[] = [], today = '2026-10-22'): string {
  return renderToStaticMarkup(createElement(CardReturn, { card, trailingFrom: '2025-10-23', unattributed, today }));
}

test('a card that cost more than it returned reads as a number, in neutral ink', () => {
  const html = render(SAPPHIRE, [CASH_REDEMPTION]);
  assert.deepEqual(chromaticIn(html), []);
  assert.match(html, /−\$95\.00/);
  assert.match(html, /The next is expected around Feb 1, 2027/);
  assert.match(html, /\$944\.89 &quot;Cash Redemption&quot; into Chase Checking on Aug 10, 2026 names no card/);
  assert.doesNotMatch(html, /bonus|worth|keep|score/i);
});

test('a card with nothing redeemed and no fees reads zero, with no renewal and no notes', () => {
  const html = render(PLAIN, [CASH_REDEMPTION]);
  assert.deepEqual(chromaticIn(html), []);
  assert.equal((html.match(/\$0\.00/g) ?? []).length, 6);
  assert.doesNotMatch(html, /Annual fee/);
  assert.doesNotMatch(html, /names no card/);
});

test('an annual fee a few days past its anniversary is still expected, not reported missing', () => {
  for (const today of ['2027-02-02', '2027-02-05', '2027-03-08']) {
    const html = render(SAPPHIRE, [], today);
    assert.match(html, /The next is expected around Feb 1, 2027/, today);
    assert.doesNotMatch(html, /has not posted|None has posted/, today);
  }
});

test('past one statement cycle the line states only what posted, with no expectation left standing', () => {
  const html = render(SAPPHIRE, [], '2027-03-09');
  assert.match(html, /Annual fee of \$95\.00 last charged Feb 1, 2026\. None has posted since\./);
  assert.doesNotMatch(html, /expected|has not posted/);
});
