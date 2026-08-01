import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  RELINK_OUTCOMES,
  adoptRelinkPairs,
  detectSimplefinRelink,
  dismissRelinkProposal,
  getPendingRelinkProposal,
  getRelinkProposal,
  guardSimplefinRelink,
  proposeSimplefinPairing,
  readStoredSimplefinAccounts,
  toProviderSnapshot,
  toRelinkProposalView,
  type ProviderAccountSnapshot,
} from '../server/src/services/simplefinRelink';
import { insertAccount, migratedTestDb } from './helpers/schema';

const NOW = '2026-08-01T12:00:00.000Z';

/**
 * A stored SimpleFIN account carrying the five columns adoption exists to protect.
 *
 * `insertAccount` covers the NOT NULLs; the provider id, currency, backfill floor and the two
 * `*_source` columns are set here because those are exactly the values the 2026-08-01 incident
 * destroyed and the ones every adoption test reads back.
 */
function linkedAccount(
  db: Database.Database,
  fields: {
    id?: string;
    providerId: string;
    accountName: string;
    institutionName: string;
    type?: string;
    balanceCents?: number;
    isLiability?: boolean;
    currency?: string;
    nameSource?: string;
    typeSource?: string;
    backfillFloorDate?: string | null;
  }
): string {
  const id = insertAccount(db, {
    id: fields.id,
    account_name: fields.accountName,
    institution_name: fields.institutionName,
    type: fields.type ?? 'checking',
    connection_type: 'simplefin',
    current_balance: fields.balanceCents ?? 0,
    is_liability: fields.isLiability ? 1 : 0,
    is_manual: 0,
  });
  db.prepare(`
    UPDATE accounts
    SET simplefin_account_id = ?, connection_id = 'simplefin_primary', currency = ?,
        name_source = ?, type_source = ?, backfill_floor_date = ?
    WHERE id = ?
  `).run(
    fields.providerId,
    fields.currency ?? 'USD',
    fields.nameSource ?? 'manual',
    fields.typeSource ?? 'manual',
    fields.backfillFloorDate ?? null,
    id
  );
  return id;
}

function provider(
  id: string,
  name: string,
  institutionName: string,
  balanceCents: number | null = 0,
  currency = 'USD'
): ProviderAccountSnapshot {
  return { id, name, institutionName, currency, balanceCents };
}

function proposalCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM simplefin_relink_proposals').get() as { n: number }).n;
}

// ── The healthy cases ────────────────────────────────────────────────────────
// A detector that speaks on an ordinary sync is a broken detector. Every one of these asserts
// silence: outcome 'none', no proposal row written, and the sync free to proceed.

test('HEALTHY: an ordinary sync where every provider id matches a stored id detects nothing', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  linkedAccount(db, { providerId: 'ACT-2', accountName: 'Chase Savings', institutionName: 'Chase' });
  linkedAccount(db, { providerId: 'ACT-3', accountName: 'Amex Gold', institutionName: 'Amex', isLiability: true, type: 'credit' });

  const detection = detectSimplefinRelink(db, [
    provider('ACT-1', 'Chase Checking', 'Chase'),
    provider('ACT-2', 'Chase Savings', 'Chase'),
    provider('ACT-3', 'Amex Gold', 'Amex'),
  ]);

  assert.equal(detection.outcome, 'none');
  assert.deepEqual(detection.unmatchedProviderIds, []);
  assert.deepEqual(detection.unmatchedStoredAccountIds, []);

  const guard = guardSimplefinRelink(db, [
    provider('ACT-1', 'Chase Checking', 'Chase'),
    provider('ACT-2', 'Chase Savings', 'Chase'),
    provider('ACT-3', 'Amex Gold', 'Amex'),
  ], NOW);
  assert.equal(guard.proceed, true);
  assert.equal(proposalCount(db), 0);
  db.close();
});

test('HEALTHY: a first-ever connection with zero stored accounts is not a re-link', () => {
  const db = migratedTestDb();

  const detection = detectSimplefinRelink(db, [
    provider('ACT-1', 'Chase Checking', 'Chase'),
    provider('ACT-2', 'Chase Savings', 'Chase'),
  ]);
  assert.equal(detection.outcome, 'none');
  assert.match(detection.reason, /first connection/);

  const guard = guardSimplefinRelink(db, [provider('ACT-1', 'Chase Checking', 'Chase')], NOW);
  assert.equal(guard.proceed, true);
  assert.equal(proposalCount(db), 0);
  db.close();
});

test('HEALTHY: an empty response is not a re-link', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });

  const detection = detectSimplefinRelink(db, []);
  assert.equal(detection.outcome, 'none');
  assert.match(detection.reason, /no accounts at all/);

  const guard = guardSimplefinRelink(db, [], NOW);
  assert.equal(guard.proceed, true);
  assert.equal(proposalCount(db), 0);
  db.close();
});

