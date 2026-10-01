import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { applySimplefinResponse } from '../server/src/services/simplefin';
import { hideAccountsForDisconnect, updateAccount } from '../server/src/services/accounts';
import { migratedTestDb, insertAccount, TEST_NOW } from './helpers/schema';

/**
 * What a disconnect hides, and what a reconnect gives back.
 *
 * Disconnecting set is_hidden = 1 on every account of the provider and nothing ever cleared it, so
 * on 2026-10-01 a SimpleFIN reconnect refreshed nine accounts that stayed out of net worth and every
 * total. The fix has to restore exactly what the disconnect hid: an account the owner hid on
 * purpose must stay hidden through any number of disconnects and reconnects.
 */

const CHECKING = 'ACT-checking';
const OLD_CARD = 'ACT-old-card';

function payload(): unknown {
  return {
    accounts: [CHECKING, OLD_CARD].map((id) => ({
      id,
      name: id === CHECKING ? 'Checking' : 'Old Card',
      currency: 'USD',
      balance: '100.00',
      org: { name: 'Bank' },
      transactions: [],
    })),
  };
}

interface Fixture {
  db: Database.Database;
  checking: string;
  oldCard: string;
}

/** Two synced SimpleFIN accounts; the owner has hidden the old card themselves. */
function fixture(): Fixture {
  const db = migratedTestDb();
  const add = (providerId: string, name: string, hidden: number): string => {
    const id = insertAccount(db, { account_name: name, connection_type: 'simplefin', is_manual: 0, is_hidden: hidden });
    db.prepare('UPDATE accounts SET simplefin_account_id = ? WHERE id = ?').run(providerId, id);
    return id;
  };
  return { db, checking: add(CHECKING, 'Checking', 0), oldCard: add(OLD_CARD, 'Old Card', 1) };
}

function state(db: Database.Database, id: string): { is_hidden: number; hidden_by_disconnect: number } {
  return db.prepare('SELECT is_hidden, hidden_by_disconnect FROM accounts WHERE id = ?').get(id) as {
    is_hidden: number;
    hidden_by_disconnect: number;
  };
}

function sync(db: Database.Database): void {
  assert.equal(applySimplefinResponse(db, payload(), TEST_NOW).status, 'synced');
}

test('HEALTHY: an ordinary sync changes no account\'s visibility', () => {
  const { db, checking, oldCard } = fixture();
  sync(db);
  assert.deepEqual(state(db, checking), { is_hidden: 0, hidden_by_disconnect: 0 });
  assert.deepEqual(state(db, oldCard), { is_hidden: 1, hidden_by_disconnect: 0 }, 'a sync unhid an account the owner hid');
});

test('a disconnect marks only the accounts it hides', () => {
  const { db, checking, oldCard } = fixture();
  assert.equal(hideAccountsForDisconnect(db, 'simplefin', TEST_NOW), 1);
  assert.deepEqual(state(db, checking), { is_hidden: 1, hidden_by_disconnect: 1 });
  assert.deepEqual(state(db, oldCard), { is_hidden: 1, hidden_by_disconnect: 0 });
});

test('the first sync after a reconnect restores what the disconnect hid, and nothing else', () => {
  const { db, checking, oldCard } = fixture();
  hideAccountsForDisconnect(db, 'simplefin', TEST_NOW);
  sync(db);
  assert.deepEqual(state(db, checking), { is_hidden: 0, hidden_by_disconnect: 0 }, 'the reconnected account stayed out of every total');
  assert.deepEqual(state(db, oldCard), { is_hidden: 1, hidden_by_disconnect: 0 });
});

test('an owner\'s own decision after the disconnect wins over the reconnect', () => {
  const { db, checking } = fixture();
  hideAccountsForDisconnect(db, 'simplefin', TEST_NOW);
  // While disconnected, the owner looks at the hidden account and decides to keep it hidden.
  assert.equal(updateAccount(db, checking, { is_hidden: true }).ok, true);
  sync(db);
  assert.deepEqual(state(db, checking), { is_hidden: 1, hidden_by_disconnect: 0 });
});

test('a disconnect touches no other provider\'s accounts', () => {
  const { db } = fixture();
  const wallet = insertAccount(db, { account_name: 'Coinbase', connection_type: 'coinbase', is_manual: 0 });
  hideAccountsForDisconnect(db, 'simplefin', TEST_NOW);
  assert.deepEqual(state(db, wallet), { is_hidden: 0, hidden_by_disconnect: 0 });
});
