import test from 'node:test';
import assert from 'node:assert/strict';
import { investmentReturns, investmentReturnsToDollars, xirr } from '../server/src/services/investmentReturns';
import { AGENT_TOOLS, runAgentTool } from '../server/src/services/advisorAgentTools';
import { insertAccount, insertTransaction, migratedTestDb } from './helpers/schema';

const TODAY = '2026-10-22';

test('xirr solves a hand-computed series: 1000(1.1)^2 + 1000(1.1) = 2310', () => {
  const result = xirr([
    { date: '2024-01-01', amount: -1000 },
    { date: '2024-12-31', amount: -1000 },
    { date: '2025-12-31', amount: 2310 },
  ]);
  assert.equal(result.rate?.toFixed(4), '0.1000');
});

test('xirr matches the published spreadsheet example to four decimals', () => {
  const result = xirr([
    { date: '2008-01-01', amount: -10000 },
    { date: '2008-03-01', amount: 2750 },
    { date: '2008-10-30', amount: 4250 },
    { date: '2009-02-15', amount: 3250 },
    { date: '2009-04-01', amount: 2750 },
  ]);
  assert.equal(result.rate?.toFixed(4), '0.3734');
});

test('xirr refuses flows no rate can balance rather than returning one', () => {
  assert.equal(xirr([{ date: '2026-01-01', amount: -100 }, { date: '2026-06-01', amount: -50 }]).rate, null);
  assert.equal(xirr([{ date: '2026-01-01', amount: 0 }, { date: '2026-06-01', amount: 0 }]).reason, 'no money moved and nothing was held');
  // Held at the end with nothing put in: something is held, so the reason must not say otherwise.
  assert.equal(xirr([{ date: '2026-01-01', amount: 0 }, { date: '2026-06-01', amount: 500 }]).reason, 'the flows all run one way, so no rate balances them');
  // A loss is a rate, not a refusal.
  assert.ok((xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 900 }]).rate ?? 0) < 0);
});

function brokerage(balance: number) {
  const db = migratedTestDb();
  const id = insertAccount(db, { type: 'brokerage', account_name: 'Fidelity Individual', current_balance: balance });
  insertTransaction(db, { account_id: id, date: '2026-06-24', amount: 100000, category_id: 'cat_inv_transfer' });
  return { db, id };
}

test('a deposit that grew is its compound annual rate over the window', () => {
  const { db, id } = brokerage(110000);
  const returns = investmentReturns(db, { from: '2026-06-01', today: TODAY });
  assert.ok(returns);
  assert.equal(returns.days, 143);
  const row = returns.accounts.find((a) => a.account_id === id)!;
  assert.equal(row.reason, null);
  // 1000 on 2026-06-24 to 1100 on 2026-10-22 is 120 days.
  assert.equal(row.annualized?.toFixed(4), (Math.pow(1.1, 365 / 120) - 1).toFixed(4));
  assert.equal(returns.portfolio.annualized?.toFixed(4), row.annualized?.toFixed(4));
  assert.deepEqual([row.start_value, row.end_value, row.net_flows], [0, 110000, 100000]);
});

test('a 60-day window says not enough history', () => {
  const { db } = brokerage(110000);
  const returns = investmentReturns(db, { from: '2026-08-23', today: TODAY })!;
  assert.equal(returns.days, 60);
  for (const row of [...returns.accounts, returns.portfolio]) {
    assert.equal(row.annualized, null);
    assert.equal(row.reason, 'not enough history');
  }
});

test('an estimated end point is not computed', () => {
  const { db } = brokerage(110000);
  // Before today and with no recorded value that day, the brokerage is replayed from today's balance.
  const returns = investmentReturns(db, { from: '2026-06-01', to: '2026-10-01', today: TODAY })!;
  for (const row of [...returns.accounts, returns.portfolio]) {
    assert.equal(row.annualized, null);
    assert.equal(row.reason, 'the value on 2026-10-01 is an estimate');
  }
});

test('dollars at the edge, and the advisor reads the same figures', () => {
  const { db } = brokerage(110000);
  const dollars = investmentReturnsToDollars(investmentReturns(db, { from: '2026-06-01', today: TODAY })!);
  assert.deepEqual([dollars.portfolio.start_value, dollars.portfolio.end_value, dollars.portfolio.net_flows], [0, 1100, 1000]);
  assert.ok(AGENT_TOOLS.some((tool) => tool.name === 'get_investment_returns'));
  const viaTool = runAgentTool(db, 'get_investment_returns', { months: 0 }) as ReturnType<typeof investmentReturnsToDollars>;
  // All history opens on the deposit's own day, replayed flat from today's balance, so the start is flagged.
  assert.deepEqual(
    [viaTool.from, viaTool.portfolio.start_value, viaTool.portfolio.start_estimated, viaTool.portfolio.net_flows],
    ['2026-06-24', 1100, true, 0],
  );
});

