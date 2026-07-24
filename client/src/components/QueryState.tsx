import type { ReactNode } from 'react';
import { SkeletonRows } from './SkeletonLoader';

/**
 * Wraps a section that reads from a query so a FAILED request never renders as an EMPTY one.
 *
 * Before this existed, no view in the app checked `isError`, so a dead server or a 500 showed up
 * as "All caught up." / "No spending in this period." / a permanent "Loading…" — the user could
 * not tell "you have no data" from "the request failed".
 *
 * Usage: wrap only the part of the section that depends on the query; keep headings outside so
 * the layout doesn't jump between states.
 */
export function QueryState({
  isLoading,
  isError,
  error,
  onRetry,
  label,
  skeletonRows = 3,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** What failed to load, lowercase, e.g. "spending" -> "Couldn't load spending." */
  label: string;
  skeletonRows?: number;
  children: ReactNode;
}) {
  if (isError) {
    const detail = error instanceof Error && error.message ? error.message : null;
    return (
      <div className="py-4">
        <div className="text-[13.5px] text-clay">Couldn&apos;t load {label}.</div>
        {detail && <div className="mt-0.5 text-xs text-muted-2">{detail}</div>}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded-md border border-line-2 px-2.5 py-1 text-xs text-ink transition-colors hover:bg-rail"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (isLoading) return <SkeletonRows rows={skeletonRows} />;

  return <>{children}</>;
}
