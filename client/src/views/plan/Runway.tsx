import { addDays, format } from 'date-fns';
import type { RunwayReading } from '@shared/types';
import { formatCurrency, formatDate } from '../../lib/formatters';
import { SectionLabel } from '../../components/balance';

function signed(amount: number): string {
  return amount < 0 ? `${formatCurrency(Math.abs(amount))} short` : formatCurrency(amount);
}

export function runwayHeadline(reading: RunwayReading): string {
  if (reading.covered) return `Covered through ${formatDate(reading.end_date)}`;
  return reading.first_short_on
    ? `Projected short from ${formatDate(reading.first_short_on)}`
    : `Short in at least 1 of 10 simulated futures before ${formatDate(reading.end_date)}`;
}

export function runwayLowLine(reading: RunwayReading): string {
  const low = `Lowest projected point ${signed(reading.lowest)} on ${formatDate(reading.lowest_on)}`;
  if (!reading.lowest_band || reading.lowest_band.p10 === reading.lowest_band.p90) return `${low}.`;
  return `${low}; in 8 of 10 simulated futures it falls between ${signed(reading.lowest_band.p10)} and ${signed(reading.lowest_band.p90)}.`;
}

export function runwayDrainLine(reading: RunwayReading): string | null {
  const drain = reading.largest_scheduled_drain;
  if (!drain) return null;
  const times = drain.occurrences === 1 ? 'once' : `${drain.occurrences} times`;
  return `Without ${drain.label} (scheduled ${times}, ${formatCurrency(drain.total)} in all) the lowest point would be ${signed(drain.lowest_without)} on ${formatDate(drain.lowest_without_on)}.`;
}

/**
 * The lowest point of what is free, to a chosen date. A covered reading carries no ink of its
 * own, so a healthy ledger reads quietly; a shortfall is set in estimate ink because it is one.
 */
export function Runway({ reading, onEndChange }: { reading: RunwayReading; onEndChange: (end: string) => void }) {
  const ink = reading.covered ? 'text-muted' : 'text-estimate';
  const drain = runwayDrainLine(reading);
  return (
    <section className="mb-9">
      <SectionLabel
        className="mb-1"
        summary={
          <label className="flex items-baseline gap-2">
            <span className="text-muted-2">to</span>
            <input
              type="date"
              aria-label="Runway end date"
              className="rounded border border-line-2 bg-transparent px-1.5 py-0.5 text-body tabular-nums text-ink"
              value={reading.end_date}
              min={format(addDays(new Date(), 1), 'yyyy-MM-dd')}
              max={format(addDays(new Date(), 400), 'yyyy-MM-dd')}
              onChange={(e) => e.target.value && onEndChange(e.target.value)}
            />
          </label>
        }
        explain={
          <>
            {reading.assumptions.map((line) => <p key={line}>{line}</p>)}
          </>
        }
      >
        Runway
      </SectionLabel>
      <p className={`mt-2 text-body-lg ${reading.covered ? 'text-ink' : 'text-estimate'}`}>{runwayHeadline(reading)}</p>
      <p className={`mt-1 text-note tabular-nums ${ink}`}>{runwayLowLine(reading)}</p>
      {reading.band_note && <p className="mt-1 text-note text-muted-2">{`${reading.band_note} The reading above is the point projection alone.`}</p>}
      {reading.expected_lumps_counted.map((lump) => (
        <p key={`${lump.label}-${lump.counted_on}`} className={`mt-1 text-note tabular-nums ${ink}`}>
          Counts {lump.label} at {formatCurrency(lump.counted_amount)} on {formatDate(lump.counted_on)}, the low end of its range on the last day of its window.
        </p>
      ))}
      {drain && <p className="mt-1 text-note tabular-nums text-muted-2">{drain}</p>}
    </section>
  );
}
