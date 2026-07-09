import test from 'node:test';
import assert from 'node:assert/strict';
import { guessCategoryFromText } from '../server/src/services/textCategorization';

test('matches common merchants to their category', () => {
  assert.equal(guessCategoryFromText('STARBUCKS STORE #123', 'STARBUCKS STORE #123'), 'cat_food_coffee');
  assert.equal(guessCategoryFromText(null, 'WHOLEFDS MKT #10245'), null); // no match without a keyword hit is expected
  assert.equal(guessCategoryFromText('Whole Foods Market', 'WFM 10245'), 'cat_food_groceries');
  assert.equal(guessCategoryFromText('AMAZON.COM*A1B2C3', 'AMAZON.COM*A1B2C3'), 'cat_shop_amazon');
  assert.equal(guessCategoryFromText('Netflix.com', 'NETFLIX.COM'), 'cat_ent_streaming');
  assert.equal(guessCategoryFromText('Uber Eats', 'UBER   *EATS'), 'cat_food_restaurants');
  assert.equal(guessCategoryFromText('Uber', 'UBER *TRIP HELP.UBER.COM'), 'cat_transport_ride');
});

test('returns null for unrecognized or empty text', () => {
  assert.equal(guessCategoryFromText(null, ''), null);
  assert.equal(guessCategoryFromText(null, 'SOME RANDOM MERCHANT XYZ 4521'), null);
});

test('is case-insensitive and punctuation-tolerant', () => {
  assert.equal(guessCategoryFromText(null, "trader joe's #512"), 'cat_food_groceries');
  assert.equal(guessCategoryFromText(null, 'CVS/PHARMACY #01234'), 'cat_health_pharmacy');
});
