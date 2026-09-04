import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { App } from './App';
import { ApiError } from './lib/api.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // Hidden tabs must not keep polling.
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // A 4xx will not fix itself — only retry transport/5xx failures.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

/**
 * Last-resort error boundary. A single uncaught render error must never leave a
 * blank iframe on a customer's page — show a minimal message instead.
 */
class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[hovod] Unhandled render error:', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', color: '#a1a1aa', fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
          <div style={{ textAlign: 'center', padding: 16 }}>
            <p style={{ margin: 0 }}>Something went wrong while loading the player.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ marginTop: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid #3f3f46', background: '#18181b', color: '#e4e4e7', cursor: 'pointer' }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </RootErrorBoundary>
  </React.StrictMode>
);
