import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '../../components/Modal';
import { accountsApi } from '../../lib/api';
import type { Account } from '@shared/types';
import { invalidateFinancialData } from '../../lib/queryInvalidation';

interface MergeAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetAccount: Account;
}

export function MergeAccountModal({ isOpen, onClose, targetAccount }: MergeAccountModalProps) {
  const queryClient = useQueryClient();
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: accountsResponse } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  });

  const accounts = accountsResponse || [];
  
  // Filter out the target account, manual accounts, and hidden accounts? 
  // Actually you might want to merge from a hidden account. Just filter out target and manual.
  const sourceOptions = accounts.filter(
    (a: Account) => a.id !== targetAccount.id && !a.is_manual
  );

  const mergeMutation = useMutation({
    mutationFn: () => accountsApi.merge({ 
      targetAccountId: targetAccount.id, 
      sourceAccountId 
    }),
    onSuccess: () => {
      invalidateFinancialData(queryClient);
      onClose();
    },
    onError: (err: any) => {
      setError(err.response?.data?.error || err.message);
    },
  });

  const handleMerge = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceAccountId) return;
    mergeMutation.mutate();
  };

  return (
    <Modal open={isOpen} onClose={onClose} title="Merge Account Connection">
      <form onSubmit={handleMerge} className="space-y-4">
        <p className="text-sm text-muted">
          Select an account to merge into <strong>{targetAccount.account_name}</strong>. 
          The selected account will be deleted, and all of its transactions will be moved into this account. 
          This is useful when switching an account from one sync provider to another.
        </p>

        {error && <div className="text-sm text-red-500">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-text mb-1">Source Account</label>
          <select
            value={sourceAccountId}
            onChange={(e) => setSourceAccountId(e.target.value)}
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:outline-none focus:border-foreground"
            required
          >
            <option value="" disabled>Select account to merge from...</option>
            {sourceOptions.map((a: Account) => (
              <option key={a.id} value={a.id}>
                {a.institution_name} - {a.account_name} {a.mask ? `(••${a.mask})` : ''} 
                [{a.connection_type}]
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-text"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mergeMutation.isPending || !sourceAccountId}
            className="px-4 py-2 text-sm bg-rose text-background font-medium rounded hover:opacity-90 disabled:opacity-50"
          >
            {mergeMutation.isPending ? 'Merging...' : 'Merge & Replace'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