test('HEALTHY: an account closed at the bank leaves stored unmatched and is still silent', () => {
  // The ordinary closure. Every provider id still matches; one stored account simply stops being
  // mentioned. zeroAccountsMissingFromResponse already owns this, and a second detector firing on
  // it would put a standing finding on the screen for an event the owner already handled.
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  const closed = linkedAccount(db, { providerId: 'ACT-2', accountName: 'Old Savings', institutionName: 'Chase' });

  const detection = detectSimplefinRelink(db, [provider('ACT-1', 'Chase Checking', 'Chase')]);
  assert.equal(detection.outcome, 'none');
  assert.deepEqual(detection.unmatchedStoredAccountIds, [closed]);
  assert.deepEqual(detection.unmatchedProviderIds, []);

  assert.equal(guardSimplefinRelink(db, [provider('ACT-1', 'Chase Checking', 'Chase')], NOW).proceed, true);
  assert.equal(proposalCount(db), 0);
  db.close();
});

test('HEALTHY: a new account opened at the bank is an addition, not a re-link', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });

  const accounts = [provider('ACT-1', 'Chase Checking', 'Chase'), provider('ACT-9', 'Chase Sapphire', 'Chase')];
  const detection = detectSimplefinRelink(db, accounts);
  assert.equal(detection.outcome, 'none');
  assert.deepEqual(detection.unmatchedProviderIds, ['ACT-9']);
  assert.deepEqual(detection.unmatchedStoredAccountIds, []);

  assert.equal(guardSimplefinRelink(db, accounts, NOW).proceed, true);
  assert.equal(proposalCount(db), 0);
  db.close();
});

test('HEALTHY: a Coinbase-linked and a manual account are not stored SimpleFIN accounts', () => {
  // readStoredSimplefinAccounts is the population zeroAccountsMissingFromResponse walks. If it
  // widened to every account, a manual ledger would read as nine unmatched stored accounts and
  // every first SimpleFIN connection would report a partial re-link.
  const db = migratedTestDb();
  insertAccount(db, { account_name: 'Cash tin', connection_type: 'manual' });
  const coinbase = insertAccount(db, { account_name: 'BTC', connection_type: 'coinbase' });
  db.prepare('UPDATE accounts SET coinbase_account_id = ? WHERE id = ?').run('cb-1', coinbase);

  assert.deepEqual(readStoredSimplefinAccounts(db), []);
  assert.equal(detectSimplefinRelink(db, [provider('ACT-1', 'Chase Checking', 'Chase')]).outcome, 'none');
  db.close();
});

// ── Detection ────────────────────────────────────────────────────────────────

test('a full rotation of every id IS a re-link', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  linkedAccount(db, { providerId: 'ACT-2', accountName: 'Chase Savings', institutionName: 'Chase' });
  linkedAccount(db, { providerId: 'ACT-3', accountName: 'Amex Gold', institutionName: 'Amex', isLiability: true, type: 'credit' });

  const detection = detectSimplefinRelink(db, [
    provider('ACT-77', 'Chase Checking', 'Chase'),
    provider('ACT-78', 'Chase Savings', 'Chase'),
    provider('ACT-79', 'Amex Gold', 'Amex'),
  ]);

  assert.equal(detection.outcome, 'relink');
  assert.equal(detection.matchedProviderIds.length, 0);
  assert.equal(detection.unmatchedProviderIds.length, 3);
  assert.equal(detection.unmatchedStoredAccountIds.length, 3);
  assert.equal(RELINK_OUTCOMES.relink.blocksSync, true);
  db.close();
});

test('a partial overlap is reported as partial and never auto-paired', () => {
  const db = migratedTestDb();
  const chase = linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  linkedAccount(db, { providerId: 'ACT-2', accountName: 'Amex Gold', institutionName: 'Amex', isLiability: true, type: 'credit' });

  const accounts = [
    provider('ACT-2', 'Amex Gold', 'Amex'),
    provider('ACT-55', 'Chase Checking', 'Chase'),
  ];
  const detection = detectSimplefinRelink(db, accounts);
  assert.equal(detection.outcome, 'partial');
  assert.deepEqual(detection.matchedProviderIds, ['ACT-2']);
  assert.deepEqual(detection.unmatchedProviderIds, ['ACT-55']);
  assert.deepEqual(detection.unmatchedStoredAccountIds, [chase]);

  const guard = guardSimplefinRelink(db, accounts, NOW);
  assert.equal(guard.proceed, false);

  // A pairing was proposed and NOTHING was applied: the stored row still holds its dead id.
  const stored = db.prepare('SELECT simplefin_account_id FROM accounts WHERE id = ?').get(chase) as { simplefin_account_id: string };
  assert.equal(stored.simplefin_account_id, 'ACT-1');

  const pending = getPendingRelinkProposal(db);
  assert.ok(pending);
  assert.equal(pending.outcome, 'partial');
  assert.equal(pending.pairs.length, 1);
  assert.equal(pending.pairs[0].providerAccountId, 'ACT-55');
  // The account that matched cleanly is not put in question by the ones that did not.
  assert.deepEqual(pending.unpairedStored, []);
  assert.deepEqual(pending.unpairedProvider, []);
  db.close();
});

