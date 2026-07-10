import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { settingsApi } from '../../lib/api';
import { useAppStore } from '../../store';
import { InkButton } from '../../components/balance';

export function TaxesSection() {
  const { addToast } = useAppStore();
  const [rate, setRate] = useState<string>('0');

  const { data: pref, isLoading } = useQuery({
    queryKey: ['settings', 'preferences', 'estimated_tax_rate'],
    queryFn: () => settingsApi.getPreference<number>('estimated_tax_rate'),
  });

  useEffect(() => {
    if (pref) setRate(String(pref.value));
  }, [pref]);

  const saveMutation = useMutation({
    mutationFn: (newRate: number) => settingsApi.setPreference('estimated_tax_rate', newRate),
    onSuccess: () => addToast({ type: 'success', message: 'Estimated tax rate saved' }),
    onError: (err: Error) => addToast({ type: 'error', message: err.message }),
  });

  const handleSave = () => {
    const num = parseFloat(rate);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      addToast({ type: 'error', message: 'Enter a valid percentage between 0 and 100' });
      return;
    }
    saveMutation.mutate(num);
  };

  if (isLoading) return <div className="text-xs text-muted">Loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-muted">
        For freelancers and business owners. Mizān drafts transfers for this share of income in categories marked
        taxable, keeping it out of safe-to-spend.
      </p>
      <div className="flex items-center gap-3">
        <div>
          <label className="mz-label">Estimated tax rate</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              className="mz-field !w-24 tabular-nums"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
            <span className="text-sm text-muted">%</span>
            <InkButton onClick={handleSave} disabled={saveMutation.isPending} className="ml-2">
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </InkButton>
          </div>
        </div>
      </div>
    </div>
  );
}
