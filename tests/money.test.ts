import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents,
  toDollars,
  toCentsOrNull,
  toDollarsOrNull,
  dollarizeFields,
} from '../server/src/services/money';

// money.ts is the single conversion chokepoint for every inbound/outbound money value
// (dollars at the API edge <-> integer cents in the DB). It had no tests; a regression
// here silently scales every number by 100 or drops a cent. These lock the contract.

test('toCents: whole and simple fractional dollars', () => {
  assert.equal(toCents(0), 0);
  assert.equal(toCents(1), 100);
  assert.equal(toCents(12.34), 1234);
  assert.equal(toCents(0.01), 1);
  assert.equal(toCents(1000000), 100000000);
});

test('toCents: float artifacts round to exact cents, not 1998.9999...', () => {
  // 19.99 * 100 === 1998.9999999999998 in IEEE-754; Math.round rescues it.
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.29), 29);
  assert.equal(toCents(0.58), 58);
  assert.equal(toCents(4.2), 420);
  assert.equal(toCents(1.005), 100); // 1.005*100 === 100.49999...; rounds down to 100 cents
});

test('toCents: negative amounts (expenses) keep sign and magnitude', () => {
  assert.equal(toCents(-15), -1500);
  assert.equal(toCents(-19.99), -1999);
  assert.equal(toCents(-0.01), -1);
});

test('toCents: sub-cent inputs round to nearest cent', () => {
  assert.equal(toCents(0.004), 0);
  assert.equal(toCents(0.006), 1);
  // Math.round breaks .5 toward +Infinity, so magnitude differs by sign at the half-cent.
  assert.equal(toCents(0.005), 1);
  // Produces -0 (numerically zero). Node's strict assert uses Object.is, so compare explicitly.
  assert.ok(Object.is(toCents(-0.005), -0));
  assert.equal(toCents(-0.005) + 0, 0);
});

test('toDollars: exact inverse for integer cents', () => {
  assert.equal(toDollars(0), 0);
  assert.equal(toDollars(100), 1);
  assert.equal(toDollars(1999), 19.99);
  assert.equal(toDollars(-1500), -15);
  assert.equal(toDollars(100000000), 1000000);
});

test('round-trip: toDollars(toCents(x)) recovers x for cent-aligned values', () => {
  for (const x of [0, 1, 19.99, -42.5, 1234.56, -0.01, 999999.99]) {
    assert.equal(toDollars(toCents(x)), x, `round-trip failed for ${x}`);
  }
});

test('toCentsOrNull / toDollarsOrNull: pass null and undefined through untouched', () => {
  assert.equal(toCentsOrNull(null), null);
  assert.equal(toCentsOrNull(undefined), null);
  assert.equal(toCentsOrNull(12.34), 1234);
  assert.equal(toDollarsOrNull(null), null);
  assert.equal(toDollarsOrNull(undefined), null);
  assert.equal(toDollarsOrNull(1234), 12.34);
});

test('dollarizeFields: converts only the named numeric fields, copies the rest', () => {
  const row = {
    id: 'abc',
    current_balance: 175704, // cents
    available_balance: null, // stays null
    label: 'Checking', // non-number, untouched
    credit_limit: 500000, // cents
  };
  const out = dollarizeFields(row, ['current_balance', 'available_balance', 'credit_limit']);
  assert.equal(out.current_balance, 1757.04);
  assert.equal(out.available_balance, null);
  assert.equal(out.credit_limit, 5000);
  assert.equal(out.label, 'Checking');
  assert.equal(out.id, 'abc');
});

test('dollarizeFields: returns a shallow copy, does not mutate the input', () => {
  const row = { amount: 2500 };
  const out = dollarizeFields(row, ['amount']);
  assert.equal(row.amount, 2500, 'input must be untouched');
  assert.equal(out.amount, 25);
  assert.notEqual(out, row);
});

test('dollarizeFields: a named field that is absent or non-number is left as-is', () => {
  const row = { amount: 2500, note: 'x' } as Record<string, unknown>;
  const out = dollarizeFields(row, ['amount', 'note', 'missing']);
  assert.equal(out.amount, 25);
  assert.equal(out.note, 'x');
  assert.equal(out.missing, undefined);
});

// KNOWN GAP (not yet hardened): toCents does not guard non-finite input, so a NaN/Infinity
// that slips past upstream validation propagates instead of throwing. Callers currently
// guard first (simplefin.parseFinancialAmount throws on non-finite; the advisor confirm
// boundary re-validates with Zod), so this is latent, not live. This test documents the
// current behavior so a future hardening (throw on non-finite) is a deliberate, visible change.
test('toCents: DOCUMENTS current unguarded non-finite behavior (see money.ts hardening follow-up)', () => {
  assert.ok(Number.isNaN(toCents(NaN)));
  assert.equal(toCents(Infinity), Infinity);
});
