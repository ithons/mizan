import type { ReactNode } from 'react';

interface RowProps {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}

/** Hairline list row: rounded, hover-tints to the rail paper when interactive. */
export function Row({ children, onClick, className = '' }: RowProps) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center rounded-lg border-b border-line transition-colors ${
        onClick ? 'cursor-pointer hover:bg-rail' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
