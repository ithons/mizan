import test from 'node:test';
import assert from 'node:assert/strict';
import { liabilityAdjustedCents } from '../server/src/services/simplefin';

test('a liability reported negative (the normal SimpleFIN convention) stores positive owed', () => {
  const errors: string[] = [];
  // $500 owed, reported as -500 by the provider -> stored +50000 cents.
  assert.equal(liabilityAdjustedCents(-500, true, 'Chase Sapphire', errors), 50000);
  assert.equal(errors.length, 0);
});

test('a liability reported positive flags the unexpected sign', () => {
  const errors: string[] = [];
  const cents = liabilityAdjustedCents(500, true, 'Weird Card', errors);
  assert.equal(cents, -50000); // negated as before, but...
  assert.equal(errors.length, 1); // ...the anomaly is surfaced through the sync result
  assert.match(errors[0], /Weird Card/);
  assert.match(errors[0], /sign may be wrong/);
});

test('an asset balance is stored as-is with no warning', () => {
  const errors: string[] = [];
  assert.equal(liabilityAdjustedCents(1234.56, false, 'Checking', errors), 123456);
  assert.equal(errors.length, 0);
});
