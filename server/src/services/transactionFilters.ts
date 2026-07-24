/**
 * Rows that a user resolution has removed from real spending/income:
 *
 *  - `transfer_status` candidate/confirmed — money moving between the user's own accounts, not
 *    spending. (A candidate is excluded too: counting a suspected transfer as spend until it's
 *    confirmed would make totals jump around as detection runs.)
 *  - `duplicate_status` confirmed — a redundant copy the user resolved. Provider rows can't be
 *    deleted (the next sync re-inserts them), so they're flagged and excluded instead.
 *
 * EVERY query that sums transactions as spend or income must apply this. It lived inline in
 * reporting.ts only, so budgets, insights, and the AI context silently counted transfers and
 * duplicates that Reports excluded — the same number differing by screen. Shared here so the
 * definition can't drift again.
 *
 * @param alias table alias used in the query (`t` -> `t.transfer_status`); omit for unaliased.
 */
export function excludedFromTotalsSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  return `COALESCE(${prefix}transfer_status, 'none') NOT IN ('candidate','confirmed')
    AND COALESCE(${prefix}duplicate_status, 'none') <> 'confirmed'`;
}
