import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface TextButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** primary = ink with underline; secondary = muted, darkens on hover. */
  variant?: 'primary' | 'secondary';
}

export function TextButton({ children, variant = 'secondary', className = '', ...rest }: TextButtonProps) {
  return (
    <button
      type="button"
      className={`text-body transition-colors duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 ${
        variant === 'primary'
          ? 'border-b border-ink pb-0.5 text-ink hover:border-sage-deep hover:text-sage-deep'
          : 'text-muted hover:text-ink'
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

interface InkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

/** Solid ink button, used sparingly (one primary CTA per surface at most). */
export function InkButton({ children, className = '', ...rest }: InkButtonProps) {
  return (
    <button
      type="button"
      className={`rounded-lg bg-ink px-3.5 py-1.5 text-body font-medium text-paper shadow-e1 transition-all duration-150 hover:bg-ink-soft active:translate-y-px active:shadow-none disabled:pointer-events-none disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
