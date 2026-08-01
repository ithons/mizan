import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applySimplefinResponse } from '../server/src/services/simplefin';
import { describeRelinkBlock, recordSimplefinStage } from '../server/src/services/syncManager';
import { adoptRelinkPairs, getPendingRelinkProposal } from '../server/src/services/simplefinRelink';
import { migratedTestDb } from './helpers/schema';

/**
 * The gate, from the sync's side.
 *
 * `tests/simplefinRelink.test.ts` proves the detector, the pairing and the adoption. This file
 * proves the one thing only the sync can prove: that a pass which detects a re-link writes NOTHING,
 * and that a pass which does not detect one is completely unaffected.
 *
 * Every "unaffected" case here is a real event the ledger sees on ordinary days: an account closed
 * at the bank, an account opened at the bank, a first connection, an unreadable response. A
 * detector that speaks on any of those is worse than no detector, because the owner learns to click
 * through it. Each of them asserts silence explicitly: no proposal row, no block, and the write the
 * pass was always going to make still made.
 */

const NOW = '2026-08-01T09:00:00.000Z';
const LAST_SYNCED = '2026-07-31T09:00:00.000Z';
// Local-noon epoch, so the local calendar day the sync derives is the same one in every timezone
// the fixture might run in, and comfortably above the backfill floors below.
const POSTED = Math.floor(Date.UTC(2026, 6, 15, 18, 0, 0) / 1000);

interface AccountFixture {
  id: string;
  simplefinAccountId: string;
  accountName: string;
  institutionName: string;
  type: string;
  balanceCents: number;
  isLiability: number;
  backfillFloor: string | null;
}

/**
 * Three curated accounts, in the shape the 2026-08-01 incident found them: hand-named
 * (`name_source = 'manual'`), hand-typed (`type_source = 'manual'`, which is what stopped
 * `guessAccountTypeAndLiability` from re-reading a credit card as a checking account), and carrying
 * the backfill floor below which imported manual history owns the ledger.
 */
const LEDGER: AccountFixture[] = [
  {
    id: 'acct_checking',
    simplefinAccountId: 'ACT-old-checking',
    accountName: 'Chase Checking',
    institutionName: 'Chase',
    type: 'checking',
    balanceCents: 429055,
    isLiability: 0,
    backfillFloor: '2024-01-01',
  },
  {
    id: 'acct_card',
    simplefinAccountId: 'ACT-old-card',
    accountName: 'Chase Sapphire',
    institutionName: 'Chase',
    type: 'credit',
    balanceCents: 120000,
    isLiability: 1,
    backfillFloor: '2024-06-01',
  },
  {
    id: 'acct_savings',
    simplefinAccountId: 'ACT-old-savings',
    accountName: 'Ally Savings',
    institutionName: 'Ally Bank',
    type: 'savings',
    balanceCents: 1000170,
    isLiability: 0,
    backfillFloor: null,
  },
];

function setupLedger(): Database.Database {
  const db = migratedTestDb();
  db.prepare(`
    INSERT INTO simplefin_connections (id, last_synced_at, status, created_at)
    VALUES ('simplefin_primary', ?, 'active', '2026-01-01T00:00:00.000Z')
  `).run(LAST_SYNCED);

  const insertAcct = db.prepare(`
    INSERT INTO accounts
      (id, simplefin_account_id, connection_id, connection_type, institution_name, account_name,
       type, current_balance, currency, is_manual, is_hidden, is_liability, sort_order,
       type_source, name_source, backfill_floor_date, created_at, updated_at)
    VALUES (?, ?, 'simplefin_primary', 'simplefin', ?, ?, ?, ?, 'USD', 0, 0, ?, 0,
            'manual', 'manual', ?, '2026-01-01T00:00:00.000Z', '2026-07-31T09:00:00.000Z')
  `);
  const insertTxn = db.prepare(`
    INSERT INTO transactions
      (id, simplefin_transaction_id, account_id, date, amount, merchant_name, original_name,
       pending, is_manual, source_type, created_at, updated_at)
    VALUES (?, ?, ?, '2026-07-10', ?, ?, ?, 0, 0, 'simplefin', ?, ?)
  `);

  for (const account of LEDGER) {
    insertAcct.run(
      account.id,
      account.simplefinAccountId,
      account.institutionName,
      account.accountName,
      account.type,
      account.balanceCents,
      account.isLiability,
      account.backfillFloor
    );
    insertTxn.run(
      `txn_${account.id}`,
      `SFT-${account.id}`,
      account.id,
      -4250,
      'Existing merchant',
      'EXISTING MERCHANT',
      LAST_SYNCED,
      LAST_SYNCED
    );
  }
  return db;
}

