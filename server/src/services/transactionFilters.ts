/**
 * Rows that a user resolution has removed from real spending/income:
 *
 *  - `transfer_status` candidate/confirmed: money moving between the user's own accounts, not
 *    spending. (A candidate is excluded too: counting a suspected transfer as spend until it's
 *    confirmed would make totals jump around as detection runs.)
 *  - `duplicate_status` confirmed: a redundant copy the user resolved. Provider rows can't be
 *    deleted (the next sync re-inserts them), so they're flagged and excluded instead.
 *
 * EVERY query that sums transactions as spend or income must apply this. It lived inline in
 * reporting.ts only, so budgets, insights, and the AI context silently counted transfers and
 * duplicates that Reports excluded, the same number differing by screen. Shared here so the
 * definition can't drift again.
 *
 * @param alias table alias used in the query (`t` -> `t.transfer_status`); omit for unaliased.
 */
export function excludedFromTotalsSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  return `COALESCE(${prefix}transfer_status, 'none') NOT IN ('candidate','confirmed')
    AND COALESCE(${prefix}duplicate_status, 'none') <> 'confirmed'`;
}

/**
 * WHICH SIDE of the ledger a row counts on, and how much it contributes.
 *
 * This is the other half of "what counts as spend", and leaving it un-extracted cost real money on
 * screen. `excludedFromTotalsSql` above was pulled out so the transfer/duplicate rule could not
 * drift, but the POLARITY rule stayed hand-written in seven places with at least three different
 * semantics, and one of them silently dropped money on the floor.
 *
 * THE BUG. Reports classified a row by sign AND by category class at once:
 *
 *   SUM(CASE WHEN amount > 0 AND <income category> THEN amount END)   AS income
 *   SUM(CASE WHEN amount < 0 AND <expense category> THEN ABS(amount) END) AS expenses
 *
 * A refund is a POSITIVE amount sitting in an EXPENSE category, so it satisfies neither arm and
 * vanishes from both totals. For 2026-07 the live ledger has five such rows worth $2,054.24 (three
 * Amazon credits, an REI return, a Lyft adjustment). Reports and Today rendered net -$665.24 and a
 * savings rate of -31% for a month that was actually +$1,389.00 and +64%. It is bidirectional: a
 * negative amount in an income category (a payroll correction) was dropped too. Ledger-wide the
 * residual is 53 rows and $6,267.43, and none of it appeared in the "excluded flows" panel that
 * exists to account for what reports leave out.
 *
 * THE RULE. Classify by category class, then sum the SIGNED amount within that class. A refund in
 * an expense category contributes negatively to expenses, netting the purchase down, which is what
 * a refund is. Nothing is filtered out by sign, so nothing can fall between the arms.
 *
 * Uncategorized rows are the one case where sign has to decide, because there is no category to
 * ask. They are assigned by sign and therefore still land on exactly one side.
 *
 * @param t alias for the transactions table
 * @param c alias for the joined categories row (LEFT JOINed, so COALESCE every read)
 */
export function incomeSideSql(t = 't', c = 'c'): string {
  return `(
    COALESCE(${c}.is_income, 0) = 1
    OR (${t}.category_id IS NULL AND ${t}.amount > 0)
  )`;
}

export function expenseSideSql(t = 't', c = 'c'): string {
  return `(
    (${t}.category_id IS NOT NULL
      AND COALESCE(${c}.is_income, 0) = 0
      AND COALESCE(${c}.is_investment, 0) = 0)
    OR (${t}.category_id IS NULL AND ${t}.amount < 0)
  )`;
}

/**
 * What a row contributes to a spend total: a purchase adds, a refund subtracts.
 *
 * Use this instead of `ABS(amount)` behind an `amount < 0` filter. The two are equivalent for a
 * pure-outflow month and differ by exactly the refunds otherwise.
 */
export function spendAmountSql(t = 't'): string {
  return `(-${t}.amount)`;
}
