import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

const deltaTones = {
  muted: 'text-muted',
  sage: 'text-sage',
  clay: 'text-clay',
} as const;

interface KpiTileProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: keyof typeof deltaTones;
  to?: string;
}

export function KpiTile({ label, value, delta, deltaTone = 'muted', to }: KpiTileProps) {
  const navigate = useNavigate();
  return (
    <div
      onClick={to ? () => navigate(to) : undefined}
      className={`rounded-xl border border-line-2 bg-card p-4 ${
        to ? 'cursor-pointer transition-colors hover:bg-card-alt' : ''
      }`}
    >
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1.5 font-serif text-[22px] leading-tight text-ink tabular-nums">{value}</div>
      {delta && <div className={`mt-1 text-[12.5px] tabular-nums ${deltaTones[deltaTone]}`}>{delta}</div>}
    </div>
  );
}
