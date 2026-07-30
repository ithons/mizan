import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store';
import { invalidateFinancialData } from '../lib/queryInvalidation';
import type { SyncEvent } from '@shared/types';

export function useSyncStatus() {
  const { setSyncStatus, setLastSynced, addToast } = useAppStore();
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    function connect() {
      if (!active) return;

      const es = new EventSource('/api/sync/status');
      esRef.current = es;

      es.onopen = () => {
        // Connected successfully
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SyncEvent;
          switch (data.type) {
            case 'sync_start':
              setSyncStatus('syncing');
              break;
            case 'sync_progress':
              setSyncStatus('syncing');
              break;
            case 'sync_complete': {
              // A partial run failed a stage after its provider writes had already committed, so it
              // refreshes like any other completion: what changes is that it reports the failure.
              const partial = data.status === 'partial';
              setSyncStatus(partial ? 'error' : 'idle');
              setLastSynced(data.completedAt ?? new Date().toISOString());
              invalidateFinancialData(queryClient);
              addToast(partial
                ? { type: 'error', message: data.message || 'Sync finished with issues' }
                : { type: 'success', message: 'Sync complete' });
              break;
            }
            case 'sync_error':
              setSyncStatus('error');
              // A sync that dies mid-run can already have committed provider writes, so dropping
              // the caches is right either way; not dropping them left the ledger on screen older
              // than the ledger in the database for the whole staleTime.
              invalidateFinancialData(queryClient);
              addToast({ type: 'error', message: data.message || 'Sync failed' });
              break;
          }
        } catch (err) {
          console.warn('Ignoring malformed sync event', err);
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (active) {
          // Auto-reconnect after 5 seconds
          reconnectTimerRef.current = setTimeout(() => {
            connect();
          }, 5000);
        }
      };
    }

    connect();

    return () => {
      active = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [setSyncStatus, setLastSynced, addToast, queryClient]);
}
