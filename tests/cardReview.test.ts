import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { cardReview, cardReviewToDollars } from '../server/src/services/cardReview';
import { getSpendingReport } from '../server/src/services/reporting';
import { AGENT_TOOLS, runAgentTool } from '../server/src/services/advisorAgentTools';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const AS_OF = '2026-10-22';

function tx(db: Database.Database, account_id: string, date: string, amount: number, original_name: string, category_id: string | null): string {
  return insertTransaction(db, { account_id, date, amount, original_name, merchant_name: original_name, category_id });
}

function fixture() {
  const db = migratedTestDb();
  const sapphire = insertAccount(db, { account_name: 'Sapphire', institution_name: 'Chase Bank', type: 'credit', is_liability: 1 });
  const flex = insertAccount(db, { account_name: 'Freedom Flex', institution_name: 'Chase Bank', type: 'credit', is_liability: 1 });
  const bofa = insertAccount(db, { account_name: 'BofA Cash Rewards', institution_name: 'Bank of America', type: 'credit', is_liability: 1 });
  const plain = insertAccount(db, { account_name: 'Plain Card', institution_name: 'Capital One', type: 'credit', is_liability: 1 });
  const checking = insertAccount(db, { account_name: 'Chase Checking', institution_name: 'Chase Bank', type: 'checking' });
  const savings = insertAccount(db, { account_name: 'BofA Savings', institution_name: 'Bank of America', type: 'closed' });
  const brokerage = insertAccount(db, { account_name: 'Brokerage', institution_name: 'Fidelity', type: 'brokerage' });

  tx(db, sapphire, '2025-02-01', -9500, 'ANNUAL MEMBERSHIP FEE', 'cat_fees');
  tx(db, sapphire, '2026-02-01', -9500, 'ANNUAL MEMBERSHIP FEE', 'cat_fees');
  tx(db, sapphire, '2026-02-19', -1300, 'RMV BOSTON', 'cat_fees');
  tx(db, sapphire, '2026-07-13', -4500, 'DELTA AIR   Baggage Fee', 'cat_travel_flights');
  tx(db, sapphire, '2026-08-01', -20000, 'AMAZON', 'cat_shop_amazon');
  tx(db, sapphire, '2026-08-05', 5000, 'AMAZON', 'cat_shop_amazon');
  tx(db, sapphire, '2026-08-20', 30000, 'Payment Thank You', 'cat_xfer_cc');
  tx(db, sapphire, '2026-09-01', -1999, 'INTEREST CHARGE ON PURCHASES', 'cat_fees');

  tx(db, flex, '2026-03-20', -34100, 'US TREAS TAX PYMT', 'cat_taxes');
  tx(db, flex, '2026-03-20', -597, 'SERVICE FEE', 'cat_fees');
  tx(db, flex, '2026-07-27', 28381, 'STATEMENT CREDIT', 'cat_income_other');

  tx(db, bofa, '2025-01-02', -37, 'FOREIGN TRANSACTION FEE REF 4340', 'cat_fees');
  tx(db, bofa, '2025-01-02', -3700, 'CAFE LISBOA', 'cat_food_restaurants');
  tx(db, bofa, '2026-07-24', 582, 'CASH REWARDS STATEMENT CREDIT', 'cat_income_other');
  tx(db, savings, '2024-01-02', 3702, 'Bank of America DES:CASHREWARD ID:X INDN:Y PPD', 'cat_income_other');
  tx(db, savings, '2026-03-02', 4076, 'Bank of America DES:CASHREWARD ID:X INDN:Y PPD', 'cat_income_other');

  tx(db, plain, '2026-06-01', -4200, 'GROCER', 'cat_food_groceries');

  tx(db, checking, '2026-08-10', 94489, 'Cash Redemption', 'cat_income_other');
  tx(db, brokerage, '2026-02-03', 89995, 'REDEMPTION FROM CORE ACCOUNT SPAXX', 'cat_inv_transfer');

  return { db, sapphire, flex, bofa, plain, checking };
}

test('per card sums are exact over life and the trailing twelve months', () => {
  const { db, sapphire, flex, bofa } = fixture();
  const review = cardReview(db, AS_OF);
  assert.equal(review.trailing_12_from, '2025-10-23');
  const card = (id: string) => review.cards.find((c) => c.account_id === id)!;

  const s = card(sapphire);
  assert.deepEqual(s.life, { redeemed: 0, fees: 9500 + 9500 + 1999, net: -20999, spend: 1300 + 4500 + 20000 - 5000 });
  assert.deepEqual(s.trailing_12, { redeemed: 0, fees: 9500 + 1999, net: -11499, spend: 1300 + 4500 + 20000 - 5000 });
  assert.deepEqual(s.fees.map((f) => f.kind), ['annual', 'annual', 'interest']);
  assert.equal(s.last_annual_fee_date, '2026-02-01');
  assert.equal(s.next_annual_fee_date, '2027-02-01');

  const f = card(flex);
  assert.deepEqual(f.life, { redeemed: 28381, fees: 0, net: 28381, spend: 34100 + 597 });
  assert.equal(f.fees.length, 0, 'a processor fee beside a tax payment is not a card fee');

  const b = card(bofa);
  assert.deepEqual(b.life, { redeemed: 3702 + 4076 + 582, fees: 37, net: 3702 + 4076 + 582 - 37, spend: 3700 });
  assert.deepEqual(b.trailing_12, { redeemed: 4076 + 582, fees: 0, net: 4076 + 582, spend: 0 });
  assert.deepEqual(b.redemptions.map((r) => r.account_name), ['BofA Savings', 'BofA Savings', 'BofA Cash Rewards']);
});

