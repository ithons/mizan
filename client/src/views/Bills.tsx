import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import type { Account, RecurringForecastOccurrence } from '@shared/types';
import { accountsApi, recurringApi } from '../lib/api';
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

const LIQUID_ACCOUNT_TYPES = new Set(['checking', 'savings', 'cash']);

interface ProjectionPoint {
  date: string;
  delta: number;
  balance: number;
}

function isLiquidAccount(account: Account): boolean {
  return !account.is_hidden && !account.is_liability && LIQUID_ACCOUNT_TYPES.has(account.type);
}

function buildProjection(
  startingBalance: number,
  occurrences: RecurringForecastOccurrence[]
): ProjectionPoint[] {
  const deltaByDate = new Map<string, number>();

  for (const occurrence of occurrences) {
    deltaByDate.set(
      occurrence.expected_date,
      (deltaByDate.get(occurrence.expected_date) ?? 0) + occurrence.amount
    );
  }

  let balance = startingBalance;
  return Array.from(deltaByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, delta]) => {
      balance += delta;
      return { date, delta, balance };
    });
}

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

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
  });

  const occurrences = forecast?.occurrences ?? [];
  const confirmedCount = occurrences.filter((occurrence) => occurrence.is_confirmed).length;
  const detectedCount = occurrences.length - confirmedCount;
  const liquidAccounts = accounts.filter(isLiquidAccount);
  const startingBalance = liquidAccounts.reduce((sum, account) => sum + account.current_balance, 0);
  const projection = useMemo(
    () => buildProjection(startingBalance, occurrences),
    [occurrences, startingBalance]
  );
  const endingBalance = projection.at(-1)?.balance ?? startingBalance;
  const lowestPoint = projection.reduce<ProjectionPoint | null>(
    (lowest, point) => (!lowest || point.balance < lowest.balance ? point : lowest),
    null
  );
  const lowestBalance = lowestPoint?.balance ?? startingBalance;

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

      <div className="border border-border bg-surface rounded p-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-medium text-text">Cash Projection</h2>
            <p className="text-xs text-muted mt-1">
              {liquidAccounts.length} liquid {liquidAccounts.length === 1 ? 'account' : 'accounts'}
            </p>
          </div>
          <Wallet size={18} className="text-[#7aa2f7]" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div>
            <p className="text-xs text-muted mb-1">Starting Cash</p>
            <p className="font-mono text-lg text-text">{formatCurrency(startingBalance)}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Lowest Point</p>
            <p
              className="font-mono text-lg"
              style={{ color: lowestBalance >= 0 ? '#4ecba3' : '#e07070' }}
            >
              {formatCurrency(lowestBalance)}
            </p>
            {lowestPoint && (
              <p className="text-xs text-muted mt-0.5">{formatDate(lowestPoint.date)}</p>
            )}
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Projected Ending</p>
            <p
              className="font-mono text-lg"
              style={{ color: endingBalance >= startingBalance ? '#4ecba3' : '#e07070' }}
            >
              {formatCurrency(endingBalance)}
            </p>
          </div>
        </div>
        {projection.length > 0 && (
          <div className="divide-y divide-border border border-border rounded bg-background">
            {projection.slice(0, 5).map((point) => (
              <div key={point.date} className="grid grid-cols-[120px_1fr_auto] gap-3 px-3 py-2 text-xs items-center">
                <span className="font-mono text-muted">{formatDate(point.date)}</span>
                <span style={{ color: point.delta >= 0 ? '#4ecba3' : '#e07070' }}>
                  {formatCurrency(point.delta, { showSign: true })}
                </span>
                <span className="font-mono text-text">{formatCurrency(point.balance)}</span>
              </div>
            ))}
          </div>
        )}
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
