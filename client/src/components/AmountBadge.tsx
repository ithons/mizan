import React from 'react';
import { formatCurrencyColored } from '../lib/formatters';

interface AmountBadgeProps {
  amount: number;
  className?: string;
}

export function AmountBadge({ amount, className = '' }: AmountBadgeProps) {
  const { text, className: colorClass } = formatCurrencyColored(amount);
  return (
    <span className={`font-mono text-sm ${colorClass} ${className}`}>{text}</span>
  );
}
