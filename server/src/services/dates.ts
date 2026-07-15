// Provider transaction dates are normalized to a UTC calendar day (YYYY-MM-DD).
// Using UTC rather than the server's local timezone keeps a given instant on the same
// calendar day regardless of where the process runs, and makes SimpleFIN and Coinbase
// agree with each other (Coinbase timestamps were already treated as UTC). This matters
// for daily reports, "this month" boundaries, and recurring detection: a transaction
// posted just before midnight must not drift onto a different day when the server's tz
// changes.

export function epochSecondsToUtcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function isoToUtcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
