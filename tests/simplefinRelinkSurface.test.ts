import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
import type Database from 'better-sqlite3';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import simplefinRouter from '../server/src/routes/simplefin';
import {
  guardSimplefinRelink,
  type ProviderAccountSnapshot,
} from '../server/src/services/simplefinRelink';
import { RelinkPanel, relinkBalanceLine, relinkCarryLine } from '../client/src/views/settings/SimplefinSection';
import type {
  SimplefinRelinkPendingResponse,
  SimplefinRelinkStoredCarryView,
} from '../shared/types';

/**
 * The surface the owner settles a re-minted SimpleFIN account id on: the three routes over real
 * HTTP, and the panel they feed.
 *
 * WHAT THIS FILE IS GUARDING. On 2026-08-01 nine accounts arrived under new provider ids, nine
 * duplicates were inserted and the nine originals were zeroed. The guard now stops the sync before
 * any of that, but stopping it is only half: the owner has to be able to confirm the RIGHT pairing,
 * and this screen appears at the moment they are most likely to click through without reading. So
 * the tests here are as much about what the screen does NOT do (apply anything on render, preselect
 * anything, hide either side's leftovers) as about what it renders.
 *
 * THE HEALTHY CASE IS THE FIRST TEST, and it is the state of this install nearly all of the time:
 * no proposal, so the route answers null and the panel renders literally nothing. An "all clear"
 * panel is the shape that made a clean ledger read as carrying open conditions.
 */

const NOW = '2026-08-01T12:00:00.000Z';

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Reply<T> {
  status: number;
  body: T;
}

