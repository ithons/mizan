import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { settingsApi, coinbaseApi } from '../../lib/api';
import { useAppStore } from '../../store';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { ConfirmRemoveModal } from '../../components/ConfirmRemoveModal';
import { InkButton, TextButton } from '../../components/balance';

export function CoinbaseSection() {
  const { addToast } = useAppStore();
  const qc = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const [form, setForm] = useState({ keyName: '', privateKey: '' });
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const { data: credStatus } = useQuery({
    queryKey: ['credential-status'],
    queryFn: settingsApi.getCredentials,
  });

  const connected = !!credStatus?.coinbase;

  const connectMutation = useMutation({
    mutationFn: () => coinbaseApi.connect(form),
    onSuccess: (data) => {
      const detail = data?.accountCount != null
        ? ` - ${data.accountCount} account(s) found`
        : '';
      addToast({ type: 'success', message: `Coinbase connected${detail}` });
      qc.invalidateQueries({ queryKey: ['credential-status'] });
      invalidateFinancialData(qc);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: coinbaseApi.sync,
    onSuccess: (result) => {
      invalidateFinancialData(qc);
      const changes = result.transactionCount + result.staleAccountCount;
      const detail = changes > 0 ? `, ${changes} update(s)` : '';
      addToast({ type: 'success', message: `Coinbase sync complete${detail}` });
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const disconnectMutation = useMutation({
    mutationFn: coinbaseApi.disconnect,
    onSuccess: () => {
      addToast({ type: 'info', message: 'Coinbase disconnected' });
      qc.invalidateQueries({ queryKey: ['credential-status'] });
      invalidateFinancialData(qc);
      setShowDisconnectConfirm(false);
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <div className="space-y-4 max-w-md">
      {credStatus?.coinbaseFromEnv ? (
        <p className="text-body text-muted">
          <span className="mr-2 text-sage-deep">● Connected</span>
          Credentials loaded from <span className="font-mono text-note text-ink">.env</span>. To change them, edit that file and
          restart the server.
        </p>
      ) : connected ? (
        <p className="text-body text-muted">
          <span className="mr-2 text-sage-deep">● Connected</span>
          API key encrypted in local credentials.
        </p>
      ) : (
        <>
          <p className="text-body text-muted">
            Create an API key at{' '}
            <a
              href="https://portal.cdp.coinbase.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink underline underline-offset-2"
            >
              portal.cdp.coinbase.com
            </a>
            , under Advanced Trade API, with read-only permissions.
          </p>
          <div>
            <label htmlFor="coinbasesection-key-name" className="mz-label">Key name</label>
            <input id="coinbasesection-key-name"
              className="mz-field font-mono !text-body"
              value={form.keyName}
              onChange={(e) => setForm({ ...form, keyName: e.target.value })}
              placeholder="organizations/xxx/apiKeys/yyy"
            />
          </div>
          <div>
            <label htmlFor="coinbasesection-private-key" className="mz-label">Private key</label>
            <div className="relative">
              <textarea id="coinbasesection-private-key"
                className="mz-field resize-none font-mono !text-body"
                rows={4}
                value={form.privateKey}
                onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
                placeholder="-----BEGIN EC PRIVATE KEY-----&#10;..."
                style={{ filter: showKey ? 'none' : 'blur(4px)' }}
              />
              <button
                type="button"
                className="absolute right-2.5 top-2.5 text-muted transition-colors hover:text-ink"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        </>
      )}

      {credStatus?.coinbaseFromEnv || connected ? (
        <div className="flex items-center gap-5">
          <TextButton onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
            {syncMutation.isPending ? 'Syncing…' : 'Sync now'}
          </TextButton>
          {!credStatus?.coinbaseFromEnv && (
            <TextButton
              onClick={() => setShowDisconnectConfirm(true)}
              disabled={disconnectMutation.isPending}
              className="hover:!text-clay"
            >
              Disconnect
            </TextButton>
          )}
        </div>
      ) : (
        <InkButton
          onClick={() => connectMutation.mutate()}
          disabled={connectMutation.isPending || !form.keyName || !form.privateKey}
        >
          {connectMutation.isPending ? 'Connecting…' : 'Connect Coinbase'}
        </InkButton>
      )}

      <ConfirmRemoveModal
        open={showDisconnectConfirm}
        onClose={() => setShowDisconnectConfirm(false)}
        title="Disconnect Coinbase"
        description="This will remove your Coinbase API credentials. Existing Coinbase accounts and transactions will be hidden, not deleted."
        confirmLabel="Disconnect Coinbase"
        onConfirm={() => disconnectMutation.mutate()}
        isPending={disconnectMutation.isPending}
      />
    </div>
  );
}
