import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { isLoggedIn, setToken } from '../lib/auth.js';
import { useT } from '../lib/i18n/index.js';
import { AuthError, AuthField, AuthShell, AuthSubmit } from './AuthShell.js';

/** Only allow same-origin, absolute in-app paths from ?from= (no open redirect). */
export function safeRedirect(from: string | null): string {
  if (!from) return '/videos';
  if (!from.startsWith('/') || from.startsWith('//')) return '/videos';
  if (from.startsWith('/login')) return '/videos';
  return from;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const target = safeRedirect(searchParams.get('from'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { t } = useT();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api<{ token: string }>('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setToken(data.token);
      navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.common.somethingWentWrong);
    } finally {
      setLoading(false);
    }
  };

  // Someone who is already signed in has nothing to do here.
  if (isLoggedIn()) return <Navigate to={target} replace />;

  return (
    <AuthShell
      title={t.auth.signIn}
      subtitle={t.auth.enterCredentials}
      footer={
        <>
          {t.auth.noAccount}{' '}
          <Link to="/signup" className="text-accent-400 hover:text-accent-500 transition-colors font-medium">
            {t.auth.signUp}
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3">
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
          autoComplete="current-password"
          placeholder={t.auth.yourPassword}
        />

        <div className="text-right">
          <Link to="/forgot-password" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            {t.auth.forgotPassword}
          </Link>
        </div>

        {error && <AuthError message={error} />}

        <AuthSubmit disabled={loading}>{loading ? t.auth.signingIn : t.auth.signIn}</AuthSubmit>
      </form>
    </AuthShell>
  );
}
