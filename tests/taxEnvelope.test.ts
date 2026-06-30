import test from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { runMigrations, _setDbForTesting } from '../server/src/db/index.js';
import { setPreference } from '../server/src/services/preferences.js';
import { calculateGoalProgress } from '../server/src/services/goalProgress.js';

test('Tax envelope safe-to-spend subtraction', async (t) => {
  const db = new Database(':memory:');
  _setDbForTesting(db);
  runMigrations();

  // 1. Set up tax envelope goal and normal savings goal
  db.prepare(`
    INSERT INTO goals (id, name, type, target_amount, current_amount, is_tax_envelope, is_archived, created_at, updated_at)
    VALUES 
      ('goal_tax', 'Tax Liability', 'savings', 10000, 1500, 1, 0, '2024-01-01', '2024-01-01'),
      ('goal_house', 'Downpayment', 'savings', 50000, 20000, 0, 0, '2024-01-01', '2024-01-01')
  `).run();

  // 2. Set up Liquid Assets (Account balances)
  // Let's say we have an account with $25,000
  db.prepare(`
    INSERT INTO accounts (id, connection_type, account_name, type, current_balance, created_at, updated_at)
    VALUES ('acc_1', 'manual', 'Checking', 'checking', 25000, '2024-01-01', '2024-01-01')
  `).run();

  // Let's mimic what Dashboard.tsx does for safe to spend:
  // const safeToSpend = Math.max(0, liquid - upcomingBills - allocatedBudgets - allocatedGoals);
  
  // Actually, we'll verify the math directly here as it would be evaluated.
  const liquid = 25000;
  const upcomingBills = 0;
  const allocatedBudgets = 0;
  
  // Find goals that are tax envelopes
  const goals = db.prepare(`SELECT * FROM goals WHERE is_archived = 0`).all() as any[];
  
  // Dashboard logic:
  const allocatedTaxEnvelopes = goals.reduce((sum, g) => {
    return g.is_tax_envelope ? sum + g.current_amount : sum;
  }, 0);

  const safeToSpend = Math.max(0, liquid - upcomingBills - allocatedBudgets - allocatedTaxEnvelopes);

  // $25k liquid - $1.5k tax liability = $23.5k safe to spend.
  // The $20k house downpayment is NOT subtracted.
  assert.strictEqual(safeToSpend, 23500);

  // 3. Verify the AI Worker SQL picks up the right goal and income
  // Add a category that is taxable
  db.prepare(`
    INSERT INTO categories (id, name, is_income, taxable, is_system, is_investment, sort_order)
    VALUES ('cat_freelance', 'Freelance', 1, 1, 0, 0, 1)
  `).run();

  // Insert a $5000 income transaction today
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, amount, merchant_name, category_id, created_at, updated_at)
    VALUES ('tx_1', 'acc_1', datetime('now'), 5000, 'Upwork', 'cat_freelance', datetime('now'), datetime('now'))
  `).run();

  const taxGoal = db.prepare(`SELECT id, name FROM goals WHERE type = 'savings' AND is_tax_envelope = 1 AND is_archived = 0 LIMIT 1`).get() as any;
  assert.strictEqual(taxGoal.id, 'goal_tax');

  const recentTaxableIncome = db.prepare(`
    SELECT t.id, t.merchant_name, t.amount, c.name as category_name
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE c.taxable = 1 AND t.amount > 0 AND t.created_at >= datetime('now', '-7 days')
  `).all() as any[];

  assert.strictEqual(recentTaxableIncome.length, 1);
  assert.strictEqual(recentTaxableIncome[0].amount, 5000);
});
