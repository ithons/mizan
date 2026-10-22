import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { addDays, format } from 'date-fns';
import { candidatePayload, detectExpectedLumps, listConfirmedLumps, lumpKey } from '../server/src/services/expectedLumps';
import { openLumpCandidates } from '../server/src/services/expectedLumpCandidates';
import { proposeChanges } from '../server/src/services/advisorProposals';
import { confirmAdvisorDraftsByIds, dismissAdvisorDraft, supersedeLapsedDrafts } from '../server/src/services/advisorDrafts';
import { draftTargetKey } from '../server/src/services/aiJobs';
import { computeSafeToSpend } from '../server/src/services/safeToSpend';
import { projectFree, runwayTo } from '../server/src/services/simulations';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import http from 'node:http';
import express from 'express';
import { _setDbForTesting } from '../server/src/db/index';
import expectedLumpsRouter from '../server/src/routes/expectedLumps';
import type { ExpectedLumpsResponse } from '../shared/types';

const TODAY = new Date(2026, 9, 22);
const ymd = (date: Date) => format(date, 'yyyy-MM-dd');

function ledger() {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Chase Checking', type: 'checking', current_balance: 465397 });
  const savings = insertAccount(db, { account_name: 'BofA Savings', type: 'savings', current_balance: 100170 });
  return { db, checking, savings };
}

type Row = [date: string, cents: number, merchant: string, original: string, category: string | null];

function seed(db: Database.Database, account: string, rows: Row[]): string[] {
  return rows.map(([date, amount, merchant, original, category]) =>
    insertTransaction(db, { account_id: account, date, amount, merchant_name: merchant, original_name: original, category_id: category }));
}

const MIT: Row[] = [
  ['2023-09-13', 229725, 'MIT student account refund', 'MA INSTITUTE TEC DES:EREFUND = ID:100001 INDN:ALEX OWNER', 'cat_income_other'],
  ['2024-04-02', 184225, 'MIT student account refund', 'MA INSTITUTE TEC DES:EREFUND ID:100002 INDN:ALEX OWNER ES', 'cat_income_other'],
  ['2025-09-10', 259025, 'MIT student account refund', 'MA INSTITUTE TEC DES:EREFUND ID:100003 INDN:ALEX OWNER ES', 'cat_income_other'],
  ['2026-02-12', 265695, 'MIT student account refund', 'MA INSTITUTE TEC DES:EREFUND ID:100004 INDN:ALEX OWNER CO', 'cat_income_other'],
  ['2026-09-17', 323625, 'Tec Erefund', 'MA INSTITUTE TEC EREFUND PPD ID: 1000000005', 'cat_income_other'],
];

const DEPOSITS: Row[] = [
  ['2023-08-25', 300000, 'Counter deposit', 'Counter Credit', 'cat_income_other'],
  ['2023-11-22', 500000, 'Banking center deposit', 'BOFAFIN CTR 11/22 #000000001 DEPOSIT 1 Main St Cambridge MA', 'cat_income_other'],
  ['2024-05-03', 500000, 'Mobile check deposit', 'BKOFAMERICA MOBILE 05/03 3700000001 DEPOSIT *MOBILE MA', 'cat_income_other'],
  ['2024-12-23', 500000, 'Mobile check deposit', 'BKOFAMERICA MOBILE 12/22 3700000002 DEPOSIT *MOBILE MA', 'cat_income_other'],
  ['2025-01-21', 250000, 'ATM deposit', 'BKOFAMERICA ATM 01/21 #000000002 DEPOSIT MASSACHUSETTS & VA', 'cat_xfer_in'],
  ['2025-03-17', 500000, 'Mobile check deposit', 'BKOFAMERICA MOBILE 03/17 3700000003 DEPOSIT *MOBILE MA', 'cat_income_other'],
  ['2025-10-06', 500000, 'Mobile check deposit', 'BKOFAMERICA MOBILE 10/04 3700000004 DEPOSIT *MOBILE MA', 'cat_income_other'],
  ['2026-03-24', 500000, 'REMOTE ONLINE DEPOSIT # 1', 'REMOTE ONLINE DEPOSIT # 1', 'cat_xfer_in'],
  ['2026-09-29', 500000, 'Online Deposit Check #1', 'REMOTE ONLINE DEPOSIT # 1', 'cat_income_other'],
];

