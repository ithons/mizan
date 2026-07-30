import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditNote, isInCredit, signedAccountBalance } from '../client/src/lib/accountBalance';
import { beamTiltDegrees, scalePans } from '../client/src/components/balance/BalanceScale';

/**
 * How the screens read a liability that is in CREDIT.
 *
 * The server was fixed first and the screens still contradicted it: `-Math.abs(current_balance)`
 * turned each of the three cards that owed the owner money on 2026-07-29 (Discover $563.26, Chase
 * Freedom Flex $283.81, BofA Cash Rewards $5.82) into debt of the same size, so the Accounts list
 * printed a net worth $1,705.78 below the one the AI context computed from the same rows.
 *
 * Balances are dollars here, the unit the API hands the client.
 */

const discover = { type: 'credit' as const, is_liability: true, current_balance: -563.26 };
const sapphire = { type: 'credit' as const, is_liability: true, current_balance: 4791.94 };
const checking = { type: 'checking' as const, is_liability: false, current_balance: 7735.16 };
const loan = { type: 'other' as const, is_liability: true, current_balance: -20 };

test('a card in credit contributes to net worth instead of subtracting from it', () => {
  assert.equal(signedAccountBalance(discover), 563.26);
  assert.equal(signedAccountBalance(sapphire), -4791.94);
  assert.equal(signedAccountBalance(checking), 7735.16);
});

test('a credit position is a different state from debt, and says so', () => {
  assert.equal(isInCredit(discover), true);
  assert.equal(isInCredit(sapphire), false);
  assert.equal(isInCredit(checking), false, 'an asset is never "in credit"');

  // Matches the advisor context's wording, which renders these as "credit balance (the card owes
  // you)". Two surfaces describing the same row must not describe it two different ways.
  assert.match(creditNote(discover), /owes you/);
  assert.match(creditNote(discover), /card/);
  // Not every liability is a card: an overpaid loan is in credit too, and is not called one.
  assert.match(creditNote(loan), /account/);
});

test('the accounts screen totals agree with the server on all three figures', () => {
  const live = [checking, discover, sapphire];
  const assets = live.filter((a) => !a.is_liability).reduce((s, a) => s + a.current_balance, 0);
  const owed = live.filter((a) => a.is_liability).reduce((s, a) => s + a.current_balance, 0);

  // snapshot.ts splits by role and subtracts. The screen used to split by SIGN, which put a card in
  // credit on the assets side and then counted it against itself through Math.abs().
  assert.equal(round(assets), 7735.16);
  assert.equal(round(owed), 4228.68);
  assert.equal(round(assets - owed), 3506.48);

  const flattened = live.reduce((s, a) => s + (a.is_liability ? -Math.abs(a.current_balance) : a.current_balance), 0);
  assert.equal(round(assets - owed - flattened), 1126.52, 'the old expression was low by twice the credit');
});

test('a net credit position sits on the assets pan, not on the debt pan', () => {
  const pans = scalePans(7735.16, -852.89);
  assert.equal(pans.owed, 0, 'nothing is owed when every card is in credit');
  assert.equal(round(pans.held), 8588.05);
  assert.equal(pans.credit, 852.89);
  // The property that keeps the instrument honest against the figures printed beside it.
  assert.equal(round(pans.held - pans.owed), round(7735.16 + 852.89));

  // Math.abs() drew this sheet as one carrying $852.89 of debt: the beam tipped the wrong way.
  assert.ok(beamTiltDegrees(pans.held, pans.owed) > beamTiltDegrees(7735.16, 852.89));
});

test('an ordinary sheet of debt is unchanged by the credit handling', () => {
  const pans = scalePans(7735.16, 4228.68);
  assert.equal(pans.owed, 4228.68);
  assert.equal(pans.held, 7735.16);
  assert.equal(pans.credit, 0);
  assert.equal(beamTiltDegrees(pans.held, pans.owed), beamTiltDegrees(7735.16, 4228.68));
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
