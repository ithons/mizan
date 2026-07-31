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
  /** Cap the screen to the viewport on lg+ so an inner region scrolls (chat-style views). */
  contained?: boolean;
  className?: string;
}

export function Screen({ children, size = 'reading', contained = false, className = '' }: ScreenProps) {
  return (
    <div
      className={`mz-screen flex min-h-full flex-col px-6 py-6 lg:px-9 lg:py-9 xl:px-12 ${
        size === 'editorial' ? 'lg:py-12' : ''
      } ${contained ? 'lg:h-full lg:overflow-hidden' : ''}`}
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

/**
 * The title is a signpost, not the subject.
 *
 * It used to be `text-display` (28px), which made the word "Budget" the largest thing on the
 * budget screen and left every figure below it at 22px or less. The nav rail already says which
 * screen this is; what the owner came to see is the number. 19px keeps the title a heading and
 * gives `Figure`'s 44px subject step somewhere to stand.
 */
export function ScreenHeader({ title, sub, actions, className = '' }: ScreenHeaderProps) {
  return (
    <div className={`flex flex-shrink-0 flex-wrap items-baseline justify-between gap-x-6 gap-y-2 ${className}`}>
      <div>
        <h1 className="font-serif text-title font-normal leading-tight text-ink">{title}</h1>
        {sub && <div className="mt-1 text-body text-muted">{sub}</div>}
      </div>
      {/* Wrap as a group, never mid-label: at phone widths a non-wrapping row squeezed the actions
          until "+ New group" broke across two lines. `whitespace-nowrap` keeps each action intact
          and lets the row reflow instead. */}
      {actions && (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 whitespace-nowrap text-body">
          {actions}
        </div>
      )}
    </div>
  );
}
