export function SkeletonCell({ width = '60%' }: { width?: string }) {
  return <div className="h-3 animate-pulse rounded bg-line/70" style={{ width }} />;
}

export function SkeletonRow({ cols = 5 }: { cols?: number }) {
  const widths = ['40%', '55%', '30%', '45%', '35%', '50%', '40%', '30%'];
  return (
    <tr className="border-b border-line">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <SkeletonCell width={widths[i % widths.length]} />
        </td>
      ))}
    </tr>
  );
}

export function SkeletonList({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} cols={cols} />
      ))}
    </>
  );
}

/** Hairline list-row skeletons matching the Balance row rhythm. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  const widths = ['45%', '60%', '35%', '55%', '40%', '50%'];
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between border-b border-line px-3 py-4">
          <div className="w-1/2 space-y-2">
            <div className="h-3.5 animate-pulse rounded bg-line/70" style={{ width: widths[i % widths.length] }} />
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-line/50" />
          </div>
          <div className="h-4 w-16 animate-pulse rounded bg-line/70" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="space-y-3 rounded-xl border border-line-2 bg-card p-[18px]">
      <div className="h-3 w-1/3 animate-pulse rounded bg-line/70" />
      <div className="h-6 w-2/3 animate-pulse rounded bg-line/70" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-line/50" />
    </div>
  );
}