test('the two descriptor formats of the MIT refund share one key, and every deposit channel shares another', () => {
  assert.equal(lumpKey(MIT[0][2], MIT[0][3]), lumpKey(MIT[4][2], MIT[4][3]));
  assert.equal(lumpKey(MIT[0][2], MIT[0][3]), 'ma institute tec erefund');
  assert.deepEqual(new Set(DEPOSITS.map(([, , m, o]) => lumpKey(m, o))), new Set(['deposit']));
});

test('the live-shaped MIT refunds propose one group with its window and range', () => {
  const { db, checking } = ledger();
  const closed = insertAccount(db, { account_name: 'BofA Savings', type: 'closed' });
  seed(db, closed, MIT.slice(0, 4));
  seed(db, checking, MIT.slice(4));
  const found = detectExpectedLumps(db, TODAY);
  assert.equal(found.length, 1);
  const [lump] = found;
  assert.equal(lump.merchant_key, 'ma institute tec erefund');
  assert.equal(lump.label, 'MIT student account refund');
  assert.equal(lump.occurrences.length, 5);
  assert.equal(lump.amount_low_cents, 184225);
  assert.equal(lump.amount_high_cents, 323625);
  assert.equal(lump.last_occurrence, '2026-09-17');
  assert.equal(lump.median_gap_days, 210);
  assert.equal(lump.spread_days, 32);
  assert.equal(lump.window_start, '2027-03-14');
  assert.equal(lump.window_end, '2027-05-17');
});

test('the seven $5,000 deposits propose one group, and the $2,500 and $3,000 deposits stay out of it', () => {
  const { db, checking } = ledger();
  seed(db, checking, DEPOSITS);
  const found = detectExpectedLumps(db, TODAY);
  assert.equal(found.length, 1);
  const [lump] = found;
  assert.equal(lump.merchant_key, 'deposit');
  assert.equal(lump.occurrences.length, 7);
  assert.equal(lump.amount_low_cents, 500000);
  assert.equal(lump.amount_high_cents, 500000);
  assert.equal(lump.median_gap_days, 179);
  assert.equal(lump.spread_days, 20);
  assert.equal(lump.window_start, '2027-03-07');
  assert.equal(lump.window_end, '2027-04-16');
});

test('HEALTHY: pay, a one-off refund, paired transfers, card payments, purchase credits and a pair of deposits propose nothing', () => {
  const { db, checking, savings } = ledger();
  const card = insertAccount(db, { account_name: 'Chase Sapphire', type: 'credit', is_liability: 1 });
  seed(db, checking, [
    ['2026-06-01', 200000, 'MIT', 'MASS INST OF T PAYROLL PPD ID: 9111111101', 'cat_income_paycheck'],
    ['2026-07-01', 200000, 'MIT', 'MASS INST OF T PAYROLL PPD ID: 9111111101', 'cat_income_paycheck'],
    ['2026-08-01', 200000, 'MIT', 'MASS INST OF T PAYROLL PPD ID: 9111111101', 'cat_income_paycheck'],
    ['2026-06-15', 150000, 'Stipend', 'MASS INST OF T PAYROLL PPD ID: 9111111101', 'cat_income_other'],
    ['2026-07-15', 150000, 'Stipend', 'MASS INST OF T PAYROLL PPD ID: 9111111101', 'cat_income_other'],
    ['2026-08-15', 150000, 'Stipend', 'MASS INST OF T PAYROLL PPD ID: 9111111101', 'cat_income_other'],
    ['2026-05-02', 150000, 'Security deposit refund', 'LANDLORD REFUND', 'cat_income_other'],
    ['2026-02-01', 120000, 'Amazon', 'AMAZON REFUND', 'cat_shop_electronics'],
    ['2026-04-01', 120000, 'Amazon', 'AMAZON REFUND', 'cat_shop_electronics'],
    ['2026-06-01', 120000, 'Amazon', 'AMAZON REFUND', 'cat_shop_electronics'],
    ['2026-01-10', 400000, 'Grandparents', 'ZELLE FROM GRANDPARENTS', 'cat_income_other'],
    ['2026-06-10', 400000, 'Grandparents', 'ZELLE FROM GRANDPARENTS', 'cat_income_other'],
  ]);
  const transfers = seed(db, checking, [
    ['2026-03-01', 200000, 'Transfer from BofA Savings', 'Online Banking transfer from SAV 5038', 'cat_xfer_in'],
    ['2026-05-01', 200000, 'Transfer from BofA Savings', 'Online Banking transfer from SAV 5038', 'cat_xfer_in'],
    ['2026-07-01', 200000, 'Transfer from BofA Savings', 'Online Banking transfer from SAV 5038', 'cat_xfer_in'],
  ]);
  for (const id of transfers) db.prepare("UPDATE transactions SET transfer_status = 'confirmed', transfer_pair_id = ? WHERE id = ?").run(`pair_${id}`, id);
  seed(db, card, [
    ['2026-07-10', 237314, 'Automatic Payment', 'AUTOMATIC PAYMENT - THANK', null],
    ['2026-08-10', 320013, 'Automatic Payment', 'AUTOMATIC PAYMENT - THANK', null],
    ['2026-09-10', 481314, 'Automatic Payment', 'AUTOMATIC PAYMENT - THANK', null],
  ]);
  seed(db, savings, [['2026-03-10', 99999, 'Gift', 'GIFT', 'cat_income_other'], ['2026-05-10', 99999, 'Gift', 'GIFT', 'cat_income_other'], ['2026-07-10', 99999, 'Gift', 'GIFT', 'cat_income_other']]);
  assert.deepEqual(detectExpectedLumps(db, TODAY), []);
  assert.deepEqual(openLumpCandidates(db, TODAY), []);
});

