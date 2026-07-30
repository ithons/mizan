import { useState, type ReactNode } from 'react';

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Hover/focus tooltip on a card surface; for icon buttons and chart marks. */
export function Tooltip({ label, children, className = '' }: TooltipProps) {
  const [show, setShow] = useState(false);
  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-line-2 bg-card px-2.5 py-1 text-note text-ink-soft"
        >
          {label}
        </span>
      )}
    </span>
  );
}
