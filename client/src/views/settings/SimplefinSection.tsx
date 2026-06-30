import { useState, useEffect } from 'react';
import { simplefinApi } from '../../lib/api';

export function SimplefinSection() {
  const [setupToken, setSetupToken] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="bg-surface rounded-lg p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-medium text-foreground">SimpleFIN</h3>
          <p className="text-sm text-muted">Primary connection powered by MX.</p>
        </div>
      </div>

      {error && <div className="text-red-500 text-sm">{error}</div>}

      {status ? (
        <div className="flex items-center justify-between bg-background p-4 rounded border border-border">
          <div className="text-sm">
            <span className="text-green-500 font-medium mr-2">● Connected</span>
            <span className="text-muted">SimpleFIN active</span>
          </div>
          <button
            onClick={handleDisconnect}
            disabled={loading}
            className="px-4 py-2 text-sm bg-surface hover:bg-surface-hover border border-border rounded"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted mb-1">Setup Token</label>
            <input
              type="text"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              placeholder="Paste your base64 setup token here..."
              className="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-foreground"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading || !setupToken}
            className="px-4 py-2 text-sm bg-foreground text-background font-medium rounded hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Connecting...' : 'Connect SimpleFIN'}
          </button>
        </form>
      )}
    </div>
  );
}
