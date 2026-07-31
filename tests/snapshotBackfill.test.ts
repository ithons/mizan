import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { addDays, format, startOfMonth, subMonths } from 'date-fns';
import { _setDbForTesting } from '../server/src/db/index';
import {
  accountFloorMonths,
  backfillSnapshots,
  earliestCoveredMonth,
  readReconstructionFrontier,
  reconcileReconstructedHistory,
  reconstructionTrigger,
  takeSnapshot,
} from '../server/src/services/snapshot';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

// backfillSnapshots estimates historical net worth by reversing later transactions off the
// current balances. Liability balances are stored as positive "amount owed" and move opposite
// the transaction sign (a purchase is a negative amount but raises what's owed), so they must
// be reversed in the opposite direction from asset balances. This guards that split.
//
// These tests run against the REAL migrated schema rather than a hand-written one. The floor bug
// this file now covers survived partly because a hand-written net_worth_snapshots had no idea what
// columns production carried, so a test could pass against a table shape that did not exist.

function withTestDb(run: (db: Database.Database) => void): void {
  const db = migratedTestDb();
  _setDbForTesting(db);
  try {
    run(db);
  } finally {
    // The service caches getDb(); drop the test handle so later suites don't reuse it.
    _setDbForTesting(undefined as unknown as Database.Database);
    db.close();
  }
}

function monthStart(monthsBack: number): string {
  return format(startOfMonth(subMonths(new Date(), monthsBack)), 'yyyy-MM-dd');
}

/**
 * The 15th of a past month, which is the date every fixture transaction wants.
 *
 * A month's estimate is the following month's estimate with that month's transactions undone, so a
 * transaction has to fall strictly inside the target month to be both reversed into it and counted
 * as evidence for it. Anchoring to the 15th keeps that true on the 1st and the 31st alike.
 */
function midMonth(monthsBack: number): string {
  return format(addDays(startOfMonth(subMonths(new Date(), monthsBack)), 14), 'yyyy-MM-dd');
}

// Reverse-replay only runs for months an account's own ledger reaches back to (see
// accountFloorMonths), and only for months that ledger actually recorded something in. These
// fixtures test the DIRECTION of the reversal and use "last month" as a convenient target, so each
// one needs an anchor transaction old enough to establish the account's floor. The anchor is dated
// before the target month, so it is never among the transactions being reversed and never perturbs
// the arithmetic.
function anchorCoverage(db: Database.Database, accountId: string): void {
  insertTransaction(db, { account_id: accountId, date: midMonth(4), amount: 0 });
}

interface SnapshotRow {
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  liquid_assets: number;
  investment_assets: number;
  crypto_assets: number;
  breakdown: string;
  is_estimated: number;
  covered_accounts: number | null;
  total_accounts: number | null;
  created_at: string;
}

function snapshotAt(db: Database.Database, date: string): SnapshotRow | undefined {
  return db.prepare('SELECT * FROM net_worth_snapshots WHERE date = ?').get(date) as
    | SnapshotRow
    | undefined;
}