test('spend is what Reports counts on the card, less the fees counted as fees', () => {
  const { db, sapphire, bofa, flex, plain } = fixture();
  const review = cardReview(db, AS_OF);
  const reportTotal = getSpendingReport(db, { endDate: AS_OF }).total;
  const feeTotal = review.cards.reduce((sum, c) => sum + c.fees.reduce((s, x) => s - x.amount, 0), 0);
  const cardSpend = [sapphire, bofa, flex, plain].reduce((sum, id) => sum + review.cards.find((c) => c.account_id === id)!.life.spend, 0);
  assert.equal(cardSpend + feeTotal, reportTotal);
});

test('a card with no fees and no redemptions reads zero with no renewal', () => {
  const { db, plain } = fixture();
  const card = cardReview(db, AS_OF).cards.find((c) => c.account_id === plain)!;
  assert.deepEqual(card.life, { redeemed: 0, fees: 0, net: 0, spend: 4200 });
  assert.equal(card.redemptions.length, 0);
  assert.equal(card.fees.length, 0);
  assert.equal(card.last_annual_fee_date, null);
  assert.equal(card.next_annual_fee_date, null);
});

test('a bank deposit whose descriptor names no card stays unattributed', () => {
  const { db, sapphire, flex, checking } = fixture();
  const review = cardReview(db, AS_OF);
  assert.equal(review.unattributed.length, 1, 'the brokerage core redemption is not a reward');
  const [row] = review.unattributed;
  assert.equal(row.account_id, checking);
  assert.equal(row.amount, 94489);
  assert.deepEqual([...row.same_institution_card_ids].sort(), [sapphire, flex].sort());
  for (const card of review.cards) assert.ok(!card.redemptions.some((r) => r.account_id === checking));
});

test('a program deposit is unattributed when two cards share its issuer', () => {
  const { db } = fixture();
  insertAccount(db, { account_name: 'BofA Travel', institution_name: 'Bank of America', type: 'credit', is_liability: 1 });
  const review = cardReview(db, AS_OF);
  assert.equal(review.unattributed.filter((r) => r.descriptor.includes('CASHREWARD')).length, 2);
  for (const card of review.cards) assert.ok(!card.redemptions.some((r) => r.descriptor.includes('CASHREWARD')));
});

test('dollars at the edge cover every money field', () => {
  const { db, sapphire } = fixture();
  const review = cardReviewToDollars(cardReview(db, AS_OF));
  const s = review.cards.find((c) => c.account_id === sapphire)!;
  assert.deepEqual(s.life, { redeemed: 0, fees: 209.99, net: -209.99, spend: 208 });
  assert.equal(s.fees[0].amount, -95);
  assert.equal(review.unattributed[0].amount, 944.89);
});

test('the advisor reads the same review, in dollars, through get_card_review', () => {
  assert.ok(AGENT_TOOLS.some((tool) => tool.name === 'get_card_review'));
  const { db, checking } = fixture();
  const review = runAgentTool(db, 'get_card_review', {}) as ReturnType<typeof cardReviewToDollars>;
  assert.equal(review.unattributed[0].account_id, checking);
  assert.equal(review.unattributed[0].amount, 944.89);
});

test('the life window starts at the first row on the card, even one that is a transfer', () => {
  const { db, plain } = fixture();
  const payment = tx(db, plain, '2026-01-15', 5000, 'Payment Thank You', 'cat_xfer_cc');
  db.prepare("UPDATE transactions SET transfer_status = 'confirmed' WHERE id = ?").run(payment);
  assert.equal(cardReview(db, AS_OF).cards.find((c) => c.account_id === plain)!.ledger_from, '2026-01-15');
});

test('a merchant fee that names the merchant first is spend, not an issuer fee', () => {
  const { db, plain } = fixture();
  tx(db, plain, '2025-06-01', -4900, 'IRONWORKS GYM ANNUAL FEE', 'cat_fees');
  tx(db, plain, '2025-07-01', -2500, 'TOWN OF ELMHAVEN LATE FEE', 'cat_fees');
  tx(db, plain, '2025-08-01', -800, 'ACME LENDING INTEREST CHARGE', 'cat_fees');
  const card = cardReview(db, AS_OF).cards.find((c) => c.account_id === plain)!;
  assert.equal(card.fees.length, 0);
  assert.deepEqual(card.life, { redeemed: 0, fees: 0, net: 0, spend: 4200 + 4900 + 2500 + 800 });
  assert.equal(card.last_annual_fee_date, null);
  assert.equal(card.next_annual_fee_date, null);
});

test('an issuer fee that begins with the charge name is still a fee', () => {
  const { db, plain } = fixture();
  tx(db, plain, '2025-06-01', -9900, 'ANNUAL FEE', 'cat_fees');
  tx(db, plain, '2025-07-01', -2900, 'LATE PAYMENT FEE', 'cat_fees');
  tx(db, plain, '2025-08-01', -1200, 'PURCHASE INTEREST CHARGE', 'cat_fees');
  tx(db, plain, '2025-09-01', -300, 'FINANCE CHARGE', 'cat_fees');
  const card = cardReview(db, AS_OF).cards.find((c) => c.account_id === plain)!;
  assert.deepEqual(card.fees.map((f) => f.kind), ['annual', 'late', 'interest', 'interest']);
  assert.equal(card.life.spend, 4200);
  assert.equal(card.last_annual_fee_date, '2025-06-01');
});
