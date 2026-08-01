import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two conditional surfaces the amount-correction and snapshot-membership work added.
 *
 * Both are gated on a state the code checked, and both were shipped without a test on either half.
 * Rule 3 applies to copy as much as to detectors: a sentence that appears on an ordinary healthy row
 * is a standing finding the owner cannot act on. These assert the GATE rather than a rendering,
 * because what can go wrong here is the condition widening, not the markup.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

test('the "amount: you" mark is gated on the owner actually owning the amount', () => {
  const rows = read('client', 'src', 'views', 'ledger', 'rows.tsx');
  // Not on `amount_source` being non-null: 12 of the owner's 2,600 rows carry 'provider', and a
  // provider-authored amount is the ordinary case, not a correction.
  assert.match(rows, /transaction\.amount_source === 'human' && <Mark>amount: you<\/Mark>/);
  assert.doesNotMatch(rows, /amount_source\s*!==?\s*null[^\n]*amount: you/);
});

test('HEALTHY: an uncorrected row has no condition that could render the mark', () => {
  const rows = read('client', 'src', 'views', 'ledger', 'rows.tsx');
  // The only mention of the mark is the gated one, so there is no unguarded path to it.
  const mentions = [...rows.matchAll(/amount: you/g)];
  assert.equal(mentions.length, 1, 'the mark is rendered from exactly one gated site');
});

test('the disagreement sentence names the institution and is gated on a live disagreement', () => {
  const modals = read('client', 'src', 'views', 'ledger', 'modals.tsx');
  // It states what the provider reports, so it may only appear when there IS a provider figure.
  assert.match(modals, /providerAmount/);
  assert.match(modals, /\{institution\} still reports/);
  // And the way back is offered beside it, so the pin is never a one-way door.
  assert.match(modals, /Let \$\{institution\} own this amount again/);
});

test('HEALTHY: with no provider disagreement there is nothing for the sheet to claim', () => {
  const modals = read('client', 'src', 'views', 'ledger', 'modals.tsx');
  // `providerAmount` is null unless the server found a rejection whose from_value is what the row
  // currently holds, so the sentence cannot render on a row nobody corrected.
  assert.match(modals, /providerAmount\s*!=+\s*null|providerAmount\s*&&/);
});

test('the reconstruction notice is gated on the baseline point being reconstructed', () => {
  const investments = read('client', 'src', 'views', 'Investments.tsx');
  assert.match(investments, /baselineMembership === 'reconstructed' &&/);
  // It says what was reconstructed and why, rather than asserting the figure is wrong.
  assert.match(investments, /reconstructed from your accounts as they are now/);
});

test('HEALTHY: a recorded baseline renders no reconstruction notice', () => {
  const investments = read('client', 'src', 'views', 'Investments.tsx');
  const gated = [...investments.matchAll(/baselineMembership === 'reconstructed'/g)];
  assert.equal(gated.length, 1, 'the notice is rendered from exactly one gated site');
  assert.doesNotMatch(investments, /baselineMembership !== 'recorded'/);
});
