/**
 * Retired into `/ledger`.
 *
 * The route is still mounted in `App.tsx` and still linked from other screens, so it renders the
 * ledger rather than redirecting to a path the router does not know yet. `Ledger` reads the
 * `uncategorized` and `range` search params this screen used to answer, so its deep links keep
 * working unchanged.
 */
export { Ledger as Transactions } from './Ledger';