test('HEALTHY: a group whose next window has already passed proposes nothing', () => {
  const { db, checking } = ledger();
  seed(db, checking, [
    ['2024-01-05', 300000, 'Scholarship', 'FOUNDATION SCHOLARSHIP', 'cat_income_other'],
    ['2024-03-05', 300000, 'Scholarship', 'FOUNDATION SCHOLARSHIP', 'cat_income_other'],
    ['2024-05-05', 300000, 'Scholarship', 'FOUNDATION SCHOLARSHIP', 'cat_income_other'],
  ]);
  assert.deepEqual(detectExpectedLumps(db, TODAY), []);
});

/** Three refunds 180 days apart, the last 100 days ago, so the window sits ahead of the real today. */
function liveLedger() {
  const { db, checking, savings } = ledger();
  const now = new Date();
  const dates = [460, 280, 100].map((back) => ymd(addDays(now, -back)));
  seed(db, checking, dates.map((date, i) => [date, 250000 + i * 10000, 'Term refund', 'MA INSTITUTE TEC EREFUND PPD ID: 1000000005', 'cat_income_other'] as Row));
  const [candidate] = detectExpectedLumps(db);
  assert.ok(candidate, 'the fixture proposes a lump');
  return { db, checking, savings, candidate, payload: candidatePayload(candidate) };
}

test('confirming the proposal writes the expected_lumps row through the draft path, in cents', () => {
  const { db, payload } = liveLedger();
  const proposed = proposeChanges(db, { changes: [{ label: 'Expect the term refund', summary: 'It came three times.', payload }] });
  assert.deepEqual(proposed.refused, []);
  const [draft] = proposed.proposed;
  assert.equal(draft.route, '/plan');
  assert.equal(confirmAdvisorDraftsByIds(db, [draft.id]).applied, 1);
  const rows = db.prepare('SELECT label, merchant_key, amount_low_cents, amount_high_cents, window_start, window_end, status, confirmed_at FROM expected_lumps').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_low_cents, 250000);
  assert.equal(rows[0].amount_high_cents, 270000);
  assert.equal(rows[0].window_start, payload.window_start);
  assert.equal(rows[0].status, 'confirmed');
  assert.ok(rows[0].confirmed_at);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM advisor_actions WHERE kind = 'expect_lump'").get() as { n: number }).n, 1);
  assert.deepEqual(openLumpCandidates(db), [], 'a confirmed lump is no longer a candidate');
  assert.equal(listConfirmedLumps(db)[0].state, 'expected');
});

test('a lapsed proposal is superseded once the lump arrives, and the confirmed lump reads as arrived', () => {
  const { db, checking, payload } = liveLedger();
  const [draft] = proposeChanges(db, { changes: [{ label: 'Expect it', summary: 's', payload }] }).proposed;
  const other = proposeChanges(db, { changes: [{ label: 'Expect it', summary: 's', payload: { ...payload, merchant_key: 'deposit' } }] }).proposed[0];
  confirmAdvisorDraftsByIds(db, [other.id]);
  assert.equal(supersedeLapsedDrafts(db), 0, 'HEALTHY: nothing lapses before the lump arrives');
  seed(db, checking, [[ymd(new Date()), 262000, 'Tec Erefund', 'MA INSTITUTE TEC EREFUND PPD ID: 1000000005', 'cat_income_other']]);
  assert.equal(supersedeLapsedDrafts(db), 1);
  assert.equal((db.prepare('SELECT status FROM advisor_drafts WHERE id = ?').get(draft.id) as { status: string }).status, 'superseded');
  assert.equal(listConfirmedLumps(db)[0].state, 'expected', 'a deposit-key lump is not settled by a refund');
});

