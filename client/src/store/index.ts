import { create } from 'zustand';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface AppStore {
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;

  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;

  syncStatus: 'idle' | 'syncing' | 'error';
  setSyncStatus: (s: 'idle' | 'syncing' | 'error') => void;

  lastSynced: string | null;
  setLastSynced: (t: string | null) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  selectedAccountId: null,
  setSelectedAccountId: (id) => set({ selectedAccountId: id }),

  toasts: [],
  addToast: (toast) =>
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id: crypto.randomUUID() }],
    })),
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  syncStatus: 'idle',
  setSyncStatus: (syncStatus) => set({ syncStatus }),

  lastSynced: null,
  setLastSynced: (lastSynced) => set({ lastSynced }),
}));