async function withRouter<T>(
  db: Database.Database,
  run: (call: <R>(path: string, init?: RequestInit) => Promise<Reply<R>>) => Promise<T>
): Promise<T> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/simplefin', simplefinRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const call = async <R,>(path: string, init?: RequestInit): Promise<Reply<R>> => {
      const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
      const json = (await res.json()) as { data?: R; error?: string };
      return { status: res.status, body: (json.data ?? json) as R };
    };
    return await run(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A stored SimpleFIN account carrying the five columns adoption exists to preserve. */
function linkedAccount(
  db: Database.Database,
  fields: {
    id: string;
    providerId: string;
    accountName: string;
    institutionName: string;
    type?: string;
    balanceCents?: number;
    isLiability?: boolean;
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
    SET simplefin_account_id = ?, connection_id = 'simplefin_primary', currency = 'USD',
        name_source = 'manual', type_source = 'manual', backfill_floor_date = ?
    WHERE id = ?
  `).run(fields.providerId, fields.backfillFloorDate ?? null, id);
  return id;
}

function provider(
  id: string,
  name: string,
  institutionName: string,
  balanceCents: number | null = 0
): ProviderAccountSnapshot {
  return { id, name, institutionName, currency: 'USD', balanceCents };
}

interface AccountRow {
  id: string;
  simplefin_account_id: string | null;
  account_name: string;
  type: string;
  type_source: string;
  name_source: string;
  backfill_floor_date: string | null;
  current_balance: number;
}

function accountRows(db: Database.Database): AccountRow[] {
  return db.prepare(`
    SELECT id, simplefin_account_id, account_name, type, type_source, name_source,
           backfill_floor_date, current_balance
    FROM accounts ORDER BY id
  `).all() as AccountRow[];
}

/**
 * The 2026-08-01 shape in miniature: three curated accounts whose ids were all re-minted at once,
 * one account the provider stopped sending (a closure at the bank looks exactly like this), and one
 * account the provider sent that this ledger has never held.
 */
function seedRelinked(db: Database.Database): void {
  linkedAccount(db, {
    id: 'acct_chase_checking',
    providerId: 'ACT-OLD-1',
    accountName: 'Chase Checking',
    institutionName: 'Chase',
    balanceCents: 412_355,
    backfillFloorDate: '2024-01-01',
  });
  linkedAccount(db, {
    id: 'acct_chase_savings',
    providerId: 'ACT-OLD-2',
    accountName: 'Chase Savings',
    institutionName: 'Chase',
    type: 'savings',
    balanceCents: 1_000_000,
  });
  linkedAccount(db, {
    id: 'acct_amex',
    providerId: 'ACT-OLD-3',
    accountName: 'Amex Gold',
    institutionName: 'Amex',
    type: 'credit',
    isLiability: true,
    balanceCents: 56_326,
  });
  linkedAccount(db, {
    id: 'acct_wells',
    providerId: 'ACT-OLD-4',
    accountName: 'Wells Checking',
    institutionName: 'Wells Fargo',
    balanceCents: 22_500,
  });

  for (const date of ['2024-03-02', '2025-01-05', '2026-07-30']) {
    insertTransaction(db, { account_id: 'acct_chase_checking', date, amount: -1_250 });
  }
  insertTransaction(db, { account_id: 'acct_wells', date: '2025-06-06', amount: -900 });
}

const RELINKED_RESPONSE: ProviderAccountSnapshot[] = [
  provider('ACT-NEW-1', 'Chase Checking', 'Chase', 412_355),
  provider('ACT-NEW-2', 'Chase Savings', 'Chase', 1_000_000),
  provider('ACT-NEW-3', 'Amex Gold', 'Amex', -56_326),
  provider('ACT-NEW-9', 'Sofi Savings', 'Sofi', 5_000),
];

function raiseProposal(db: Database.Database): string {
  const guard = guardSimplefinRelink(db, RELINKED_RESPONSE, NOW);
  assert.equal(guard.proceed, false, 'the fixture is supposed to be a blocked re-link');
  if (guard.proceed) throw new Error('unreachable');
  return guard.block.proposalId;
}

/**
 * The rendered markup with HTML entities put back.
 *
 * The service quotes account names in its reason sentences, and React escapes `"` on the way out,
 * so asserting the reason against the raw markup would fail for a reason that has nothing to do
 * with what the screen says.
 */
function plain(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function panel(pending: SimplefinRelinkPendingResponse | null | undefined, spies?: {
  onConfirm?: (pairs: Array<{ stored_account_id: string; provider_account_id: string }>) => void;
  onDismiss?: (reason: string) => void;
}): string {
  return renderToStaticMarkup(
    createElement(RelinkPanel, {
      pending,
      busy: false,
      onConfirm: spies?.onConfirm ?? (() => undefined),
      onDismiss: spies?.onDismiss ?? (() => undefined),
    })
  );
}

// ─── The healthy case ────────────────────────────────────────────────────────

test('HEALTHY: an install with nothing pending serves null and the panel renders nothing at all', async () => {
  const db = migratedTestDb();
  // Not an empty ledger: three ordinary SimpleFIN accounts, syncing normally, no re-link.
  linkedAccount(db, { id: 'acct_a', providerId: 'ACT-1', accountName: 'Chase Checking', institutionName: 'Chase' });
  linkedAccount(db, { id: 'acct_b', providerId: 'ACT-2', accountName: 'Chase Savings', institutionName: 'Chase', type: 'savings' });
  linkedAccount(db, { id: 'acct_c', providerId: 'ACT-3', accountName: 'Amex Gold', institutionName: 'Amex', type: 'credit', isLiability: true });

  const guard = guardSimplefinRelink(
    db,
    [provider('ACT-1', 'Chase Checking', 'Chase'), provider('ACT-2', 'Chase Savings', 'Chase'), provider('ACT-3', 'Amex Gold', 'Amex')],
    NOW
  );
  assert.equal(guard.proceed, true, 'an ordinary sync must not raise anything');

  const pending = await withRouter(db, async (call) => {
    const res = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.equal(res.status, 200);
    return res.body;
  });

  assert.equal(pending.proposal, null);
  assert.deepEqual(pending.carries, []);

  // Nothing at all. Not an empty card, not a "no re-link detected" line.
  assert.equal(panel(pending), '');
  // And the same for the states the query itself can be in before it answers.
  assert.equal(panel(undefined), '');
  assert.equal(panel(null), '');

  db.close();
});

test('HEALTHY: a never-connected install serves null rather than erroring', async () => {
  const db = migratedTestDb();
  const pending = await withRouter(db, async (call) => {
    const res = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.equal(res.status, 200);
    return res.body;
  });
  assert.deepEqual(pending, { proposal: null, carries: [] });
  assert.equal(panel(pending), '');
  db.close();
});

// ─── Reading the pending proposal ────────────────────────────────────────────

test('the pending proposal is served with its pairing and what each existing account carries', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  const pending = await withRouter(db, async (call) => {
    const res = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.equal(res.status, 200);
    return res.body;
  });

  const proposal = pending.proposal;
  assert.ok(proposal, 'a pending proposal was raised and must be served');
  assert.equal(proposal.id, proposalId);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.outcome, 'relink');
  assert.equal(proposal.resolve_on, 'Settings');
  assert.equal(proposal.resolve_on_path, '/settings');

  // Three pairs, each carrying the comparison it was proposed on rather than a bare likelihood.
  assert.equal(proposal.pairs.length, 3);
  for (const pair of proposal.pairs) {
    assert.ok(pair.reason.length > 0, `${pair.stored_account_id} was proposed with no stated reason`);
    assert.ok(pair.evidence.length > 0, `${pair.stored_account_id} was proposed with no evidence`);
  }
  assert.deepEqual(
    proposal.pairs.map((p) => [p.stored_account_id, p.provider_account_id]).sort(),
    [
      ['acct_amex', 'ACT-NEW-3'],
      ['acct_chase_checking', 'ACT-NEW-1'],
      ['acct_chase_savings', 'ACT-NEW-2'],
    ]
  );

  // Both sides' leftovers are reported, not hidden.
  assert.deepEqual(proposal.unpaired_stored.map((u) => u.account_id), ['acct_wells']);
  assert.deepEqual(proposal.unpaired_provider.map((u) => u.provider_account_id), ['ACT-NEW-9']);

  // Money crossed the edge into dollars exactly once.
  const checking = proposal.stored_accounts.find((a) => a.account_id === 'acct_chase_checking');
  assert.equal(checking?.balance, 4123.55);
  const amex = proposal.stored_accounts.find((a) => a.account_id === 'acct_amex');
  assert.equal(amex?.balance, 563.26);
  assert.equal(amex?.is_liability, true);

  // The carry is read live off the row, for every stored account the proposal asks about.
  const carry = (id: string): SimplefinRelinkStoredCarryView | undefined =>
    pending.carries.find((c) => c.account_id === id);
  assert.deepEqual(pending.carries.map((c) => c.account_id).sort(), [
    'acct_amex',
    'acct_chase_checking',
    'acct_chase_savings',
    'acct_wells',
  ]);
  assert.equal(carry('acct_chase_checking')?.transaction_count, 3);
  assert.equal(carry('acct_chase_checking')?.first_transaction_date, '2024-03-02');
  assert.equal(carry('acct_chase_checking')?.backfill_floor_date, '2024-01-01');
  assert.equal(carry('acct_chase_checking')?.name_source, 'manual');
  assert.equal(carry('acct_chase_checking')?.type_source, 'manual');
  assert.equal(carry('acct_chase_savings')?.transaction_count, 0);
  assert.equal(carry('acct_chase_savings')?.first_transaction_date, null);

  db.close();
});

// ─── The panel ───────────────────────────────────────────────────────────────

test('every pair renders what the existing account carries, the account it would adopt, and why', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  raiseProposal(db);

  const pending = await withRouter(db, async (call) => {
    const res = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    return res.body;
  });
  const html = plain(panel(pending));

  // The condition, in the words the service generates, so screen copy and sync copy cannot drift.
  assert.ok(html.includes(pending.proposal!.headline));
  assert.ok(html.includes('Settings'), 'the recovery action names the screen');

  // The existing account: name, type, transaction count, the date its history starts.
  assert.ok(html.includes('Chase Checking'));
  assert.ok(html.includes('3 transactions, starting Mar 2, 2024'));
  assert.ok(html.includes('$4,123.55'));
  assert.ok(html.includes('checking'));
  // And what adoption is protecting, said out loud on the row it protects.
  assert.ok(html.includes('Jan 1, 2024'), 'the backfill floor is shown');
  assert.ok(html.includes('You named this account.'));
  assert.ok(html.includes('You set its type.'));

  // The account it would adopt, named by the id that actually moves.
  assert.ok(html.includes('ACT-NEW-1'));
  assert.ok(html.includes('ACT-OLD-1'), 'the id being replaced is shown too');
  assert.ok(html.includes('would adopt'));

  // The reason, per pair.
  for (const pair of pending.proposal!.pairs) {
    assert.ok(html.includes(pair.reason), `the reason for ${pair.stored_account_id} is not rendered`);
  }

  // A liability reads as owed rather than as a bare number.
  assert.ok(html.includes('$563.26 owed'));

  // Both leftovers, explicitly, with their reasons.
  assert.ok(html.includes('Wells Checking'));
  assert.ok(html.includes(pending.proposal!.unpaired_stored[0].reason));
  assert.ok(html.includes('Sofi Savings'));
  assert.ok(html.includes(pending.proposal!.unpaired_provider[0].reason));

  db.close();
});

test('nothing is selected or applied on render, and the confirm control says so', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  raiseProposal(db);

  const pending = await withRouter(db, async (call) => {
    const res = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    return res.body;
  });

  const confirmed: unknown[] = [];
  const dismissed: string[] = [];
  const html = panel(pending, {
    onConfirm: (pairs) => confirmed.push(pairs),
    onDismiss: (reason) => dismissed.push(reason),
  });

  // Rendering is not an action.
  assert.deepEqual(confirmed, []);
  assert.deepEqual(dismissed, []);

  // No checkbox arrives ticked, so a reflex click on the primary control confirms nothing.
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.ok(!html.includes('checked'), 'a pair was preselected');
  assert.ok(html.includes('0 of 3 selected'));
  assert.match(
    html,
    /<button[^>]*disabled[^>]*>Select the pairs to confirm<\/button>/,
    'the confirm control is enabled with nothing selected'
  );

  // The consequence of confirming is stated, both halves of it.
  assert.ok(html.includes('keeps its name, its type, its transactions and the date its history starts'));
  assert.ok(html.includes('cannot be undone from this screen'));

  // And the render wrote nothing: the ledger still holds the dead ids.
  assert.deepEqual(
    accountRows(db).map((a) => a.simplefin_account_id).sort(),
    ['ACT-OLD-1', 'ACT-OLD-2', 'ACT-OLD-3', 'ACT-OLD-4']
  );

  db.close();
});

