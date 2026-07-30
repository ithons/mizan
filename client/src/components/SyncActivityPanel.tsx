import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SyncRun, SyncRunDetail, SyncRunStatus } from '@shared/types';
import { syncApi } from '../lib/api';
import { advisorRouteState } from '../lib/advisorRouteState';
import { buildSyncRunAdvisorPrompt } from '../lib/advisorPrompts';
import { formatRelativeTime } from '../lib/formatters';

const statusTone = {
  running: { color: '#7c8b99', icon: RefreshCw, label: 'Running' },
  succeeded: { color: '#c9963a', icon: CheckCircle2, label: 'Succeeded' },
  partial: { color: '#ce8642', icon: AlertTriangle, label: 'Partial' },
  failed: { color: '#b5654a', icon: CircleAlert, label: 'Failed' },
} satisfies Record<SyncRunStatus, { color: string; icon: LucideIcon; label: string }>;

const scopeLabel: Record<SyncRun['scope'], string> = {
  full: 'Full sync',
  simplefin_all: 'SimpleFIN sync',
  coinbase: 'Coinbase sync',
};

function changedCount(run: SyncRun): number {
  return run.transactions_added + run.transactions_modified + run.transactions_removed;
}

function RunSummary({ run, selected, onSelect }: {
  run: SyncRun;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = statusTone[run.status];
  const Icon = tone.icon;
  const changes = changedCount(run);

  return (
    <button
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-well transition-colors ${
        selected ? 'bg-rail' : ''
      }`}
      onClick={onSelect}
    >
      <div
        className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${tone.color}18` }}
      >
        <Icon size={14} style={{ color: tone.color }} className={run.status === 'running' ? 'animate-spin' : ''} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-body-lg text-ink truncate">{scopeLabel[run.scope]}</p>
          <span className="text-micro font-mono" style={{ color: tone.color }}>
            {tone.label}
          </span>
        </div>
        <p className="text-note text-muted truncate">
          {formatRelativeTime(run.started_at)}
          {changes > 0 ? `, ${changes} tx change${changes === 1 ? '' : 's'}` : ', no tx changes'}
          {run.transactions_skipped > 0 ? `, ${run.transactions_skipped} skipped` : ''}
        </p>
      </div>
      <ChevronRight size={13} className="text-muted flex-shrink-0" />
    </button>
  );
}

