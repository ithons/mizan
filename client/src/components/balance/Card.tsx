import type { ReactNode } from 'react';

const paddings = {
  none: '',
  sm: 'p-3.5',
  md: 'p-[18px]',
  lg: 'p-5',
} as const;

interface CardProps {
  children: ReactNode;
  padding?: keyof typeof paddings;
  className?: string;
  onClick?: () => void;
}

export function Card({ children, padding = 'md', className = '', onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border border-line-2 bg-card ${paddings[padding]} ${
        onClick ? 'cursor-pointer transition-colors hover:bg-card-alt' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