/** Every column of every account, plus the ledger and the connection: the whole write surface. */
function snapshotLedger(db: Database.Database): {
  accounts: unknown[];
  transactions: unknown[];
  connection: unknown;
  holdings: unknown[];
} {
  return {
    accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    transactions: db.prepare('SELECT * FROM transactions ORDER BY id').all(),
    connection: db.prepare("SELECT * FROM simplefin_connections WHERE id = 'simplefin_primary'").get(),
    holdings: db.prepare('SELECT * FROM holdings ORDER BY id').all(),
  };
}

/** One scalar off the ledger, typed at the call site rather than cast inline ten times. */
function one<T>(db: Database.Database, sql: string): T {
  return db.prepare(sql).get() as T;
}

function pendingProposalCount(db: Database.Database): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM simplefin_relink_proposals WHERE status = 'pending'"
  ).get() as { n: number }).n;
}

function proposalCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM simplefin_relink_proposals').get() as { n: number }).n;
}

/** The provider payload for one account, at whatever id the response is carrying it under. */
function providerAccount(
  account: AccountFixture,
  providerId: string,
  extras: { balance?: string; transactions?: unknown[] } = {}
): Record<string, unknown> {
  return {
    id: providerId,
    name: account.accountName,
    currency: 'USD',
    // The provider sends a liability's balance owed as a negative; `liabilityAdjustedCents` negates
    // it back to positive-as-owed on the way in.
    balance: extras.balance ?? String(
      (account.isLiability === 1 ? -account.balanceCents : account.balanceCents) / 100
    ),
    org: { name: account.institutionName },
    transactions: extras.transactions ?? [],
  };
}

/** The incident: every institution re-added at the provider, so every id is new. */
function rotatedResponse(): unknown {
  return {
    accounts: LEDGER.map((account) =>
      providerAccount(account, account.simplefinAccountId.replace('old', 'new'), {
        transactions: [
          {
            id: `SFT-new-${account.id}`,
            posted: POSTED,
            amount: '-12.34',
            payee: 'Re-served merchant',
            description: 'RE-SERVED MERCHANT',
          },
        ],
      })
    ),
  };
}

/** An ordinary sync: the same ids, one balance moved, one new transaction. */
function healthyResponse(): unknown {
  return {
    accounts: LEDGER.map((account) =>
      providerAccount(
        account,
        account.simplefinAccountId,
        account.id === 'acct_checking'
          ? {
              balance: '4500.55',
              transactions: [
                {
                  id: 'SFT-fresh',
                  posted: POSTED,
                  amount: '-61.45',
                  payee: 'Corner Store',
                  description: 'CORNER STORE 118',
                },
              ],
            }
          : {}
      )
    ),
  };
}

// ── The condition ────────────────────────────────────────────────────────────

test('a rotated-id response writes nothing at all', () => {
  const db = setupLedger();
  const before = snapshotLedger(db);

  const result = applySimplefinResponse(db, rotatedResponse(), NOW);

  assert.equal(result.status, 'relink_pending');
  assert.ok(result.relinkBlock, 'the pass reports the block rather than silently proceeding');
  assert.equal(result.relinkBlock.outcome, 'relink');
  assert.equal(result.relinkBlock.errorCode, 'simplefin_relink_pending');
  assert.equal(result.relinkBlock.syncRunItemStatus, 'skipped');
  assert.equal(result.added, 0);
  assert.equal(result.modified, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.balanceChanges, []);

  const after = snapshotLedger(db);
  assert.deepEqual(after.accounts, before.accounts, 'not one account column moved');
  assert.deepEqual(after.transactions, before.transactions, 'no transaction was written');
  assert.deepEqual(after.holdings, before.holdings);
  assert.deepEqual(after.connection, before.connection, 'last_synced_at was not advanced');

  // Named individually, because a deepEqual that passes for the wrong reason (both sides zeroed)
  // is exactly the failure this file exists for.
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM accounts').n, 3,
    'three accounts, not six');
  const rows = db.prepare(
    'SELECT id, current_balance, backfill_floor_date, account_name, type, type_source, name_source FROM accounts ORDER BY id'
  ).all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => r.current_balance), [120000, 429055, 1000170],
    'no account was zeroed');
  assert.deepEqual(rows.map((r) => r.backfill_floor_date), ['2024-06-01', '2024-01-01', null]);
  assert.deepEqual(rows.map((r) => r.account_name), ['Chase Sapphire', 'Chase Checking', 'Ally Savings']);
  assert.deepEqual(rows.map((r) => r.type), ['credit', 'checking', 'savings']);
  assert.ok(rows.every((r) => r.type_source === 'manual' && r.name_source === 'manual'));
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM transactions').n, 3);

  // The one row the pass does write: the question being put to the owner.
  assert.equal(pendingProposalCount(db), 1);
  db.close();
});

