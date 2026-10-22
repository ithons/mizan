import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { addDays, format, subDays } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import { defaultRunwayEnd, horizonDays, projectFree, projectFreeBand, runwayTo } from '../server/src/services/simulations';
import { detectRecurring } from '../server/src/services/recurring';
import { refreshTransactionIntegrity } from '../server/src/services/transactionIntegrity';
import { runAgentTool } from '../server/src/services/advisorAgentTools';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';
import http from 'node:http';
import express from 'express';
import insightsRouter from '../server/src/routes/insights';
import type { RunwayReading } from '../shared/types';

const now = new Date();
const ymd = (date: Date) => format(date, 'yyyy-MM-dd');
const back = (days: number) => ymd(subDays(now, days));
const ahead = (days: number) => ymd(addDays(now, days));

/** Daily cafe spending, a weekly $100 move to the brokerage and Netflix, with no pay: free falls every day. */
function withFallingLedger(balance: number, run: (db: Database.Database) => void): void {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    const chase = insertAccount(db, { account_name: 'Chase Checking', type: 'checking', current_balance: balance });
    const fidelity = insertAccount(db, { account_name: 'Fidelity', type: 'brokerage', current_balance: 500000 });
    for (let d = 150; d >= 1; d--) {
      insertTransaction(db, { account_id: chase, date: back(d), amount: -2000, merchant_name: `Cafe ${d}`, original_name: `CAFE ${d}`, category_id: 'cat_food_restaurants' });
    }
    for (const weeksAgo of [6, 5, 4, 3, 2, 1]) {
      insertTransaction(db, { account_id: chase, date: back(7 * weeksAgo), amount: -10000, original_name: 'FID BKG SVC LLC MONEYLINE', category_id: 'cat_inv_transfer', category_source: 'rule' });
      insertTransaction(db, { account_id: fidelity, date: back(7 * weeksAgo), amount: 10000, original_name: 'Electronic Funds Transfer Received' });
    }
    for (const monthsAgo of [4, 3, 2, 1]) {
      insertTransaction(db, { account_id: chase, date: back(30 * monthsAgo + 5), amount: -1599, merchant_name: 'Netflix', original_name: 'NETFLIX.COM', category_id: 'cat_ent_streaming' });
    }
    refreshTransactionIntegrity(db);
    detectRecurring();
    run(db);
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
}

function confirmLump(db: Database.Database, low: number, high: number, start: string, end: string): void {
  db.prepare(`
    INSERT INTO expected_lumps (id, label, merchant_key, amount_low_cents, amount_high_cents, window_start, window_end,
                                last_occurrence, status, created_at, updated_at, confirmed_at)
    VALUES (?, 'Term refund', 'ma institute tec erefund', ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
  `).run(`lump_${start}`, low, high, start, end, back(200), now.toISOString(), now.toISOString(), now.toISOString());
}

test('an end date is the same horizon as its day count', () => {
  withFallingLedger(300000, (db) => {
    assert.equal(horizonDays(ahead(45), now), 45);
    assert.equal(horizonDays(back(1), now), null);
    assert.equal(horizonDays('2026-13-40', now), null);
    assert.deepEqual(projectFree(db, ahead(45), [], now), projectFree(db, 45, [], now));
    assert.deepEqual(projectFreeBand(db, ahead(45), 200, now), projectFreeBand(db, 45, 200, now));
  });
});

test('a confirmed lump inside the horizon raises the low point by exactly its low amount, and never the baseline', () => {
  withFallingLedger(300000, (db) => {
    const before = projectFree(db, 60, [], now);
    const runwayBefore = runwayTo(db, ahead(60), now);
    confirmLump(db, 50000, 80000, ahead(5), ahead(10));
    const after = projectFree(db, 60, [], now);
    assert.deepEqual(after.baseline, before.baseline, 'free to spend never counts a lump');
    assert.ok(after.with_expected_lumps);
    assert.equal(Math.round(after.with_expected_lumps.lowest * 100) - Math.round(before.baseline.lowest * 100), 50000);
    assert.equal(after.expected_lumps_counted?.[0].counted_on, ahead(10));
    const runwayAfter = runwayTo(db, ahead(60), now);
    assert.equal(Math.round(runwayAfter.lowest * 100) - Math.round(runwayBefore.lowest * 100), 50000);
    assert.equal(runwayAfter.expected_lumps_counted.length, 1);
    const band = projectFreeBand(db, 60, 400, now) as { band: { p50: number }; with_expected_lumps?: { band: { p10: number; p50: number; p90: number } } };
    assert.ok(band.with_expected_lumps);
    const lift = band.with_expected_lumps.band.p50 - band.band.p50;
    assert.ok(lift >= 500 && lift <= 800, `the lump lifts the typical end by ${lift}, inside its range`);
    assert.ok(band.with_expected_lumps.band.p90 - band.with_expected_lumps.band.p10 > 0);
  });
});

