import { format, parseISO, formatDistanceToNow } from 'date-fns';

export function formatCurrency(
  amount: number,
  options: { showSign?: boolean; negate?: boolean } = {}
): string {
  const val = options.negate ? -amount : amount;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(val));

  if (options.showSign) {
    if (val > 0) return `+${formatted}`;
    if (val < 0) return `\u2212${formatted}`; // minus sign
    return formatted;
  }
  return val < 0 ? `\u2212${formatted}` : formatted;
}

export function formatWholeCurrency(amount: number, options: { showSign?: boolean } = {}): string {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Math.abs(amount));

  if (options.showSign && amount > 0) return `+${formatted}`;
  return amount < 0 ? `−${formatted}` : formatted;
}

export function formatCurrencyColored(amount: number): { text: string; className: string } {
  if (amount === 0) {
    return { text: '$0.00', className: 'text-muted' };
  }
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));

  if (amount > 0) {
    return { text: `+${formatted}`, className: 'text-positive' };
  }
  return { text: `\u2212${formatted}`, className: 'text-negative' };
}

export function formatCrypto(amount: number, currency: string): string {
  return `${amount.toFixed(8)} ${currency}`;
}

export function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MMM d, yyyy');
  } catch {
    return dateStr;
  }
}

export function formatDateShort(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MMM d');
  } catch {
    return dateStr;
  }
}

export function formatMonth(yearMonth: string): string {
  try {
    return format(parseISO(`${yearMonth}-01`), 'MMM yyyy');
  } catch {
    return yearMonth;
  }
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/** "just now" / "2m ago" / "3h ago" / "5d ago" (the rail/meta variant). */
export function formatCompactRelative(isoStr: string): string {
  const then = new Date(isoStr).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatRelativeTime(isoStr: string): string {
  try {
    return formatDistanceToNow(parseISO(isoStr), { addSuffix: true });
  } catch {
    return isoStr;
  }
}
