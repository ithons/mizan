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
      className={`text-[13.5px] transition-colors disabled:opacity-50 ${
        variant === 'primary'
          ? 'border-b border-ink pb-0.5 text-ink'
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
      className={`rounded-lg bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
