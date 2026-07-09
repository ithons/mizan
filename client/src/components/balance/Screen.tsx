import type { ReactNode } from 'react';

interface ScreenProps {
  children: ReactNode;
  /** Settings-style editorial padding (52px 64px) instead of data-screen padding (36px 48px). */
  editorial?: boolean;
  className?: string;
}

export function Screen({ children, editorial = false, className = '' }: ScreenProps) {
  return (
    <div
      className={`mz-screen flex min-h-full flex-col ${
        editorial ? 'px-16 py-[52px]' : 'px-12 py-9'
      } ${className}`}
    >
      {children}
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
    <div className={`flex flex-shrink-0 items-baseline justify-between ${className}`}>
      <div>
        <h1 className="font-serif text-[27px] font-normal leading-tight text-ink">{title}</h1>
        {sub && <div className="mt-1 text-[13.5px] text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex items-baseline gap-6 text-[13.5px]">{actions}</div>}
    </div>
  );
}
