// Money TOTALS (balances, transaction amounts, position values, budgets, goals,
// net-worth figures) are stored as integer cents so that sums and comparisons are
// exact rather than drifting at the float level. The API contract stays in dollars:
// each service converts at its output boundary with toDollars(), and writes convert
// inbound dollars with toCents(). Internal aggregation stays in cents and is only
// divided once, at the edge.
//
// IMPORTANT: per-unit PRICES (e.g. holdings.institution_price, a token spot price
// like $0.003) are NOT stored as cents — rounding them to whole cents would destroy
// sub-cent precision. Prices remain REAL dollars.

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function toDollars(cents: number): number {
  return cents / 100;
}

export function toCentsOrNull(dollars: number | null | undefined): number | null {
  return dollars == null ? null : toCents(dollars);
}

export function toDollarsOrNull(cents: number | null | undefined): number | null {
  return cents == null ? null : toDollars(cents);
}

// Return a shallow copy of `obj` with the named cent fields converted to dollars.
// The field list is explicit per call site (never a generic name-sniff) so that
// overloaded numeric keys like `total`/`value`/`balance` are only touched where the
// caller knows they hold money. Null/undefined/non-number fields pass through.
export function dollarizeFields<T extends Record<string, unknown>>(obj: T, fields: readonly string[]): T {
  const out: Record<string, unknown> = { ...obj };
  for (const f of fields) {
    if (typeof out[f] === 'number') out[f] = toDollars(out[f] as number);
  }
  return out as T;
}