test('a proposal whose window has passed is refused before it becomes a card', () => {
  const { db, payload } = liveLedger();
  const past = { ...payload, window_start: '2020-01-01', window_end: '2020-02-01' };
  const result = proposeChanges(db, { changes: [{ label: 'x', summary: 'y', payload: past }] });
  assert.equal(result.proposed.length, 0);
  assert.match(result.refused[0].reason, /already passed/);
});

test('dismissing a candidate declines that payer, so it is not offered again', () => {
  const { db, payload } = liveLedger();
  const [draft] = proposeChanges(db, { changes: [{ label: 'x', summary: 'y', payload }] }).proposed;
  assert.equal(openLumpCandidates(db)[0].draft_id, draft.id);
  dismissAdvisorDraft(db, draft.id);
  assert.deepEqual(openLumpCandidates(db), []);
});

test('a fresh pass supersedes its own earlier window for the same payer, not another payer', () => {
  const { payload } = liveLedger();
  assert.equal(draftTargetKey(payload), draftTargetKey({ ...payload, window_start: '2099-01-01' }));
  assert.notEqual(draftTargetKey(payload), draftTargetKey({ ...payload, merchant_key: 'deposit' }));
});

test('neither a candidate nor a confirmed lump moves free to spend', () => {
  const { db, payload } = liveLedger();
  const before = computeSafeToSpend(db, { forecastDays: 120 });
  assert.equal(openLumpCandidates(db).length, 1);
  const [draft] = proposeChanges(db, { changes: [{ label: 'x', summary: 'y', payload }] }).proposed;
  confirmAdvisorDraftsByIds(db, [draft.id]);
  const after = computeSafeToSpend(db, { forecastDays: 120 });
  assert.equal(after.free, before.free);
  assert.equal(after.expectedInflows, before.expectedInflows);
  assert.deepEqual(after.scheduled, before.scheduled);
});

async function withRouter(db: Database.Database, fn: (base: string) => Promise<void>): Promise<void> {
  _setDbForTesting(db);
  const app = express();
  app.use(express.json());
  app.use('/api/expected-lumps', expectedLumpsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    await fn(`http://127.0.0.1:${addr.port}/api/expected-lumps`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setDbForTesting(null);
    db.close();
  }
}

test('the route serves candidates in dollars, confirms one through the draft path and removes it again', async () => {
  const { db, payload } = liveLedger();
  await withRouter(db, async (base) => {
    const listed = (await (await fetch(base)).json()) as { data: ExpectedLumpsResponse };
    assert.equal(listed.data.candidates.length, 1);
    assert.equal(listed.data.candidates[0].payload.amount_low, 2500);
    assert.deepEqual(listed.data.confirmed, []);
    const post = (body: unknown) => fetch(`${base}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ payload: { kind: 'delete_budget', category_id: 'cat_food' }, decision: 'confirm' })).status, 400);
    assert.equal((await post({ payload, decision: 'confirm' })).status, 200);
    const after = (await (await fetch(base)).json()) as { data: ExpectedLumpsResponse };
    assert.equal(after.data.candidates.length, 0);
    assert.equal(after.data.confirmed[0].amount_high, 2700);
    assert.equal((await fetch(`${base}/${after.data.confirmed[0].id}/dismiss`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/${after.data.confirmed[0].id}/dismiss`, { method: 'POST' })).status, 404);
  });
});

const GRANT_ORIGINAL = 'NORTHFIELD COLL GRANT PPD ID: 4400000001';

/** Three invented college grants 180 days apart, the last 100 days ago, confirmed through the draft path. */
function confirmedGrant() {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Harbor Checking', type: 'checking', current_balance: 312345 });
  const dates = [460, 280, 100].map((back) => ymd(addDays(new Date(), -back)));
  seed(db, checking, dates.map((date, i) => [date, 180000 + i * 5000, 'Northfield grant', GRANT_ORIGINAL, 'cat_income_other'] as Row));
  const [candidate] = detectExpectedLumps(db);
  assert.ok(candidate, 'the fixture proposes a lump');
  const payload = candidatePayload(candidate);
  const [draft] = proposeChanges(db, { changes: [{ label: 'Expect the grant', summary: 's', payload }] }).proposed;
  assert.equal(confirmAdvisorDraftsByIds(db, [draft.id]).applied, 1);
  assert.equal(listConfirmedLumps(db)[0].state, 'expected');
  return { db, checking, payload };
}

