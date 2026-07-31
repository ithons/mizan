/**
 * Retired into `/ledger`.
 *
 * Review was a filter built as a screen: uncategorized rows, duplicate candidates and transfer
 * candidates are all predicates over the transactions table, and each of them was a tab. They are
 * filter chips on the ledger now, and the decisions they carry happen on the rows they are about.
 */
export { Ledger as ReviewInbox } from '../views/Ledger';
