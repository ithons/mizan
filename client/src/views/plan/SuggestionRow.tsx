import type { ReactNode } from 'react';

/** One row of a Plan suggestion list: a label and figure, then a detail line with its actions. */
export function SuggestionRow({ label, figure, figureInk, detail, detailInk, note, children }: {
  label: string;
  figure: string;
  figureInk: 'text-ink' | 'text-estimate';
  detail: string;
  detailInk: 'text-muted-2' | 'text-estimate';
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-line-2 py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate text-body-lg text-ink">{label}</span>
        <span className={`flex-shrink-0 text-body tabular-nums ${figureInk}`}>{figure}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-note">
        <span className={detailInk}>{detail}</span>
        <span className="flex items-baseline gap-4">
          {note && <span className="text-muted-2">{note}</span>}
          {children}
        </span>
      </div>
    </div>
  );
}
