import type { ReactNode } from 'react';
import { ExplainPanel, ExplainToggle, useDisclosure } from './Disclosure';

interface SectionLabelProps {
  children: ReactNode;
  /** Right-aligned summary (e.g. a group subtotal). */
  summary?: ReactNode;
  underline?: boolean;
  className?: string;
  /** Methodology for this section, kept behind a "?" rather than printed. */
  explain?: ReactNode;
}

export function SectionLabel({ children, summary, underline = false, className = '', explain }: SectionLabelProps) {
  const disclosure = useDisclosure();
  const label = typeof children === 'string' ? children.toLowerCase() : 'this section';
  return (
    <div className={className}>
    <div
      className={`flex items-baseline justify-between ${
        underline ? 'border-b border-line-3 pb-1.5' : ''
      }`}
    >
      {/* 600 rather than 400: at 11.5px with 0.18em of tracking the letterforms are far enough
          apart that a regular weight reads as a broken line rather than a word. This is the only
          place in the app that needed weight to be legible rather than to be loud. */}
      <span className="flex items-center gap-2">
        <span className="text-micro font-semibold uppercase tracking-[0.18em] text-muted-2">{children}</span>
        {explain && <ExplainToggle disclosure={disclosure} label={label} />}
      </span>
      {summary != null && <span className="text-body tabular-nums text-muted">{summary}</span>}
    </div>
    {explain && <ExplainPanel disclosure={disclosure}>{explain}</ExplainPanel>}
    </div>
  );
}