test('a proposal that is no longer pending renders nothing, whatever it says', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  const pending = await withRouter(db, async (call) => {
    const before = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    await call(`/api/simplefin/relink/${proposalId}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'These are genuinely new accounts.' }),
    });
    return before.body;
  });

  // The stale copy a client may still be holding. Status is the gate, not the presence of a row.
  const settled: SimplefinRelinkPendingResponse = {
    ...pending,
    proposal: { ...pending.proposal!, status: 'dismissed' },
  };
  assert.equal(panel(settled), '');

  db.close();
});

// ─── Confirming ──────────────────────────────────────────────────────────────

test('confirming adopts the ids onto the existing rows and moves nothing else', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);
  const before = accountRows(db);

  await withRouter(db, async (call) => {
    const res = await call<{
      proposal: { status: string };
      adopted: Array<{ stored_account_id: string; provider_account_id: string; previous_simplefin_account_id: string | null; outcome: string }>;
      left_unpaired_stored_account_ids: string[];
      left_unpaired_provider_account_ids: string[];
    }>(`/api/simplefin/relink/${proposalId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({
        pairs: [
          { stored_account_id: 'acct_chase_checking', provider_account_id: 'ACT-NEW-1' },
          { stored_account_id: 'acct_chase_savings', provider_account_id: 'ACT-NEW-2' },
          { stored_account_id: 'acct_amex', provider_account_id: 'ACT-NEW-3' },
        ],
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.proposal.status, 'applied');
    assert.equal(res.body.adopted.length, 3);
    assert.deepEqual(
      res.body.adopted.map((a) => a.outcome),
      ['adopted', 'adopted', 'adopted']
    );
    assert.deepEqual(res.body.left_unpaired_stored_account_ids, ['acct_wells']);
    assert.deepEqual(res.body.left_unpaired_provider_account_ids, ['ACT-NEW-9']);

    // Silent again, immediately: nothing is left standing for the owner to look at.
    const after = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.deepEqual(after.body, { proposal: null, carries: [] });
    assert.equal(panel(after.body), '');
  });

  // Four accounts, not eight. Every column but the provider id is exactly where it was.
  const after = accountRows(db);
  assert.equal(after.length, 4);
  const byId = new Map(after.map((a) => [a.id, a]));
  assert.equal(byId.get('acct_chase_checking')?.simplefin_account_id, 'ACT-NEW-1');
  assert.equal(byId.get('acct_chase_savings')?.simplefin_account_id, 'ACT-NEW-2');
  assert.equal(byId.get('acct_amex')?.simplefin_account_id, 'ACT-NEW-3');
  assert.equal(byId.get('acct_wells')?.simplefin_account_id, 'ACT-OLD-4', 'an unconfirmed pair must not move');

  for (const row of before) {
    const now = byId.get(row.id)!;
    assert.equal(now.account_name, row.account_name);
    assert.equal(now.type, row.type);
    assert.equal(now.type_source, row.type_source);
    assert.equal(now.name_source, row.name_source);
    assert.equal(now.backfill_floor_date, row.backfill_floor_date);
    assert.equal(now.current_balance, row.current_balance, 'adoption is not a balance write');
  }

  // The stranded-transaction half of the 2026-08-01 damage: the rows never left their accounts.
  const counts = db.prepare(
    'SELECT account_id, COUNT(*) AS n FROM transactions GROUP BY account_id ORDER BY account_id'
  ).all() as Array<{ account_id: string; n: number }>;
  assert.deepEqual(counts, [
    { account_id: 'acct_chase_checking', n: 3 },
    { account_id: 'acct_wells', n: 1 },
  ]);

  db.close();
});

test('confirming a subset leaves the rest pending nothing and the proposal resolved', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  await withRouter(db, async (call) => {
    const res = await call<{ left_unpaired_stored_account_ids: string[] }>(
      `/api/simplefin/relink/${proposalId}/adopt`,
      {
        method: 'POST',
        body: JSON.stringify({
          pairs: [{ stored_account_id: 'acct_chase_checking', provider_account_id: 'ACT-NEW-1' }],
        }),
      }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.left_unpaired_stored_account_ids.sort(), [
      'acct_amex',
      'acct_chase_savings',
      'acct_wells',
    ]);
  });

  const byId = new Map(accountRows(db).map((a) => [a.id, a]));
  assert.equal(byId.get('acct_chase_checking')?.simplefin_account_id, 'ACT-NEW-1');
  assert.equal(byId.get('acct_chase_savings')?.simplefin_account_id, 'ACT-OLD-2');
  db.close();
});

// ─── Dismissing ──────────────────────────────────────────────────────────────

test('dismissing records the stated reason and stops the proposal being re-raised', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  await withRouter(db, async (call) => {
    const res = await call<{
      proposal: { status: string; dismissed_reason: string | null };
      acknowledged_provider_ids: string[];
    }>(`/api/simplefin/relink/${proposalId}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'I opened four accounts at new banks.' }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.proposal.status, 'dismissed');
    assert.equal(res.body.proposal.dismissed_reason, 'I opened four accounts at new banks.');
    assert.deepEqual(res.body.acknowledged_provider_ids.sort(), [
      'ACT-NEW-1',
      'ACT-NEW-2',
      'ACT-NEW-3',
      'ACT-NEW-9',
    ]);

    const after = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.equal(after.body.proposal, null);
    assert.equal(panel(after.body), '');
  });

  // Dismissal is not a write to the ledger: no id moved.
  assert.deepEqual(
    accountRows(db).map((a) => a.simplefin_account_id).sort(),
    ['ACT-OLD-1', 'ACT-OLD-2', 'ACT-OLD-3', 'ACT-OLD-4']
  );

  // And the same response does not raise it again.
  const guard = guardSimplefinRelink(db, RELINKED_RESPONSE, '2026-08-01T13:00:00.000Z');
  assert.equal(guard.proceed, true, 'a dismissed proposal must not come straight back');

  db.close();
});

test('a dismissal with no stated reason is rejected before it reaches the service', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  await withRouter(db, async (call) => {
    for (const body of [{ reason: '' }, { reason: '   ' }, {}]) {
      const res = await call(`/api/simplefin/relink/${proposalId}/dismiss`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted as a reason`);
    }
    // Still pending, so nothing was half-resolved by a rejected request.
    const after = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.equal(after.body.proposal?.status, 'pending');
  });

  db.close();
});

