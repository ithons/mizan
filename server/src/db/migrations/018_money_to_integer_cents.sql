-- Convert monetary TOTALS from REAL dollars to integer cents for exact arithmetic.
-- Per-unit prices (holdings.institution_price, holdings_history.institution_price,
-- investment_transactions.price) are deliberately left as REAL dollars: rounding a
-- sub-cent token price to whole cents would destroy it. Crypto quantities
-- (accounts.native_balance, holdings.quantity, holdings_history.quantity) are not
-- money and are untouched.
--
-- Values are rounded to the nearest cent. Reconciliation (pre-sum * 100 == post-sum)
-- is verified on a copy before this runs against real data; the migration runner
-- also wraps this file in a transaction with a foreign-key check.

-- accounts
UPDATE accounts SET
  current_balance   = CAST(ROUND(current_balance   * 100) AS INTEGER),
  available_balance = CAST(ROUND(available_balance * 100) AS INTEGER),
  credit_limit      = CAST(ROUND(credit_limit      * 100) AS INTEGER);

-- transactions
UPDATE transactions SET amount = CAST(ROUND(amount * 100) AS INTEGER);

-- holdings (institution_price stays REAL)
UPDATE holdings SET
  institution_value  = CAST(ROUND(institution_value  * 100) AS INTEGER),
  cost_basis         = CAST(ROUND(cost_basis         * 100) AS INTEGER),
  manual_cost_basis  = CAST(ROUND(manual_cost_basis  * 100) AS INTEGER);

-- holdings_history (institution_price stays REAL)
UPDATE holdings_history SET
  institution_value = CAST(ROUND(institution_value * 100) AS INTEGER),
  cost_basis        = CAST(ROUND(cost_basis        * 100) AS INTEGER);

-- budgets
UPDATE budgets SET
  amount           = CAST(ROUND(amount           * 100) AS INTEGER),
  rollover_balance = CAST(ROUND(rollover_balance * 100) AS INTEGER);

-- budget_rollover_ledger
UPDATE budget_rollover_ledger SET
  starting_rollover = CAST(ROUND(starting_rollover * 100) AS INTEGER),
  budget_amount     = CAST(ROUND(budget_amount     * 100) AS INTEGER),
  actual_spend      = CAST(ROUND(actual_spend      * 100) AS INTEGER),
  ending_rollover   = CAST(ROUND(ending_rollover   * 100) AS INTEGER);

-- goals (CHECK target_amount > 0 / current_amount >= 0 still hold after scaling)
UPDATE goals SET
  target_amount   = CAST(ROUND(target_amount   * 100) AS INTEGER),
  current_amount  = CAST(ROUND(current_amount  * 100) AS INTEGER),
  starting_amount = CAST(ROUND(starting_amount * 100) AS INTEGER);

-- net_worth_snapshots numeric columns
UPDATE net_worth_snapshots SET
  total_assets      = CAST(ROUND(total_assets      * 100) AS INTEGER),
  total_liabilities = CAST(ROUND(total_liabilities * 100) AS INTEGER),
  net_worth         = CAST(ROUND(net_worth         * 100) AS INTEGER),
  liquid_assets     = CAST(ROUND(liquid_assets     * 100) AS INTEGER),
  investment_assets = CAST(ROUND(investment_assets * 100) AS INTEGER),
  crypto_assets     = CAST(ROUND(crypto_assets     * 100) AS INTEGER);

-- net_worth_snapshots.breakdown is a JSON {account_id: dollarBalance} map; scale
-- each value in place. A column-type migration would miss numbers inside TEXT.
UPDATE net_worth_snapshots SET breakdown = (
  SELECT json_group_object(je.key, CAST(ROUND(je.value * 100) AS INTEGER))
  FROM json_each(net_worth_snapshots.breakdown) je
)
WHERE breakdown IS NOT NULL AND json_valid(breakdown);

-- recurring
UPDATE recurring_patterns SET average_amount = CAST(ROUND(average_amount * 100) AS INTEGER);
UPDATE recurring_occurrence_adjustments SET adjusted_amount = CAST(ROUND(adjusted_amount * 100) AS INTEGER);

-- investment_transactions (price stays REAL; table currently unused but kept consistent)
UPDATE investment_transactions SET
  amount = CAST(ROUND(amount * 100) AS INTEGER),
  fees   = CAST(ROUND(fees   * 100) AS INTEGER);
