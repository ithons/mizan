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

/**
 * Whole dollars, except where whole dollars would say the money is not there.
 *
 * `formatWholeCurrency` is right for the totals this app is mostly made of, and wrong for a list
 * that can contain dust. On the live ledger the Investments holdings list rendered a $0.38 SPAXX
 * position, a $0.21 FSKAX position and a $0.01 USD balance all as "$0", and the FSKAX row's gain
 * line read "−$0 · 12.5%": a percentage stated against an amount printed as nothing. Rule 2 is
 * that a claim has to be one the code checked, and "$0" is a claim about money that exists.
 *
 * Below a dollar the cents are the whole number, so they are shown. At a dollar and above nothing
 * is lost by rounding and the compact column is worth more than the pennies.
 */
export function formatAdaptiveCurrency(amount: number, options: { showSign?: boolean } = {}): string {
  return Math.abs(amount) > 0 && Math.abs(amount) < 1
    ? formatCurrency(amount, { showSign: options.showSign })
    : formatWholeCurrency(amount, options);
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

/**
 * A PER-UNIT price, which is not the same kind of number as a total.
 *
 * Totals are money the owner holds and round to whole dollars on screen without losing anything.
 * A per-unit price is a rate, and rounding it to whole dollars destroys it: on the live ledger
 * POL trades at $0.090195 and the holdings list rendered "237.3 shares @ $0" through
 * `formatWholeCurrency`. CLAUDE.md already says prices stay REAL dollars in the database for this
 * exact reason ("rounding a $0.003 token to whole cents destroys it"); the storage kept the
 * precision and the render threw it away.
 *
 * Two decimals above a dollar, because that is what a price looks like. Below a dollar, enough
 * significant digits that the number still says something, with trailing zeros trimmed so
 * $0.50 does not render as $0.500000.
 */
export function formatUnitPrice(price: number): string {
  const abs = Math.abs(price);
  // The minus is U+2212, matching formatWholeCurrency, and it is applied once at the end so both
  // magnitude branches sign the same way. Intl's own '-' is a hyphen and would not match.
  const sign = price < 0 ? '\u2212' : '';

  if (abs === 0) return '$0.00';

  if (abs >= 1) {
    return `${sign}${new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(abs)}`;
  }

  // Four significant figures, so $0.090195 renders as $0.09020 rather than collapsing to $0.
  // `toPrecision` rather than `toFixed`: it picks the decimal count from the magnitude, and it
  // rounds on the decimal value rather than on whatever the binary double happens to sit just
  // below (0.090195.toFixed(5) is '0.09019', which is correct for the stored double but reads as
  // an off-by-one against the decimal literal).
  const trimmed = Number(abs.toPrecision(4))
    .toFixed(12)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
  const withCents = trimmed.includes('.') && trimmed.split('.')[1].length >= 2
    ? trimmed
    : Number(trimmed).toFixed(2);
  return `${sign}$${withCents}`;
}
