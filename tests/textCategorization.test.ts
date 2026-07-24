import test from 'node:test';
import assert from 'node:assert/strict';
import { guessCategoryFromText } from '../server/src/services/textCategorization';

test('matches common merchants to their category', () => {
  assert.equal(guessCategoryFromText('STARBUCKS STORE #123', 'STARBUCKS STORE #123'), 'cat_food_coffee');
  // Raw statement forms now match (the audit fix — before, only the prettified name did).
  assert.equal(guessCategoryFromText(null, 'WHOLEFDS MKT #10245'), 'cat_food_groceries');
  assert.equal(guessCategoryFromText('Whole Foods Market', 'WFM 10245'), 'cat_food_groceries');
  assert.equal(guessCategoryFromText('AMAZON.COM*A1B2C3', 'AMAZON.COM*A1B2C3'), 'cat_shop_amazon');
  assert.equal(guessCategoryFromText('Netflix.com', 'NETFLIX.COM'), 'cat_ent_streaming');
  assert.equal(guessCategoryFromText('Uber Eats', 'UBER   *EATS'), 'cat_food_delivery');
  assert.equal(guessCategoryFromText('DoorDash', 'DOORDASH*ORDER'), 'cat_food_delivery');
  assert.equal(guessCategoryFromText('Uber', 'UBER *TRIP HELP.UBER.COM'), 'cat_transport_ride');
  assert.equal(guessCategoryFromText('Chewy', 'CHEWY.COM'), 'cat_pets');
});

test('audit fixes: payments/contributions never read as spend, and new categories resolve', () => {
  // Card autopay and cash contributions are transfers, not income/spend (the $10.5k / $1k bugs).
  assert.equal(guessCategoryFromText(null, 'AUTOMATIC PAYMENT - THANK YOU'), 'cat_xfer_cc');
  assert.equal(guessCategoryFromText(null, 'INTERNET PAYMENT - THANK YOU'), 'cat_xfer_cc');
  assert.equal(guessCategoryFromText(null, 'Electronic Funds Transfer Received'), 'cat_inv_transfer');
  // New taxonomy leaves.
  assert.equal(guessCategoryFromText(null, 'OPENAI *CHATGPT SUBSCR'), 'cat_sub_software');
  assert.equal(guessCategoryFromText(null, 'Anthropic'), 'cat_sub_software');
  assert.equal(guessCategoryFromText(null, 'AMC 2657 BOSTON COMMON'), 'cat_ent_movies');
  assert.equal(guessCategoryFromText(null, 'WANDERU*WANDERU.COM'), 'cat_travel_intercity');
  assert.equal(guessCategoryFromText(null, 'BUDGET RENT A CAR'), 'cat_travel_rental');
  // Bike-share must win over rideshare even though the sync tags it "...RIDE LYFT.COM".
  assert.equal(guessCategoryFromText(null, 'BLUEBIK*1 RIDE LYFT.COM'), 'cat_transport_share');
  assert.equal(guessCategoryFromText(null, 'Zipcar Trip'), 'cat_transport_share');
});

test('returns null for unrecognized or empty text', () => {
  assert.equal(guessCategoryFromText(null, ''), null);
  assert.equal(guessCategoryFromText(null, 'SOME RANDOM MERCHANT XYZ 4521'), null);
});

test('is case-insensitive and punctuation-tolerant', () => {
  assert.equal(guessCategoryFromText(null, "trader joe's #512"), 'cat_food_groceries');
  assert.equal(guessCategoryFromText(null, 'CVS/PHARMACY #01234'), 'cat_health_pharmacy');
});