function arrive(db: Database.Database, account: string, fields: { pending?: number; category_id?: string | null; date?: string; amount?: number }): void {
  insertTransaction(db, {
    account_id: account, date: fields.date ?? ymd(new Date()), amount: fields.amount ?? 186000,
    merchant_name: 'Northfield grant', original_name: GRANT_ORIGINAL,
    category_id: fields.category_id === undefined ? 'cat_income_other' : fields.category_id, pending: fields.pending ?? 0,
  });
}

test('a confirmed lump reads as arrived when its deposit is still pending, and the runway stops counting it', () => {
  const { db, checking } = confirmedGrant();
  _setDbForTesting(db);
  try {
    const end = ymd(addDays(new Date(), 120));
    assert.equal(runwayTo(db, end).expected_lumps_counted.length, 1);
    arrive(db, checking, { pending: 1 });
    assert.equal(listConfirmedLumps(db)[0].state, 'arrived');
    assert.deepEqual(runwayTo(db, end).expected_lumps_counted, []);
    assert.equal('with_expected_lumps' in projectFree(db, 120), false);
  } finally {
    _setDbForTesting(null);
    db.close();
  }
});

test('a confirmed lump reads as arrived when its deposit is filed under a spending category', () => {
  const { db, checking } = confirmedGrant();
  arrive(db, checking, { category_id: 'cat_education' });
  assert.equal(listConfirmedLumps(db)[0].state, 'arrived');
});

test('removing a confirmed lump keeps it off the list for that window, leaves another payer alone, and offers the next window', async () => {
  const { db, checking } = confirmedGrant();
  const savings = insertAccount(db, { account_name: 'Harbor Savings', type: 'savings', current_balance: 50000 });
  const dates = [400, 220, 40].map((back) => ymd(addDays(new Date(), -back)));
  seed(db, savings, dates.map((date) => [date, 150000, 'Aunt Rowan', 'ZELLE FROM AUNT ROWAN', 'cat_income_other'] as Row));
  await withRouter(db, async (base) => {
    const before = (await (await fetch(base)).json()) as { data: ExpectedLumpsResponse };
    assert.equal(before.data.confirmed.length, 1);
    assert.deepEqual(before.data.candidates.map((c) => c.payload.label), ['Aunt Rowan']);
    assert.equal((await fetch(`${base}/${before.data.confirmed[0].id}/dismiss`, { method: 'POST' })).status, 200);
    const after = (await (await fetch(base)).json()) as { data: ExpectedLumpsResponse };
    assert.deepEqual(after.data.confirmed, []);
    assert.deepEqual(after.data.candidates.map((c) => c.payload.label), ['Aunt Rowan'], 'the removed grant is not offered again for the same window');
    arrive(db, checking, {});
    const next = (await (await fetch(base)).json()) as { data: ExpectedLumpsResponse };
    assert.deepEqual(next.data.candidates.map((c) => c.payload.label).sort(), ['Aunt Rowan', 'Northfield grant'], 'a removal is not a standing veto on the payer');
  });
});

test('a monthly inflow nothing schedules is proposed, and its card states the count and gap measured, not a cadence', async () => {
  const db = migratedTestDb();
  const checking = insertAccount(db, { account_name: 'Harbor Checking', type: 'checking', current_balance: 254321 });
  const dates = [150, 120, 90, 60, 30, 0].map((back) => ymd(addDays(new Date(), -back)));
  seed(db, checking, dates.map((date) => [date, 120000, 'Jordan Vale', 'ZELLE FROM JORDAN VALE', 'cat_income_other'] as Row));
  const [candidate] = detectExpectedLumps(db);
  assert.ok(candidate);
  assert.equal(candidate.median_gap_days, 30);
  await withRouter(db, async (base) => {
    const res = await fetch(`${base}/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: candidatePayload(candidate), decision: 'confirm' }),
    });
    assert.equal(res.status, 200);
    const { summary } = db.prepare("SELECT summary FROM advisor_drafts WHERE kind = 'expect_lump'").get() as { summary: string };
    assert.equal(summary, `Jordan Vale has come in 6 times, a median of 30 days apart, last on ${dates[5]}.`);
  });
});

test('HEALTHY: a same-payer deposit far outside the range, or on the last occurrence itself, leaves the lump expected', () => {
  const { db, checking } = confirmedGrant();
  arrive(db, checking, { amount: 40000 });
  arrive(db, checking, { date: ymd(addDays(new Date(), -100)), amount: 186000 });
  assert.equal(listConfirmedLumps(db)[0].state, 'expected');
});
