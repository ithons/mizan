import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import type { Category, RecurringPattern, Transaction } from '@shared/types';
import { accountsApi, categoriesApi, flattenCategories, recurringApi, transactionsApi } from '../../lib/api';
import { formatCurrency } from '../../lib/formatters';
import { invalidateFinancialData } from '../../lib/queryInvalidation';
import { parseDecimalInput } from '../../lib/numberInput';
import { useAppStore } from '../../store';
import { Modal } from '../../components/Modal';
import { CategoryPicker, InkButton, TextButton } from '../../components/balance';
import { readDirection } from './spine';

/** The three things the owner can hand-write into the ledger, kept out of the view itself. */

export function AddEntryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const [form, setForm] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    merchant: '',
    amount: '',
    direction: 'expense' as 'expense' | 'income',
    account_id: '',
    category_id: '',
    notes: '',
  });

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = parseDecimalInput(form.amount);
      if (parsed === null || parsed <= 0) throw new Error('Enter a valid amount');
      if (!form.account_id) throw new Error('Pick an account');
      if (!form.merchant.trim()) throw new Error('Enter a merchant');
      return transactionsApi.createManual({
        account_id: form.account_id,
        date: form.date,
        amount: form.direction === 'expense' ? -Math.abs(parsed) : Math.abs(parsed),
        merchant_name: form.merchant.trim(),
        original_name: form.merchant.trim(),
        category_id: form.category_id || undefined,
        notes: form.notes || undefined,
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Entry added' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add an entry">
      <div className="space-y-4">
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="modals-date" className="mz-label">Date</label>
            <input id="modals-date"
              type="date"
              className="mz-field"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="modals-amount" className="mz-label">Amount</label>
            <div className="flex gap-2">
              <select
                className="mz-field !w-[64px]"
                aria-label="Direction"
                value={form.direction}
                onChange={(e) => setForm({ ...form, direction: e.target.value as 'expense' | 'income' })}
              >
                <option value="expense">&minus;</option>
                <option value="income">+</option>
              </select>
              <input
                id="modals-amount"
                type="number"
                className="mz-field tabular-nums"
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
          </div>
        </div>
        <div>
          <label htmlFor="modals-merchant" className="mz-label">Merchant</label>
          <input id="modals-merchant"
            className="mz-field"
            placeholder="Blue Bottle Coffee"
            value={form.merchant}
            onChange={(e) => setForm({ ...form, merchant: e.target.value })}
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="modals-account" className="mz-label">Account</label>
            <select id="modals-account"
              className="mz-field"
              value={form.account_id}
              onChange={(e) => setForm({ ...form, account_id: e.target.value })}
            >
              <option value="">Pick an account…</option>
              {(accounts ?? [])
                .filter((a) => !a.is_hidden)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.account_name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="modals-category-1" className="mz-label">Category</label>
            <CategoryPicker id="modals-category-1"
              variant="field"
              value={form.category_id}
              categories={categories ?? []}
              onChange={(v) => setForm({ ...form, category_id: v })}
              placeholder="Uncategorized"
            />
          </div>
        </div>
        <div>
          <label htmlFor="modals-notes-2" className="mz-label">Notes</label>
          <input id="modals-notes-2" className="mz-field" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Adding…' : 'Add entry'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}

export function EditEntryModal({ transaction, onClose }: { transaction: Transaction | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: () => categoriesApi.list() });
  const [categoryId, setCategoryId] = useState('');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');

  useEffect(() => {
    if (transaction) {
      setCategoryId(transaction.category_id ?? '');
      setNotes(transaction.notes ?? '');
      setAmount(transaction.amount.toFixed(2));
    }
  }, [transaction]);

  const save = useMutation({
    mutationFn: () => {
      const parsed = parseDecimalInput(amount);
      if (parsed === null) throw new Error('Enter a valid amount');
      return transactionsApi.update(transaction!.id, {
        category_id: categoryId || null,
        notes: notes || null,
        // Sent only when it moved. `updateTransaction` already treats retyping the stored value as
        // a non-event, but sending it anyway would run the manual-account rebalance on every save
        // of a hand-entered row for a delta of zero.
        ...(parsed !== transaction!.amount ? { amount: parsed } : {}),
      });
    },
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Entry updated' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const release = useMutation({
    mutationFn: () => transactionsApi.releaseAmount(transaction!.id),
    onSuccess: (row) => {
      invalidateFinancialData(qc);
      setAmount(row.amount.toFixed(2));
      addToast({ type: 'success', message: 'The institution owns this amount again' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const remove = useMutation({
    mutationFn: () => transactionsApi.delete(transaction!.id),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Entry deleted' });
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  if (!transaction) return null;

  // Income is the only direction that earns the positive colour here. A credit is money in that
  // is filed somewhere other than income, and painting it as income is what the ledger row itself
  // stopped doing.
  const direction = readDirection(transaction);

  const ownsAmount = transaction.amount_source === 'human';
  // Non-null only when the provider re-offered a different figure AFTER the correction, so its
  // absence is "no later sync said otherwise" and never "the provider agrees". Both sentences
  // below say exactly that much and no more.
  const providerAmount = transaction.provider_amount ?? null;
  // Everything about provider disagreement is gated on this. A hand-entered row can carry
  // `amount_source = 'human'` too, and telling its owner that no sync has reported a different
  // figure would describe a thing that cannot happen to it.
  const providerBacked = Boolean(transaction.simplefin_transaction_id);
  const institution = transaction.institution_name?.trim() || 'SimpleFIN';

  return (
    <Modal open onClose={onClose} title={(transaction.merchant_name || transaction.original_name).trim()}>
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-body text-muted">
            {format(parseISO(transaction.date), 'MMM d, yyyy')} · {transaction.account_name}
          </span>
          <span
            className={`font-serif text-hero font-light leading-none tabular-nums ${
              direction === 'income' ? 'text-sage-deep' : 'text-ink'
            }`}
          >
            {formatCurrency(transaction.amount, { showSign: transaction.amount > 0 })}
          </span>
        </div>
        {direction === 'credit' && (
          <p className="text-note text-muted">
            Money in, filed under a category that is not income. It reduces that category&apos;s total rather than
            adding to income.
          </p>
        )}
        {/* The amount, and who owns it.
            An institution can be wrong about a sign and stay wrong: Fidelity reports "Electronic
            Funds Transfer Received" negative, so money arriving reads as money leaving. Correcting
            it here sets the row's author to the owner, and the next sync keeps the corrected figure
            instead of overwriting it. Everything that sums money reads the same column, so the
            correction lands on the ledger, the reports and the reconciliation at once. */}
        <div>
          <label htmlFor="modals-scheduled-amount" className="mz-label">Amount</label>
          <div className="flex items-center gap-3">
            <input
              id="modals-scheduled-amount"
              type="text"
              inputMode="decimal"
              aria-label="Amount"
              className="mz-field tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <TextButton
              onClick={() => {
                const parsed = parseDecimalInput(amount);
                if (parsed === null) {
                  addToast({ type: 'error', message: 'Enter a valid amount' });
                  return;
                }
                setAmount((-parsed).toFixed(2));
              }}
              className="whitespace-nowrap"
            >
              Flip the sign
            </TextButton>
          </div>
          {providerAmount !== null && (
            <p className="mt-2 text-note text-review-text">
              {institution} still reports {formatCurrency(providerAmount, { showSign: providerAmount > 0 })} here. Your
              figure is the one every total uses.
            </p>
          )}
          {ownsAmount && providerBacked && providerAmount === null && (
            <p className="mt-2 text-note text-muted">
              You set this amount. No later sync has reported a different one.
            </p>
          )}
          {ownsAmount && providerBacked && (
            <TextButton
              onClick={() => release.mutate()}
              disabled={release.isPending}
              className="mt-1.5 !text-note"
            >
              {release.isPending ? 'Handing it back…' : `Let ${institution} own this amount again`}
            </TextButton>
          )}
        </div>
        <div>
          <label htmlFor="modals-category-2" className="mz-label">Category</label>
          <CategoryPicker id="modals-category-2"
            variant="field"
            value={categoryId}
            categories={categories ?? []}
            onChange={setCategoryId}
            placeholder="Uncategorized"
          />
        </div>
        <div>
          <label htmlFor="modals-notes" className="mz-label">Notes</label>
          <input id="modals-notes" className="mz-field" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
          {Boolean(transaction.is_manual) && (
            <TextButton onClick={() => remove.mutate()} disabled={remove.isPending} className="ml-auto hover:!text-clay">
              Delete
            </TextButton>
          )}
        </div>
      </div>
    </Modal>
  );
}

const FREQUENCY_OPTIONS: Array<RecurringPattern['frequency']> = [
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annual',
];

/** A scheduled item is an entry the ledger expects but has not seen. Same sheet, different ink. */
export function AddScheduledModal({
  open,
  onClose,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
}) {
  const qc = useQueryClient();
  const { addToast } = useAppStore();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<RecurringPattern['frequency']>('monthly');
  const [nextDate, setNextDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [categoryId, setCategoryId] = useState('');

  const selectedCategory = flattenCategories(categories).find((c) => c.id === categoryId);
  const isIncome = Boolean(selectedCategory?.is_income);

  const reset = () => {
    setName('');
    setAmount('');
    setFrequency('monthly');
    setNextDate(format(new Date(), 'yyyy-MM-dd'));
    setCategoryId('');
  };

  const save = useMutation({
    mutationFn: () => {
      const parsed = parseDecimalInput(amount);
      if (!name.trim()) throw new Error('Name the item');
      if (parsed === null || parsed <= 0) throw new Error('Enter a valid amount');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) throw new Error('Pick the next date');
      return recurringApi.create({
        merchant_name: name.trim(),
        frequency,
        average_amount: parsed,
        next_expected: nextDate,
        category_id: categoryId || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring'] });
      addToast({ type: 'success', message: 'Scheduled item added' });
      reset();
      onClose();
    },
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  return (
    <Modal open={open} onClose={onClose} title="Add a scheduled item">
      <div className="space-y-4">
        <div>
          <label htmlFor="modals-name" className="mz-label">Name</label>
          <input id="modals-name"
            className="mz-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rent, Netflix, Paycheck…"
            autoFocus
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="modals-amount-2" className="mz-label">Amount</label>
            <input id="modals-amount-2"
              type="number"
              className="mz-field tabular-nums"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="modals-frequency" className="mz-label">Frequency</label>
            <select id="modals-frequency"
              className="mz-field"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as RecurringPattern['frequency'])}
            >
              {FREQUENCY_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label htmlFor="modals-next-date" className="mz-label">Next date</label>
            <input id="modals-next-date"
              type="date"
              className="mz-field tabular-nums"
              value={nextDate}
              onChange={(e) => setNextDate(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label htmlFor="modals-category-3" className="mz-label">Category</label>
            <CategoryPicker id="modals-category-3"
              variant="field"
              value={categoryId}
              categories={categories}
              onChange={setCategoryId}
              placeholder="Uncategorized"
            />
          </div>
        </div>
        <p className="text-note text-muted-2">
          {isIncome ? 'Scheduled as money coming in' : 'Scheduled as money going out'} · the category decides which.
        </p>
        <div className="flex items-center gap-5 pt-1">
          <InkButton onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Adding…' : 'Add scheduled item'}
          </InkButton>
          <TextButton onClick={onClose}>Cancel</TextButton>
        </div>
      </div>
    </Modal>
  );
}
