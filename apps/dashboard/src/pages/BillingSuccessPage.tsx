import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { ME_QUERY_KEY } from '../components/SubscriptionGate.js';
import { useServerConfig } from '../lib/server-config.js';
import { AuthLogo } from '../components/AuthShell.js';
import { useT } from '../lib/i18n/index.js';
import type { MeData } from '../lib/types.js';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

/** Passed to /videos so the dashboard can pop a welcome toast once. */
export const WELCOME_FLAG_KEY = 'hovod_welcome';

/**
 * Return leg from Stripe Checkout.
 *
 * `POST /v1/billing/sync` reads the session straight from Stripe, which removes
 * the race with the webhook; the poll after it only waits for the write to land.
 */
export function BillingSuccessPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { cloud, isLoading: configLoading } = useServerConfig();
  const sessionId = searchParams.get('session_id');

  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState('');
  const startedRef = useRef(false);

  const run = useCallback(async () => {
    setTimedOut(false);
    setError('');

    if (sessionId) {
      // Best effort: the webhook may already have done the work.
      try {
        await api('/v1/billing/sync', { method: 'POST', body: JSON.stringify({ sessionId }) });
      } catch { /* fall through to the poll — the webhook is the backstop */ }
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      try {
        const me = await api<MeData>('/v1/auth/me');
        queryClient.setQueryData(ME_QUERY_KEY, me);
        if (me.org.entitlement === 'active') {
          try {
            sessionStorage.setItem(WELCOME_FLAG_KEY, me.org.plan ?? '');
          } catch { /* storage unavailable — skip the toast */ }
          navigate('/videos', { replace: true });
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
      }
      if (Date.now() >= deadline) {
        setTimedOut(true);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }, [sessionId, navigate, queryClient, t]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run();
  }, [run]);

  const retry = () => {
    startedRef.current = true;
    void run();
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <AuthLogo />
        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-2xl p-6">
          {!cloud && !configLoading ? (
            <p className="text-sm text-zinc-400">{t.billing.notAvailable}</p>
          ) : timedOut ? (
            <div data-testid="billing-success-slow">
              <h1 className="text-base font-semibold text-zinc-50 mb-1">{t.billing.slowTitle}</h1>
              <p className="text-sm text-zinc-500">{t.billing.slowBody}</p>
              {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
              <button
                type="button"
                onClick={retry}
                className="mt-5 h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors"
              >
                {t.billing.refresh}
              </button>
            </div>
          ) : (
            <div data-testid="billing-success-pending" aria-busy="true">
              <div className="w-6 h-6 mx-auto mb-4 rounded-full border-2 border-zinc-700 border-t-accent-500 animate-spin" />
              <h1 className="text-base font-semibold text-zinc-50 mb-1">{t.billing.successTitle}</h1>
              <p className="text-sm text-zinc-500">{t.billing.successBody}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