export function SyncActivityPanel({
  runs,
  title = 'Sync activity',
  showDetail = false,
}: {
  runs?: SyncRun[];
  title?: string;
  showDetail?: boolean;
}) {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visibleRuns = runs ?? [];

  useEffect(() => {
    if (selectedId || visibleRuns.length === 0) return;
    setSelectedId(visibleRuns[0].id);
  }, [selectedId, visibleRuns]);

  const { data: detail } = useQuery<SyncRunDetail>({
    queryKey: ['sync', 'history', selectedId],
    queryFn: () => syncApi.historyDetail(selectedId!),
    enabled: showDetail && !!selectedId,
  });

  const selectedRun = visibleRuns.find((run) => run.id === selectedId) ?? visibleRuns[0];
  const selectedDetail = detail?.id === selectedRun?.id ? detail : undefined;
  const askAdvisorAboutSync = () => {
    if (!selectedRun) return;
    navigate('/advisor', {
      state: advisorRouteState(buildSyncRunAdvisorPrompt(selectedRun, selectedDetail)),
    });
  };

  return (
    <div className="rounded-xl border border-line-2 bg-card shadow-e1-alt">
      <div className="px-4 py-3 border-b border-line-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock3 size={14} className="text-muted" />
          <h2 className="text-body-lg font-medium text-ink">{title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {selectedRun && (
            <>
              <button
                type="button"
                onClick={askAdvisorAboutSync}
                className="flex items-center gap-1 rounded-md border border-pill-border bg-pill-bg px-2.5 py-1 text-note text-muted transition-colors hover:text-ink"
              >
                <Sparkles size={12} />
                Ask advisor
              </button>
              <span className="text-note text-muted font-mono">
                {formatRelativeTime(selectedRun.started_at)}
              </span>
            </>
          )}
        </div>
      </div>

      {visibleRuns.length === 0 ? (
        <div className="px-4 py-8 text-center text-body-lg text-muted">
          No sync runs recorded
        </div>
      ) : (
        <div className={showDetail ? 'grid grid-cols-[minmax(220px,280px)_1fr]' : ''}>
          <div className="divide-y divide-line">
            {visibleRuns.map((run) => (
              <RunSummary
                key={run.id}
                run={run}
                selected={run.id === selectedId}
                onSelect={() => setSelectedId(run.id)}
              />
            ))}
          </div>

          {showDetail && (
            <div className="border-l border-line-2 p-4 min-w-0">
              {detail ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-4 gap-3 text-note">
                    <div>
                      <p className="text-muted mb-0.5">Accounts</p>
                      <p className="font-mono text-ink">{detail.accounts_seen}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Added</p>
                      <p className="font-mono text-sage-deep">{detail.transactions_added}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Updated</p>
                      <p className="font-mono text-muted">{detail.transactions_modified}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Removed</p>
                      <p className="font-mono text-clay">{detail.transactions_removed}</p>
                    </div>
                  </div>

                  {(detail.duplicate_candidates > 0 || detail.transfer_candidates > 0) && (
                    <div className="grid grid-cols-2 gap-3 text-note">
                      <div className="rounded-lg border border-line-2 bg-card p-3">
                        <p className="text-muted mb-1">Duplicate groups</p>
                        <p className="font-mono text-gold">{detail.duplicate_candidates}</p>
                      </div>
                      <div className="rounded-lg border border-line-2 bg-card p-3">
                        <p className="text-muted mb-1">Transfer pairs</p>
                        <p className="font-mono text-muted">{detail.transfer_candidates}</p>
                      </div>
                    </div>
                  )}

                  {detail.error_message && (
                    <div className="rounded-lg border border-pill-border bg-rail p-3">
                      <p className="text-note text-clay font-medium mb-1">Issue</p>
                      <p className="text-note text-muted leading-relaxed">{detail.error_message}</p>
                      {detail.recovery_action && (
                        <p className="text-note text-muted leading-relaxed mt-1">{detail.recovery_action}</p>
                      )}
                    </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-note font-medium text-ink">Providers</p>
                    {detail.items.map((item) => {
                      const tone = item.status === 'succeeded'
                        ? '#c9963a'
                        : item.status === 'reauth_required'
                          ? '#ce8642'
                          : item.status === 'failed'
                            ? '#b5654a'
                            : '#7c8b99';
                      return (
                        <div key={item.id} className="rounded-lg border border-line-2 bg-card p-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-body-lg text-ink truncate">{item.institution_name}</p>
                            <span className="text-note font-mono flex-shrink-0" style={{ color: tone }}>
                              {item.status.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <p className="text-note text-muted mt-1">
                            {item.accounts_seen} account{item.accounts_seen === 1 ? '' : 's'}
                            {', '}
                            {item.transactions_added} added
                            {', '}
                            {item.transactions_modified} updated
                            {', '}
                            {item.transactions_removed} removed
                            {item.transactions_skipped > 0 ? `, ${item.transactions_skipped} skipped` : ''}
                          </p>
                          {item.error_message && (
                            <p className="text-note text-muted mt-1">{item.error_message}</p>
                          )}
                          {item.recovery_action && (
                            <p className="text-note text-muted mt-1">{item.recovery_action}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {detail.changes.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-note font-medium text-ink">Detected changes</p>
                      {detail.changes.map((change) => (
                        <div key={change.id} className="text-note text-muted flex items-start gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-sage mt-1.5 flex-shrink-0" />
                          <span>{change.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-32 flex items-center justify-center text-body-lg text-muted">
                  Loading sync detail…
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
