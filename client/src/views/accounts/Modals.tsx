import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Account, AccountType } from '@shared/types';
import { accountsApi } from '../../lib/api';
import { ACCOUNT_TYPE_LABELS } from '../../lib/constants';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { parseDecimalInput } from '../../lib/numberInput';
import { useAppStore } from '../../store';
import { Modal } from '../../components/Modal';
import { InkButton, TextButton } from '../../components/balance';

interface AccountForm {
  account_name: string;
  institution_name: string;
  type: string;
  current_balance: string;
  is_liability: boolean;
}

function AccountFields({ form, setForm, showBalance }: {
  form: AccountForm;
  setForm: (f: AccountForm) => void;
  showBalance: boolean;
}) {
  return (
    <>
      <div>
        <label className="mz-label">Account name</label>
        <input
          className="mz-field"
          value={form.account_name}
          onChange={(e) => setForm({ ...form, account_name: e.target.value })}
          placeholder="My savings"
        />
      </div>
      <div>
        <label className="mz-label">Institution</label>
        <input
          className="mz-field"
          value={form.institution_name}
          onChange={(e) => setForm({ ...form, institution_name: e.target.value })}
          placeholder="Chase"
        />
      </div>
      <div className="flex gap-4">
        <div className="flex-1">
          <label className="mz-label">Type</label>
          <select
            className="mz-field"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            {Object.entries(ACCOUNT_TYPE_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
        <label className="flex cursor-pointer items-center gap-2 self-end pb-2.5">
          <input
            type="checkbox"
            checked={form.is_liability}
            onChange={(e) => setForm({ ...form, is_liability: e.target.checked })}
            className="rounded border-line-3 text-sage focus:ring-0"
          />
          <span className="text-body-lg text-ink">Liability</span>
        </label>
      </div>
      {showBalance && (
        <div>
          <label className="mz-label">Current balance</label>
          <input
            type="number"
            className="mz-field tabular-nums"
            value={form.current_balance}
            onChange={(e) => setForm({ ...form, current_balance: e.target.value })}
            placeholder="0.00"
          />
        </div>
      )}
    </>
  );
}

export function AddManualAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState<AccountForm>({
    account_name: '',
    institution_name: '',
    type: 'checking',
    current_balance: '',
    is_liability: false,
  });

  const mutation = useMutation({
    mutationFn: () => {
      const currentBalance = parseDecimalInput(form.current_balance);
      if (currentBalance === null) throw new Error('Enter a valid current balance');
      return accountsApi.createManual({
        account_name: form.account_name,
        institution_name: form.institution_name,
        type: form.type,
        current_balance: currentBalance,
        currency: 'USD',
        is_liability: form.is_liability,
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Account created' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add account">
      <div className="space-y-4">
        <AccountFields form={form} setForm={setForm} showBalance />
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create account'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}

export function MergeAccountModal({ open, source, accounts, onClose, onMerged }: {
  open: boolean;
  source: Account | null;
  accounts: Account[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [targetId, setTargetId] = useState('');

  useEffect(() => {
    setTargetId('');
  }, [source, open]);

  const candidates = accounts.filter((a) => a.id !== source?.id);
  const target = candidates.find((a) => a.id === targetId) ?? null;
  const currencyMismatch = Boolean(source && target && source.currency !== target.currency);

  const mutation = useMutation({
    mutationFn: () => {
      if (!source) throw new Error('No account selected');
      if (!targetId) throw new Error('Pick an account to merge into');
      return accountsApi.merge({ sourceAccountId: source.id, targetAccountId: targetId });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Accounts merged' });
      onMerged();
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (!source) return null;

  return (
    <Modal open={open} onClose={onClose} title="Merge account">
      <div className="space-y-4">
        <div>
          <label className="mz-label">Merge into</label>
          <select className="mz-field" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Pick an account…</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.account_name}
                {a.institution_name ? ` · ${a.institution_name}` : ''}
              </option>
            ))}
          </select>
        </div>
        {target && (
          <p className="text-body leading-relaxed text-muted">
            <span className="text-ink">{source.account_name}</span> will be merged into{' '}
            <span className="text-ink">{target.account_name}</span> and removed. Its transactions and connection move to{' '}
            <span className="text-ink">{target.account_name}</span>.
          </p>
        )}
        {currencyMismatch && (
          <p className="text-body leading-relaxed text-clay">
            These accounts use different currencies ({source.currency} and {target?.currency}). Merging anyway may mix values.
          </p>
        )}
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => mutation.mutate()} disabled={mutation.isPending || !targetId}>
            {mutation.isPending ? 'Merging…' : 'Merge account'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}

export function EditAccountModal({ open, account, onClose }: {
  open: boolean;
  account: Account | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [form, setForm] = useState<AccountForm>({
    account_name: '',
    institution_name: '',
    type: 'checking',
    current_balance: '',
    is_liability: false,
  });

  useEffect(() => {
    if (account) {
      setForm({
        account_name: account.account_name,
        institution_name: account.institution_name ?? '',
        type: account.type,
        current_balance: String(account.current_balance),
        is_liability: Boolean(account.is_liability),
      });
    }
  }, [account]);

  const mutation = useMutation({
    mutationFn: () => {
      // Balance is only editable for manual accounts
      let currentBalance = account?.current_balance ?? 0;
      if (account?.is_manual) {
        const parsed = parseDecimalInput(form.current_balance);
        if (parsed === null) throw new Error('Enter a valid current balance');
        currentBalance = parsed;
      }
      return accountsApi.update(account!.id, {
        account_name: form.account_name,
        institution_name: account?.is_manual ? form.institution_name : undefined,
        type: form.type as AccountType,
        is_liability: form.is_liability,
        current_balance: account?.is_manual ? currentBalance : undefined,
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Account updated' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (!account) return null;

  return (
    <Modal open={open} onClose={onClose} title="Edit account">
      <div className="space-y-4">
        <AccountFields form={form} setForm={setForm} showBalance={Boolean(account.is_manual)} />
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}
