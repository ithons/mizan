import { formatWholeCurrency } from '../../lib/formatters';

interface BalanceScaleProps {
  assets: number;
  liabilities: number;
  className?: string;
}

/**
 * The signature brand moment: a tilting balance scale, assets pan (sage) low,
 * owed pan (clay) high, breathing gently. Path data from the Balance prototype.
 */
export function BalanceScale({ assets, liabilities, className = '' }: BalanceScaleProps) {
  return (
    <svg
      viewBox="0 0 620 300"
      className={`mz-breathe ${className}`}
      style={{ animation: 'mz-breathe 8s ease-in-out infinite', transformOrigin: '310px 80px' }}
      role="img"
      aria-label={`Balance scale: assets ${formatWholeCurrency(assets)}, owed ${formatWholeCurrency(liabilities)}`}
    >
      {/* stand */}
      <line x1="310" y1="80" x2="310" y2="250" stroke="var(--mz-beam)" strokeWidth="4" strokeLinecap="round" />
      <path d="M258 250 Q310 236 362 250" fill="none" stroke="var(--mz-beam)" strokeWidth="4" strokeLinecap="round" />
      <circle cx="310" cy="80" r="6" fill="var(--mz-sage-soft)" />
      {/* beam, tilted toward the heavier assets side */}
      <line x1="121" y1="100" x2="499" y2="60" stroke="var(--mz-sage)" strokeWidth="5" strokeLinecap="round" />
      {/* assets pan */}
      <line x1="121" y1="100" x2="66" y2="172" stroke="var(--mz-beam)" strokeWidth="2" />
      <line x1="121" y1="100" x2="176" y2="172" stroke="var(--mz-beam)" strokeWidth="2" />
      <path
        d="M60 172 Q121 226 182 172"
        fill="var(--mz-sage-soft)"
        fillOpacity="0.16"
        stroke="var(--mz-sage)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* owed pan */}
      <line x1="499" y1="60" x2="444" y2="132" stroke="var(--mz-beam)" strokeWidth="2" />
      <line x1="499" y1="60" x2="554" y2="132" stroke="var(--mz-beam)" strokeWidth="2" />
      <path
        d="M438 132 Q499 186 560 132"
        fill="var(--mz-clay-scale)"
        fillOpacity="0.14"
        stroke="var(--mz-clay-scale)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <text x="121" y="252" textAnchor="middle" fontFamily="Instrument Sans" fontSize="11" letterSpacing="2" fill="var(--mz-muted)">
        ASSETS
      </text>
      <text x="121" y="274" textAnchor="middle" fontFamily="Newsreader" fontSize="20" fill="var(--mz-ink)">
        {formatWholeCurrency(assets)}
      </text>
      <text x="499" y="210" textAnchor="middle" fontFamily="Instrument Sans" fontSize="11" letterSpacing="2" fill="var(--mz-muted)">
        OWED
      </text>
      <text x="499" y="232" textAnchor="middle" fontFamily="Newsreader" fontSize="20" fill="var(--mz-clay)">
        {formatWholeCurrency(Math.abs(liabilities))}
      </text>
    </svg>
  );
}
