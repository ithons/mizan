import React from 'react';

export function SkeletonCell({ width = '60%' }: { width?: string }) {
  return (
    <div
      className="h-3 bg-border/60 rounded animate-pulse"
      style={{ width }}
    />
  );
}

export function SkeletonRow({ cols = 5 }: { cols?: number }) {
  const widths = ['40%', '55%', '30%', '45%', '35%', '50%', '40%', '30%'];
  return (
    <tr className="border-b border-border">
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

export function SkeletonCard() {
  return (
    <div className="bg-surface border border-border rounded p-4 space-y-3">
      <div className="h-3 bg-border/60 rounded animate-pulse w-1/3" />
      <div className="h-6 bg-border/60 rounded animate-pulse w-2/3" />
      <div className="h-3 bg-border/60 rounded animate-pulse w-1/2" />
    </div>
  );
}
