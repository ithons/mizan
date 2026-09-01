/**
 * How long an outbound provider request may take before it is abandoned.
 *
 * Axios defaults to `timeout: 0`, which means wait forever, and none of the four outbound call
 * sites in this app set one. `grep -n timeout` over `simplefin.ts`, `coinbase.ts`,
 * `routes/simplefin.ts` and `retry.ts` returned nothing at all.
 *
 * It compounds with the retry policy rather than being bounded by it. `retry.ts`'s
 * `defaultIsRetryable` returns true when `err.response?.status` is `undefined`, which is exactly
 * the shape of a socket that never answered, and `maxAttempts` defaults to 3. So an unbounded
 * request was retried up to three times, each unbounded, while `runFullSync` held the sync open
 * and the hourly scheduler's re-entrancy guard skipped every pass behind it.
 *
 * The asymmetry is what makes this a design gap rather than an oversight. One directory away, the
 * AI call is bounded at 300s with `maxRetries: 1` and a paragraph arguing that the bound sits
 * "well inside the hourly sync cadence that fires this" (aiWorker.ts). The calls that fetch the
 * actual money had no bound and no argument.
 *
 * 60 seconds, times the three attempts `withRetry` allows, is three minutes for a provider stage.
 * The measured p50 of a whole successful sync on the owner's ledger is 5.3s and the p90 is 11.5s,
 * so this is roughly five times the slowest ordinary pass: generous enough that a slow-but-alive
 * provider still succeeds, short enough that a dead socket cannot outlive the sync interval.
 */
export const PROVIDER_HTTP_TIMEOUT_MS = 60_000;
