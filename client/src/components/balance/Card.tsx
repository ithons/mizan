import type { ReactNode } from 'react';

const paddings = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-[22px]',
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
