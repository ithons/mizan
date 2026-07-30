export interface FailableQuery {
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface QueryErrorBannerItem {
  query: FailableQuery;
  /** What this query provides, lowercase: "net worth" -> "Couldn't load net worth." */
  label: string;
}

/** Exported for testing: decides what the banner says without touching React. */
export function summarizeQueryFailures(
  items: QueryErrorBannerItem[]
): { labels: string[]; detail: string | null } | null {
  const failed = items.filter((item) => item.query.isError);
  if (failed.length === 0) return null;

  // The first real message is enough — repeating "Failed to fetch" per query is noise, and the
  // labels already say which parts of the screen are missing.
  const detail = failed
    .map((item) => (item.query.error instanceof Error ? item.query.error.message : null))
    .find((message): message is string => Boolean(message)) ?? null;

  return { labels: failed.map((item) => item.label), detail };
}

/** "a", "a and b", "a, b, and c" */
function joinLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/**
 * View-level "this screen is missing data" banner.
 *
 * Nine of the app's eleven views destructured only `data` from their queries and never referenced
 * `isError`, so a dead server or a 500 rendered as an EMPTY state: "Nothing due in the next 30
 * days", "$0", "no goals yet". The user could not tell a failure from genuinely having no data,
 * which is how "the whole thing is just buggy" starts.
 *
 * This is deliberately a single banner per view rather than per-section `QueryState` wrapping:
 * these screens compose many queries into one layout, and restructuring every section's JSX to
 * gain the same signal would risk far more than it fixes. Use `QueryState` instead where a section
 * stands alone and should show its own skeleton (see Reports).
 */
export function QueryErrorBanner({
  items,
  className = '',
}: {
  items: QueryErrorBannerItem[];
  /** Outer spacing. Lives on the call site so a null banner costs no layout space at all. */
  className?: string;
}) {
  const summary = summarizeQueryFailures(items);
  if (!summary) return null;

  return (
    <div
      role="alert"
      className={`rounded-lg border border-clay/30 bg-clay/5 px-3.5 py-2.5 ${className}`}
    >
      <div className="text-body text-clay">
        Couldn&apos;t load {joinLabels(summary.labels)}. What you see below may be incomplete.
      </div>
      {summary.detail && <div className="mt-0.5 text-note text-muted-2">{summary.detail}</div>}
      <button
        type="button"
        onClick={() => {
          for (const item of items) {
            if (item.query.isError) item.query.refetch();
          }
        }}
        className="mt-2 rounded-md border border-line-2 px-2.5 py-1 text-note text-ink transition-colors hover:bg-well"
      >
        Retry
      </button>
    </div>
  );
}
