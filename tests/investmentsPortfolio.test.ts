import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { migratedTestDb, TEST_NOW } from './helpers/schema';
import { _setDbForTesting } from '../server/src/db/index';
import reportsRouter from '../server/src/routes/reports';
import { investmentNotes } from '../client/src/views/Investments';

/**
 * The Investments headline, the chart under it and the list beside them must describe the same
 * accounts, and the screen must be silent where an ordinary ledger has nothing to explain.
 *
 * They did not. The headline summed `current_balance` over every account holding a position
 * (Fidelity Roth $105.07 + Coinbase $391.17 + Fidelity Individual $1,939.97 = $2,436.21) while
 * the series was `deriveAssetBuckets(...).investment`, whose INVESTMENT_TYPES set is
 * {brokerage, ira_traditional, ira_roth} with `crypto_wallet` bucketed separately, so it ended
 * at $2,045.04. The gap was the Coinbase wallet exactly; the reconciliation note compares
 * holdings against balances and so could not fire; and the "since last snapshot" delta was
 * computed off the crypto-free series, reading $0 on a day the headline moved.
 *
 * The fix that followed resolved one set, and resolved it without `is_hidden`, which is the
 * predicate `takeSnapshot` writes a breakdown entry under. So a disconnected account stayed in
 * the headline and could never appear in the series again.
 *
 * The fixture is the live ledger's shape on 2026-07-31, in cents. Balances re-derived that day
 * against a copy of `.mizan/mizan.db` at migration 054, taken with `sqlite3 .backup`:
 *   SELECT type, current_balance FROM accounts WHERE is_hidden = 0;
 *   -- brokerage 193997 | ira_roth 10507 | crypto_wallet 39117 | checking 465397 | credit -56326
 *   SELECT SUM(institution_value) FROM holdings;  -- 243621
 */

const ROTH = 10507;
const CRYPTO = 39117;
const BROKERAGE = 193997;
const CHECKING = 465397;
const CARD = -56326; // a card in credit: stored negative, and never portfolio value

