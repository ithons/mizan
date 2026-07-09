import type { ReactNode } from 'react';

const sizes = {
  /** Single-column data screens: lists, budgets, cash flow. */
  reading: 'max-w-[860px]',
  /** Two-pane screens that earn the width: ledger + panel, holdings + allocation. */
  wide: 'max-w-[1240px]',
  /** Settings-style editorial column. */
  editorial: 'max-w-[720px]',
} as const;

interface ScreenProps {
  children: ReactNode;
  size?: keyof typeof sizes;
  className?: string;
}

export function Screen({ children, size = 'reading', className = '' }: ScreenProps) {
  return (
    <div
      className={`mz-screen flex min-h-full flex-col px-6 py-6 lg:px-9 lg:py-9 xl:px-12 ${
        size === 'editorial' ? 'lg:py-12' : ''
      }`}
    >
      <div className={`mx-auto flex w-full min-h-0 flex-1 flex-col ${sizes[size]} ${className}`}>{children}</div>
    </div>
  );
}

interface ScreenHeaderProps {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function ScreenHeader({ title, sub, actions, className = '' }: ScreenHeaderProps) {
  return (
    <div className={`flex flex-shrink-0 flex-wrap items-baseline justify-between gap-x-6 gap-y-2 ${className}`}>
      <div>
        <h1 className="font-serif text-[27px] font-normal leading-tight text-ink">{title}</h1>
        {sub && <div className="mt-1 text-[13.5px] text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex items-baseline gap-6 text-[13.5px]">{actions}</div>}
    </div>
  );
}
