const tones = {
  sage: 'bg-sage',
  gold: 'bg-gold',
  clay: 'bg-clay-scale',
} as const;

export type ProgressTone = keyof typeof tones;

/** Bar color by budget health: sage under budget, gold near/at the limit, clay over. */
export function healthTone(spent: number, budget: number): ProgressTone {
  if (budget <= 0) return 'sage';
  const ratio = spent / budget;
  if (ratio > 1) return 'clay';
  if (ratio >= 0.85) return 'gold';
  return 'sage';
}

interface ProgressBarProps {
  /** 0..1 fraction; values are clamped. */
  fraction: number;
  tone?: ProgressTone;
  height?: 6 | 8 | 10;
  className?: string;
}

export function ProgressBar({ fraction, tone = 'sage', height = 6, className = '' }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, fraction * 100));
  return (
    /* Track is `bg-track`, not `bg-line` — line measured 1.04:1 against paper, so the unfilled
       portion was invisible and the bar read as a floating dash of unknown extent. */
    <div
      className={`overflow-hidden rounded-full bg-track ${className}`}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-300 ease-out ${tones[tone]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