test('a provider id a resolved proposal already settled stops being evidence', () => {
  const db = migratedTestDb();
  const chase = linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  linkedAccount(db, { providerId: 'ACT-2', accountName: 'Amex Gold', institutionName: 'Amex' });

  const accounts = [provider('ACT-2', 'Amex Gold', 'Amex'), provider('ACT-55', 'New Brokerage', 'Fidelity')];
  const first = guardSimplefinRelink(db, accounts, NOW);
  assert.equal(first.proceed, false);

  const dismissed = dismissRelinkProposal(db, (first as { block: { proposalId: string } }).block.proposalId, 'These are new accounts.', NOW);
  assert.equal(dismissed.ok, true);

  // Same response, next hour. The condition is unchanged, and the owner has already answered it.
  const second = detectSimplefinRelink(db, accounts);
  assert.equal(second.outcome, 'none');
  assert.deepEqual(second.acknowledgedProviderIds, ['ACT-55']);
  assert.equal(guardSimplefinRelink(db, accounts, NOW).proceed, true);
  assert.equal(chase.length > 0, true);
  db.close();
});

// ── Pairing ──────────────────────────────────────────────────────────────────

test('pairing proposes on institution, name and currency, and states its reason', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase', balanceCents: 123456 });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs, unpairedStored, unpairedProvider } = proposeSimplefinPairing(
    [provider('ACT-77', 'Chase Checking', 'Chase', 123456)],
    stored
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].strength, 'exact');
  assert.deepEqual(pairs[0].evidence, [
    'institution_name_match',
    'account_name_match',
    'currency_match',
    'balance_match',
  ]);
  assert.match(pairs[0].reason, /Chase Checking/);
  assert.match(pairs[0].reason, /same institution, the same name and the same currency/);
  assert.deepEqual(unpairedStored, []);
  assert.deepEqual(unpairedProvider, []);
  db.close();
});

test('a liability balance is compared in the provider sign convention, both directions', () => {
  const db = migratedTestDb();
  // $1,204.11 owed is stored +120411; the provider reports it as -1204.11.
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Card A', institutionName: 'Amex', isLiability: true, type: 'credit', balanceCents: 120411 });
  // A card in credit is legitimately negative when stored; the provider reports it positive.
  linkedAccount(db, { providerId: 'ACT-2', accountName: 'Card B', institutionName: 'Amex', isLiability: true, type: 'credit', balanceCents: -56326 });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs } = proposeSimplefinPairing(
    [provider('ACT-77', 'Card A', 'Amex', -120411), provider('ACT-78', 'Card B', 'Amex', 56326)],
    stored
  );

  const byProvider = new Map(pairs.map((p) => [p.providerAccountId, p]));
  assert.ok(byProvider.get('ACT-77')?.evidence.includes('balance_match'));
  assert.ok(byProvider.get('ACT-78')?.evidence.includes('balance_match'));
  db.close();
});

test('two equally good candidates are refused, not resolved by picking one', () => {
  const db = migratedTestDb();
  // Two identically named accounts at one institution, identical balances. Nothing separates them.
  linkedAccount(db, { id: 'a_one', providerId: 'ACT-1', accountName: 'Savings', institutionName: 'Ally', balanceCents: 500000 });
  linkedAccount(db, { id: 'a_two', providerId: 'ACT-2', accountName: 'Savings', institutionName: 'Ally', balanceCents: 500000 });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs, unpairedStored, unpairedProvider } = proposeSimplefinPairing(
    [provider('ACT-77', 'Savings', 'Ally', 500000), provider('ACT-78', 'Savings', 'Ally', 500000)],
    stored
  );

  assert.deepEqual(pairs, []);
  assert.equal(unpairedStored.length, 2);
  assert.ok(unpairedStored.every((u) => u.reasonCode === 'ambiguous'));
  assert.equal(unpairedProvider.length, 2);
  assert.ok(unpairedProvider.every((u) => u.reasonCode === 'ambiguous'));
  db.close();
});

test('the balance separates two otherwise identical candidates, and says so', () => {
  const db = migratedTestDb();
  linkedAccount(db, { id: 'a_one', providerId: 'ACT-1', accountName: 'Savings', institutionName: 'Ally', balanceCents: 500000 });
  linkedAccount(db, { id: 'a_two', providerId: 'ACT-2', accountName: 'Savings', institutionName: 'Ally', balanceCents: 900000 });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs, unpairedStored } = proposeSimplefinPairing(
    [provider('ACT-77', 'Savings', 'Ally', 500000), provider('ACT-78', 'Savings', 'Ally', 900000)],
    stored
  );

  assert.equal(pairs.length, 2);
  assert.deepEqual(unpairedStored, []);
  const one = pairs.find((p) => p.storedAccountId === 'a_one');
  assert.equal(one?.providerAccountId, 'ACT-77');
  assert.match(one?.reason ?? '', /only one whose balance matches/);
  db.close();
});

