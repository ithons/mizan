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