test('a second blocked sync still writes nothing and does not stack proposals', () => {
  const db = setupLedger();
  applySimplefinResponse(db, rotatedResponse(), NOW);
  const afterFirstBlock = snapshotLedger(db);

  const result = applySimplefinResponse(db, rotatedResponse(), '2026-08-01T10:00:00.000Z');

  assert.ok(result.relinkBlock);
  assert.deepEqual(snapshotLedger(db), afterFirstBlock);
  assert.equal(pendingProposalCount(db), 1, 'the pending row is refreshed, never duplicated');
  db.close();
});

test('the run item names the condition, and calls it skipped rather than failed', () => {
  const db = setupLedger();
  db.prepare(`
    INSERT INTO sync_runs (id, scope, status, started_at)
    VALUES ('run_1', 'full', 'running', ?)
  `).run(NOW);

  const result = applySimplefinResponse(db, rotatedResponse(), NOW);
  const stage = recordSimplefinStage(db, 'run_1', result);

  assert.equal(stage.blocked, true);
  // 'skipped', not 'failed' and not 'reauth_required': nothing failed and no login expired, and
  // the second of those would point the owner back at re-linking the bank.
  assert.equal(stage.runItem.status, 'skipped');
  assert.equal(stage.runItem.error_code, 'simplefin_relink_pending');
  assert.equal(stage.runItem.accounts_seen, 3);
  assert.equal(stage.runItem.transactions_added, 0);

  const message = stage.runItem.error_message ?? '';
  assert.match(message, /new provider id/i, 'the item states what happened');
  assert.match(message, /Nothing was written/i);

  const recovery = stage.runItem.recovery_action ?? '';
  assert.match(recovery, /Settings/, 'the recovery action names the screen the owner resolves it on');
  assert.doesNotMatch(recovery, /Retry/i, 'retrying cannot clear this, so it is never offered');

  // The connection itself authenticated and answered, so it is not left carrying a failure. A
  // stale `sync_error` here would keep pointing the owner at a lapsed subscription they renewed.
  assert.equal(stage.connectionStatus, 'active');
  assert.equal(
    one<{ status: string }>(db, "SELECT status FROM simplefin_connections WHERE id = 'simplefin_primary'").status,
    'active'
  );
  db.close();
});

test('describeRelinkBlock states the counts the guard produced', () => {
  const db = setupLedger();
  const result = applySimplefinResponse(db, rotatedResponse(), NOW);
  assert.ok(result.relinkBlock);

  const sentence = describeRelinkBlock(result.relinkBlock);
  assert.match(sentence, new RegExp(`${result.relinkBlock.pairCount} pairing`));
  assert.match(sentence, new RegExp(`${result.relinkBlock.unpairedStoredCount} stored account`));
  assert.match(sentence, new RegExp(`${result.relinkBlock.unpairedProviderCount} provider account`));
  db.close();
});

test('the block clears once the owner adopts, and the next sync writes normally', () => {
  const db = setupLedger();
  const blocked = applySimplefinResponse(db, rotatedResponse(), NOW);
  assert.ok(blocked.relinkBlock);

  const proposal = getPendingRelinkProposal(db);
  assert.ok(proposal);
  const adopted = adoptRelinkPairs(
    db,
    proposal.id,
    proposal.pairs.map((pair) => ({
      storedAccountId: pair.storedAccountId,
      providerAccountId: pair.providerAccountId,
    })),
    NOW
  );
  assert.equal(adopted.ok, true);

  const result = applySimplefinResponse(db, rotatedResponse(), '2026-08-01T11:00:00.000Z');

  assert.equal(result.relinkBlock, null, 'a settled mapping is not a standing block');
  assert.equal(result.status, 'synced');
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM accounts').n, 3);
  assert.equal(result.added, 3, 'the transactions the blocked pass refused now land');
  assert.equal(pendingProposalCount(db), 0);
  db.close();
});

// ── The healthy cases. Each asserts silence. ─────────────────────────────────