test('an account closed at the bank is left unpaired and does not block the real pairs', () => {
  const db = migratedTestDb();
  linkedAccount(db, { id: 'a_live', providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  linkedAccount(db, { id: 'a_gone', providerId: 'ACT-2', accountName: 'Wells Fargo Checking', institutionName: 'Wells Fargo' });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs, unpairedStored, unpairedProvider } = proposeSimplefinPairing(
    [provider('ACT-77', 'Chase Checking', 'Chase')],
    stored
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].storedAccountId, 'a_live');
  assert.equal(unpairedStored.length, 1);
  assert.equal(unpairedStored[0].accountId, 'a_gone');
  assert.equal(unpairedStored[0].reasonCode, 'no_candidate');
  assert.match(unpairedStored[0].reason, /closed at the bank/);
  assert.deepEqual(unpairedProvider, []);
  db.close();
});

test('a renamed account at one institution pairs on being the only one left, and says so', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Rainy day fund', institutionName: 'Ally' });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs } = proposeSimplefinPairing([provider('ACT-77', 'Online Savings', 'Ally')], stored);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].strength, 'inferred');
  assert.ok(pairs[0].evidence.includes('sole_unmatched_at_institution'));
  assert.match(pairs[0].reason, /rests on the institution alone/);
  db.close();
});

test('an account-number mask pairs across a reworded name', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Checking ...4021', institutionName: 'Chase' });
  linkedAccount(db, { providerId: 'ACT-2', accountName: 'Checking ...9915', institutionName: 'Chase' });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs } = proposeSimplefinPairing(
    [provider('ACT-77', 'TOTAL CHECKING 9915', 'Chase'), provider('ACT-78', 'TOTAL CHECKING 4021', 'Chase')],
    stored
  );

  const byStored = new Map(pairs.map((p) => [p.storedAccountName, p.providerAccountId]));
  assert.equal(byStored.get('Checking ...4021'), 'ACT-78');
  assert.equal(byStored.get('Checking ...9915'), 'ACT-77');
  assert.ok(pairs.every((p) => p.evidence.includes('account_number_mask_match')));
  db.close();
});

test('nothing pairs across a currency change without saying the currency changed', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Travel', institutionName: 'Wise', currency: 'USD' });
  const stored = readStoredSimplefinAccounts(db);

  const { pairs } = proposeSimplefinPairing([provider('ACT-77', 'Travel', 'Wise', 0, 'EUR')], stored);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].strength, 'inferred');
  assert.ok(pairs[0].evidence.includes('currency_differs'));
  assert.match(pairs[0].reason, /currency changing is unexplained/);
  db.close();
});

// ── Adoption ─────────────────────────────────────────────────────────────────

test('adoption changes simplefin_account_id and nothing else', () => {
  const db = migratedTestDb();
  const id = linkedAccount(db, {
    providerId: 'ACT-1',
    accountName: 'Sapphire Reserve',
    institutionName: 'Chase',
    type: 'credit',
    isLiability: true,
    balanceCents: 120411,
    nameSource: 'manual',
    typeSource: 'manual',
    backfillFloorDate: '2024-01-01',
  });
  const before = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown>;

  const guard = guardSimplefinRelink(db, [provider('ACT-77', 'Sapphire Reserve', 'Chase', -120411)], NOW);
  assert.equal(guard.proceed, false);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  const result = adoptRelinkPairs(db, proposalId, [{ storedAccountId: id, providerAccountId: 'ACT-77' }], NOW);
  assert.equal(result.ok, true);

  const after = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(after.simplefin_account_id, 'ACT-77');
  // The five columns the 2026-08-01 incident destroyed, plus everything else on the row.
  for (const column of Object.keys(before)) {
    if (column === 'simplefin_account_id' || column === 'updated_at') continue;
    assert.deepEqual(after[column], before[column], `${column} moved during adoption`);
  }
  assert.equal(after.account_name, 'Sapphire Reserve');
  assert.equal(after.type, 'credit');
  assert.equal(after.type_source, 'manual');
  assert.equal(after.name_source, 'manual');
  assert.equal(after.backfill_floor_date, '2024-01-01');
  assert.equal(after.current_balance, 120411);
  db.close();
});

