import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  RefreshCw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SyncRun, SyncRunStatus } from '@shared/types';
import { syncApi } from '../lib/api';
import { formatRelativeTime } from '../lib/formatters';

const statusTone = {
  running: { color: '#5b8dee', icon: RefreshCw, label: 'Running' },
  succeeded: { color: '#4ecba3', icon: CheckCircle2, label: 'Succeeded' },
  partial: { color: '#d4a44c', icon: AlertTriangle, label: 'Partial' },
  failed: { color: '#e07070', icon: CircleAlert, label: 'Failed' },
} satisfies Record<SyncRunStatus, { color: string; icon: LucideIcon; label: string }>;

const scopeLabel: Record<SyncRun['scope'], string> = {
  full: 'Full sync',
  plaid_item: 'Bank sync',
  plaid_all: 'Bank sync',
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
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors ${
        selected ? 'bg-white/5' : ''
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
          <p className="text-sm text-text truncate">{scopeLabel[run.scope]}</p>
          <span className="text-[11px] font-mono" style={{ color: tone.color }}>
            {tone.label}
          </span>
        </div>
        <p className="text-xs text-muted truncate">
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
  title = 'Sync Activity',
  showDetail = false,
}: {
  runs?: SyncRun[];
  title?: string;
  showDetail?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const visibleRuns = runs ?? [];

  useEffect(() => {
    if (selectedId || visibleRuns.length === 0) return;
    setSelectedId(visibleRuns[0].id);
  }, [selectedId, visibleRuns]);

  const { data: detail } = useQuery({
    queryKey: ['sync', 'history', selectedId],
    queryFn: () => syncApi.historyDetail(selectedId!),
    enabled: showDetail && !!selectedId,
  });

  const selectedRun = visibleRuns.find((run) => run.id === selectedId) ?? visibleRuns[0];

  return (
    <div className="bg-surface border border-border rounded">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock3 size={14} className="text-[#5b8dee]" />
          <h2 className="text-sm font-medium text-text">{title}</h2>
        </div>
        {selectedRun && (
          <span className="text-xs text-muted font-mono">
            {formatRelativeTime(selectedRun.started_at)}
          </span>
        )}
      </div>

      {visibleRuns.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted">
          No sync runs recorded
        </div>
      ) : (
        <div className={showDetail ? 'grid grid-cols-[minmax(220px,280px)_1fr]' : ''}>
          <div className="divide-y divide-border">
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
            <div className="border-l border-border p-4 min-w-0">
              {detail ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-4 gap-3 text-xs">
                    <div>
                      <p className="text-muted mb-0.5">Accounts</p>
                      <p className="font-mono text-text">{detail.accounts_seen}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Added</p>
                      <p className="font-mono text-[#4ecba3]">{detail.transactions_added}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Updated</p>
                      <p className="font-mono text-[#5b8dee]">{detail.transactions_modified}</p>
                    </div>
                    <div>
                      <p className="text-muted mb-0.5">Removed</p>
                      <p className="font-mono text-[#e07070]">{detail.transactions_removed}</p>
                    </div>
                  </div>

                  {(detail.duplicate_candidates > 0 || detail.transfer_candidates > 0) && (
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="bg-background border border-border rounded p-3">
                        <p className="text-muted mb-1">Duplicate groups</p>
                        <p className="font-mono text-[#d4a44c]">{detail.duplicate_candidates}</p>
                      </div>
                      <div className="bg-background border border-border rounded p-3">
                        <p className="text-muted mb-1">Transfer pairs</p>
                        <p className="font-mono text-[#5b8dee]">{detail.transfer_candidates}</p>
                      </div>
                    </div>
                  )}

                  {detail.error_message && (
                    <div className="bg-[#e07070]/10 border border-[#e07070]/30 rounded p-3">
                      <p className="text-xs text-[#e07070] font-medium mb-1">Issue</p>
                      <p className="text-xs text-muted leading-relaxed">{detail.error_message}</p>
                      {detail.recovery_action && (
                        <p className="text-xs text-muted leading-relaxed mt-1">{detail.recovery_action}</p>
                      )}
                    </div>
                  )}

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-text">Providers</p>
                    {detail.items.map((item) => {
                      const tone = item.status === 'succeeded'
                        ? '#4ecba3'
                        : item.status === 'reauth_required'
                          ? '#d4a44c'
                          : item.status === 'failed'
                            ? '#e07070'
                            : '#5b8dee';
                      return (
                        <div key={item.id} className="bg-background border border-border rounded p-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm text-text truncate">{item.institution_name}</p>
                            <span className="text-xs font-mono flex-shrink-0" style={{ color: tone }}>
                              {item.status.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <p className="text-xs text-muted mt-1">
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
                            <p className="text-xs text-muted mt-1">{item.error_message}</p>
                          )}
                          {item.recovery_action && (
                            <p className="text-xs text-muted mt-1">{item.recovery_action}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {detail.changes.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-text">Detected changes</p>
                      {detail.changes.map((change) => (
                        <div key={change.id} className="text-xs text-muted flex items-start gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#5b8dee] mt-1.5 flex-shrink-0" />
                          <span>{change.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-32 flex items-center justify-center text-sm text-muted">
                  Loading sync detail...
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