function seedEstimate(db: Database.Database, id: string, date: string, netWorth: number): void {
  db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, ?, 0, ?, '{}', 1, '2026-01-01T00:00:00.000Z')
  `).run(id, date, netWorth, netWorth);
}

function seedMeasured(db: Database.Database, id: string, date: string, netWorth: number): void {
  db.prepare(`
    INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?, ?, ?, 0, ?, '{}', 0, '2026-01-01T00:00:00.000Z')
  `).run(id, date, netWorth, netWorth);
}

test('backfillSnapshots reverses liability purchases in the correct direction', () => {
  withTestDb((db) => {
    // Current state: checking holds $1000, card owes $500 (positive "amount owed").
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 50000, is_liability: 1 });
    anchorCoverage(db, 'acc_check');
    anchorCoverage(db, 'acc_card');

    // Two transactions inside last month (after the month start being reconstructed):
    //  - a $200 expense on checking (negative), and
    //  - a $300 purchase on the card (negative, raises what's owed going forward).
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(1), amount: -20000 });
    insertTransaction(db, { account_id: 'acc_card', date: midMonth(1), amount: -30000 });

    backfillSnapshots();

    // Snapshot for the start of last month, before those transactions happened.
    const target = monthStart(1);
    const snap = snapshotAt(db, target);

    assert.ok(snap, `expected an estimated snapshot at ${target}`);
    // Checking before the $200 expense: 100000 - (-20000) = 120000.
    assert.equal(snap.total_assets, 120000);
    // Card owed before the $300 purchase: 50000 + (-30000) = 20000 (NOT 80000, the old bug).
    assert.equal(snap.total_liabilities, 20000);
    assert.equal(snap.net_worth, 100000);
    assert.equal(snap.is_estimated, 1);
  });
});

test('backfillSnapshots reverses only contributions for market-driven accounts', () => {
  withTestDb((db) => {
    // Brokerage worth $2000 today. Last month: a $100 auto-invest (contribution), a $500
    // sell (internal reshuffle), and a $5 dividend. Only the contribution should move the
    // estimated past value; reversing the buy/sell/dividend would be market-blind nonsense.
    insertAccount(db, { id: 'acc_inv', type: 'brokerage', current_balance: 200000 });
    anchorCoverage(db, 'acc_inv');
    const when = midMonth(1);
    insertTransaction(db, { account_id: 'acc_inv', date: when, amount: -10000, category_id: 'cat_inv_buy' });
    insertTransaction(db, { account_id: 'acc_inv', date: when, amount: 50000, category_id: 'cat_inv_sell' });
    insertTransaction(db, { account_id: 'acc_inv', date: when, amount: 500, category_id: 'cat_inv_dividend' });

    backfillSnapshots();

    const target = monthStart(1);
    const snap = snapshotAt(db, target);

    assert.ok(snap, `expected an estimated snapshot at ${target}`);
    // Only the $100 contribution reverses: 200000 - 10000 = 190000. The sell and dividend
    // must NOT move it (old reverse-everything logic would have given 200000-50000-500).
    assert.equal(snap.total_assets, 190000);
    assert.equal(snap.investment_assets, 190000);
  });
});

test('backfillSnapshots clamps a spend-only card liability at zero instead of going negative', () => {
  withTestDb((db) => {
    // Card is paid off today ($0 owed). We have only its purchases (a spend-only import),
    // no payments, so reversing purchases alone would drive "owed" to negative $500 (a phantom
    // asset).
    insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 0, is_liability: 1 });
    // A zero-balance account has nothing to reconstruct, so it never establishes coverage on
    // its own, and a clamped account is never evidence for a month. A funded checking account
    // spending in the same month is what puts the month in range.
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    anchorCoverage(db, 'acc_card');
    anchorCoverage(db, 'acc_check');
    insertTransaction(db, { account_id: 'acc_card', date: midMonth(1), amount: -50000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(1), amount: -1000 });

    backfillSnapshots();

    const snap = snapshotAt(db, monthStart(1));
    assert.ok(snap);
    assert.equal(snap.total_liabilities, 0); // clamped, not negative 50000
  });
});

test('backfillSnapshots reaches back to the oldest transaction, past the 12-month wall', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });

    // A single posted transaction 30 months ago: deep history the old 12-month cap missed.
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(30), amount: -5000 });

    backfillSnapshots();

    assert.ok(snapshotAt(db, monthStart(30)), 'expected an estimated snapshot 30 months back');
  });
});

test('takeSnapshot buckets todays balances and excludes hidden accounts; closed accounts add $0', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'chk', type: 'checking', current_balance: 100000 });    // $1000 liquid
    insertAccount(db, { id: 'card', type: 'credit', current_balance: 50000, is_liability: 1 }); // $500 owed
    insertAccount(db, { id: 'cb', type: 'crypto_wallet', current_balance: 20000 }); // $200 crypto
    insertAccount(db, { id: 'closed', type: 'closed', current_balance: 0 });        // $0 (kept for history)
    insertAccount(db, { id: 'hid', type: 'checking', current_balance: 999999, is_hidden: 1 });

    takeSnapshot();

    const snap = snapshotAt(db, format(new Date(), 'yyyy-MM-dd'));
    assert.ok(snap);
    assert.equal(snap.total_assets, 120000, 'assets = checking + crypto (+ $0 closed), hidden excluded');
    assert.equal(snap.total_liabilities, 50000);
    assert.equal(snap.net_worth, 70000);
    assert.equal(snap.liquid_assets, 100000, 'closed adds $0');
    assert.equal(snap.crypto_assets, 20000);
    assert.equal(snap.investment_assets, 0);
    assert.equal(snap.is_estimated, 0, 'live snapshot is not an estimate');
    // A measurement observed every account it lists, so it is fully covered by construction.
    assert.equal(snap.covered_accounts, 4);
    assert.equal(snap.total_accounts, 4);
  });
});

test('backfillSnapshots nets a Coinbase convert to zero (matched crypto buy + sell legs)', () => {
  withTestDb((db) => {
    // Crypto wallet worth $500 today. Last month: a BTC->ETH convert (a $100 sell leg + a $100
    // buy leg, no external money). The estimate for before the convert must be unchanged ($500),
    // not $400 (the old bug that reversed only the buy leg).
    insertAccount(db, { id: 'cb', type: 'crypto_wallet', current_balance: 50000 });
    anchorCoverage(db, 'cb');
    const when = midMonth(1);
    insertTransaction(db, { account_id: 'cb', date: when, amount: 10000, category_id: 'cat_crypto_sell' });
    insertTransaction(db, { account_id: 'cb', date: when, amount: -10000, category_id: 'cat_crypto_buy' });

    backfillSnapshots();

    const snap = snapshotAt(db, monthStart(1));
    assert.ok(snap);
    assert.equal(snap.crypto_assets, 50000, 'convert nets to zero: pre-convert crypto still $500');
    assert.equal(snap.total_assets, 50000);
  });
});

// ── Coverage gate ────────────────────────────────────────────────────────────
// Reverse-replay produces a number for any month you ask for, but past the end of an account's
// ledger that number is just today's balance restated. On real data this manufactured 20
// consecutive months with identical breakdowns, rendered on the same line as measured snapshots.

test('accountFloorMonths gives every account its own floor, not one shared floor', () => {
  const floors = accountFloorMonths(
    [
      { id: 'old', current_balance: 100000 },
      { id: 'new', current_balance: 50000 },
    ],
    new Map([
      ['old', '2024-03-15'],
      ['new', '2026-03-10'],
    ])
  );
  // The old global floor was the MAXIMUM of these, so 'new' capped 'old' at 2026-03 and threw
  // away two years of reconstructable history.
  assert.deepEqual([...floors], [['old', '2024-03-01'], ['new', '2026-03-01']]);
  assert.equal(earliestCoveredMonth(floors), '2024-03-01');
});

test('accountFloorMonths exempts accounts with nothing to reconstruct', () => {
  const floors = accountFloorMonths(
    [
      { id: 'funded', current_balance: 100000 },
      { id: 'static', current_balance: 38000 },  // manual cash: no transactions, never moves
      { id: 'emptied', current_balance: 0 },     // closed/paid off: no value to reconstruct
    ],
    new Map([
      ['funded', '2024-03-15'],
      ['emptied', '2026-07-01'],
    ])
  );
  assert.deepEqual([...floors.keys()], ['funded']);
  assert.equal(earliestCoveredMonth(floors), '2024-03-01');
});

test('earliestCoveredMonth is null when nothing that holds value has any history', () => {
  const floors = accountFloorMonths([{ id: 'cash', current_balance: 38000 }], new Map());
  assert.equal(floors.size, 0);
  assert.equal(earliestCoveredMonth(floors), null);
});

test('backfillSnapshots emits nothing for months no account reaches', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    // History starts 3 months ago. Anything older than that is unknowable.
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(3), amount: -5000 });

    backfillSnapshots();

    assert.ok(
      snapshotAt(db, monthStart(3)),
      'the month the ledger actually records is estimated'
    );
    assert.equal(
      snapshotAt(db, monthStart(6)),
      undefined,
      'a month older than every account ledger must produce no snapshot at all'
    );
  });
});

test('backfillSnapshots writes nothing when no funded account has any history', () => {
  withTestDb((db) => {
    // A manual cash account with a balance and no transactions ever. Every "estimate" here
    // would be $380 copied backwards forever, which is what the old code produced.
    insertAccount(db, { id: 'wallet', type: 'cash', current_balance: 38000 });

    backfillSnapshots();

    const count = db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number };
    assert.equal(count.n, 0);
  });
});

// ── Per-account floors ───────────────────────────────────────────────────────
// One global floor at the LATEST account start date meant the newest account gated every other
// one. On the live database a card opened 2026-03-10 holding $283.81 reduced a 35-month ledger to
// five estimated months.

test('a recently opened account no longer truncates an older account history', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_old', type: 'checking', current_balance: 100000 });
    insertAccount(db, { id: 'acc_new', type: 'credit', current_balance: 28381, is_liability: 1 });

    insertTransaction(db, { account_id: 'acc_old', date: midMonth(24), amount: -5000 });
    insertTransaction(db, { account_id: 'acc_old', date: midMonth(1), amount: -1000 });
    insertTransaction(db, { account_id: 'acc_new', date: midMonth(1), amount: -2000 });

    backfillSnapshots();

    const deep = snapshotAt(db, monthStart(24));
    assert.ok(deep, 'the old account still reaches 24 months back despite the new card');

    // The new card is left OUT of that month rather than carried back at today's balance: it did
    // not exist then, and asserting $283.81 of debt in 2024 is the failure the floor exists for.
    const deepBreakdown = JSON.parse(deep.breakdown) as Record<string, number>;
    assert.deepEqual(Object.keys(deepBreakdown), ['acc_old']);
    assert.equal(deep.total_liabilities, 0);

    // Once the card's own history begins, it is part of the balance sheet again.
    const recent = snapshotAt(db, monthStart(1));
    assert.ok(recent);
    const recentBreakdown = JSON.parse(recent.breakdown) as Record<string, number>;
    assert.deepEqual(Object.keys(recentBreakdown).sort(), ['acc_new', 'acc_old']);
  });
});

test('coverage is recorded per month and is lower the further back the series goes', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_old', type: 'checking', current_balance: 100000 });
    insertAccount(db, { id: 'acc_mid', type: 'savings', current_balance: 50000 });
    insertAccount(db, { id: 'acc_new', type: 'credit', current_balance: 28381, is_liability: 1 });

    for (const monthsBack of [24, 10, 5, 1]) {
      insertTransaction(db, { account_id: 'acc_old', date: midMonth(monthsBack), amount: -5000 });
    }
    insertTransaction(db, { account_id: 'acc_mid', date: midMonth(10), amount: -5000 });
    insertTransaction(db, { account_id: 'acc_new', date: midMonth(1), amount: -2000 });

    backfillSnapshots();

    const deep = snapshotAt(db, monthStart(24));
    const middle = snapshotAt(db, monthStart(5));
    const recent = snapshotAt(db, monthStart(1));
    assert.ok(deep && middle && recent);

    // A month covering 1 of 3 accounts is not comparable to one covering 3, and the series has to
    // carry that or the chart draws the arrival of accounts as a climb in net worth.
    assert.equal(deep.covered_accounts, 1);
    assert.equal(deep.total_accounts, 3);
    assert.equal(middle.covered_accounts, 2);
    assert.equal(middle.total_accounts, 3);
    assert.equal(recent.covered_accounts, 3);
    assert.equal(recent.total_accounts, 3);

    const uncovered = db.prepare(
      'SELECT COUNT(*) AS n FROM net_worth_snapshots WHERE covered_accounts IS NULL'
    ).get() as { n: number };
    assert.equal(uncovered.n, 0, 'every row the backfill writes records its coverage');
  });
});

// ── A month has to carry information ────────────────────────────────────────
// Per-account floors alone re-created the failure the floor was built to end: on the live ledger
// they produced ten consecutive months at exactly $380.00, where the covered set was one static
// cash account, three closed accounts at $0, and a card pinned on the clamp.

test('a month whose covered accounts are all static or clamped produces nothing', () => {
  withTestDb((db) => {
    // Manual cash, no transactions ever: carried flat, so it is a constant, not history.
    insertAccount(db, { id: 'wallet', type: 'cash', current_balance: 38000 });
    // The live BofA card in miniature: purchases known, payments not, balance ~$0 today, so
    // reversing its spending drives "owed" far negative and the clamp pins it at zero forever.
    insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 582, is_liability: 1 });
    for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
      insertTransaction(db, { account_id: 'acc_card', date: midMonth(monthsBack), amount: -40000 });
    }

    backfillSnapshots();

    const rows = db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number };
    assert.equal(rows.n, 0, 'a flat line drawn from a constant and a clamp is not history');
  });
});

test('a month is emitted as soon as one covered account is neither static nor clamped', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'wallet', type: 'cash', current_balance: 38000 });
    insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 582, is_liability: 1 });
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
      insertTransaction(db, { account_id: 'acc_card', date: midMonth(monthsBack), amount: -40000 });
    }
    // Real evidence, in one month only.
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(3), amount: -2500 });

    backfillSnapshots();

    const informative = snapshotAt(db, monthStart(3));
    assert.ok(informative, 'the month with usable evidence is estimated');
    assert.equal(informative.total_assets, 140500, 'checking reversed to $1,025 plus $380 static cash');
    assert.equal(informative.total_liabilities, 0, 'the card is still on the clamp');

    for (const silent of [6, 5, 4, 2, 1]) {
      assert.equal(
        snapshotAt(db, monthStart(silent)),
        undefined,
        `month ${silent} rests entirely on a constant and a clamp`
      );
    }
  });
});

test('a covered but silent month is left out rather than restated from its neighbour', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(6), amount: -5000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(2), amount: -3000 });

    backfillSnapshots();

    assert.ok(snapshotAt(db, monthStart(6)));
    assert.ok(snapshotAt(db, monthStart(2)));
    // The ledger covers months 5 through 3 and records nothing in them. Emitting them would copy
    // month 2's number backwards three times and draw it as observed history.
    for (const silent of [5, 4, 3]) {
      assert.equal(snapshotAt(db, monthStart(silent)), undefined, `month ${silent} says nothing new`);
    }
  });
});

// ── Stale estimates ─────────────────────────────────────────────────────────
// The floor is a function of today's balances, so it moves. Estimated rows were only ever created
// when absent and never re-examined, so a row written under an older floor outlived it. Migration
// 040 deleted this class of row by hand and rebuild.ts recreated five of them two days later.

test('an estimated snapshot below a raised floor is removed, and a measured one is not', () => {
  withTestDb((db) => {
    // Today's ledger reaches back 3 months. Anything older is no longer reconstructable, which is
    // exactly the state that follows paying an old card to zero or connecting a new account.
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(3), amount: -5000 });

    const stale = monthStart(12);
    const measured = monthStart(13);
    seedEstimate(db, 'stale_est', stale, 400000);
    seedMeasured(db, 'real', measured, 500000);

    backfillSnapshots();

    assert.equal(
      snapshotAt(db, stale),
      undefined,
      'an estimate the current floor forbids must be deleted, not left behind forever'
    );
    assert.ok(
      snapshotAt(db, measured),
      'a measured snapshot is a record of real balances and is never purged'
    );
  });
});

test('an estimate for a month that is now uninformative is removed too', () => {
  withTestDb((db) => {
    // Inside the covered window, but the ledger records nothing that month, so the current rules
    // would never write it. A row nothing re-examines is a row that outlives its justification.
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(6), amount: -5000 });
    seedEstimate(db, 'silent_est', monthStart(4), 400000);

    backfillSnapshots();

    assert.equal(snapshotAt(db, monthStart(4)), undefined);
    assert.ok(snapshotAt(db, monthStart(6)), 'the month with evidence survives');
  });
});

test('every estimate is dropped when nothing holding value has history left', () => {
  withTestDb((db) => {
    // The card was paid to zero, so it is exempt and the ledger can justify no month at all. The
    // rows it justified yesterday are the ones nothing would ever have removed.
    insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 0, is_liability: 1 });
    insertTransaction(db, { account_id: 'acc_card', date: midMonth(6), amount: -5000 });
    seedEstimate(db, 'est_a', monthStart(4), 300000);
    seedEstimate(db, 'est_b', monthStart(3), 310000);

    backfillSnapshots();

    const count = db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number };
    assert.equal(count.n, 0);
  });
});

test('an in-range estimate is recomputed against todays balances, and a measurement is not', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(10), amount: -5000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(2), amount: -5000 });

    // A stale estimate inside the covered window, holding a number computed against balances the
    // owner no longer has. Left alone (the old `if (existing) continue`) it disagrees permanently
    // with the measured segment it joins.
    const target = monthStart(2);
    seedEstimate(db, 'old_est', target, 999999);
    // A measured month start must survive the same pass untouched.
    const measured = monthStart(3);
    seedMeasured(db, 'measured', measured, 777777);

    backfillSnapshots();

    const recomputed = snapshotAt(db, target);
    assert.ok(recomputed);
    assert.equal(recomputed.net_worth, 105000, 'recomputed from current balances, not left at $9,999.99');
    assert.equal(recomputed.is_estimated, 1);
    assert.equal(recomputed.covered_accounts, 1);
    assert.notEqual(recomputed.created_at, '2026-01-01T00:00:00.000Z');

    const untouched = snapshotAt(db, measured);
    assert.ok(untouched);
    assert.equal(untouched.net_worth, 777777, 'an observation is never overwritten by an estimate');
    assert.equal(untouched.created_at, '2026-01-01T00:00:00.000Z');
  });
});

// ── Exemptions ──────────────────────────────────────────────────────────────
// Per-account floors must not quietly cancel the two accounts that never needed one.

test('a zero-balance account carries no floor and stays in every reconstructed month', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_old', type: 'checking', current_balance: 100000 });
    // Closed two months ago at $0. Its history is shallow, but with nothing to reconstruct it
    // neither gates the walk nor gets dropped out of the months it predates.
    insertAccount(db, { id: 'acc_closed', type: 'closed', current_balance: 0 });
    insertTransaction(db, { account_id: 'acc_old', date: midMonth(24), amount: -5000 });
    insertTransaction(db, { account_id: 'acc_closed', date: midMonth(2), amount: 0 });

    backfillSnapshots();

    const deep = snapshotAt(db, monthStart(24));
    assert.ok(deep, 'a shallow zero-balance account does not truncate the walk');
    const breakdown = JSON.parse(deep.breakdown) as Record<string, number>;
    assert.deepEqual(Object.keys(breakdown).sort(), ['acc_closed', 'acc_old']);
    assert.equal(breakdown.acc_closed, 0);
    assert.equal(deep.covered_accounts, 2, 'nothing to reconstruct counts as accounted for');
  });
});

// ── Reaching the reconstruction at all ──────────────────────────────────────
// `backfillSnapshots` had no caller anywhere in server/src: only scripts/backfill/rebuild.ts, run
// by hand, and this file. Every improvement above was therefore correct and unreachable, and the
// stored database still held what the old code wrote. `reconcileReconstructedHistory` is the entry
// point the sync and the owner's rebuild both go through.

const EMPTY_FRONTIER = {
  reconstructableFrom: null,
  oldestSnapshot: null,
  oldestEstimate: null,
  unreachableEstimates: 0,
  balancesAt: null,
  mark: null,
};

test('an ordinary sync finds nothing to reconstruct and does not touch the series', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(6), amount: -5000 });

    // First run: nothing has ever been replayed.
    const first = reconcileReconstructedHistory();
    assert.equal(first.ran, true);
    assert.equal(first.trigger, 'never_reconstructed');
    assert.ok(first.reconstructed > 0);

    const before = db.prepare('SELECT id, date, created_at FROM net_worth_snapshots ORDER BY date').all();

    // Second run against the same data. Reconstruction is a pure function of today's balances and
    // the ledger, so an hourly rerun would rewrite these rows on evidence that did not change.
    const second = reconcileReconstructedHistory();
    assert.equal(second.ran, false);
    assert.equal(second.trigger, null);
    assert.deepEqual(
      db.prepare('SELECT id, date, created_at FROM net_worth_snapshots ORDER BY date').all(),
      before,
      'a sync with nothing new to replay must leave every row byte-identical'
    );
  });
});

test('a ledger that reaches a new month is what fires the rebuild', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(3), amount: -5000 });
    reconcileReconstructedHistory();
    assert.equal(reconcileReconstructedHistory().ran, false);

    // The shape of a deep resync or a CSV import of old history: rows land below everything the
    // reconstruction has ever seen.
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(20), amount: -2500 });

    const frontier = readReconstructionFrontier(db);
    assert.equal(frontier.reconstructableFrom, monthStart(20));
    assert.equal(reconstructionTrigger(frontier), 'ledger_window_moved');

    const run = reconcileReconstructedHistory();
    assert.equal(run.ran, true);
    assert.equal(run.oldestReconstructed, monthStart(20));
    assert.equal(reconcileReconstructedHistory().ran, false, 'and it settles again afterwards');
  });
});

/**
 * The failure a watermark exists to prevent, reproduced.
 *
 * "The ledger reaches below the oldest snapshot" is the obvious condition and is permanently true
 * on the real database: the ledger starts 2023-09-16, a full rebuild produces an oldest replayed
 * month of 2024-07-01, and every month between is covered but uninformative, so the walk correctly
 * refuses to emit one. Keyed on the rows alone, the reconstruction would run every hour forever.
 */
test('a run that declines to emit the oldest months still settles', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    // The live BofA card in miniature: purchases known, payments not, ~$0 owed today, so every
    // month it reaches is pinned on the clamp. Its first purchase sets the floor 24 months back
    // and not one of those months earns a point, which is the live ledger's 2023-09 to 2024-06.
    insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 582, is_liability: 1 });
    for (const monthsBack of [24, 18, 12, 6]) {
      insertTransaction(db, { account_id: 'acc_card', date: midMonth(monthsBack), amount: -40000 });
    }
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(4), amount: -2500 });

    const first = reconcileReconstructedHistory();
    assert.equal(first.ran, true);
    assert.equal(first.oldestReconstructed, monthStart(4));
    assert.ok(
      readReconstructionFrontier(db).reconstructableFrom! < first.oldestReconstructed!,
      'the ledger reaches below the oldest row the walk agreed to write'
    );

    assert.equal(
      reconcileReconstructedHistory().ran,
      false,
      'the gap between what the ledger reaches and what the walk emitted is not work'
    );
  });
});

test('balances moving is work, because every replayed point starts from them', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(4), amount: -5000 });
    reconcileReconstructedHistory();
    assert.equal(reconcileReconstructedHistory().ran, false);

    const before = snapshotAt(db, monthStart(4));
    assert.ok(before);
    assert.equal(before.net_worth, 105000);

    // A sync writes a new balance. Reverse-replay is today's balance minus what came after, so
    // every replayed month moves with it; left alone, the replayed segment drifts away from the
    // measured one it joins.
    db.prepare("UPDATE accounts SET current_balance = 250000, updated_at = ? WHERE id = 'acc_check'")
      .run('2099-01-01T00:00:00.000Z');

    assert.equal(reconstructionTrigger(readReconstructionFrontier(db)), 'balances_moved');
    const run = reconcileReconstructedHistory();
    assert.equal(run.ran, true);
    assert.equal(snapshotAt(db, monthStart(4))?.net_worth, 255000);
    assert.equal(reconcileReconstructedHistory().ran, false);
  });
});

test('the reconstruction never consumes a measured snapshot, on either path', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(6), amount: -5000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(2), amount: -3000 });

    // A measurement sitting on a month start the walk is about to visit, and one below the floor
    // the purge sweeps.
    seedMeasured(db, 'inside', monthStart(2), 777777);
    seedMeasured(db, 'below', monthStart(30), 555555);

    reconcileReconstructedHistory();
    reconcileReconstructedHistory({ force: true });

    const inside = snapshotAt(db, monthStart(2));
    const below = snapshotAt(db, monthStart(30));
    assert.ok(inside && below);
    assert.equal(inside.net_worth, 777777);
    assert.equal(inside.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(below.net_worth, 555555);
    assert.equal(below.is_estimated, 0);
  });
});

test('a forced rebuild runs when the trigger would decline, and says the trigger was null', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(4), amount: -5000 });
    reconcileReconstructedHistory();

    // The case the frontier cannot see: an import landing INSIDE the window already reconstructed,
    // adding evidence to a month that had none. This is what the owner's rebuild is for.
    assert.equal(snapshotAt(db, monthStart(2)), undefined);
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(2), amount: -1500 });
    assert.equal(reconcileReconstructedHistory().ran, false);

    const forced = reconcileReconstructedHistory({ force: true });
    assert.equal(forced.ran, true);
    assert.equal(forced.trigger, null, 'the owner asking is not one of the data conditions');
    assert.ok(snapshotAt(db, monthStart(2)), 'the newly evidenced month is now reconstructed');
  });
});

test('every reconstructed row a rebuild leaves behind carries its coverage', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertAccount(db, { id: 'acc_card', type: 'credit', current_balance: 28381, is_liability: 1 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(9), amount: -5000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(3), amount: -2500 });
    insertTransaction(db, { account_id: 'acc_card', date: midMonth(3), amount: -2000 });

    // Migration 044 filled covered_accounts only WHERE is_estimated = 0, so every estimated row
    // written before it carries NULL and the chart cannot tell a coverage change from an estimate
    // across that boundary. `seedEstimate` reproduces exactly that row.
    seedEstimate(db, 'legacy', monthStart(3), 400000);
    // Same, but dated somewhere the month walk never visits, so nothing in the loop can correct it.
    seedEstimate(db, 'orphan', format(addDays(startOfMonth(subMonths(new Date(), 5)), 9), 'yyyy-MM-dd'), 410000);

    assert.equal(readReconstructionFrontier(db).unreachableEstimates, 1);
    assert.equal(reconstructionTrigger(readReconstructionFrontier(db)), 'unreachable_estimates');

    reconcileReconstructedHistory();

    const uncovered = db.prepare(
      'SELECT COUNT(*) AS n FROM net_worth_snapshots WHERE is_estimated = 1 AND covered_accounts IS NULL'
    ).get() as { n: number };
    assert.equal(uncovered.n, 0);
    assert.equal(snapshotAt(db, monthStart(3))?.covered_accounts, 2);
    assert.equal(readReconstructionFrontier(db).unreachableEstimates, 0);
  });
});

test('a raised floor is a reason to run, and the run clears what it forbids', () => {
  withTestDb((db) => {
    // Paying the card to zero exempts it and drops the floor to what checking can reach.
    insertAccount(db, { id: 'acc_check', type: 'checking', current_balance: 100000 });
    insertTransaction(db, { account_id: 'acc_check', date: midMonth(3), amount: -5000 });
    seedEstimate(db, 'stale', monthStart(14), 400000);

    assert.equal(reconstructionTrigger(readReconstructionFrontier(db)), 'floor_raised');
    const run = reconcileReconstructedHistory();
    assert.equal(run.ran, true);
    assert.equal(snapshotAt(db, monthStart(14)), undefined);
  });
});

test('every estimate is unsupported once nothing holding value has history, and that is a trigger', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'wallet', type: 'cash', current_balance: 38000 });
    seedEstimate(db, 'orphaned', monthStart(4), 300000);

    const frontier = readReconstructionFrontier(db);
    assert.equal(frontier.reconstructableFrom, null);
    assert.equal(reconstructionTrigger(frontier), 'no_ledger');

    assert.equal(reconcileReconstructedHistory().ran, true);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number }).n,
      0
    );
    // And with nothing left to withdraw, the next sync is quiet again. This is the case that only
    // the mark can settle: the run wrote no row, so nothing in the series records that it happened.
    assert.equal(reconstructionTrigger(readReconstructionFrontier(db)), null);
    assert.equal(reconcileReconstructedHistory().ran, false);
  });
});

test('reconstructionTrigger reports the state, not an opinion about it', () => {
  const MARK = { derivedAt: '2026-07-30T00:00:00.000Z', reconstructableFrom: '2024-07-01', balancesAt: '2026-07-30T00:00:00.000Z' };

  assert.equal(reconstructionTrigger(EMPTY_FRONTIER), 'never_reconstructed');
  assert.equal(
    reconstructionTrigger({ ...EMPTY_FRONTIER, mark: MARK }),
    null,
    'no ledger, nothing on record, and a run already recorded is not work'
  );
  assert.equal(
    reconstructionTrigger({ ...EMPTY_FRONTIER, oldestEstimate: '2026-02-01', mark: MARK }),
    'no_ledger'
  );

  // The live state on 2026-07-31, before anything called this: per-account floors reach 2023-09-01
  // and no run had ever been recorded.
  //   SELECT account_id, MIN(date) FROM transactions WHERE pending = 0 GROUP BY account_id;
  //   SELECT MIN(date) FROM net_worth_snapshots;   -- 2026-02-01
  const live = {
    reconstructableFrom: '2023-09-01',
    oldestSnapshot: '2026-02-01',
    oldestEstimate: '2026-02-01',
    unreachableEstimates: 0,
    balancesAt: '2026-07-30T21:50:51.314Z',
    mark: null,
  };
  assert.equal(reconstructionTrigger(live), 'never_reconstructed');

  // After that run, the same ledger is quiet: the walk emitted 2024-07-01 as its oldest row and
  // declined every month below it, which is a refusal rather than an omission.
  const settled = {
    ...live,
    oldestSnapshot: '2024-07-01',
    oldestEstimate: '2024-07-01',
    mark: { derivedAt: '2026-07-31T00:00:00.000Z', reconstructableFrom: '2023-09-01', balancesAt: '2026-07-30T21:50:51.314Z' },
  };
  assert.equal(reconstructionTrigger(settled), null);
  assert.equal(
    reconstructionTrigger({ ...settled, balancesAt: '2026-07-31T09:00:00.000Z' }),
    'balances_moved'
  );
  assert.equal(
    reconstructionTrigger({ ...settled, reconstructableFrom: '2023-01-01' }),
    'ledger_window_moved'
  );
  assert.equal(
    reconstructionTrigger({ ...settled, reconstructableFrom: '2026-03-01' }),
    'floor_raised',
    'a floor above the rows on record outranks the window having moved'
  );
  assert.equal(
    reconstructionTrigger({ ...settled, unreachableEstimates: 1 }),
    'unreachable_estimates'
  );
});

test('a transaction-free account is carried flat rather than excluded', () => {
  withTestDb((db) => {
    insertAccount(db, { id: 'acc_old', type: 'checking', current_balance: 100000 });
    // Manual cash: static as far as the ledger knows, so carrying it back adds no false movement
    // in a month that other evidence already justifies.
    insertAccount(db, { id: 'wallet', type: 'cash', current_balance: 38000 });
    insertTransaction(db, { account_id: 'acc_old', date: midMonth(24), amount: -5000 });

    backfillSnapshots();

    const deep = snapshotAt(db, monthStart(24));
    assert.ok(deep);
    const breakdown = JSON.parse(deep.breakdown) as Record<string, number>;
    assert.equal(breakdown.wallet, 38000);
    assert.equal(deep.covered_accounts, 2);
  });
});