function setupDb(): Database.Database {
  const db = migratedTestDb();

  const account = db.prepare(`INSERT INTO accounts
    (id, connection_type, account_name, type, current_balance, is_liability, sort_order, created_at, updated_at)
    VALUES (?,'manual',?,?,?,?,?,?,?)`);
  account.run('acc_roth', 'Fidelity Roth IRA', 'ira_roth', ROTH, 0, 0, TEST_NOW, TEST_NOW);
  account.run('acc_crypto', 'Coinbase', 'crypto_wallet', CRYPTO, 0, 1, TEST_NOW, TEST_NOW);
  account.run('acc_broker', 'Fidelity Individual', 'brokerage', BROKERAGE, 0, 2, TEST_NOW, TEST_NOW);
  account.run('acc_check', 'Chase Checking', 'checking', CHECKING, 0, 3, TEST_NOW, TEST_NOW);
  account.run('acc_card', 'Discover', 'credit', CARD, 1, 4, TEST_NOW, TEST_NOW);

  const security = db.prepare(`INSERT INTO securities (id, ticker, name, type) VALUES (?,?,?,?)`);
  security.run('sec_fund', 'FXAIX', '500 Index Fund', 'mutual_fund');
  security.run('sec_btc', 'BTC', 'Bitcoin', 'crypto');
  security.run('sec_etf', 'VTI', 'Total Market ETF', 'etf');

  const holding = db.prepare(`INSERT INTO holdings
    (id, account_id, security_id, quantity, institution_price, institution_value, cost_basis, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  holding.run('h_roth', 'acc_roth', 'sec_fund', 1, 105.07, ROTH, 9000, TEST_NOW);
  holding.run('h_crypto', 'acc_crypto', 'sec_btc', 0.004, 97792.5, CRYPTO, null, TEST_NOW);
  holding.run('h_broker', 'acc_broker', 'sec_etf', 7, 277.14, BROKERAGE, 180000, TEST_NOW);

  const snapshot = db.prepare(`INSERT INTO net_worth_snapshots
    (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const breakdown = (crypto: number): string =>
    JSON.stringify({ acc_roth: ROTH, acc_crypto: crypto, acc_broker: BROKERAGE, acc_check: CHECKING, acc_card: CARD });
  snapshot.run('s1', '2026-07-30', 1, 0, 1, breakdown(40085), 0, TEST_NOW);
  snapshot.run('s2', '2026-07-31', 1, 0, 1, breakdown(CRYPTO), 0, TEST_NOW);

  return db;
}

/** `takeSnapshot` writes a breakdown entry only for `is_hidden = 0` accounts. */
function rewriteNewestBreakdownWithoutHidden(db: Database.Database): void {
  const visible = db.prepare(
    'SELECT id, current_balance FROM accounts WHERE is_hidden = 0'
  ).all() as Array<{ id: string; current_balance: number }>;
  const breakdown: Record<string, number> = {};
  for (const account of visible) breakdown[account.id] = account.current_balance;
  db.prepare('UPDATE net_worth_snapshots SET breakdown = ? WHERE date = ?').run(
    JSON.stringify(breakdown),
    '2026-07-31'
  );
}

interface InvestmentsReport {
  portfolio_value: number;
  holdings_value: number;
  invested_balance: number;
  crypto_value: number;
  portfolio_account_ids: string[];
  allocation: Array<{ security_type: string; total_value: number }>;
  holdings: Array<{ id: string; account_id: string }>;
  history: Array<{ date: string; value: number; estimated: boolean; covered_accounts: number }>;
}

async function getReport(db: Database.Database, query = ''): Promise<InvestmentsReport> {
  _setDbForTesting(db);
  const app = express();
  app.use('/api/reports', reportsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/reports/investments${query}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: InvestmentsReport }).data;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The notes the screen renders, built the way `Investments` builds them. */
function notesFor(report: InvestmentsReport) {
  return investmentNotes({
    portfolioValue: report.portfolio_value,
    investedBalance: report.invested_balance,
    holdingsValue: report.holdings_value,
    cryptoValue: report.crypto_value,
  });
}

test('the headline and the last point of its own series are the same number', async () => {
  const db = setupDb();
  try {
    const report = await getReport(db);

    assert.equal(report.portfolio_value, 2436.21);
    assert.equal(report.history.at(-1)?.value, 2436.21);

    // The number the old series ended at. If this ever comes back, crypto has been dropped again.
    assert.notEqual(report.history.at(-1)?.value, 2045.04);
  } finally {
    db.close();
  }
});

test('the crypto wallet moving shows up in the series, so the delta is not zero', async () => {
  const db = setupDb();
  try {
    const report = await getReport(db);
    const [prior, newest] = report.history.slice(-2);

    // Only the wallet moved between the two snapshots: 40085c -> 39117c.
    assert.equal(prior.value, 2445.89);
    assert.equal(newest.value, 2436.21);
    assert.equal(Number((newest.value - prior.value).toFixed(2)), -9.68);
  } finally {
    db.close();
  }
});

test('liabilities and cash are not portfolio value, in the headline or in the series', async () => {
  const db = setupDb();
  try {
    const report = await getReport(db);

    // Checking ($4,653.97) and the card in credit (-$563.26) are in every breakdown and in
    // `accounts`, and neither reaches either number.
    for (const point of report.history) {
      assert.ok(point.value < 2500, `${point.date} carries a non-portfolio account: ${point.value}`);
    }
    assert.ok(report.portfolio_value < 2500);
  } finally {
    db.close();
  }
});

test('an ordinary ledger says nothing it does not have to', async () => {
  const db = setupDb();
  try {
    const report = await getReport(db);
    const notes = notesFor(report);

    // Positions and balances agree to the cent, and every account in the headline holds
    // something, so neither note has anything to report.
    assert.equal(report.holdings_value, report.invested_balance);
    assert.equal(report.invested_balance, report.portfolio_value);
    assert.equal(notes.reconciliation, null);
    assert.equal(notes.uninvested, null);

    // Every point covers the whole headline, so the delta is supportable on every one of them.
    assert.deepEqual(
      report.history.map((point) => point.covered_accounts),
      [report.portfolio_account_ids.length, report.portfolio_account_ids.length]
    );
  } finally {
    db.close();
  }
});

test('an unsettled sweep shows as a gap rather than being absorbed into the headline', async () => {
  const db = setupDb();
  try {
    // The provider reports a balance $12.00 above what its own position list adds up to.
    db.prepare('UPDATE accounts SET current_balance = ? WHERE id = ?').run(BROKERAGE + 1200, 'acc_broker');
    const report = await getReport(db);

    assert.equal(report.portfolio_value, 2448.21);
    assert.equal(report.holdings_value, 2436.21);
    assert.equal(report.invested_balance, 2448.21);
    assert.equal(Number((report.holdings_value - report.invested_balance).toFixed(2)), -12);
    assert.match(notesFor(report).reconciliation ?? '', /\$12 below the \$2,448/);
  } finally {
    db.close();
  }
});

test('an IRA funded and not yet invested is an ordinary account, not a discrepancy', async () => {
  const db = setupDb();
  try {
    // Reconciled against the headline, this reported the whole $500 as positions gone missing.
    db.prepare(`INSERT INTO accounts
      (id, connection_type, account_name, type, current_balance, is_liability, sort_order, created_at, updated_at)
      VALUES ('acc_newira','manual','Vanguard Rollover IRA','ira_traditional',50000,0,5,?,?)`).run(TEST_NOW, TEST_NOW);
    const report = await getReport(db);
    const notes = notesFor(report);

    assert.equal(report.portfolio_value, 2936.21);
    assert.equal(report.invested_balance, 2436.21);
    assert.equal(report.holdings_value, 2436.21);
    assert.equal(notes.reconciliation, null);
    // The money is still accounted for, in copy that accuses nothing.
    assert.equal(
      notes.uninvested,
      '$500 of the balance above sits in accounts holding no positions, so it is not in this list.'
    );
  } finally {
    db.close();
  }
});

test('a disconnected account leaves the headline, because it can never rejoin the series', async () => {
  const db = setupDb();
  try {
    // DELETE /api/coinbase/disconnect sets is_hidden = 1 and leaves current_balance alone
    // (server/src/routes/coinbase.ts). The next snapshot then omits the account entirely.
    db.prepare("UPDATE accounts SET is_hidden = 1 WHERE id = 'acc_crypto'").run();
    rewriteNewestBreakdownWithoutHidden(db);
    const report = await getReport(db);

    // Without the is_hidden filter this read 2436.21 against a series ending at 2045.04, and the
    // screen printed a standing "+$391.17 since Jul 31" on a portfolio that had not moved.
    assert.equal(report.portfolio_value, 2045.04);
    assert.equal(report.history.at(-1)?.value, 2045.04);
    assert.deepEqual(report.portfolio_account_ids, ['acc_broker', 'acc_roth']);
    assert.equal(report.crypto_value, 0);
    assert.equal(notesFor(report).crypto, null);

    // Its positions leave the list, the allocation and the reconciliation with it, so nothing on
    // the screen adds up to a number the headline does not contain.
    assert.equal(report.holdings.some((holding) => holding.account_id === 'acc_crypto'), false);
    assert.equal(report.allocation.some((row) => row.security_type === 'crypto'), false);
    assert.equal(report.holdings_value, 2045.04);
    assert.equal(notesFor(report).reconciliation, null);
  } finally {
    db.close();
  }
});

test('an archived account that holds nothing does not enter the headline either', async () => {
  const db = setupDb();
  try {
    // archiveAccount sets is_hidden = 1 on a non-manual account and leaves the balance
    // (server/src/services/accounts.ts). Typed as a brokerage, it matched the type arm of the
    // portfolio set, which carried no is_hidden predicate at all.
    db.prepare(`INSERT INTO accounts
      (id, connection_type, account_name, type, current_balance, is_liability, is_hidden, sort_order, created_at, updated_at)
      VALUES ('acc_old','manual','Archived Brokerage','brokerage',12345,0,1,6,?,?)`).run(TEST_NOW, TEST_NOW);
    const report = await getReport(db);

    assert.equal(report.portfolio_value, 2436.21);
    assert.equal(report.portfolio_account_ids.includes('acc_old'), false);
  } finally {
    db.close();
  }
});

test('a point that does not carry every portfolio account says so', async () => {
  const db = setupDb();
  try {
    // An account opened after a snapshot was taken: the older point is a sum over two accounts,
    // the newer over three, and the difference between them is an account appearing rather than
    // money arriving.
    db.prepare("UPDATE net_worth_snapshots SET breakdown = ? WHERE date = '2026-07-30'").run(
      JSON.stringify({ acc_roth: ROTH, acc_broker: BROKERAGE, acc_check: CHECKING })
    );
    const report = await getReport(db);

    assert.equal(report.portfolio_account_ids.length, 3);
    assert.deepEqual(report.history.map((point) => point.covered_accounts), [2, 3]);
  } finally {
    db.close();
  }
});

test('the crypto split is stated on the screen that includes crypto', async () => {
  const db = setupDb();
  try {
    const report = await getReport(db);

    // Cmd+K reports "Investment Portfolio - $2,045.04" for the same words, because its net-worth
    // section reports crypto separately. Both figures are now printed where either one is.
    assert.equal(report.crypto_value, 391.17);
    assert.equal(
      notesFor(report).crypto,
      'Includes $391 crypto · investment accounts $2,045'
    );
  } finally {
    db.close();
  }
});

test('a ledger with no crypto has no split to state', async () => {
  const db = setupDb();
  try {
    db.prepare("DELETE FROM holdings WHERE account_id = 'acc_crypto'").run();
    db.prepare("DELETE FROM accounts WHERE id = 'acc_crypto'").run();
    const report = await getReport(db);

    assert.equal(report.crypto_value, 0);
    assert.equal(notesFor(report).crypto, null);
  } finally {
    db.close();
  }
});

test('an account typed as cash but holding positions is still in the portfolio', async () => {
  const db = setupDb();
  try {
    // Both live Fidelity accounts were auto-typed `checking` before being corrected. A type-only
    // definition drops them from the series while their holdings stay in the list below it.
    db.prepare("UPDATE accounts SET type = 'checking' WHERE id = ?").run('acc_broker');
    const report = await getReport(db);

    assert.equal(report.portfolio_value, 2436.21);
    assert.equal(report.history.at(-1)?.value, 2436.21);
  } finally {
    db.close();
  }
});

test('a snapshot whose breakdown cannot be read is dropped, not plotted as zero', async () => {
  const db = setupDb();
  try {
    db.prepare(`INSERT INTO net_worth_snapshots
      (id, date, total_assets, total_liabilities, net_worth, breakdown, is_estimated, created_at)
      VALUES ('s0','2026-07-29',1,0,1,'{not json',0,?)`).run(TEST_NOW);
    const report = await getReport(db);

    assert.deepEqual(report.history.map((p) => p.date), ['2026-07-30', '2026-07-31']);
    assert.equal(report.history.some((p) => p.value === 0), false);
  } finally {
    db.close();
  }
});

test('estimated travels with the point so the screen can say which baseline it used', async () => {
  const db = setupDb();
  try {
    db.prepare('UPDATE net_worth_snapshots SET is_estimated = 1 WHERE date = ?').run('2026-07-30');
    const report = await getReport(db);

    assert.deepEqual(report.history.map((p) => p.estimated), [true, false]);
  } finally {
    db.close();
  }
});

test('an empty portfolio is served as one, not as a SQL error', async () => {
  const db = setupDb();
  try {
    db.prepare('DELETE FROM holdings').run();
    db.prepare("DELETE FROM accounts WHERE id IN ('acc_roth','acc_crypto','acc_broker')").run();
    const report = await getReport(db);

    assert.deepEqual(report.portfolio_account_ids, []);
    assert.equal(report.portfolio_value, 0);
    assert.equal(report.holdings_value, 0);
    assert.deepEqual(report.allocation, []);
    assert.deepEqual(report.holdings, []);
    assert.deepEqual(report.history.map((point) => point.covered_accounts), [0, 0]);
  } finally {
    db.close();
  }
});
