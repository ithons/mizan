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
      className={`rounded-xl border border-line-2 bg-card shadow-e1 ${paddings[padding]} ${
        onClick ? 'cursor-pointer transition-all duration-150 hover:shadow-e2 active:translate-y-px active:shadow-e1' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}