function withCoinbase(coinMove: boolean) {
  const { db, id } = brokerage(110000);
  const wallet = insertAccount(db, { type: 'crypto_wallet', account_name: 'Coinbase', current_balance: 50000 });
  insertTransaction(db, { account_id: wallet, date: '2026-06-24', amount: -40000, category_id: 'cat_crypto_buy' });
  if (coinMove) {
    db.prepare("INSERT INTO securities (id, ticker, name, type) VALUES ('sec_btc', 'BTC', 'Bitcoin', 'crypto')").run();
    const moved = insertTransaction(db, { account_id: wallet, date: '2026-08-10', amount: -5000, category_id: 'cat_xfer_out' });
    db.prepare("UPDATE transactions SET quantity = -0.001, security_id = 'sec_btc' WHERE id = ?").run(moved);
  }
  return { db, id, wallet };
}

test('a crypto wallet whose coins moved to another wallet is not computed, and the portfolio leaves it out by name', () => {
  const { db, id, wallet } = withCoinbase(true);
  const returns = investmentReturns(db, { from: '2026-06-01', today: TODAY })!;
  const coinbase = returns.accounts.find((a) => a.account_id === wallet)!;
  assert.equal(coinbase.annualized, null);
  assert.equal(coinbase.reason, 'a coin transfer to or from another wallet is not counted as money in or out');
  const fidelity = returns.accounts.find((a) => a.account_id === id)!;
  assert.equal(returns.portfolio.name, 'Portfolio, without Coinbase');
  assert.equal(returns.portfolio.annualized?.toFixed(6), fidelity.annualized?.toFixed(6));
  assert.equal(returns.portfolio.end_value, 110000);
});

test('a crypto wallet with no coin moves is computed and stays in the portfolio', () => {
  const { db, wallet } = withCoinbase(false);
  const returns = investmentReturns(db, { from: '2026-06-01', today: TODAY })!;
  const coinbase = returns.accounts.find((a) => a.account_id === wallet)!;
  assert.equal(coinbase.reason, null);
  assert.equal(returns.portfolio.name, 'Portfolio');
  assert.equal(returns.portfolio.end_value, 160000);
});

function harbor(duplicate: boolean) {
  const db = migratedTestDb();
  const id = insertAccount(db, { type: 'brokerage', account_name: 'Harbor Brokerage', current_balance: 210000 });
  insertTransaction(db, { account_id: id, date: '2026-01-10', amount: 100000, category_id: 'cat_inv_transfer' });
  insertTransaction(db, { account_id: id, date: '2026-06-24', amount: 100000, category_id: 'cat_inv_transfer' });
  if (duplicate) {
    const copy = insertTransaction(db, { account_id: id, date: '2026-06-24', amount: 100000, category_id: 'cat_inv_transfer' });
    db.prepare("UPDATE transactions SET duplicate_status = 'confirmed' WHERE id = ?").run(copy);
  }
  return investmentReturns(db, { from: '2026-03-01', today: TODAY })!.accounts.find((a) => a.account_id === id)!;
}

test('a confirmed duplicate is neither a deposit nor part of the replayed start value', () => {
  const row = harbor(true);
  // 2,100 today less the one real 1,000 deposit after the start: 1,100 then, so nothing was earned.
  assert.equal(row.start_value, 110000);
  assert.equal(row.net_flows, 100000);
  assert.equal(row.annualized?.toFixed(6), '0.000000');
});

test('HEALTHY: without the duplicate the same ledger reads the same, so the copy changed nothing', () => {
  const { account_id: _plain, ...plain } = harbor(false);
  const { account_id: _copied, ...copied } = harbor(true);
  assert.deepEqual(plain, copied);
});

