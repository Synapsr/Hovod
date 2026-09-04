import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCheckout } from '../lib/billing.js';
import { DEFAULT_PLAN, resolvePlans, toPlanId } from '../lib/plans.js';
import { useServerConfig } from '../lib/server-config.js';
import { AuthLogo } from '../components/AuthShell.js';
import { PlanCards } from '../components/PlanCards.js';
import { SELF_HOST_README_URL } from '../components/SubscriptionGate.js';
import { useT } from '../lib/i18n/index.js';
import type { PlanId } from '../lib/types.js';

/** `cancel_url` of the Stripe Checkout session — nothing was charged. */
export function BillingCancelPage() {
  const { t } = useT();
  const [searchParams] = useSearchParams();
  const { config, cloud, isLoading } = useServerConfig();
  const [error, setError] = useState('');
  const plans = useMemo(() => resolvePlans(config?.plans), [config]);
  const [selected, setSelected] = useState<PlanId>(() => toPlanId(searchParams.get('plan')) ?? DEFAULT_PLAN);
  const checkout = useCheckout(setError, t);

  const restart = (plan: PlanId) => {
    setSelected(plan);
    setError('');
    checkout.mutate(plan);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl">
        <AuthLogo />
        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-2xl p-6">
          {!cloud && !isLoading ? (
            <p className="text-sm text-zinc-400 text-center">{t.billing.notAvailable}</p>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-zinc-50">{t.billing.cancelTitle}</h1>
              <p className="text-sm text-zinc-400 mt-1.5">{t.billing.cancelBody}</p>

              {error && (
                <p className="mt-4 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2" role="alert">
                  {error}
                </p>
              )}

              <div className="mt-6">
                <PlanCards
                  plans={plans}
                  selected={selected}
                  onSelect={restart}
                  ctaLabel={t.billing.retryCheckout}
                  pendingPlan={checkout.isPending ? checkout.variables ?? null : null}
                  disabled={checkout.isPending}
                />
              </div>

              <div className="mt-6 rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-4 py-3">
                <p className="text-xs text-zinc-500">{t.billing.paywallSelfHost}</p>
                <a
                  href={SELF_HOST_README_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs font-medium text-accent-400 hover:text-accent-500 transition-colors"
                >
                  {t.billing.selfHostDocs} →
                </a>
              </div>
            </>
          )}

          <div className="mt-6 text-center">
            <Link to="/videos" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              {t.billing.backToDashboard}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