test('an ordinary sync with matching ids is completely unaffected', () => {
  const db = setupLedger();
  const result = applySimplefinResponse(db, healthyResponse(), NOW);

  assert.equal(result.relinkBlock, null);
  assert.equal(result.status, 'synced');
  assert.equal(result.accountCount, 3);
  assert.equal(result.added, 1);

  const balances = db.prepare('SELECT id, current_balance FROM accounts ORDER BY id').all() as Array<{ id: string; current_balance: number }>;
  assert.deepEqual(balances, [
    { id: 'acct_card', current_balance: 120000 },
    { id: 'acct_checking', current_balance: 450055 },
    { id: 'acct_savings', current_balance: 1000170 },
  ]);
  assert.equal(
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM transactions WHERE simplefin_transaction_id = 'SFT-fresh'").n,
    1,
    'the new transaction landed'
  );
  assert.equal(
    one<{ last_synced_at: string }>(db, "SELECT last_synced_at FROM simplefin_connections WHERE id = 'simplefin_primary'").last_synced_at,
    NOW
  );
  assert.equal(proposalCount(db), 0, 'a healthy sync leaves nothing for the owner to answer');

  db.prepare(`INSERT INTO sync_runs (id, scope, status, started_at) VALUES ('run_1','full','running',?)`).run(NOW);
  const stage = recordSimplefinStage(db, 'run_1', result);
  assert.equal(stage.blocked, false);
  assert.equal(stage.runItem.status, 'succeeded');
  assert.equal(stage.runItem.error_code, null);
  assert.equal(stage.runItem.error_message, null);
  assert.equal(stage.runItem.recovery_action, null);
  db.close();
});

test('an account closed at the bank is still zeroed, and raises nothing', () => {
  const db = setupLedger();
  // Ally is gone from the response; the other two ids are unchanged. Absence with every other id
  // matching is a closure, which is the case `zeroAccountsMissingFromResponse` already owns.
  const response = {
    accounts: LEDGER.filter((a) => a.id !== 'acct_savings').map((a) => providerAccount(a, a.simplefinAccountId)),
  };

  const result = applySimplefinResponse(db, response, NOW);

  assert.equal(result.relinkBlock, null, 'a closure is not a re-link');
  assert.equal(proposalCount(db), 0);
  assert.equal(
    one<{ current_balance: number }>(db, "SELECT current_balance FROM accounts WHERE id = 'acct_savings'").current_balance,
    0,
    'the closure path still runs'
  );
  assert.equal(result.balanceChanges.length, 1);
  db.close();
});

test('an account newly opened at the bank is inserted, and raises nothing', () => {
  const db = setupLedger();
  const response = {
    accounts: [
      ...LEDGER.map((a) => providerAccount(a, a.simplefinAccountId)),
      {
        id: 'ACT-brand-new',
        name: 'Ally Checking',
        currency: 'USD',
        balance: '250.00',
        org: { name: 'Ally Bank' },
        transactions: [],
      },
    ],
  };

  const result = applySimplefinResponse(db, response, NOW);

  assert.equal(result.relinkBlock, null, 'a new account is not a re-link: every stored id still matched');
  assert.equal(proposalCount(db), 0);
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM accounts').n, 4);
  assert.equal(
    one<{ current_balance: number }>(db, "SELECT current_balance FROM accounts WHERE simplefin_account_id = 'ACT-brand-new'").current_balance,
    25000
  );
  db.close();
});

test('a first connection is not a re-link', () => {
  const db = migratedTestDb();
  db.prepare(`
    INSERT INTO simplefin_connections (id, last_synced_at, status, created_at)
    VALUES ('simplefin_primary', NULL, 'active', '2026-01-01T00:00:00.000Z')
  `).run();

  const response = { accounts: LEDGER.map((a) => providerAccount(a, a.simplefinAccountId)) };
  const result = applySimplefinResponse(db, response, NOW);

  assert.equal(result.relinkBlock, null, 'nothing is stored, so no id could have rotated');
  assert.equal(proposalCount(db), 0);
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM accounts').n, 3);
  db.close();
});

test('a response carrying no accounts blocks nothing and zeroes nothing', () => {
  const db = setupLedger();
  const before = snapshotLedger(db);

  const result = applySimplefinResponse(db, { accounts: [] }, NOW);

  assert.equal(result.relinkBlock, null, 'total absence says nothing about the stored ids');
  assert.equal(proposalCount(db), 0);
  assert.deepEqual(
    db.prepare('SELECT id, current_balance FROM accounts ORDER BY id').all(),
    (before.accounts as Array<{ id: string; current_balance: number }>).map((a) => ({ id: a.id, current_balance: a.current_balance })),
    'the empty-200 guard still holds the balances'
  );
  db.close();
});

test('an unreadable response still fails rather than reaching the gate', () => {
  const db = setupLedger();
  assert.throws(
    () => applySimplefinResponse(db, { status: 'maintenance' }, NOW),
    /no accounts array/
  );
  assert.equal(proposalCount(db), 0, 'a response the parser refused raises no question about ids');
  db.close();
});
