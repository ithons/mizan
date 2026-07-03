import { create } from 'zustand';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

export type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'mizan:theme';

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch (err) {
    console.warn('Failed to load theme preference', err);
  }
  return 'light';
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (err) {
    console.warn('Failed to save theme preference', err);
  }
}

const initialTheme = loadTheme();
applyTheme(initialTheme);

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

  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
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

  theme: initialTheme,
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next: Theme = get().theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    set({ theme: next });
  },
}));
