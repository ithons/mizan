import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store';

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
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'sync_start':
              setSyncStatus('syncing');
              break;
            case 'sync_progress':
              setSyncStatus('syncing');
              break;
            case 'sync_complete':
              setSyncStatus('idle');
              setLastSynced(new Date().toISOString());
              // Invalidate all relevant queries
              queryClient.invalidateQueries({ queryKey: ['accounts'] });
              queryClient.invalidateQueries({ queryKey: ['transactions'] });
              queryClient.invalidateQueries({ queryKey: ['networth'] });
              queryClient.invalidateQueries({ queryKey: ['budgets'] });
              queryClient.invalidateQueries({ queryKey: ['recurring'] });
              queryClient.invalidateQueries({ queryKey: ['holdings'] });
              addToast({ type: 'success', message: 'Sync complete' });
              break;
            case 'sync_error':
              setSyncStatus('error');
              addToast({ type: 'error', message: data.message || 'Sync failed' });
              break;
          }
        } catch {
          // ignore parse errors
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
