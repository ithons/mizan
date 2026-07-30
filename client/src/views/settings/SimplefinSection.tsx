import { useState, useEffect } from 'react';
import { simplefinApi } from '../../lib/api';
import { formatRelativeTime } from '../../lib/formatters';
import { useAppStore } from '../../store';
import { InkButton, TextButton } from '../../components/balance';

export function SimplefinSection() {
  const [setupToken, setSetupToken] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    fetchConnection();
  }, []);

  const fetchConnection = async () => {
    try {
      const data = await simplefinApi.connection();
      setStatus(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await simplefinApi.setup({ setupToken });
      setSetupToken('');
      await fetchConnection();
    } catch (e: any) {
      setError(e.message || 'Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect SimpleFIN?')) return;
    setLoading(true);
    try {
      await simplefinApi.disconnect();
      await fetchConnection();
    } catch (e: any) {
      setError(e.message || 'Failed to disconnect');
    } finally {
      setLoading(false);
    }
  };

  const handleResync = async () => {
    if (
      !confirm(
        'Re-requests up to 2 years of history from SimpleFIN. Most institutions only expose data from when you connected, so this may not add much — but it doesn\'t hurt to check. Continue?'
      )
    )
      return;
    setResyncing(true);
    setError(null);
    try {
      const result = await simplefinApi.resync();
      await fetchConnection();
      if (result.transactionsAdded === 0 && result.transactionsModified === 0) {
        addToast({ type: 'info', message: 'Resync complete — no additional history was available' });
      } else {
        addToast({
          type: 'success',
          message: `Resync complete — ${result.transactionsAdded} new transaction(s), ${result.transactionsModified} updated`,
        });
      }
    } catch (e: any) {
      addToast({ type: 'error', message: e.message || 'Resync failed' });
    } finally {
      setResyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-body text-muted">Primary bank connection, powered by MX. Read-only.</p>

      {error && <div className="text-body-lg text-clay">{error}</div>}

      {status ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-body-lg">
            <span className="mr-2 text-sage-deep">● Connected</span>
            <span className="text-muted">
              {status.last_synced_at ? `Last synced ${formatRelativeTime(status.last_synced_at)}` : 'SimpleFIN active'}
            </span>
          </div>
          <div className="flex items-center gap-5">
            <TextButton onClick={handleResync} disabled={loading || resyncing}>
              {resyncing ? 'Resyncing…' : 'Resync full history'}
            </TextButton>
            <TextButton onClick={handleDisconnect} disabled={loading || resyncing} className="hover:!text-clay">
              Disconnect
            </TextButton>
          </div>
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-4">
          <div>
            <label className="mz-label">Setup token</label>
            <input
              type="text"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              placeholder="Paste your base64 setup token"
              className="mz-field"
              required
            />
          </div>
          <InkButton type="submit" disabled={loading || !setupToken}>
            {loading ? 'Connecting…' : 'Connect SimpleFIN'}
          </InkButton>
        </form>
      )}
    </div>
  );
}
