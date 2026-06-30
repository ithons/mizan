import React, { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { settingsApi } from '../../lib/api';
import { useAppStore } from '../../store';

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

  if (isLoading) return <div className="text-xs text-muted">Loading...</div>;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-text mb-1">Estimated Tax Rate</h3>
        <p className="text-xs text-muted leading-relaxed mb-3">
          For freelancers and business owners. Mizān will proactively draft transfers for this percentage of income in categories marked "taxable" to shield it from your "Safe to Spend" metric.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            className="bg-background border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-green-50 w-24"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
          <span className="text-muted text-sm">%</span>
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            className="ml-2 px-3 py-2 text-sm bg-text text-surface font-medium rounded hover:opacity-90"
          >
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
