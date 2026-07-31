/**
 * Retired into `/ledger`.
 *
 * A bill is a transaction that has not happened yet. Giving future money its own screen is the
 * mechanism by which a forecast gets read as a fact, so the 30-day forecast now sits at the top of
 * the ledger, above today's rule, on the same date spine, in estimate ink.
 */
export { Ledger as Bills } from './Ledger';