test('HEALTHY: a lump whose window ends past the horizon, or one still unconfirmed, moves nothing', () => {
  withFallingLedger(300000, (db) => {
    const before = runwayTo(db, ahead(60), now);
    confirmLump(db, 50000, 80000, ahead(55), ahead(70));
    db.prepare(`INSERT INTO expected_lumps (id, label, merchant_key, amount_low_cents, amount_high_cents, window_start, window_end,
      last_occurrence, status, created_at, updated_at) VALUES ('open_1', 'x', 'deposit', 500000, 500000, ?, ?, ?, 'open', ?, ?)`)
      .run(ahead(5), ahead(10), back(100), now.toISOString(), now.toISOString());
    const after = runwayTo(db, ahead(60), now);
    assert.equal(after.lowest, before.lowest);
    assert.deepEqual(after.expected_lumps_counted, []);
    assert.equal('with_expected_lumps' in projectFree(db, 60, [], now), false);
  });
});

test('the runway names the weekly transfer as the scheduled outflow whose removal raises the low most', () => {
  withFallingLedger(300000, (db) => {
    const transfer = db.prepare("SELECT id FROM recurring_patterns WHERE kind = 'transfer'").get() as { id: string } | undefined;
    assert.ok(transfer, 'the fixture schedules a weekly transfer');
    const runway = runwayTo(db, ahead(60), now);
    const drain = runway.largest_scheduled_drain;
    assert.ok(drain);
    assert.equal(drain.pattern_id, transfer.id);
    assert.ok(drain.occurrences >= 8);
    assert.equal(drain.raises_low_by, drain.total, 'with the low on the last day, removing it raises the low by all of it');
  });
});

test('HEALTHY: a ledger that stays above its claims reads covered, with no first short day', () => {
  withFallingLedger(600000, (db) => {
    const runway = runwayTo(db, ahead(60), now);
    assert.equal(runway.covered, true);
    assert.equal(runway.first_short_on, null);
    assert.ok(runway.lowest_band && runway.lowest_band.p10 > 0);
  });
});

test('a ledger that runs below its claims is not covered and names the first short day', () => {
  withFallingLedger(100000, (db) => {
    const runway = runwayTo(db, ahead(60), now);
    assert.equal(runway.covered, false);
    assert.ok(runway.first_short_on && runway.first_short_on <= ahead(60));
  });
});

test('HEALTHY: a point projection that bottoms at exactly $0.00, with no band, reads covered and names no simulation', () => {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    insertAccount(db, { account_name: 'Harbor Checking', type: 'checking', current_balance: 87654 });
    insertAccount(db, { account_name: 'Harbor Card', type: 'credit', is_liability: 1, current_balance: 87654 });
    const runway = runwayTo(db, ahead(30), now);
    assert.equal(runway.lowest, 0);
    assert.equal(runway.lowest_band, null);
    assert.equal(runway.first_short_on, null);
    assert.equal(runway.covered, true, 'reaching the claims exactly is not short of them');
  } finally {
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
});

test('the default end is Dec 31, or next year\'s once this year has under two weeks left', () => {
  assert.equal(defaultRunwayEnd(new Date(2026, 9, 22)), '2026-12-31');
  assert.equal(defaultRunwayEnd(new Date(2026, 11, 20)), '2027-12-31');
});

test('run_simulation takes an end date and refuses one in the past', () => {
  withFallingLedger(300000, (db) => {
    const projected = runAgentTool(db, 'run_simulation', { type: 'project', params: { end_date: ahead(45) } }) as { days: number };
    assert.equal(projected.days, 45);
    const refused = runAgentTool(db, 'run_simulation', { type: 'project', params: { end_date: back(3) } }) as { error?: string };
    assert.match(refused.error ?? '', /end_date/);
    const runway = runAgentTool(db, 'run_simulation', { type: 'runway_to', params: { end_date: ahead(30) } }) as { end_date: string };
    assert.equal(runway.end_date, ahead(30));
  });
});

test('GET /api/insights/runway serves the reading in dollars to the default or a chosen end, and refuses a past one', async () => {
  const db = migratedTestDb();
  insertAccount(db, { account_name: 'Chase Checking', type: 'checking', current_balance: 123456 });
  _setDbForTesting(db);
  const app = express();
  app.use('/api/insights', insightsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const base = `http://127.0.0.1:${addr.port}/api/insights/runway`;
    const plain = (await (await fetch(base)).json()) as { data: RunwayReading };
    assert.equal(plain.data.end_date, defaultRunwayEnd());
    assert.equal(plain.data.lowest, 1234.56);
    assert.equal(plain.data.covered, true);
    const chosen = (await (await fetch(`${base}?end=${ahead(20)}`)).json()) as { data: RunwayReading };
    assert.equal(chosen.data.days, 20);
    assert.equal((await fetch(`${base}?end=${back(2)}`)).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
});