test('adoption keeps every transaction on the account it was already on', () => {
  const db = migratedTestDb();
  const id = linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, original_name, source_type, created_at, updated_at)
    VALUES ('t1', ?, '2026-07-01', -1234, 'coffee', 'simplefin', ?, ?)
  `).run(id, NOW, NOW);

  const guard = guardSimplefinRelink(db, [provider('ACT-77', 'Chase Checking', 'Chase')], NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;
  assert.equal(adoptRelinkPairs(db, proposalId, [{ storedAccountId: id, providerAccountId: 'ACT-77' }], NOW).ok, true);

  const row = db.prepare('SELECT account_id FROM transactions WHERE id = ?').get('t1') as { account_id: string };
  assert.equal(row.account_id, id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n, 1);
  db.close();
});

test('adoption is idempotent', () => {
  const db = migratedTestDb();
  const id = linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  const accounts = [provider('ACT-77', 'Chase Checking', 'Chase')];

  const first = guardSimplefinRelink(db, accounts, NOW);
  const firstId = (first as { block: { proposalId: string } }).block.proposalId;
  const firstResult = adoptRelinkPairs(db, firstId, [{ storedAccountId: id, providerAccountId: 'ACT-77' }], NOW);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.ok && firstResult.adoptions[0].outcome, 'adopted');
  assert.equal(firstResult.ok && firstResult.adoptions[0].previousSimplefinAccountId, 'ACT-1');

  // Once adopted, the ids match, so the same response no longer raises anything at all.
  const second = guardSimplefinRelink(db, accounts, NOW);
  assert.equal(second.proceed, true);

  // And replaying the confirmation against the resolved proposal is a refusal, not a second write.
  const replay = adoptRelinkPairs(db, firstId, [{ storedAccountId: id, providerAccountId: 'ACT-77' }], NOW);
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.reason, 'proposal_not_pending');
  assert.equal(
    (db.prepare('SELECT simplefin_account_id FROM accounts WHERE id = ?').get(id) as { simplefin_account_id: string }).simplefin_account_id,
    'ACT-77'
  );
  db.close();
});

test('confirming a pair the row already holds is a no-op, not a duplicate write', () => {
  const db = migratedTestDb();
  const kept = linkedAccount(db, { id: 'a_kept', providerId: 'ACT-2', accountName: 'Amex Gold', institutionName: 'Amex' });
  const moved = linkedAccount(db, { id: 'a_moved', providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });

  const accounts = [provider('ACT-2', 'Amex Gold', 'Amex'), provider('ACT-77', 'Chase Checking', 'Chase')];
  const guard = guardSimplefinRelink(db, accounts, NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  const result = adoptRelinkPairs(db, proposalId, [
    { storedAccountId: kept, providerAccountId: 'ACT-2' },
    { storedAccountId: moved, providerAccountId: 'ACT-77' },
  ], NOW);

  assert.equal(result.ok, true);
  const outcomes = result.ok ? new Map(result.adoptions.map((a) => [a.storedAccountId, a.outcome])) : new Map();
  assert.equal(outcomes.get('a_kept'), 'already_adopted');
  assert.equal(outcomes.get('a_moved'), 'adopted');
  db.close();
});

test('adoption refuses a provider id another account already holds, and writes nothing', () => {
  // The proposal is raised while ACT-77 belongs to nobody, and something else claims it before the
  // owner confirms: another account adopted it, or a merge moved it. A confirmation carrying stale
  // evidence must not quietly take the id off whichever row the provider is actually talking to.
  const db = migratedTestDb();
  const claimant = linkedAccount(db, { id: 'a_claimant', providerId: 'ACT-1', accountName: 'Chase Savings', institutionName: 'Chase' });
  const holder = linkedAccount(db, { id: 'a_holder', providerId: 'ACT-2', accountName: 'Chase Checking', institutionName: 'Chase' });

  const guard = guardSimplefinRelink(db, [provider('ACT-77', 'Chase Savings', 'Chase')], NOW);
  assert.equal(guard.proceed, false);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  db.prepare('UPDATE accounts SET simplefin_account_id = ? WHERE id = ?').run('ACT-77', holder);

  const result = adoptRelinkPairs(db, proposalId, [{ storedAccountId: claimant, providerAccountId: 'ACT-77' }], NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'contested_provider_id');
  assert.equal(result.ok === false && result.details.includes(holder), true);

  assert.equal(
    (db.prepare('SELECT simplefin_account_id FROM accounts WHERE id = ?').get(holder) as { simplefin_account_id: string }).simplefin_account_id,
    'ACT-77'
  );
  assert.equal(
    (db.prepare('SELECT simplefin_account_id FROM accounts WHERE id = ?').get(claimant) as { simplefin_account_id: string }).simplefin_account_id,
    'ACT-1'
  );
  assert.equal(getPendingRelinkProposal(db)?.id, proposalId, 'a refused adoption must leave the proposal pending');
  db.close();
});

test('a batch that rotates ids among its own accounts releases before it claims', () => {
  // UNIQUE plus no deferred constraints. Claiming B's id for A while B still holds it throws, which
  // is the trap mergeAccounts had to learn. Swapping two accounts is the smallest case that hits it.
  const db = migratedTestDb();
  const a = linkedAccount(db, { id: 'a_one', providerId: 'ACT-1', accountName: 'One', institutionName: 'Bank', balanceCents: 100 });
  const b = linkedAccount(db, { id: 'a_two', providerId: 'ACT-2', accountName: 'Two', institutionName: 'Bank', balanceCents: 200 });

  const guard = guardSimplefinRelink(db, [
    provider('ACT-9', 'One', 'Bank', 100),
    provider('ACT-8', 'Two', 'Bank', 200),
  ], NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  // Deliberately confirmed in an order where the naive write would collide on the intermediate step.
  const result = adoptRelinkPairs(db, proposalId, [
    { storedAccountId: a, providerAccountId: 'ACT-8' },
    { storedAccountId: b, providerAccountId: 'ACT-9' },
  ], NOW);

  assert.equal(result.ok, true);
  const ids = db.prepare('SELECT id, simplefin_account_id FROM accounts ORDER BY id').all() as Array<{ id: string; simplefin_account_id: string }>;
  assert.deepEqual(ids, [
    { id: 'a_one', simplefin_account_id: 'ACT-8' },
    { id: 'a_two', simplefin_account_id: 'ACT-9' },
  ]);
  db.close();
});

test('an invalid pair anywhere in the batch refuses the whole batch', () => {
  const db = migratedTestDb();
  const good = linkedAccount(db, { id: 'a_good', providerId: 'ACT-1', accountName: 'One', institutionName: 'Bank' });
  linkedAccount(db, { id: 'a_other', providerId: 'ACT-2', accountName: 'Two', institutionName: 'Bank' });

  const guard = guardSimplefinRelink(db, [provider('ACT-9', 'One', 'Bank'), provider('ACT-8', 'Two', 'Bank')], NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  const result = adoptRelinkPairs(db, proposalId, [
    { storedAccountId: good, providerAccountId: 'ACT-9' },
    { storedAccountId: 'no_such_account', providerAccountId: 'ACT-8' },
  ], NOW);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unknown_stored_account');
  assert.equal(
    (db.prepare('SELECT simplefin_account_id FROM accounts WHERE id = ?').get(good) as { simplefin_account_id: string }).simplefin_account_id,
    'ACT-1',
    'the valid half of a refused batch must not be applied'
  );
  db.close();
});

test('adoption refuses a provider id the proposal never recorded', () => {
  const db = migratedTestDb();
  const id = linkedAccount(db, { providerId: 'ACT-1', accountName: 'One', institutionName: 'Bank' });
  const guard = guardSimplefinRelink(db, [provider('ACT-9', 'One', 'Bank')], NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  const result = adoptRelinkPairs(db, proposalId, [{ storedAccountId: id, providerAccountId: 'ACT-INVENTED' }], NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'provider_account_not_in_snapshot');
  db.close();
});

test('adoption refuses to turn a manual or Coinbase account into a SimpleFIN one', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'One', institutionName: 'Bank' });
  const manual = insertAccount(db, { account_name: 'Cash tin', connection_type: 'manual' });
  const guard = guardSimplefinRelink(db, [provider('ACT-9', 'One', 'Bank')], NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  const result = adoptRelinkPairs(db, proposalId, [{ storedAccountId: manual, providerAccountId: 'ACT-9' }], NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'stored_account_not_simplefin');
  db.close();
});

test('adopting some pairs and leaving others acknowledges both decisions', () => {
  const db = migratedTestDb();
  const kept = linkedAccount(db, { id: 'a_kept', providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  linkedAccount(db, { id: 'a_closed', providerId: 'ACT-2', accountName: 'Wells Checking', institutionName: 'Wells Fargo' });

  const accounts = [provider('ACT-9', 'Chase Checking', 'Chase'), provider('ACT-8', 'Fidelity Brokerage', 'Fidelity')];
  const guard = guardSimplefinRelink(db, accounts, NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  const result = adoptRelinkPairs(db, proposalId, [{ storedAccountId: kept, providerAccountId: 'ACT-9' }], NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.leftUnpairedStoredAccountIds, ['a_closed']);
  assert.deepEqual(result.ok && result.leftUnpairedProviderAccountIds, ['ACT-8']);

  const applied = getRelinkProposal(db, proposalId);
  assert.equal(applied?.status, 'applied');
  assert.equal(applied?.appliedPairs?.length, 1);
  assert.ok(applied?.acknowledgedProviderIds?.includes('ACT-8'));

  // The next sync must be silent: ACT-9 is now a stored id and ACT-8 has been ruled on.
  assert.equal(detectSimplefinRelink(db, accounts).outcome, 'none');
  assert.equal(guardSimplefinRelink(db, accounts, NOW).proceed, true);
  db.close();
});

// ── The sync guard ───────────────────────────────────────────────────────────

test('a pending proposal keeps blocking, and does not accumulate rows', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  const accounts = [provider('ACT-77', 'Chase Checking', 'Chase')];

  const first = guardSimplefinRelink(db, accounts, NOW);
  const second = guardSimplefinRelink(db, accounts, '2026-08-01T13:00:00.000Z');
  assert.equal(first.proceed, false);
  assert.equal(second.proceed, false);
  assert.equal(proposalCount(db), 1);
  assert.equal(
    (first as { block: { proposalId: string } }).block.proposalId,
    (second as { block: { proposalId: string } }).block.proposalId
  );
  db.close();
});

test('a pending proposal is refreshed against the response actually in hand', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });

  guardSimplefinRelink(db, [provider('ACT-77', 'Chase Checking', 'Chase')], NOW);
  guardSimplefinRelink(db, [provider('ACT-88', 'Chase Checking', 'Chase')], '2026-08-01T13:00:00.000Z');

  const pending = getPendingRelinkProposal(db);
  assert.equal(pending?.detectedAt, '2026-08-01T13:00:00.000Z');
  assert.equal(pending?.pairs[0].providerAccountId, 'ACT-88');
  assert.equal(proposalCount(db), 1);
  db.close();
});

test('a pending proposal whose condition cleared is resolved, not left standing', () => {
  // The provider went back to the old ids (or the owner fixed it at the bridge). A finding that
  // outlives its cause is a standing finding the owner cannot act on.
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });

  const blocked = guardSimplefinRelink(db, [provider('ACT-77', 'Chase Checking', 'Chase')], NOW);
  assert.equal(blocked.proceed, false);
  const proposalId = (blocked as { block: { proposalId: string } }).block.proposalId;

  const cleared = guardSimplefinRelink(db, [provider('ACT-1', 'Chase Checking', 'Chase')], '2026-08-01T14:00:00.000Z');
  assert.equal(cleared.proceed, true);
  assert.equal(cleared.proceed === true && cleared.clearedProposalId, proposalId);
  assert.equal(getPendingRelinkProposal(db), null);
  assert.equal(getRelinkProposal(db, proposalId)?.status, 'dismissed');
  // The auto-resolution acknowledges nothing, so a genuine re-link later is still detectable.
  assert.deepEqual(getRelinkProposal(db, proposalId)?.acknowledgedProviderIds, []);
  db.close();
});

test('the block names the recovery action and does not claim a provider failure', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  const guard = guardSimplefinRelink(db, [provider('ACT-77', 'Chase Checking', 'Chase')], NOW);
  assert.equal(guard.proceed, false);
  const block = (guard as { block: { syncRunItemStatus: string; recoveryAction: string; errorCode: string; pairCount: number } }).block;

  assert.equal(block.syncRunItemStatus, 'skipped');
  assert.equal(block.errorCode, 'simplefin_relink_pending');
  assert.equal(block.pairCount, 1);
  assert.match(block.recoveryAction, /Settings/);
  assert.doesNotMatch(block.recoveryAction, /re-?auth|setup token/i);
  db.close();
});

test('dismissal lets the sync proceed and does not come back', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Old Chase', institutionName: 'Chase' });
  const accounts = [provider('ACT-77', 'New Chase', 'Chase')];

  const guard = guardSimplefinRelink(db, accounts, NOW);
  const proposalId = (guard as { block: { proposalId: string } }).block.proposalId;

  const dismissed = dismissRelinkProposal(db, proposalId, 'The old account really was closed.', NOW);
  assert.equal(dismissed.ok, true);
  assert.deepEqual(dismissed.ok && dismissed.acknowledgedProviderIds, ['ACT-77']);
  assert.equal(getPendingRelinkProposal(db), null);

  assert.equal(guardSimplefinRelink(db, accounts, '2026-08-01T15:00:00.000Z').proceed, true);
  assert.equal(proposalCount(db), 1);

  const replay = dismissRelinkProposal(db, proposalId, 'again', NOW);
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.reason, 'proposal_not_pending');
  db.close();
});

// ── The 2026-08-01 shape, end to end ─────────────────────────────────────────

test('nine accounts re-minted at once: nothing is written until the pairing is confirmed', () => {
  const db = migratedTestDb();
  const names: Array<[string, string, string, boolean]> = [
    ['Chase Checking', 'Chase', 'checking', false],
    ['Chase Savings', 'Chase', 'savings', false],
    ['Sapphire Reserve', 'Chase', 'credit', true],
    ['Amex Gold', 'Amex', 'credit', true],
    ['Ally Online Savings', 'Ally', 'savings', false],
    ['Fidelity Brokerage', 'Fidelity', 'brokerage', false],
    ['Fidelity Roth', 'Fidelity', 'ira_roth', false],
    ['Discover it', 'Discover', 'credit', true],
    ['Schwab Checking', 'Schwab', 'checking', false],
  ];
  const storedIds = names.map(([name, institution, type, liability], i) =>
    linkedAccount(db, {
      id: `a_${i}`,
      providerId: `ACT-OLD-${i}`,
      accountName: name,
      institutionName: institution,
      type,
      isLiability: liability,
      balanceCents: (i + 1) * 10000,
      backfillFloorDate: '2024-01-01',
    })
  );
  const response = names.map(([name, institution], i) => provider(`ACT-NEW-${i}`, name, institution));

  const guard = guardSimplefinRelink(db, response, NOW);
  assert.equal(guard.proceed, false);
  const block = (guard as { block: { proposalId: string; outcome: string; pairCount: number } }).block;
  assert.equal(block.outcome, 'relink');
  assert.equal(block.pairCount, 9);

  // Still nine accounts, still their old ids, nothing zeroed.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n, 9);
  const balances = db.prepare('SELECT current_balance FROM accounts ORDER BY id').all() as Array<{ current_balance: number }>;
  assert.deepEqual(balances.map((b) => b.current_balance), [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000]);

  const pending = getPendingRelinkProposal(db);
  assert.ok(pending);
  assert.ok(pending.pairs.every((p) => p.reason.length > 0), 'every pair must state why it was proposed');

  const result = adoptRelinkPairs(
    db,
    block.proposalId,
    pending.pairs.map((p) => ({ storedAccountId: p.storedAccountId, providerAccountId: p.providerAccountId })),
    NOW
  );
  assert.equal(result.ok, true);

  // Nine accounts, not eighteen; every floor and every curated name intact.
  const after = db.prepare('SELECT id, simplefin_account_id, account_name, type, name_source, type_source, backfill_floor_date FROM accounts ORDER BY id').all() as Array<Record<string, unknown>>;
  assert.equal(after.length, 9);
  after.forEach((row, i) => {
    assert.equal(row.id, storedIds[i]);
    assert.equal(row.simplefin_account_id, `ACT-NEW-${i}`);
    assert.equal(row.account_name, names[i][0]);
    assert.equal(row.type, names[i][2]);
    assert.equal(row.name_source, 'manual');
    assert.equal(row.type_source, 'manual');
    assert.equal(row.backfill_floor_date, '2024-01-01');
  });

  assert.equal(guardSimplefinRelink(db, response, '2026-08-01T16:00:00.000Z').proceed, true);
  db.close();
});

// ── Boundaries ───────────────────────────────────────────────────────────────

test('toProviderSnapshot keeps an unparseable balance null rather than NaN or zero', () => {
  const ok = toProviderSnapshot({ id: 'ACT-1', name: 'Checking', balance: '1234.56', org: { name: 'Chase' } });
  assert.equal(ok.balanceCents, 123456);
  assert.equal(ok.institutionName, 'Chase');
  assert.equal(ok.currency, 'USD');

  const bad = toProviderSnapshot({ id: 'ACT-2', name: 'Checking', balance: 'n/a' });
  assert.equal(bad.balanceCents, null);
  assert.equal(bad.institutionName, 'SimpleFIN');
});

test('a provider balance that did not parse is not compared, and the pair says so', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Checking', institutionName: 'Chase', balanceCents: 0 });
  const { pairs } = proposeSimplefinPairing([provider('ACT-77', 'Checking', 'Chase', null)], readStoredSimplefinAccounts(db));

  assert.equal(pairs.length, 1);
  assert.ok(!pairs[0].evidence.includes('balance_match'), 'a null balance must not match a zero balance');
  assert.match(pairs[0].reason, /did not parse/);
  db.close();
});

test('the API view divides cents to dollars exactly once', () => {
  const db = migratedTestDb();
  linkedAccount(db, { providerId: 'ACT-1', accountName: 'Card', institutionName: 'Amex', isLiability: true, type: 'credit', balanceCents: 120411 });
  const guard = guardSimplefinRelink(db, [provider('ACT-77', 'Card', 'Amex', -120411)], NOW);
  const proposal = getRelinkProposal(db, (guard as { block: { proposalId: string } }).block.proposalId);
  assert.ok(proposal);

  const view = toRelinkProposalView(proposal);
  assert.equal(view.stored_accounts[0].balance, 1204.11);
  assert.equal(view.stored_accounts[0].is_liability, true);
  assert.equal(view.provider_accounts[0].balance, -1204.11);
  assert.equal(view.resolve_on, 'Settings');
  assert.equal(view.status, 'pending');
  assert.equal(view.headline, RELINK_OUTCOMES.relink.headline);
  db.close();
});

test('the outcome table is total and only the silent outcome is silent', () => {
  const outcomes = Object.keys(RELINK_OUTCOMES).sort();
  assert.deepEqual(outcomes, ['none', 'partial', 'relink']);
  for (const [key, policy] of Object.entries(RELINK_OUTCOMES)) {
    assert.equal(policy.outcome, key);
    assert.equal(policy.headline === null, key === 'none');
    assert.equal(policy.recoveryAction === null, key === 'none');
    assert.equal(policy.blocksSync, key !== 'none');
    assert.equal(policy.opensProposal, key !== 'none');
  }
});

test('at most one proposal is ever pending', () => {
  const db = migratedTestDb();
  db.prepare(`
    INSERT INTO simplefin_relink_proposals
      (id, detected_at, outcome, status, provider_snapshot, stored_snapshot, pairs, unpaired_stored, unpaired_provider)
    VALUES ('p1', ?, 'relink', 'pending', '[]', '[]', '[]', '[]', '[]')
  `).run(NOW);
  assert.throws(() => {
    db.prepare(`
      INSERT INTO simplefin_relink_proposals
        (id, detected_at, outcome, status, provider_snapshot, stored_snapshot, pairs, unpaired_stored, unpaired_provider)
      VALUES ('p2', ?, 'relink', 'pending', '[]', '[]', '[]', '[]', '[]')
    `).run(NOW);
  }, /UNIQUE/);
  db.close();
});
