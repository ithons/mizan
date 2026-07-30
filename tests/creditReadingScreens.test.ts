import test from 'node:test';
import assert from 'node:assert/strict';
import { creditBalancePhrase, readOwedTotal } from '../client/src/lib/accountBalance';
import { afterPayoff, type Buckets } from '../client/src/views/Reports';
import {
  buildAccountAdvisorPrompt,
  buildNetWorthEvidenceAdvisorPrompt,
} from '../client/src/lib/advisorPrompts';
import type { Account, NetWorthSnapshot, ReportNetWorthEvidence } from '../shared/types';

/**
 * The screens that still read a credit as debt of the same size after the accounts views were
 * fixed: Reports (the payoff chart and its liabilities row), Today (the "Owed" figure), and the
 * client-built advisor prompts. Balances are dollars here, the unit the API hands the client.
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

test('a card in credit is described to the model the way the server context describes it', () => {
  const prompt = buildAccountAdvisorPrompt(account());

  assert.match(prompt.prompt, /\$563\.26 credit balance \(the card owes you\)/);
  assert.doesNotMatch(prompt.prompt, /balance is -\$563\.26/, 'a bare minus sign is not a reading');
  assert.equal(prompt.params?.inCredit, true);
  // The stored value is preserved, sign and all: the prose explains it, it does not replace it.
  assert.equal(prompt.params?.currentBalance, -563.26);
});

test('an ordinary card and an ordinary asset say nothing about credit', () => {
  const debt = buildAccountAdvisorPrompt(
    account({ id: 'acct_sapphire', account_name: 'Chase Sapphire', current_balance: 4791.94 })
  );
  assert.match(debt.prompt, /The current balance is \$4,?791\.94\./);
  assert.doesNotMatch(debt.prompt, /credit balance/);
  assert.equal(debt.params?.inCredit, false);

  // A checking account overdrawn to -$40 is negative and is NOT in credit: only a liability can be.
  const overdrawn = buildAccountAdvisorPrompt(
    account({ id: 'acct_checking', type: 'checking', is_liability: false, current_balance: -40 })
  );
  assert.match(overdrawn.prompt, /The current balance is -\$40\.00\./);
  assert.doesNotMatch(overdrawn.prompt, /credit balance/);
  assert.equal(overdrawn.params?.inCredit, false);
});

function snapshot(overrides: Partial<NetWorthSnapshot> = {}): NetWorthSnapshot {
  return {
    id: 'snap_1',
    date: '2026-07-29',
    total_assets: 7735.16,
    total_liabilities: 3947.93,
    net_worth: 3787.23,
    created_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  } as NetWorthSnapshot;
}

function netWorthEvidence(snap: NetWorthSnapshot): ReportNetWorthEvidence {
  return {
    kind: 'networth_snapshot',
    label: snap.date,
    snapshot: snap,
    previous_snapshot: null,
    delta: null,
    asset_delta: null,
    liability_delta: null,
    accounts: [],
  };
}

test('net-worth evidence names a credit position instead of signing it', () => {
  const evidence: ReportNetWorthEvidence = {
    kind: 'networth_snapshot',
    label: '2026-07-29',
    snapshot: snapshot(),
    previous_snapshot: null,
    delta: null,
    asset_delta: null,
    liability_delta: null,
    accounts: [
      { account_id: 'a1', account_name: 'Discover', institution_name: 'Discover', type: 'credit', is_liability: true, balance: -563.26 },
      { account_id: 'a2', account_name: 'Chase Sapphire', institution_name: 'Chase', type: 'credit', is_liability: true, balance: 4791.94 },
      { account_id: 'a3', account_name: 'Checking', institution_name: 'BofA', type: 'checking', is_liability: false, balance: 7735.16 },
    ],
  };

  const prompt = buildNetWorthEvidenceAdvisorPrompt(evidence);
  assert.match(prompt.prompt, /Discover at Discover \$563\.26 credit balance \(the card owes you\) \(credit\)/);
  assert.doesNotMatch(prompt.prompt, /-\$563\.26/);
  // Healthy rows keep the wording they had.
  assert.match(prompt.prompt, /Chase Sapphire at Chase \$4791\.94 liability \(credit\)/);
  assert.match(prompt.prompt, /Checking at BofA \$7735\.16 asset \(checking\)/);
});

test('a net-worth liabilities TOTAL in credit reads as credit, not as signed debt', () => {
  const prompt = buildNetWorthEvidenceAdvisorPrompt(
    netWorthEvidence(snapshot({ total_liabilities: -CREDIT_TOTAL, net_worth: 7735.16 + CREDIT_TOTAL }))
  );

  assert.match(prompt.prompt, /liabilities are \$852\.89 in credit \(the cards owe you\)/);
  assert.doesNotMatch(prompt.prompt, /liabilities are -\$852\.89/, 'a bare minus sign is not a reading');
  assert.equal(prompt.params?.liabilitiesInCredit, true);
  // The stored value keeps its sign: the prose explains it rather than replacing it.
  assert.equal(prompt.params?.totalLiabilities, -CREDIT_TOTAL);
});

test('an ordinary sheet with positive liabilities says nothing about credit', () => {
  const prompt = buildNetWorthEvidenceAdvisorPrompt(netWorthEvidence(snapshot()));

  assert.match(
    prompt.prompt,
    /Assets are \$7735\.16, liabilities are \$3947\.93, and net worth is \$3787\.23\./,
    'the healthy line is exactly what it always was'
  );
  assert.doesNotMatch(prompt.prompt, /in credit/);
  assert.equal(prompt.params?.liabilitiesInCredit, false);
  assert.equal(prompt.params?.totalLiabilities, 3947.93);

  // Zero owed is not a credit either.
  const settled = buildNetWorthEvidenceAdvisorPrompt(netWorthEvidence(snapshot({ total_liabilities: 0 })));
  assert.match(settled.prompt, /liabilities are \$0\.00,/);
  assert.equal(settled.params?.liabilitiesInCredit, false);
});

test('the credit phrase is one string, shared with the server context', () => {
  // services/aiContext.ts emits `${fmt(-bal)} credit balance (the card owes you)`. Two surfaces
  // describing the same card must not describe it two different ways.
  assert.equal(creditBalancePhrase('$563.26'), '$563.26 credit balance (the card owes you)');
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
