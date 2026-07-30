import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, CircleAlert } from 'lucide-react';
import type { DataQualityIssue, DataQualitySummary, InsightSeverity } from '@shared/types';
import { insightsApi } from '../lib/api';
import { Card, Row } from './balance';

const severityTone: Record<InsightSeverity, string> = {
  critical: 'text-clay',
  warning: 'text-gold',
  info: 'text-muted-2',
  positive: 'text-sage-deep',
};

// The word carries the severity; the colour only repeats it, because colour alone is not a reading.
const severityWord: Record<InsightSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Note',
  positive: 'Clear',
};

interface DataQualityIssueListProps {
  issues: DataQualityIssue[];
  onOpen: (route: string) => void;
}

/**
 * Split out from the panel so the zero-issue rendering can be asserted directly.
 *
 * There is no score and no verdict to render: `DataQualitySummary` carries open conditions and
 * nothing else, so the number out of 100 is gone from the payload rather than hidden from the
 * markup. Every row is something the owner can act on, which is what makes the clean state
 * reachable and the header's promise true.
 */
export function DataQualityIssueList({ issues, onOpen }: DataQualityIssueListProps) {
  // A clean result is one line of the same weight as any other note on this screen. Given a card,
  // a heading and an icon it would out-shout the panels that carry actual findings, and a panel
  // that shouts when nothing is wrong stops being read when something is.
  if (issues.length === 0) {
    return (
      <p className="text-note text-muted">
        Data quality: sync state, review queues, forecast confidence, and the ledger invariants
        report nothing open.
      </p>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-body-lg text-ink">Data Quality</p>
          <p className="text-note text-muted mt-1">
            {issues.length} open condition{issues.length === 1 ? '' : 's'}. Each row opens the
            screen it is about.
          </p>
        </div>
        <CircleAlert size={16} className="text-muted flex-shrink-0" />
      </div>

      {/* The trailing hairline would otherwise sit a few pixels above the card's own edge. */}
      <div className="mt-3 [&>*:last-child]:border-b-0">
        {issues.map((issue) => (
          <Row
            key={issue.id}
            onClick={() => onOpen(issue.route)}
            className="justify-between gap-3 px-1 py-2.5"
          >
            <div className="min-w-0">
              <p className="text-body-lg text-ink">{issue.label}</p>
              <p className="text-note text-muted mt-0.5">{issue.message}</p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <span
                className={`text-rule uppercase tracking-[0.09em] ${severityTone[issue.severity]}`}
              >
                {severityWord[issue.severity]}
              </span>
              <ChevronRight size={13} className="text-muted" />
            </div>
          </Row>
        ))}
      </div>
    </Card>
  );
}

export function DataQualityPanel() {
  const navigate = useNavigate();
  const { data, isError, error } = useQuery<DataQualitySummary>({
    queryKey: ['insights', 'quality'],
    queryFn: insightsApi.quality,
  });

  if (isError) {
    return (
      <p className="text-note text-clay">
        Data quality checks could not be read: {error instanceof Error ? error.message : 'unknown error'}.
      </p>
    );
  }

  if (!data) return null;

  return <DataQualityIssueList issues={data.issues} onOpen={(route) => navigate(route)} />;
}
