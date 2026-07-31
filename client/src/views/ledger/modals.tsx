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
            <label className="mz-label">Date</label>
            <input
              type="date"
              className="mz-field"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>
          <div className="flex-1">
            <label className="mz-label">Amount</label>
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
          <label className="mz-label">Merchant</label>
          <input
            className="mz-field"
            placeholder="Blue Bottle Coffee"
            value={form.merchant}
            onChange={(e) => setForm({ ...form, merchant: e.target.value })}
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Account</label>
            <select
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
            <label className="mz-label">Category</label>
            <CategoryPicker
              variant="field"
              value={form.category_id}
              categories={categories ?? []}
              onChange={(v) => setForm({ ...form, category_id: v })}
              placeholder="Uncategorized"
            />
          </div>
        </div>
        <div>
          <label className="mz-label">Notes</label>
          <input className="mz-field" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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

  useEffect(() => {
    if (transaction) {
      setCategoryId(transaction.category_id ?? '');
      setNotes(transaction.notes ?? '');
    }
  }, [transaction]);

  const save = useMutation({
    mutationFn: () =>
      transactionsApi.update(transaction!.id, { category_id: categoryId || null, notes: notes || null }),
    onSuccess: () => {
      invalidateFinancialData(qc);
      addToast({ type: 'success', message: 'Entry updated' });
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
        <div>
          <label className="mz-label">Category</label>
          <CategoryPicker
            variant="field"
            value={categoryId}
            categories={categories ?? []}
            onChange={setCategoryId}
            placeholder="Uncategorized"
          />
        </div>
        <div>
          <label className="mz-label">Notes</label>
          <input className="mz-field" value={notes} onChange={(e) => setNotes(e.target.value)} />
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
          <label className="mz-label">Name</label>
          <input
            className="mz-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rent, Netflix, Paycheck…"
            autoFocus
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mz-label">Amount</label>
            <input
              type="number"
              className="mz-field tabular-nums"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label className="mz-label">Frequency</label>
            <select
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
            <label className="mz-label">Next date</label>
            <input
              type="date"
              className="mz-field tabular-nums"
              value={nextDate}
              onChange={(e) => setNextDate(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label className="mz-label">Category</label>
            <CategoryPicker
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