/** A $1,000 buy and its $1,000 sell: worth nothing either way, whether the dollars stayed or left. */
function lanternWallet(dollarsStayed: boolean) {
  const db = migratedTestDb();
  const broker = insertAccount(db, { type: 'brokerage', account_name: 'Harbor Brokerage', current_balance: 110000 });
  insertTransaction(db, { account_id: broker, date: '2026-06-24', amount: 100000, category_id: 'cat_inv_transfer' });
  const wallet = insertAccount(db, { type: 'crypto_wallet', account_name: 'Lantern Wallet', current_balance: dollarsStayed ? 100000 : 0 });
  insertTransaction(db, { account_id: wallet, date: '2025-10-01', amount: -100000, category_id: 'cat_crypto_buy' });
  insertTransaction(db, { account_id: wallet, date: '2026-04-01', amount: 100000, category_id: 'cat_crypto_sell' });
  db.prepare("INSERT INTO securities (id, ticker, name, type) VALUES ('sec_usd', 'USD', 'US Dollar', 'crypto')").run();
  if (dollarsStayed) {
    db.prepare(`INSERT INTO holdings (id, account_id, security_id, quantity, institution_price, institution_value, currency, updated_at)
      VALUES ('h_usd', ?, 'sec_usd', 1000, 1, 100000, 'USD', '2026-10-22T00:00:00Z')`).run(wallet);
  } else {
    const out = insertTransaction(db, { account_id: wallet, date: '2026-04-01', amount: -100000, category_id: 'cat_xfer_out' });
    db.prepare("UPDATE transactions SET quantity = -1000, security_id = 'sec_usd' WHERE id = ?").run(out);
  }
  return { db, broker, wallet };
}

test('a wallet holding the dollars from a sell is not computed, and the portfolio leaves it out by name', () => {
  const { db, broker, wallet } = lanternWallet(true);
  const returns = investmentReturns(db, { from: '2025-09-01', today: TODAY })!;
  const lantern = returns.accounts.find((a) => a.account_id === wallet)!;
  assert.equal(lantern.annualized, null);
  assert.equal(lantern.reason, 'the wallet held $1,000.00 in US dollars on 2026-10-22, and dollars resting in a wallet are not counted as money in or out');
  assert.equal(returns.portfolio.name, 'Portfolio, without Lantern Wallet');
  assert.equal(returns.portfolio.end_value, 110000);
  assert.equal(returns.portfolio.annualized?.toFixed(6), returns.accounts.find((a) => a.account_id === broker)!.annualized?.toFixed(6));
});

test('dollars a recorded holding shows resting in the wallet on the window\'s first day refuse the rate too', () => {
  const { db, wallet } = lanternWallet(false);
  const deposit = insertTransaction(db, { account_id: wallet, date: '2025-08-20', amount: 5000, category_id: 'cat_xfer_in' });
  db.prepare("UPDATE transactions SET quantity = 50, security_id = 'sec_usd' WHERE id = ?").run(deposit);
  db.prepare(`INSERT INTO holdings_history (id, account_id, security_id, date, quantity, institution_price, institution_value, created_at)
    VALUES ('hh_usd', ?, 'sec_usd', '2025-09-01', 50, 1, 5000, '2025-09-01T00:00:00Z')`).run(wallet);
  const lantern = investmentReturns(db, { from: '2025-09-01', today: TODAY })!.accounts.find((a) => a.account_id === wallet)!;
  assert.equal(lantern.annualized, null);
  assert.equal(lantern.reason, 'the wallet held $50.00 in US dollars on 2025-09-01, and dollars resting in a wallet are not counted as money in or out');
});

test('HEALTHY: a wallet whose sell left the same day is computed, at the zero it earned', () => {
  const { db, wallet } = lanternWallet(false);
  const returns = investmentReturns(db, { from: '2025-09-01', today: TODAY })!;
  const lantern = returns.accounts.find((a) => a.account_id === wallet)!;
  assert.equal(lantern.reason, null);
  assert.equal(lantern.annualized?.toFixed(6), '0.000000');
  assert.equal(returns.portfolio.name, 'Portfolio');
});

function newRoth(contributed: string) {
  const db = migratedTestDb();
  const id = insertAccount(db, { type: 'ira_roth', account_name: 'Juniper Roth', current_balance: 105000 });
  insertTransaction(db, { account_id: id, date: contributed, amount: 100000, category_id: 'cat_inv_transfer' });
  return { db, id };
}

test('an account held for 30 days of a 1-year window is not annualized from those 30 days', () => {
  const { db, id } = newRoth('2026-09-22');
  const returns = investmentReturns(db, { from: '2025-10-22', today: TODAY })!;
  assert.equal(returns.days, 365);
  for (const row of [returns.accounts.find((a) => a.account_id === id)!, returns.portfolio]) {
    assert.equal(row.annualized, null);
    assert.equal(row.reason, 'not enough history');
  }
});

test('HEALTHY: an account held for 100 days of a 1-year window is annualized over those days', () => {
  const { db, id } = newRoth('2026-07-14');
  const returns = investmentReturns(db, { from: '2025-10-22', today: TODAY })!;
  const row = returns.accounts.find((a) => a.account_id === id)!;
  assert.equal(row.reason, null);
  assert.equal(row.annualized?.toFixed(4), (Math.pow(1.05, 365 / 100) - 1).toFixed(4));
  assert.equal(returns.portfolio.annualized?.toFixed(4), row.annualized?.toFixed(4));
});
