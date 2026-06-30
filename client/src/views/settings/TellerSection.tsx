import { useState, useEffect } from 'react';
import { tellerApi } from '../../lib/api';

export function TellerSection() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchItems();
  }, []);

  const fetchItems = async () => {
    try {
      const data = await tellerApi.listItems();
      setItems(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDisconnect = async (id: string) => {
    if (!confirm('Disconnect this Teller institution?')) return;
    setLoading(true);
    try {
      await tellerApi.deleteItem(id);
      await fetchItems();
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-surface rounded-lg p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-medium text-foreground">Teller</h3>
          <p className="text-sm text-muted">High-fidelity secondary connection.</p>
        </div>
      </div>

      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="flex items-center justify-between bg-background p-4 rounded border border-border">
            <div>
              <div className="font-medium">{item.institution_name}</div>
              <div className="text-xs text-muted">Status: {item.status}</div>
            </div>
            <button
              onClick={() => handleDisconnect(item.id)}
              disabled={loading}
              className="px-3 py-1.5 text-sm bg-surface hover:bg-surface-hover border border-border rounded text-red-400"
            >
              Disconnect
            </button>
          </div>
        ))}
        {items.length === 0 && (
          <div className="text-sm text-muted">No Teller connections active.</div>
        )}
      </div>
      
      {/* A "Connect" button here would normally invoke the Teller Connect UI 
          using the App ID and a custom hook. For brevity, it is represented as a placeholder. */}
      <button disabled className="px-4 py-2 text-sm bg-surface hover:bg-surface-hover border border-border rounded opacity-50 cursor-not-allowed">
        Connect Teller (Configure mTLS First)
      </button>
    </div>
  );
}
