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
    return { text: `+${formatted}`, className: 'text-[#4ecba3]' };
  }
  return { text: `\u2212${formatted}`, className: 'text-[#e07070]' };
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

export function formatRelativeTime(isoStr: string): string {
  try {
    return formatDistanceToNow(parseISO(isoStr), { addSuffix: true });
  } catch {
    return isoStr;
  }
}
