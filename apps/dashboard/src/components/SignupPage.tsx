import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { isLoggedIn, setToken } from '../lib/auth.js';
import { DEFAULT_PLAN, resolvePlans, toPlanId } from '../lib/plans.js';
import { useServerConfig } from '../lib/server-config.js';
import { useT } from '../lib/i18n/index.js';
import { AuthError, AuthField, AuthShell, AuthSubmit } from './AuthShell.js';
import { PlanCards } from './PlanCards.js';
import { safeRedirect } from './LoginPage.js';
import type { PlanId } from '../lib/types.js';

interface SignupResponse {
  token: string;
  /** Cloud only — Stripe Checkout for the subscription that was just created. */
  checkoutUrl?: string;
}

/**
 * `/signup`. Self-host keeps the plain three-field form it has always had.
 * Cloud adds the plan selector and hands the browser to Stripe once the account
 * exists (the token is stored first, so the user comes back signed in).
 */
export function SignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const target = safeRedirect(searchParams.get('from'));
  const { t } = useT();
  const { config, cloud, isLoading: configLoading } = useServerConfig();

  const plans = useMemo(() => resolvePlans(config?.plans), [config]);
  const [plan, setPlan] = useState<PlanId>(() => toPlanId(searchParams.get('plan')) ?? DEFAULT_PLAN);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const body: Record<string, string> = { email, password, name };
      if (orgName.trim()) body.orgName = orgName.trim();
      if (cloud) body.plan = plan;

      const data = await api<SignupResponse>('/v1/auth/signup', { method: 'POST', body: JSON.stringify(body) });
      setToken(data.token);

      if (data.checkoutUrl) {
        // Leave the SPA: Stripe Checkout is a full page redirect, and coming back
        // lands on /billing/success where the subscription is confirmed.
        setRedirecting(true);
        window.location.href = data.checkoutUrl;
        return;
      }
      navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  };

  // While the browser is on its way to Stripe the token already exists — bouncing to
  // /videos here would mount (and immediately unmount) the whole dashboard.
  if (isLoggedIn() && !redirecting) return <Navigate to={target} replace />;

  const busy = loading || redirecting;
  const submitLabel = redirecting
    ? t.auth.redirectingToPayment
    : loading
      ? t.auth.creatingAccount
      : cloud
        ? t.auth.continueToPayment
        : t.auth.createAccount;

  const form = (
    <form onSubmit={handleSubmit} className="space-y-3">
      <AuthField
        id="name"
        label={t.auth.name}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        autoComplete="name"
        placeholder={t.auth.yourName}
      />
      <AuthField
        id="email"
        label={t.auth.email}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
        placeholder={t.auth.emailPlaceholder}
      />
      <AuthField
        id="password"
        label={t.auth.password}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={8}
        autoComplete="new-password"
        placeholder={t.auth.minChars}
      />
      <AuthField
        id="orgName"
        label={t.auth.orgName}
        type="text"
        value={orgName}
        onChange={(e) => setOrgName(e.target.value)}
        required={cloud}
        autoComplete="organization"
        placeholder={t.auth.orgNamePlaceholder}
      />

      {error && <AuthError message={error} />}

      <AuthSubmit disabled={busy}>{submitLabel}</AuthSubmit>
    </form>
  );

  const footer = (
    <>
      {t.auth.haveAccount}{' '}
      <Link to="/login" className="text-accent-400 hover:text-accent-500 transition-colors font-medium">
        {t.auth.signIn}
      </Link>
    </>
  );

  // Self-host (and the moment before /v1/config answers): the original narrow card.
  if (!cloud) {
    return (
      <AuthShell title={t.auth.createYourAccount} subtitle={t.auth.startManaging} footer={footer}>
        {form}
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t.auth.createYourAccount} subtitle={t.auth.signupCloudSubtitle} footer={footer} width="lg">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]" data-testid="signup-cloud">
        <div aria-busy={configLoading}>
          <PlanCards plans={plans} selected={plan} onSelect={setPlan} disabled={busy} />
        </div>
        <div className="md:border-l md:border-zinc-800/60 md:pl-6">{form}</div>
      </div>
    </AuthShell>
  );
}
