import type { ReactNode } from 'react';

interface SectionLabelProps {
  children: ReactNode;
  /** Right-aligned summary (e.g. a group subtotal). */
  summary?: ReactNode;
  underline?: boolean;
  className?: string;
}

export function SectionLabel({ children, summary, underline = false, className = '' }: SectionLabelProps) {
  return (
    <div
      className={`flex items-baseline justify-between ${
        underline ? 'border-b border-line-3 pb-1.5' : ''
      } ${className}`}
    >
      {/* 600 rather than 400: at 11.5px with 0.18em of tracking the letterforms are far enough
          apart that a regular weight reads as a broken line rather than a word. This is the only
          place in the app that needed weight to be legible rather than to be loud. */}
      <span className="text-micro font-semibold uppercase tracking-[0.18em] text-muted-2">{children}</span>
      {summary != null && <span className="text-body tabular-nums text-muted">{summary}</span>}
    </div>
  );
}
