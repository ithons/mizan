import { format } from 'date-fns';

// Provider transaction instants are normalized to a calendar day (YYYY-MM-DD) in the
// server's LOCAL timezone. Mizān is single-user and local-first: the process runs on the
// owner's own machine in one timezone, and every "today"/"this month" boundary elsewhere
// (snapshot, reporting, recurring, budgets) is already computed in local time. Storing the
// transaction day in local time keeps the data and those boundaries consistent, and matches
// how the owner actually reckons a purchase ("I bought this Tuesday") — a late-night
// transaction stays on the local day it happened rather than drifting to the next UTC day.
// (Existing rows dated under the old UTC rule reconcile on the next resync, which re-fetches
// each transaction's full timestamp.)

export function epochSecondsToLocalDate(epochSeconds: number): string {
  return format(new Date(epochSeconds * 1000), 'yyyy-MM-dd');
}

export function isoToLocalDate(iso: string): string {
  return format(new Date(iso), 'yyyy-MM-dd');
}
