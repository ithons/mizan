import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { useAppStore } from './store';
import './index.css';

// Query failures used to be entirely silent (no view checked isError), so a dead server looked
// like empty data. One toast per distinct failing query keeps that from ever being invisible;
// views additionally render their own inline error via <QueryState>.
let lastQueryErrorAt = 0;
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      // A dead server fails every in-flight query at once; collapse that burst into one toast.
      const now = Date.now();
      if (now - lastQueryErrorAt < 3000) return;
      lastQueryErrorAt = now;
      const message = error instanceof Error && error.message ? error.message : 'Request failed';
      useAppStore.getState().addToast({
        type: 'error',
        message: message === 'Failed to fetch' ? "Can't reach the Mizān server — is it running?" : message,
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
