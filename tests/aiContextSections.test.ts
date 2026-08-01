import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { _setDbForTesting } from '../server/src/db/index';
import { buildFinancialContext } from '../server/src/services/aiContext';
import {
  TEST_NOW,
  insertAccount,
  insertAdvisorAction,
  insertCategory,
  insertTransaction,
  migratedTestDb,
} from './helpers/schema';

/**
 * The sections that let the model stop guessing: existing rules, category provenance, its own
 * applied actions and what became of them, ledger integrity, and the full temporal reach.
 *
 * Every detector and every sentence of copy in here is tested TWICE: once on the shape it exists
 * to report, and once on the ordinary healthy shape, asserting SILENCE. The healthy assertions are
 * the point. Five rounds of this rebuild shipped a detector that fired on a normal event, and none
 * of the failures were caught, because each round's tests only proved that the defect was found.
 */

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthsBack(back: number, day = 15): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - back, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const SNAPSHOT_SQL = `
  INSERT INTO net_worth_snapshots
    (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated,
     liquid_assets, investment_assets, crypto_assets, created_at)
  VALUES (?, ?, ?, 0, ?, ?, 0, ?, 0, 0, '2026-07-30T00:00:00.000Z')
`;

function measuredSnapshot(
  db: Database.Database,
  id: string,
  date: string,
  balances: Record<string, number>
): void {
  const total = Object.values(balances).reduce((sum, value) => sum + value, 0);
  db.prepare(SNAPSHOT_SQL).run(id, date, total, total, JSON.stringify(balances), total);
}

