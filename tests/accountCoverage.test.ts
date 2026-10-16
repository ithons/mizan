import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { accountCoverage } from '../server/src/services/accountCoverage';
import { insertAccount, insertTransaction, localDaysFromToday, migratedTestDb } from './helpers/schema';

const NOW = '2026-10-01T00:00:00Z';

function pattern(db: Database.Database, row: {
  id: string; name: string; amount: number; frequency: string; next: string;
  kind?: 'flow' | 'transfer'; from?: string; to?: string; category?: string | null;
}) {
  db.prepare(`
    INSERT INTO recurring_patterns (id, merchant_name, category_id, average_amount, frequency, last_seen, next_expected,
      is_active, is_confirmed, transaction_count, created_at, updated_at, kind, account_id, counterparty_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 3, ?, ?, ?, ?, ?)
  `).run(row.id, row.name, row.category ?? null, row.amount, row.frequency, localDaysFromToday(-30), row.next,
    NOW, NOW, row.kind ?? 'flow', row.from ?? null, row.to ?? null);
}

function paidInto(db: Database.Database, patternId: string, accountId: string, amount: number) {
  for (const back of [-28, -21, -14]) {
    const id = insertTransaction(db, { account_id: accountId, date: localDaysFromToday(back), amount, merchant_name: patternId });
    db.prepare('UPDATE transactions SET recurring_id = ? WHERE id = ?').run(patternId, id);
  }
}

function ledger(checkingCents: number, paymentCents: number, dueIn: number) {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Checking', type: 'checking', current_balance: checkingCents });
  const card = insertAccount(db, { account_name: 'Card', type: 'credit', is_liability: 1, current_balance: paymentCents + 5000 });
  insertAccount(db, { account_name: 'Other card', type: 'credit', is_liability: 1, current_balance: 9000 });
  pattern(db, { id: 'rp_pay', name: 'Checking to Card', amount: -paymentCents, frequency: 'monthly', next: localDaysFromToday(dueIn), kind: 'transfer', from: checking, to: card });
  return { db, checking, card };
}

const cardsOf = (result: ReturnType<typeof accountCoverage>) => Object.fromEntries(result.cards.map((c) => [c.card, c]));

test('HEALTHY: a checking account that covers its card payment is silent and the unpaid card stays unjudged', () => {
  const { db } = ledger(500000, 300000, 5);
  const result = accountCoverage(db, 30);
  const cards = cardsOf(result);
  assert.equal(cards.Card.status, 'covered');
  assert.equal(cards['Other card'].status, 'unjudged');
  const checking = result.cash_accounts.find((a) => a.account === 'Checking')!;
  assert.equal(checking.first_below_zero, null);
  assert.equal(checking.lowest?.balance, 2000);
});

test('a payment larger than the paying account is short by the exact difference', () => {
  const { db } = ledger(100000, 130012, 5);
  const result = accountCoverage(db, 30);
  const card = cardsOf(result).Card;
  assert.equal(card.status, 'short');
  assert.equal(card.paying_account_after, -300.12);
  assert.deepEqual(result.cash_accounts.find((a) => a.account === 'Checking')!.first_below_zero, { date: localDaysFromToday(5), balance: -300.12 });
});

test('an overdue payment counts as due today, and a skipped one does not count', () => {
  const { db } = ledger(100000, 130000, -4);
  const card = cardsOf(accountCoverage(db, 30)).Card;
  assert.ok(card.status === 'short' && card.due === localDaysFromToday(0) && card.overdue);

  db.prepare(`INSERT INTO recurring_occurrence_adjustments (id, recurring_id, original_date, action, adjusted_date, created_at, updated_at)
    VALUES ('adj', 'rp_pay', ?, 'skip', NULL, ?, ?)`).run(localDaysFromToday(-4), NOW, NOW);
  const after = accountCoverage(db, 20);
  assert.equal(after.cash_accounts.find((a) => a.account === 'Checking')!.first_below_zero, null);
});

test('pay that lands before the payment covers it, and overdue pay is not counted', () => {
  const { db, checking } = ledger(100000, 130000, 5);
  pattern(db, { id: 'rp_wage', name: 'payroll', amount: 50000, frequency: 'biweekly', next: localDaysFromToday(2) });
  paidInto(db, 'rp_wage', checking, 50000);
  assert.equal(cardsOf(accountCoverage(db, 6)).Card.status, 'covered');

  db.prepare('UPDATE recurring_patterns SET next_expected = ? WHERE id = ?').run(localDaysFromToday(-2), 'rp_wage');
  const result = accountCoverage(db, 6);
  assert.equal(cardsOf(result).Card.status, 'short');
  assert.deepEqual(result.overdue_income_not_counted.map((row) => row.amount), [500]);
});

test('a bill that last posted to a card is not charged to checking', () => {
  const { db, card } = ledger(500000, 100000, 5);
  pattern(db, { id: 'rp_sub', name: 'subscription', amount: -480000, frequency: 'monthly', next: localDaysFromToday(3) });
  paidInto(db, 'rp_sub', card, -480000);
  const checking = accountCoverage(db, 30).cash_accounts.find((a) => a.account === 'Checking')!;
  assert.deepEqual(checking.scheduled.map((row) => row.what), ['Checking to Card']);
  assert.equal(checking.first_below_zero, null);
});