// ─── Refusals ────────────────────────────────────────────────────────────────

test('an unknown proposal id is a 404 on both write routes', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  raiseProposal(db);

  await withRouter(db, async (call) => {
    const adopt = await call('/api/simplefin/relink/rlk_nope/adopt', {
      method: 'POST',
      body: JSON.stringify({ pairs: [{ stored_account_id: 'acct_amex', provider_account_id: 'ACT-NEW-3' }] }),
    });
    assert.equal(adopt.status, 404);

    const dismiss = await call('/api/simplefin/relink/rlk_nope/dismiss', {
      method: 'POST',
      body: JSON.stringify({ reason: 'nothing to dismiss' }),
    });
    assert.equal(dismiss.status, 404);

    // The real proposal is untouched by either miss.
    const after = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.equal(after.body.proposal?.status, 'pending');
  });

  db.close();
});

test('confirming an already-settled proposal is a conflict, not a second adoption', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  await withRouter(db, async (call) => {
    const first = await call(`/api/simplefin/relink/${proposalId}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'These are new accounts.' }),
    });
    assert.equal(first.status, 200);

    const second = await call<{ reason?: string }>(`/api/simplefin/relink/${proposalId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ pairs: [{ stored_account_id: 'acct_amex', provider_account_id: 'ACT-NEW-3' }] }),
    });
    assert.equal(second.status, 409);

    const dismissAgain = await call(`/api/simplefin/relink/${proposalId}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'again' }),
    });
    assert.equal(dismissAgain.status, 409);
  });

  // No id moved on either refused call.
  assert.deepEqual(
    accountRows(db).map((a) => a.simplefin_account_id).sort(),
    ['ACT-OLD-1', 'ACT-OLD-2', 'ACT-OLD-3', 'ACT-OLD-4']
  );
  db.close();
});

test('confirming an empty pairing is rejected, because that is a dismissal without its reason', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  await withRouter(db, async (call) => {
    const res = await call(`/api/simplefin/relink/${proposalId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ pairs: [] }),
    });
    assert.equal(res.status, 400);
    const after = await call<SimplefinRelinkPendingResponse>('/api/simplefin/relink');
    assert.equal(after.body.proposal?.status, 'pending');
  });

  db.close();
});

