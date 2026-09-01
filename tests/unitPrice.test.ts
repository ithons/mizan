import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatAdaptiveCurrency, formatUnitPrice, formatWholeCurrency } from '../client/src/lib/formatters';

/**
 * A per-unit price is a rate, not a total, and rounding it to whole dollars destroys it.
 *
 * The live ledger holds POL at $0.090195 per unit across 237.3 units. The holdings list rendered
 * that through `formatWholeCurrency` as "237.3 shares @ $0". CLAUDE.md already records why the
 * DATABASE keeps prices as REAL dollars ("rounding a $0.003 token to whole cents destroys it");
 * the render was throwing away precision the storage had been careful to keep.
 */
test('a sub-dollar price survives being rendered', () => {
  // The exact live value that read as $0. Four significant figures of the STORED double: the
  // literal 0.090195 is not exactly representable and the nearest double is a hair below, so the
  // fourth figure is 9 rather than 0. That is the number the database holds, which is the number
  // to show.
  assert.equal(formatUnitPrice(0.090195), '$0.09019');
  assert.equal(formatWholeCurrency(0.090195), '$0', 'the old behaviour, kept here as the contrast');

  assert.equal(formatUnitPrice(0.003), '$0.003');
  assert.equal(formatUnitPrice(0.0000123), '$0.0000123');

  // The property that actually matters, stated as a property rather than as three examples.
  for (const price of [0.090195, 0.003, 0.0000123, 0.5, 0.01, 0.000001]) {
    assert.notEqual(formatUnitPrice(price), '$0', `${price} collapsed to $0`);
    assert.notEqual(formatUnitPrice(price), '$0.00', `${price} collapsed to $0.00`);
  }
});

test('a price at or above a dollar reads like a price', () => {
  assert.equal(formatUnitPrice(104.2312), '$104.23');
  assert.equal(formatUnitPrice(1), '$1.00');
  assert.equal(formatUnitPrice(60000), '$60,000.00');
});

test('trailing zeros are trimmed but cents are never dropped', () => {
  assert.equal(formatUnitPrice(0.5), '$0.50');
  assert.equal(formatUnitPrice(0.25), '$0.25');
  assert.equal(formatUnitPrice(0), '$0.00');
});

test('a negative price keeps the minus the rest of the app uses', () => {
  // The codebase renders a minus as U+2212, not a hyphen; formatWholeCurrency sets that precedent.
  assert.equal(formatUnitPrice(-0.5), '−$0.50');
  assert.equal(formatUnitPrice(-104.23), '−$104.23');
});

test('no per-unit price is rendered through the whole-dollar formatter', () => {
  const src = readFileSync(join(__dirname, '..', 'client/src/views/Investments.tsx'), 'utf8');
  // The regression is specifically formatWholeCurrency applied to a price. Totals may keep it.
  assert.ok(
    !/formatWholeCurrency\([^)]*institution_price/.test(src),
    'a per-unit price is being rounded to whole dollars again'
  );
});

/**
 * Money under a dollar is still money, and a list that can hold dust must say so.
 *
 * On the live ledger the Investments holdings list rendered a $0.38 SPAXX position, a $0.21 FSKAX
 * position and a $0.01 USD balance all as "$0", and the FSKAX row's gain read "−$0 · 12.5%", a
 * percentage stated against an amount printed as nothing.
 */
test('a holding worth less than a dollar is not rendered as nothing', () => {
  assert.equal(formatAdaptiveCurrency(0.38), '$0.38');
  assert.equal(formatAdaptiveCurrency(0.21), '$0.21');
  assert.equal(formatAdaptiveCurrency(0.01), '$0.01');
  assert.equal(formatAdaptiveCurrency(-0.03, { showSign: true }), '−$0.03');
});

test('HEALTHY: a dollar and above is unchanged, so the column stays compact', () => {
  for (const amount of [1, 25.4, 1289.55, 60000]) {
    assert.equal(formatAdaptiveCurrency(amount), formatWholeCurrency(amount));
  }
  assert.equal(formatAdaptiveCurrency(1289.55), '$1,290');
});

test('an exact zero stays $0, because there is nothing to lose', () => {
  // A genuinely zero holding is not dust; spelling it "$0.00" would only add noise.
  assert.equal(formatAdaptiveCurrency(0), '$0');
});
