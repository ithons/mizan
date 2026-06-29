const DECIMAL_INPUT = /^-?(?:\d+|\d+\.\d*|\.\d+)$/;

export function parseDecimalInput(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!DECIMAL_INPUT.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