test('an id the proposal never named is refused, and refuses the whole batch with it', async () => {
  const db = migratedTestDb();
  seedRelinked(db);
  const proposalId = raiseProposal(db);

  await withRouter(db, async (call) => {
    const res = await call(`/api/simplefin/relink/${proposalId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({
        pairs: [
          { stored_account_id: 'acct_chase_checking', provider_account_id: 'ACT-NEW-1' },
          { stored_account_id: 'acct_chase_savings', provider_account_id: 'ACT-NOT-SENT' },
        ],
      }),
    });
    assert.equal(res.status, 422);
  });

  // All or nothing: the valid half of the batch did not land either.
  assert.equal(
    accountRows(db).find((a) => a.id === 'acct_chase_checking')?.simplefin_account_id,
    'ACT-OLD-1'
  );
  db.close();
});

// ─── The two sentences the panel builds ──────────────────────────────────────

test('the carry line says what the row holds, and says so when the row is gone', () => {
  const carry = (over: Partial<SimplefinRelinkStoredCarryView>): SimplefinRelinkStoredCarryView => ({
    account_id: 'acct_1',
    transaction_count: 0,
    first_transaction_date: null,
    backfill_floor_date: null,
    type_source: 'auto',
    name_source: 'auto',
    ...over,
  });

  assert.equal(
    relinkCarryLine(carry({ transaction_count: 2569, first_transaction_date: '2024-03-02' })),
    '2,569 transactions, starting Mar 2, 2024.'
  );
  assert.equal(
    relinkCarryLine(carry({ transaction_count: 1, first_transaction_date: '2026-07-30' })),
    '1 transaction, starting Jul 30, 2026.'
  );
  assert.equal(relinkCarryLine(carry({})), 'No transactions yet.');
  // Absent is not empty. An account the proposal names that the ledger no longer holds says so
  // rather than rendering a zero nothing measured.
  assert.equal(relinkCarryLine(undefined), 'No longer in this ledger.');
});

test('a liability in credit and a liability owed read differently', () => {
  assert.equal(relinkBalanceLine(563.26, true), '$563.26 owed');
  assert.equal(relinkBalanceLine(-563.26, true), '$563.26 in credit');
  assert.equal(relinkBalanceLine(4123.55, false), '$4,123.55');
  assert.equal(relinkBalanceLine(-12.5, false), '−$12.50');
});

/**
 * A condition that blocks every sync has to be visible before the owner goes looking for it.
 *
 * The panel that resolves a re-link lives inside a collapsed Settings row. As first built, the row
 * read "Connected" and the panel was not in the DOM until the row was clicked, so the one state
 * that stops the ledger updating was reachable only by guessing which row to expand. That is a
 * standing finding the owner cannot act on, which rule 3 forbids.
 */
test('the Settings row states a pending re-link instead of reading Connected', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'client', 'src', 'views', 'settings', 'Settings.tsx'),
    'utf8'
  );
  // The row's trailing is derived from the pending proposal, not from connection state alone.
  assert.match(source, /relinkPending[\s\S]{0,120}Needs your confirmation/);
  assert.match(source, /const relinkPending = Boolean\(pendingRelink\?\.proposal\)/);
  // And the panel opens itself, so the copy that says "confirm in Settings" lands somewhere.
  assert.match(source, /if \(relinkPending\) setOpenPanel\('simplefin'\)/);
});

test('HEALTHY: with nothing pending the row is not given a re-link state to render', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'client', 'src', 'views', 'settings', 'Settings.tsx'),
    'utf8'
  );
  // `relinkPending` is false unless the server returned a proposal, so the ordinary install falls
  // through to statusText and the effect never fires. Asserted on the expression rather than on a
  // render, because the render of an ordinary install is what every other test in this file covers.
  assert.match(source, /relinkPending\s*\n?\s*\?\s*<span className="text-review-text">/);
  assert.match(source, /:\s*statusText\(Boolean\(simplefinConnection\)\)/);
});
