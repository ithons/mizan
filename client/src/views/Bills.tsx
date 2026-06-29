import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  RefreshCw,
} from 'lucide-react';
import type { RecurringForecastOccurrence } from '@shared/types';
import { recurringApi } from '../lib/api';
import { formatCurrency, formatDate } from '../lib/formatters';
import { PageLoader } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';

const FREQUENCY_LABELS: Record<RecurringForecastOccurrence['frequency'], string> = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
};

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'income' | 'bill' | 'net';
}) {
  const color = tone === 'bill' ? '#e07070' : value >= 0 ? '#4ecba3' : '#e07070';

  return (
    <div className="border border-border bg-surface rounded p-4">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className="font-mono text-xl" style={{ color }}>
        {formatCurrency(value)}
      </p>
    </div>
  );
}

function ScheduleRow({ occurrence }: { occurrence: RecurringForecastOccurrence }) {
  const Icon = occurrence.is_income ? ArrowUpCircle : ArrowDownCircle;
  const color = occurrence.is_income ? '#4ecba3' : '#e07070';

  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-4 px-4 py-3 border-b border-border last:border-b-0 items-center">
      <div className="font-mono text-xs text-muted whitespace-nowrap">
        {formatDate(occurrence.expected_date)}
      </div>
      <div className="flex items-center gap-3 min-w-0">
        <Icon size={16} style={{ color }} className="flex-shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-text truncate">{occurrence.merchant_name}</p>
            {!occurrence.is_confirmed && (
              <span className="text-[10px] text-muted border border-border rounded px-1.5 py-0.5">
                detected
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted mt-0.5">
            <span>{FREQUENCY_LABELS[occurrence.frequency]}</span>
            {occurrence.category_name && (
              <>
                <span>·</span>
                <span>{occurrence.category_name}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <p className="font-mono text-sm text-right" style={{ color }}>
        {formatCurrency(occurrence.amount)}
      </p>
    </div>
  );
}

export function Bills() {
  const [days, setDays] = useState(60);

  const { data: forecast, isLoading } = useQuery({
    queryKey: ['recurring', 'forecast', days],
    queryFn: () => recurringApi.forecast(days),
  });

  const occurrences = forecast?.occurrences ?? [];
  const confirmedCount = occurrences.filter((occurrence) => occurrence.is_confirmed).length;
  const detectedCount = occurrences.length - confirmedCount;

  const nextOccurrence = occurrences[0];
  const grouped = useMemo(() => {
    const groups = new Map<string, RecurringForecastOccurrence[]>();
    for (const occurrence of occurrences) {
      const items = groups.get(occurrence.expected_date) ?? [];
      items.push(occurrence);
      groups.set(occurrence.expected_date, items);
    }
    return Array.from(groups.entries());
  }, [occurrences]);

  if (isLoading) return <PageLoader />;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Bills and Income</h1>
          <p className="text-xs text-muted mt-1">
            {nextOccurrence
              ? `Next: ${nextOccurrence.merchant_name} on ${formatDate(nextOccurrence.expected_date)}`
              : 'No upcoming recurring activity'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[30, 60, 90].map((option) => (
            <button
              key={option}
              className={`text-xs border rounded px-3 py-1.5 ${
                days === option
                  ? 'border-[#4ecba3]/50 bg-[#4ecba3]/10 text-[#4ecba3]'
                  : 'border-border text-muted hover:text-text'
              }`}
              onClick={() => setDays(option)}
            >
              {option}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat label="Incoming" value={forecast?.income ?? 0} tone="income" />
        <Stat label="Bills" value={-(forecast?.bills ?? 0)} tone="bill" />
        <Stat label="Net Impact" value={forecast?.net ?? 0} tone="net" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border border-border bg-surface rounded p-4 flex items-center gap-3">
          <CalendarDays size={18} className="text-[#7aa2f7]" />
          <div>
            <p className="text-xs text-muted">Scheduled</p>
            <p className="font-mono text-lg text-text">{occurrences.length}</p>
          </div>
        </div>
        <div className="border border-border bg-surface rounded p-4 flex items-center gap-3">
          <CheckCircle2 size={18} className="text-[#4ecba3]" />
          <div>
            <p className="text-xs text-muted">Confirmed</p>
            <p className="font-mono text-lg text-text">{confirmedCount}</p>
          </div>
        </div>
        <div className="border border-border bg-surface rounded p-4 flex items-center gap-3">
          <Clock3 size={18} className="text-[#f0c040]" />
          <div>
            <p className="text-xs text-muted">Detected</p>
            <p className="font-mono text-lg text-text">{detectedCount}</p>
          </div>
        </div>
      </div>

      <div className="border border-border bg-surface rounded overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-text">Upcoming Schedule</h2>
          <span className="text-xs text-muted font-mono">{days} days</span>
        </div>
        {occurrences.length === 0 ? (
          <EmptyState icon={RefreshCw} title="No recurring activity scheduled" />
        ) : (
          <div>
            {grouped.map(([date, items]) => (
              <div key={date}>
                {items.map((occurrence) => (
                  <ScheduleRow key={occurrence.id} occurrence={occurrence} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
