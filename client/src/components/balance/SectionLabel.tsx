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
      <span className="text-micro uppercase tracking-[0.18em] text-muted-2">{children}</span>
      {summary != null && <span className="text-body tabular-nums text-muted">{summary}</span>}
    </div>
  );
}
