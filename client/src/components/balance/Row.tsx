import type { ReactNode } from 'react';

interface RowProps {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}

/**
 * Hairline list row. When interactive it is a real button: a bare `div` with `onClick` is
 * unreachable by keyboard and invisible to assistive tech, which is how every list in this app
 * used to behave.
 *
 * Hover carries two redundant signals (a `well` wash and a sage left rule) because a tone-on-tone
 * tint alone cannot clear 3:1 on this palette.
 */
export function Row({ children, onClick, className = '' }: RowProps) {
  const base = `flex w-full items-center border-b border-line text-left transition-colors duration-150 ${className}`;
  if (!onClick) return <div className={`rounded-lg ${base}`}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative cursor-pointer rounded-lg hover:bg-well focus-visible:bg-well before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:bg-transparent hover:before:bg-sage focus-visible:before:bg-sage ${base}`}
    >
      {children}
    </button>
  );
}