function insertRule(
  db: Database.Database,
  rule: { pattern: string; categoryId: string; source: string; retiredAt?: string }
): void {
  db.prepare(`
    INSERT INTO merchant_rules (id, pattern, category_id, source, created_at, retired_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `rule_${rule.pattern.toLowerCase().replace(/\W+/g, '_')}_${rule.retiredAt ?? 'live'}`,
    rule.pattern,
    rule.categoryId,
    rule.source,
    TEST_NOW,
    rule.retiredAt ?? null
  );
}

function insertRevision(
  db: Database.Database,
  revision: { transactionId: string; actionId: string; toCategoryId: string; revertedAt?: string }
): void {
  db.prepare(`
    INSERT INTO transaction_category_revisions
      (id, transaction_id, from_category_id, to_category_id, from_source, to_source,
       action_id, revert_of, reverted_at, created_at)
    VALUES (?, ?, NULL, ?, NULL, 'ai', ?, NULL, ?, ?)
  `).run(
    `rev_${revision.transactionId}_${revision.actionId}`,
    revision.transactionId,
    revision.toCategoryId,
    revision.actionId,
    revision.revertedAt ?? null,
    TEST_NOW
  );
}

function insertHolding(
  db: Database.Database,
  holding: { accountId: string; ticker: string; valueCents: number }
): void {
  const securityId = `sec_${holding.ticker.toLowerCase()}`;
  db.prepare(`
    INSERT OR IGNORE INTO securities (id, ticker, name, type, currency)
    VALUES (?, ?, ?, 'equity', 'USD')
  `).run(securityId, holding.ticker, holding.ticker);
  db.prepare(`
    INSERT INTO holdings
      (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis,
       currency, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, NULL, 'USD', ?)
  `).run(
    `hold_${holding.accountId}_${securityId}`,
    holding.accountId,
    securityId,
    holding.valueCents / 100,
    holding.valueCents,
    TEST_NOW
  );
}

function insertRuleAction(
  db: Database.Database,
  action: { id: string; pattern: string; categoryId: string }
): void {
  db.prepare(`
    INSERT INTO advisor_actions (id, kind, label, summary, source, payload, created_at)
    VALUES (?, 'create_merchant_rule', ?, ?, 'worker_auto', ?, ?)
  `).run(
    action.id,
    `Always categorize ${action.pattern}`,
    `Rule for ${action.pattern}.`,
    JSON.stringify({ kind: 'create_merchant_rule', pattern: action.pattern, category_id: action.categoryId }),
    TEST_NOW
  );
}

// ── Ledger Integrity ───────────────────────────────────────────────────────

test('an account whose transactions do not explain its balance is named, with the amount', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', account_name: 'Checking', current_balance: 90000 });
  measuredSnapshot(db, 's1', daysAgo(30), { [account]: 100000 });
  measuredSnapshot(db, 's2', daysAgo(1), { [account]: 90000 });

  const context = buildFinancialContext();
  assert.match(context, /### Ledger Integrity/);
  assert.match(
    context,
    /Checking: the balance shows a fall of \$100\.00 where the transactions account for no movement, leaving \$100\.00 unexplained/
  );
  db.close();
});

test('a liability residual is stated in amount owed, the direction the owner reads it in', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  // The live shape this copy was wrong on: Discover's owed FELL from $1,055.63 to $563.26 while its
  // net-worth-signed adjusted_residual is negative, so "the balance moved down" was backwards.
  const card = insertAccount(db, {
    type: 'credit', account_name: 'Discover', is_liability: 1, current_balance: 56326,
  });
  measuredSnapshot(db, 's1', daysAgo(30), { [card]: 105563 });
  insertTransaction(db, { account_id: card, date: daysAgo(15), amount: 161889, category_id: 'cat_xfer_cc' });
  measuredSnapshot(db, 's2', daysAgo(1), { [card]: 56326 });

  const context = buildFinancialContext();
  assert.match(
    context,
    /Discover: the amount owed shows a fall of \$492\.37 where the transactions account for a fall of \$1,618\.89, leaving \$1,126\.52 unexplained/
  );
  // The sentence that was true for one of the three live accounts it labelled, and backwards for two.
  assert.doesNotMatch(context, /the balance moved down by more than the transactions account for/);
  db.close();
});

test('an account whose transactions exactly explain its balance produces no finding', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', account_name: 'Checking', current_balance: 90000 });
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  measuredSnapshot(db, 's1', daysAgo(30), { [account]: 100000 });
  // Strictly inside the horizon, so it is neither a boundary artifact nor missing from `explained`.
  insertTransaction(db, { account_id: account, date: daysAgo(15), amount: -10000, category_id: groceries });
  measuredSnapshot(db, 's2', daysAgo(1), { [account]: 90000 });

  const context = buildFinancialContext();
  assert.match(context, /### Ledger Integrity/);
  // An ordinary spend on an ordinary account is the most common event the ledger contains. If any
  // of this fires here, the section is noise the owner learns to skip.
  assert.doesNotMatch(context, /unexplained between/);
  assert.doesNotMatch(context, /carries a balance the ledger does not fully explain/);
  assert.doesNotMatch(context, /carry a balance the ledger does not fully explain/);
  assert.doesNotMatch(context, /point the opposite way/);
  assert.doesNotMatch(context, /left two accounts within/);
  // Every account here was judged, so neither caveat may appear.
  assert.doesNotMatch(context, /Not judged at all/);
  assert.doesNotMatch(context, /Exempt and not judged/);
  assert.match(context, /None of the 1 account this check judged carries an unexplained residual beyond tolerance\./);
  db.close();
});

test('a newly connected account is named as unjudged rather than covered by the clean bill', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking', current_balance: 90000 });
  measuredSnapshot(db, 's1', daysAgo(30), { [checking]: 100000 });
  insertTransaction(db, { account_id: checking, date: daysAgo(15), amount: -10000, category_id: groceries });
  measuredSnapshot(db, 's2', daysAgo(1), { [checking]: 90000 });

  // Connected after the last balance sheet, so it appears in no consecutive pair and reconciliation
  // skips it entirely. It is not reconciled and it is not exempt: it was never looked at.
  const card = insertAccount(db, {
    type: 'credit', account_name: 'New Card', is_liability: 1, current_balance: 250000,
  });
  insertTransaction(db, { account_id: card, date: daysAgo(2), amount: -250000, category_id: groceries });

  const context = buildFinancialContext();
  assert.match(context, /None of the 1 account this check judged carries an unexplained residual beyond tolerance\./);
  assert.match(context, /Not judged at all, because it is absent from at least one end of every consecutive pair/);
  assert.match(context, /New Card \(credit\)/);
  db.close();
});

test('a market-driven account is named as exempt and is not counted among the judged', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking', current_balance: 90000 });
  const brokerage = insertAccount(db, { type: 'brokerage', account_name: 'Fidelity', current_balance: 120000 });
  measuredSnapshot(db, 's1', daysAgo(30), { [checking]: 100000, [brokerage]: 100000 });
  insertTransaction(db, { account_id: checking, date: daysAgo(15), amount: -10000, category_id: groceries });
  measuredSnapshot(db, 's2', daysAgo(1), { [checking]: 90000, [brokerage]: 120000 });

  const context = buildFinancialContext();
  // The brokerage rose $200.00 on no transactions, which is a price move and not a gap.
  assert.match(context, /None of the 1 account this check judged carries an unexplained residual beyond tolerance\./);
  assert.match(context, /Exempt and not judged.*Fidelity \(brokerage\)/);
  assert.doesNotMatch(context, /Not judged at all/);
  db.close();
});

test('a ledger of nothing but market-driven accounts gives no clean bill at all', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const brokerage = insertAccount(db, { type: 'brokerage', account_name: 'Fidelity', current_balance: 120000 });
  measuredSnapshot(db, 's1', daysAgo(30), { [brokerage]: 100000 });
  measuredSnapshot(db, 's2', daysAgo(1), { [brokerage]: 120000 });

  const context = buildFinancialContext();
  assert.match(context, /No account was judged for an unexplained residual/);
  // "None of the 0 accounts this check judged" would be a verdict over an empty set.
  assert.doesNotMatch(context, /this check judged carries/);
  db.close();
});

test('two same-signed transfer legs are reported as what was checked, not as a diagnosed sign error', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const a = insertAccount(db, { type: 'checking', account_name: 'Chase Checking', current_balance: 100000 });
  const b = insertAccount(db, { type: 'brokerage', account_name: 'Fidelity Individual', current_balance: 100000 });
  for (const [day, amount] of [[9, -50000], [4, -70000]] as const) {
    insertTransaction(db, { account_id: a, date: daysAgo(day), amount, category_id: 'cat_xfer_out' });
    insertTransaction(db, { account_id: b, date: daysAgo(day), amount, category_id: 'cat_xfer_out' });
  }

  const context = buildFinancialContext();
  assert.match(context, /Equal amounts left two accounts within 5 days of each other, repeatedly between the same pair\./);
  assert.match(context, /it does not say which row is wrong/);
  // The detector establishes transfer-class, outbound, unpaired and repeated. It never establishes
  // which leg is wrong, and the copy used to assert a wrong sign on every finding.
  assert.doesNotMatch(context, /stored with the wrong sign/);
  assert.match(context, /Chase Checking and Fidelity Individual: 4 legs/);
  db.close();
});

test('a ledger of ordinary paired transfers produces no flow-conservation finding', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const checking = insertAccount(db, { type: 'checking', account_name: 'Checking', current_balance: 100000 });
  const savings = insertAccount(db, { type: 'savings', account_name: 'Savings', current_balance: 100000 });
  // Each leg has its equal and opposite counterpart, which is what a settled transfer looks like.
  for (const [day, amount] of [[9, 50000], [4, 70000]] as const) {
    insertTransaction(db, { account_id: checking, date: daysAgo(day), amount: -amount, category_id: 'cat_xfer_out' });
    insertTransaction(db, { account_id: savings, date: daysAgo(day), amount, category_id: 'cat_xfer_in' });
  }

  const context = buildFinancialContext();
  assert.doesNotMatch(context, /left two accounts within/);
  assert.doesNotMatch(context, /it does not say which row is wrong/);
  db.close();
});

test('with fewer than two measured balance sheets the check reports that it has not run', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 90000 });
  measuredSnapshot(db, 's1', daysAgo(1), { [account]: 90000 });

  const context = buildFinancialContext();
  // Silence from a check that never ran must not read as a clean bill of health: that is the
  // "absence of a finding presented as a finding of health" failure this whole rebuild is about.
  assert.match(context, /the check has not run/);
  assert.match(context, /absence of evidence, not evidence that the ledger is complete/);
  assert.doesNotMatch(context, /this check judged/);
  db.close();
});

// ── Merchant rules ─────────────────────────────────────────────────────────

test('merchant rules distinguish the owner from the AI and state that the owner wins', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertRule(db, { pattern: 'SPOTIFY 877-778-1161, NY', categoryId: 'cat_ent_streaming', source: 'human' });
  insertRule(db, { pattern: 'Netflix', categoryId: 'cat_subscriptions', source: 'ai' });

  const context = buildFinancialContext();
  assert.match(context, /### Merchant Rules Already In Place \(2 live\)/);
  assert.match(context, /Netflix -> Subscriptions \(yours\)/);
  // The owner's rule carries no marker at all, and must not be labelled as the model's own work.
  assert.match(context, /^ {2}SPOTIFY 877-778-1161, NY -> Streaming$/m);
  assert.match(context, /the owner's rule wins over yours/);
  db.close();
});

test('a retired rule is shown as retired and is not listed as live', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertRule(db, { pattern: 'Backblaze', categoryId: 'cat_subscriptions', source: 'ai', retiredAt: '2026-07-30T00:00:00.000Z' });
  insertRule(db, { pattern: 'BACKBLAZE INC', categoryId: 'cat_sub_software', source: 'human' });

  const context = buildFinancialContext();
  const live = context.split('### Merchant Rules Retired')[0];
  assert.match(context, /### Merchant Rules Retired \(1\)/);
  assert.match(context, /Backblaze -> Subscriptions, retired 2026-07-30 \(was yours\)/);
  // The retirement is what stops the worker re-proposing the rule that caused it. Listing it as
  // live would do the opposite.
  assert.doesNotMatch(live, /Backblaze -> Subscriptions/);
  db.close();
});

test('a ledger with nothing retired carries no retired-rules section', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertRule(db, { pattern: 'BACKBLAZE INC', categoryId: 'cat_sub_software', source: 'human' });

  const context = buildFinancialContext();
  assert.doesNotMatch(context, /Merchant Rules Retired/);
  db.close();
});

// ── Provenance ─────────────────────────────────────────────────────────────

test('a null category source is reported as unrecorded provenance, not as unclaimed', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  insertTransaction(db, { account_id: account, date: daysAgo(3), amount: -1000, category_id: groceries });
  insertTransaction(db, {
    account_id: account, date: daysAgo(2), amount: -1000,
    category_id: groceries, category_source: 'human',
  });

  const context = buildFinancialContext();
  assert.match(context, /### How Categories Were Set \(2 transactions\)/);
  assert.match(context, /Set by hand by the owner: 1/);
  assert.match(context, /No provenance recorded: 1/);
  assert.match(context, /not a decision and not a vacancy/);
  assert.match(context, /Rows with no category at all: 0/);
  db.close();
});

test('a ledger where every row records its source says nothing about unrecorded provenance', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  insertTransaction(db, {
    account_id: account, date: daysAgo(3), amount: -1000,
    category_id: groceries, category_source: 'rule',
  });

  const context = buildFinancialContext();
  assert.match(context, /Set by a merchant rule: 1/);
  assert.doesNotMatch(context, /No provenance recorded/);
  assert.doesNotMatch(context, /not a decision and not a vacancy/);
  db.close();
});

// ── The model's own actions and their outcomes ─────────────────────────────

test('applied actions report how many of their category writes still stand', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const coffee = insertCategory(db, { name: 'Coffee Test' });
  const actionId = insertAdvisorAction(db, { kind: 'categorize_transaction', source: 'worker_auto' });
  const txn = insertTransaction(db, {
    account_id: account, date: daysAgo(4), amount: -545,
    category_id: coffee, category_source: 'ai', category_action_id: actionId,
  });
  insertRevision(db, { transactionId: txn, actionId, toCategoryId: coffee });

  const context = buildFinancialContext();
  assert.match(context, /### Actions You Have Already Applied \(1\)/);
  assert.match(context, /categorize_transaction: 1 \(1 applied autonomously/);
  assert.match(
    context,
    /Category writes: 1 write across 1 row\. Still the category the row carries: 1\. Undone: 0\. On a row the owner has since set by hand: 0\./
  );
  // Nothing went wrong here, so nothing may be reported as having gone wrong.
  assert.doesNotMatch(context, /the owner then changed by hand/);
  assert.doesNotMatch(context, /Repeat proposals/);
  db.close();
});

test('two writes on one row are counted as two writes on one row', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const coffee = insertCategory(db, { name: 'Coffee Test' });
  const restaurants = insertCategory(db, { name: 'Restaurants Test' });
  const first = insertAdvisorAction(db, { id: 'act_first', kind: 'categorize_transaction', source: 'worker_auto' });
  const second = insertAdvisorAction(db, { id: 'act_second', kind: 'categorize_transaction', source: 'worker_auto' });
  const txn = insertTransaction(db, {
    account_id: account, date: daysAgo(4), amount: -545,
    category_id: restaurants, category_source: 'ai', category_action_id: second,
  });
  insertRevision(db, { transactionId: txn, actionId: first, toCategoryId: coffee });
  insertRevision(db, { transactionId: txn, actionId: second, toCategoryId: restaurants });

  const context = buildFinancialContext();
  // The revision log counts writes. Calling that count a row count made the three outcomes read as
  // covering 1 of 2 rows, and the live ledger only hid it because no row there is written twice.
  assert.match(context, /Category writes: 2 writes across 1 row\./);
  assert.match(context, /Still the category the row carries: 1\./);
  db.close();
});

// ── Holdings against the Net Worth investment total ─────────────────────────

test('a funded but uninvested IRA does not make the holdings look misfiled', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const brokerage = insertAccount(db, { type: 'brokerage', account_name: 'Brokerage', current_balance: 95000 });
  insertHolding(db, { accountId: brokerage, ticker: 'VTI', valueCents: 95000 });
  // Cash in, nothing bought yet. Ordinary, and it makes the two totals differ on its own.
  insertAccount(db, { type: 'ira_roth', account_name: 'Roth IRA', current_balance: 50000 });

  const context = buildFinancialContext();
  assert.match(context, /the \$500\.00 difference is uninvested cash or a provider lag/);
  assert.doesNotMatch(context, /not classified as an investment there/);
  db.close();
});

test('a brokerage whose holdings match its balance exactly carries no reconciling note', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const brokerage = insertAccount(db, { type: 'brokerage', account_name: 'Brokerage', current_balance: 95000 });
  insertHolding(db, { accountId: brokerage, ticker: 'VTI', valueCents: 95000 });

  const context = buildFinancialContext();
  assert.match(context, /### Investment Portfolio - \$950\.00/);
  assert.doesNotMatch(context, /Note: the Net Worth section reports investments as/);
  db.close();
});

test('a holding in an account the Net Worth section does not call an investment is named', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const brokerage = insertAccount(db, { type: 'brokerage', account_name: 'Brokerage', current_balance: 95000 });
  insertHolding(db, { accountId: brokerage, ticker: 'VTI', valueCents: 95000 });
  const savings = insertAccount(db, { type: 'savings', account_name: 'Savings', current_balance: 50000 });
  insertHolding(db, { accountId: savings, ticker: 'SPAXX', valueCents: 50000 });

  const context = buildFinancialContext();
  assert.match(context, /1 account holding a position is not classified as an investment there: Savings \(savings\), \$500\.00/);
  db.close();
});

test('a category the owner overrode afterwards is reported as an override', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const coffee = insertCategory(db, { name: 'Coffee Test' });
  const restaurants = insertCategory(db, { name: 'Restaurants Test' });
  const actionId = insertAdvisorAction(db, { kind: 'categorize_transaction', source: 'worker_auto' });
  // The AI wrote Coffee; the owner then set Restaurants by hand, which clears category_action_id.
  const txn = insertTransaction(db, {
    account_id: account, date: daysAgo(4), amount: -1038, merchant_name: 'Van Leeuwen',
    category_id: restaurants, category_source: 'human', category_action_id: null,
  });
  insertRevision(db, { transactionId: txn, actionId, toCategoryId: coffee });

  const context = buildFinancialContext();
  assert.match(context, /On a row the owner has since set by hand: 1\./);
  assert.match(context, /Van Leeuwen: you set Coffee Test, the owner set Restaurants Test/);
  db.close();
});

test('one rule proposal per merchant reports no repetition; a repeated one does', () => {
  const quiet = migratedTestDb();
  _setDbForTesting(quiet);
  insertRuleAction(quiet, { id: 'a1', pattern: 'Trupanion', categoryId: 'cat_pets' });
  const quietContext = buildFinancialContext();
  assert.match(quietContext, /create_merchant_rule: 1/);
  assert.doesNotMatch(quietContext, /Repeat proposals/);
  quiet.close();

  const noisy = migratedTestDb();
  _setDbForTesting(noisy);
  insertRuleAction(noisy, { id: 'b1', pattern: 'Spotify', categoryId: 'cat_ent_streaming' });
  insertRuleAction(noisy, { id: 'b2', pattern: 'Spotify', categoryId: 'cat_subscriptions' });
  const noisyContext = buildFinancialContext();
  assert.match(noisyContext, /Repeat proposals: 2 merchant-rule actions cover only 1 distinct pattern/);
  assert.match(noisyContext, /Spotify: proposed 2 times, across 2 different categories/);
  noisy.close();
});

test('a ledger the advisor has never written to carries no action-history section', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  insertAccount(db, { type: 'checking', current_balance: 100000 });

  const context = buildFinancialContext();
  assert.doesNotMatch(context, /Actions You Have Already Applied/);
  db.close();
});

// ── Temporal reach ─────────────────────────────────────────────────────────

test('the monthly series reaches the oldest month the ledger holds, not three months back', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', account_name: 'Old Card', current_balance: 100000 });
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  insertTransaction(db, { account_id: account, date: monthsBack(30), amount: -12345, category_id: groceries });
  insertTransaction(db, { account_id: account, date: monthsBack(1), amount: -6789, category_id: groceries });

  const context = buildFinancialContext();
  assert.match(context, /### Ledger Reach/);
  assert.match(context, /Old Card \(checking\): 2 rows/);
  assert.match(context, new RegExp(`${monthsBack(30).slice(0, 7)}: income \\$0\\.00, spending \\$123\\.45`));
  db.close();
});

test('partial account coverage is marked on the months it applies to and nowhere else', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  const older = insertAccount(db, { type: 'checking', account_name: 'Older', current_balance: 100000 });
  const newer = insertAccount(db, { type: 'checking', account_name: 'Newer', current_balance: 100000 });
  insertTransaction(db, { account_id: older, date: monthsBack(6), amount: -1000, category_id: groceries });
  insertTransaction(db, { account_id: older, date: monthsBack(1), amount: -1000, category_id: groceries });
  insertTransaction(db, { account_id: newer, date: monthsBack(1), amount: -2000, category_id: groceries });

  const context = buildFinancialContext();
  const sixBack = context.split('\n').find((line) => line.trim().startsWith(`${monthsBack(6).slice(0, 7)}:`));
  const oneBack = context.split('\n').find((line) => line.trim().startsWith(`${monthsBack(1).slice(0, 7)}:`));
  assert.ok(sixBack && oneBack, 'both months must appear in the series');
  assert.match(sixBack, /\[reach 1\/2\]/);
  // The month both accounts reach is ordinary and must carry no annotation.
  assert.doesNotMatch(oneBack, /\[reach/);
  db.close();
});

test('a ledger whose accounts all start together carries no coverage notation at all', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const groceries = insertCategory(db, { name: 'Groceries Test' });
  const a = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const b = insertAccount(db, { type: 'checking', current_balance: 100000 });
  insertTransaction(db, { account_id: a, date: monthsBack(2), amount: -1000, category_id: groceries });
  insertTransaction(db, { account_id: b, date: monthsBack(2), amount: -2000, category_id: groceries });

  const context = buildFinancialContext();
  assert.match(context, /### Monthly History/);
  assert.doesNotMatch(context, /\[reach /);
  db.close();
});

// ── Signed category totals ─────────────────────────────────────────────────

test('a category driven negative by refunds is explained, and an ordinary month is not', () => {
  const ordinary = migratedTestDb();
  _setDbForTesting(ordinary);
  const plainAccount = insertAccount(ordinary, { type: 'checking', current_balance: 100000 });
  const plainCategory = insertCategory(ordinary, { name: 'Shopping Test' });
  insertTransaction(ordinary, { account_id: plainAccount, date: daysAgo(2), amount: -5000, category_id: plainCategory });
  const ordinaryContext = buildFinancialContext();
  assert.match(ordinaryContext, /### Category Movement/);
  assert.doesNotMatch(ordinaryContext, /refunds and credits exceeded purchases/);
  ordinary.close();

  const refunded = migratedTestDb();
  _setDbForTesting(refunded);
  const account = insertAccount(refunded, { type: 'checking', current_balance: 100000 });
  const shopping = insertCategory(refunded, { name: 'Shopping Test' });
  insertTransaction(refunded, { account_id: account, date: daysAgo(2), amount: -5000, category_id: shopping });
  insertTransaction(refunded, { account_id: account, date: daysAgo(1), amount: 20000, category_id: shopping });
  const refundedContext = buildFinancialContext();
  assert.match(refundedContext, /refunds and credits exceeded purchases/);
  refunded.close();
});

/**
 * The year-window tree prints children, so the note that explains a negative total has to be
 * decided over children too. The guard used to read the roots only, which on the live database is
 * silent today (2025-07-01 to 2026-06-30 has no negative at any depth) and was not three months ago
 * (2025-04-01 to 2026-03-31 puts Entertainment / Movies at -1548 cents under a positive root).
 */
test('a child category driven negative under a positive parent still gets the note', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const parent = insertCategory(db, { name: 'Entertainment Test' });
  const movies = insertCategory(db, { name: 'Movies Test', parent_id: parent });
  const concerts = insertCategory(db, { name: 'Concerts Test', parent_id: parent });
  // Inside the 12 complete months this section reports, not the current month.
  insertTransaction(db, { account_id: account, date: monthsBack(3), amount: -1000, category_id: movies });
  insertTransaction(db, { account_id: account, date: monthsBack(3, 16), amount: 2548, category_id: movies });
  insertTransaction(db, { account_id: account, date: monthsBack(3), amount: -50000, category_id: concerts });

  const context = buildFinancialContext();
  const section = context.split('### Spending By Category')[1] ?? '';
  assert.match(section, /Entertainment Test: \$484\.52/);
  assert.match(section, /Movies Test: -\$15\.48/);
  assert.match(context, /A negative total means refunds and credits in this window exceeded purchases/);
  db.close();
});

test('a year of ordinary spending carries no negative-total note', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const parent = insertCategory(db, { name: 'Entertainment Test' });
  const movies = insertCategory(db, { name: 'Movies Test', parent_id: parent });
  insertTransaction(db, { account_id: account, date: monthsBack(3), amount: -1000, category_id: movies });
  insertTransaction(db, { account_id: account, date: monthsBack(3, 16), amount: 400, category_id: movies });

  const context = buildFinancialContext();
  assert.match(context, /### Spending By Category/);
  assert.match(context, /Movies Test: \$6\.00/);
  assert.doesNotMatch(context, /A negative total means refunds and credits in this window exceeded purchases/);
  db.close();
});

// ── Provenance on the rows the model is most likely to change ──────────────

test('recent transactions carry the provenance of their category', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 100000 });
  const coffee = insertCategory(db, { name: 'Coffee Test' });
  insertTransaction(db, {
    account_id: account, date: daysAgo(1), amount: -545, merchant_name: 'Starbucks',
    category_id: coffee, category_source: 'human',
  });
  insertTransaction(db, {
    account_id: account, date: daysAgo(2), amount: -545, merchant_name: 'Blue Bottle',
    category_id: coffee, category_source: 'ai',
  });
  insertTransaction(db, {
    account_id: account, date: daysAgo(3), amount: -545, merchant_name: 'Dunkin',
    category_id: coffee,
  });

  const context = buildFinancialContext();
  assert.match(context, /Starbucks - -\$5\.45 \(Coffee Test\) \[owner\]/);
  assert.match(context, /Blue Bottle - -\$5\.45 \(Coffee Test\) \[you\]/);
  // No recorded source means no tag, and the legend says so rather than leaving it to be guessed.
  assert.match(context, /Dunkin - -\$5\.45 \(Coffee Test\)$/m);
  assert.match(context, /No tag means no provenance was recorded/);
  db.close();
});

/* ── The category list the model reads, and what its ordering used to hide ──── */

/**
 * `ORDER BY total DESC LIMIT 8` over a SIGNED total is a filter on sign, not a ranking by size.
 *
 * A category whose refunds exceeded its purchases sorts below every ordinary one, so the cut
 * removed exactly the rows the note underneath the list existed to explain, and the note was
 * guarded on the already-sliced array so it could not fire either. Measured 2026-07-31 against a
 * copy of `.mizan/mizan.db` at migration 054, for 2026-07-01 onward, the ten categories with
 * activity ranked signed-descending were Food & Drink 73160, Travel 49625, Transport 41614,
 * Subscriptions 16271, Pets 14029, Entertainment 9622, Health 8257, Home 1584, Transfers -97500,
 * Shopping -102863. The eight printed summed to $2,141.62 under a Report Summary line reading
 * "Spending: $1,112.99", and the largest single category movement of the month was not on the page.
 */

/** A day inside the current month that is never in the future, so the window always holds it. */
function thisMonth(day: number): string {
  const now = new Date();
  const clamped = Math.min(day, now.getDate());
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

function movementSection(context: string): string {
  return context.split('### Category Movement')[1]?.split('\n###')[0] ?? '';
}

test('a net-refund category is not ranked off the list, however far negative it goes', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });

  // Eight ordinary categories, each larger than the last, plus one driven far negative. Under the
  // old ordering the ninth could not survive a LIMIT 8 no matter how large its movement.
  const ordinary = ['cat_food', 'cat_travel', 'cat_transport', 'cat_subscriptions', 'cat_pets', 'cat_ent', 'cat_health', 'cat_home'];
  ordinary.forEach((category, index) => {
    insertTransaction(db, { account_id: account, date: thisMonth(2), amount: -(index + 1) * 1000, category_id: category });
  });
  insertTransaction(db, { account_id: account, date: thisMonth(3), amount: -102_459, category_id: 'cat_shop' });
  insertTransaction(db, { account_id: account, date: thisMonth(4), amount: 205_322, category_id: 'cat_shop' });

  const section = movementSection(buildFinancialContext());
  assert.match(section, /Shopping: -\$1,028\.63/, 'the largest movement of the month must be on the page');
  assert.match(section, /refunds and credits exceeded purchases/);
  db.close();
});

test('HEALTHY: an ordinary month carries no refund note and leaves nothing off', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  insertTransaction(db, { account_id: account, date: thisMonth(2), amount: -5_000, category_id: 'cat_food' });
  insertTransaction(db, { account_id: account, date: thisMonth(3), amount: -2_500, category_id: 'cat_shop' });

  const section = movementSection(buildFinancialContext());
  assert.match(section, /Food & Drink: \$50\.00/);
  assert.doesNotMatch(section, /refunds and credits exceeded purchases/);
  assert.doesNotMatch(section, /not listed/);
  db.close();
});

test('what is left off is counted and totalled rather than cut', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  const categories = ['cat_food', 'cat_travel', 'cat_transport', 'cat_subscriptions', 'cat_pets', 'cat_ent', 'cat_health', 'cat_home', 'cat_shop', 'cat_personal_care'];
  categories.forEach((category, index) => {
    insertTransaction(db, { account_id: account, date: thisMonth(2), amount: -(index + 1) * 1000, category_id: category });
  });

  const section = movementSection(buildFinancialContext());
  // The two smallest of ten: $10.00 and $20.00.
  assert.match(section, /2 smaller categories are not listed, together \$30\.00\./);
  db.close();
});

test('the list covers the same rows as the Spending figure printed above it', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  insertTransaction(db, { account_id: account, date: thisMonth(2), amount: -73_160, category_id: 'cat_food' });
  insertTransaction(db, { account_id: account, date: thisMonth(3), amount: -102_459, category_id: 'cat_shop' });
  insertTransaction(db, { account_id: account, date: thisMonth(4), amount: 205_322, category_id: 'cat_shop' });
  // A transfer, which Report Summary excludes. The old SQL did not, so the two lists differed by
  // exactly this row on top of everything the ordering dropped.
  insertTransaction(db, { account_id: account, date: thisMonth(5), amount: -97_500, category_id: 'cat_xfer_out' });

  const context = buildFinancialContext();
  const spending = /Spending: (-?\$[\d,]+\.\d\d)/.exec(context)?.[1];
  const section = movementSection(context);

  assert.equal(spending, '-$297.03', 'Food $731.60 less Shopping $1,028.63, transfer excluded');
  assert.match(section, new RegExp(`they sum to the Spending figure there: ${spending?.replace(/[$.]/g, (c) => `\\${c}`)}`));
  assert.doesNotMatch(section, /Transfers/, 'a transfer is not spending on either surface');
  db.close();
});

/**
 * ONE DEFINITION OF BUDGET USAGE, AND IT IS THE ONE /plan RENDERS.
 *
 * The Category Movement line used to compute its own: a query selecting `b.amount` keyed by
 * `COALESCE(parent name, name)`, looked up by the ROOT category name `getSpendingReport` returns.
 * So a budget set on a CHILD was printed against its whole parent's spend, two budgets under one
 * parent collapsed to whichever the Map saw last, and `rollover_balance` was ignored, while
 * `getMonthlyBudgetsWithProjection` rolls a budget's own descendants up and adds rollover. The
 * model read a percentage /plan does not render. It reads /plan's now.
 */
function budgetOn(db: Database.Database, categoryId: string, amountCents: number, rolloverCents = 0): void {
  db.prepare(`
    INSERT INTO budgets (id, category_id, amount, period, rollover, rollover_balance, created_at, updated_at)
    VALUES (?, ?, ?, 'monthly', ?, ?, ?, ?)
  `).run(`bud_${categoryId}`, categoryId, amountCents, rolloverCents === 0 ? 0 : 1, rolloverCents, TEST_NOW, TEST_NOW);
}

test('a budget set on a child category is not compared against its whole parent', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  const parent = insertCategory(db, { name: 'Leisure Test' });
  const child = insertCategory(db, { name: 'Concerts Test', parent_id: parent });
  const sibling = insertCategory(db, { name: 'Cinema Test', parent_id: parent });

  budgetOn(db, child, 10000);
  insertTransaction(db, { account_id: account, date: daysAgo(2), amount: -5000, category_id: child });
  // The sibling's spend belongs to the parent's movement total and to no budget at all.
  insertTransaction(db, { account_id: account, date: daysAgo(1), amount: -40000, category_id: sibling });

  const context = buildFinancialContext();
  const section = context.split('### Category Movement')[1] ?? '';
  assert.match(section, /Leisure Test: \$450\.00/, 'the movement total is still the parent root');
  // The budget is the child's $100.00 against the child's $50.00, which is what /plan shows.
  // Keyed by parent name against the parent's $450.00 it read 450%, on a budget covering none of it.
  assert.doesNotMatch(section, /450%/);
  assert.doesNotMatch(section, /budget on this category/, 'the parent carries no budget of its own');

  db.close();
});

test('a budget with rollover is stated against the amount available, the way /plan states it', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  const category = insertCategory(db, { name: 'Groceries Test' });
  budgetOn(db, category, 20000, 10000);
  insertTransaction(db, { account_id: account, date: daysAgo(2), amount: -15000, category_id: category });

  const context = buildFinancialContext();
  const section = context.split('### Category Movement')[1] ?? '';
  // $150.00 of $300.00 available ($200.00 budget + $100.00 carried), which is 50%. Over the bare
  // $200.00 the old expression read 75% on a budget the owner is nowhere near.
  assert.match(section, /budget on this category: \$150\.00 spent of \$300\.00 \(50%\)/);
  assert.doesNotMatch(section, /75%/);

  db.close();
});

test('HEALTHY: an ordinary budget on a root category reads exactly as it always did', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  const category = insertCategory(db, { name: 'Transport Test' });
  budgetOn(db, category, 20000);
  insertTransaction(db, { account_id: account, date: daysAgo(2), amount: -5000, category_id: category });

  const context = buildFinancialContext();
  const section = context.split('### Category Movement')[1] ?? '';
  assert.match(section, /Transport Test: \$50\.00 \| budget on this category: \$50\.00 spent of \$200\.00 \(25%\)/);

  db.close();
});

test('HEALTHY: a category with no budget carries no budget clause at all', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  const account = insertAccount(db, { type: 'checking', current_balance: 500000 });
  const category = insertCategory(db, { name: 'Hobbies Test' });
  insertTransaction(db, { account_id: account, date: daysAgo(2), amount: -5000, category_id: category });

  const context = buildFinancialContext();
  const section = context.split('### Category Movement')[1] ?? '';
  assert.match(section, /Hobbies Test: \$50\.00$/m);
  assert.doesNotMatch(section, /budget on this category/);

  db.close();
});
